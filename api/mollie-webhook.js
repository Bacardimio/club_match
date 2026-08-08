// api/mollie-webhook.js
// Webhook UNIQUE partagé par SocialMeet et ClubMatchPro.
// Appelé par Mollie (pas par le navigateur) dès que le statut d'un paiement change.
// C'est le SEUL endroit du système qui a le droit d'écrire un déblocage.
//
// L'aiguillage se fait sur metadata.app, posé par create-payment. Les deux apps
// n'écrivent PAS au même endroit :
//
//   socialmeet   → events/<id>/users/<uid>        (unlockedVibes, vibe, unlockedAll)
//   clubmatchpro → events/<id>/bonus/<badge>      (flash, msg/<paire>)
//
// ⚠ Ne jamais écrire un objet dans events/<id>/users/<badge> côté ClubMatchPro : ce
// nœud contient une simple CHAÎNE (l'uid du propriétaire du badge) et l'app le
// surveille — toute autre valeur la déconnecte et recharge la page.

import admin from 'firebase-admin';

// Deux façons de fournir les identifiants Firebase.
//
//   Option A (recommandée) : trois variables séparées
//     FIREBASE_PROJECT_ID    → champ "project_id" du fichier JSON
//     FIREBASE_CLIENT_EMAIL  → champ "client_email"
//     FIREBASE_PRIVATE_KEY   → champ "private_key"
//   Option B : FIREBASE_SERVICE_ACCOUNT contenant le JSON entier.
//
// Si les deux sont présentes, l'option A gagne.
function credentials() {
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;

  if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
    return {
      projectId: FIREBASE_PROJECT_ID.trim(),
      clientEmail: FIREBASE_CLIENT_EMAIL.trim(),
      // Deux nettoyages indispensables : les guillemets copiés avec la valeur, et les
      // \n arrivés en deux caractères alors qu'OpenSSL attend de vrais retours ligne.
      privateKey: FIREBASE_PRIVATE_KEY.trim().replace(/^"|"$/g, '').replace(/\\n/g, '\n'),
    };
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }

  throw new Error(
    'Identifiants Firebase absents : renseigne FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY (ou FIREBASE_SERVICE_ACCOUNT)'
  );
}

// Si les deux apps partagent la même Realtime Database, il n'y a rien à faire :
// FIREBASE_DB_URL suffit. Si ClubMatchPro vit dans une AUTRE base (recommandé — les
// deux apps utilisent le même chemin events/<id>/users/<clé> avec des contenus
// incompatibles), renseigne FIREBASE_DB_URL_CLUBMATCHPRO et l'aiguillage est
// automatique. Chaque URL a sa propre instance nommée, initialisée une seule fois.
function database(app) {
  const url =
    (app === 'clubmatchpro' && process.env.FIREBASE_DB_URL_CLUBMATCHPRO) ||
    process.env.FIREBASE_DB_URL;

  const name = url === process.env.FIREBASE_DB_URL ? '[DEFAULT]' : 'clubmatchpro';

  let instance = admin.apps.find(a => a && a.name === name);
  if (!instance) {
    instance = admin.initializeApp(
      { credential: admin.credential.cert(credentials()), databaseURL: url },
      name
    );
  }
  return instance.database();
}

// Clé de conversation ClubMatchPro : les deux badges triés, joints par un tiret.
// Identique au calcul fait dans l'app.
const pairKey = (a, b) => [String(a), String(b)].sort().join('-');

/* ---------------------------------------------------------------- */
/* Déblocage SocialMeet — inchangé                                   */
/* ---------------------------------------------------------------- */
async function creditSocialMeet(payment, meta) {
  const { kind, vibeId, uid, eventId } = meta;
  if (!uid || !eventId) {
    console.error('Métadonnées incomplètes', payment.id, meta);
    return;
  }

  const userRef = database('socialmeet').ref(`events/${eventId}/users/${uid}`);
  console.log('[webhook] socialmeet', payment.id, '→', `events/${eventId}/users/${uid}`, kind, vibeId || '');

  // Le SDK Admin écrit en contournant les règles de sécurité : celles-ci peuvent donc
  // interdire ces champs au client sans gêner le webhook.
  if (kind === 'all') {
    await userRef.update({ unlockedAll: true });
  } else if (vibeId) {
    // Débloque le mood ET l'applique : l'utilisateur voit le changement arriver en
    // temps réel, même s'il a fermé l'onglet avant la fin du paiement.
    await userRef.update({ [`unlockedVibes/${vibeId}`]: true, vibe: vibeId });
  }

  await userRef.child(`payments/${payment.id}`).set({
    kind: kind || null,
    vibeId: vibeId || null,
    amount: payment.amount ? payment.amount.value : null,
    paidAt: payment.paidAt || null,
  });
}

/* ---------------------------------------------------------------- */
/* Déblocage ClubMatchPro — quotas incrémentaux                      */
/* ---------------------------------------------------------------- */
async function creditClubMatchPro(payment, meta) {
  const { kind, qty, badge, peer, eventId } = meta;
  if (!badge || !eventId) {
    console.error('Métadonnées incomplètes', payment.id, meta);
    return;
  }

  const bonusRef = database('clubmatchpro').ref(`events/${eventId}/bonus/${badge}`);
  const receiptRef = bonusRef.child(`payments/${payment.id}`);

  // IDEMPOTENCE. Contrairement à SocialMeet où l'on écrit des booléens (rejouer le
  // webhook est sans effet), ici on INCRÉMENTE : sans ce garde-fou, un webhook rejoué
  // par Mollie créditerait deux fois le même paiement.
  const already = await receiptRef.once('value');
  if (already.exists()) {
    console.log('[webhook] clubmatchpro : paiement déjà traité, ignoré :', payment.id);
    return;
  }

  const amount = Number(qty) || (kind === 'flash5' ? 5 : 10);

  // Transaction : deux paiements simultanés ne peuvent pas s'écraser l'un l'autre.
  const target = kind === 'msg10'
    ? bonusRef.child(`msg/${pairKey(badge, peer)}`)
    : bonusRef.child('flash');

  await target.transaction(current => (current || 0) + amount);

  await receiptRef.set({
    kind,
    qty: amount,
    peer: peer || null,
    amount: payment.amount ? payment.amount.value : null,
    paidAt: payment.paidAt || null,
  });

  console.log('[webhook] clubmatchpro', payment.id, '→ +' + amount, kind, `events/${eventId}/bonus/${badge}`);
}

export default async function handler(req, res) {
  // --- AUTOTEST ---
  // https://ton-domaine/api/mollie-webhook?selftest=1
  // Vérifie sans attendre un vrai paiement que les variables Firebase sont présentes,
  // lisibles, et qu'une écriture passe DANS CHAQUE BASE utilisée. Ne renvoie aucun
  // secret : uniquement des booléens et le message d'erreur éventuel.
  if (req.method === 'GET' && req.query && req.query.selftest) {
    const report = {
      MOLLIE_API_KEY: !!process.env.MOLLIE_API_KEY,
      FIREBASE_DB_URL: process.env.FIREBASE_DB_URL || null,
      FIREBASE_DB_URL_CLUBMATCHPRO: process.env.FIREBASE_DB_URL_CLUBMATCHPRO || '(même base que SocialMeet)',
      FIREBASE_PROJECT_ID: !!process.env.FIREBASE_PROJECT_ID,
      FIREBASE_CLIENT_EMAIL: !!process.env.FIREBASE_CLIENT_EMAIL,
      FIREBASE_PRIVATE_KEY: !!process.env.FIREBASE_PRIVATE_KEY,
      // La clé doit commencer par cet en-tête : si c'est false alors que la variable
      // existe, c'est qu'on a copié autre chose que le champ private_key.
      privateKeyLooksValid: (process.env.FIREBASE_PRIVATE_KEY || '').includes('BEGIN PRIVATE KEY'),
      FIREBASE_SERVICE_ACCOUNT_present: !!process.env.FIREBASE_SERVICE_ACCOUNT,
      credentialsReadable: false,
      serviceAccountEmail: null,
      firebaseWriteSocialMeet: false,
      firebaseWriteClubMatchPro: false,
      error: null,
    };
    try {
      const creds = credentials();
      report.credentialsReadable = true;
      report.serviceAccountEmail = creds.clientEmail || creds.client_email || null;

      // Écriture PUIS suppression immédiate : l'autotest doit prouver qu'il sait écrire
      // sans laisser de nœud `__selftest` traîner à la racine de la base.
      for (const [app, field] of [
        ['socialmeet', 'firebaseWriteSocialMeet'],
        ['clubmatchpro', 'firebaseWriteClubMatchPro'],
      ]) {
        const probe = database(app).ref('__selftest');
        await probe.set({ at: Date.now() });
        await probe.remove();
        report[field] = true;
      }
    } catch (e) {
      report.error = e.message;
    }
    return res.status(200).json(report);
  }

  if (req.method !== 'POST') return res.status(405).end();

  // Mollie envoie l'id en form-urlencoded. Le corps ne contient QUE cet id — et on ne
  // lui fait pas confiance : n'importe qui peut poster ici. La vérité vient de l'appel
  // ci-dessous, authentifié par notre clé API.
  const paymentId = req.body && req.body.id;
  if (!paymentId) return res.status(400).end();

  try {
    const r = await fetch(`https://api.mollie.com/v2/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` },
    });
    if (!r.ok) {
      // 500 → Mollie réessaiera plus tard, ce qu'on veut en cas de panne passagère.
      console.error('Lecture du paiement impossible', paymentId, r.status);
      return res.status(500).end();
    }

    const payment = await r.json();

    // Un webhook arrive aussi pour 'failed', 'expired', 'canceled'. On répond 200
    // (rien à faire, inutile que Mollie réessaie) sans rien débloquer.
    if (payment.status !== 'paid') return res.status(200).end();

    const meta = payment.metadata || {};

    // Repli sur le kind : les paiements SocialMeet créés AVANT ce déploiement n'ont pas
    // de champ `app` dans leurs métadonnées et pourraient encore être en vol.
    const app = meta.app || (['flash5', 'msg10'].includes(meta.kind) ? 'clubmatchpro' : 'socialmeet');

    if (app === 'clubmatchpro') {
      await creditClubMatchPro(payment, meta);
    } else {
      await creditSocialMeet(payment, meta);
    }

    return res.status(200).end();
  } catch (e) {
    console.error(e);
    return res.status(500).end();
  }
}
