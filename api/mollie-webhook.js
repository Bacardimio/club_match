// api/mollie-webhook.js
// Appelé par Mollie (pas par le navigateur) dès que le statut d'un paiement change.
// C'est le SEUL endroit du système qui a le droit d'écrire un déblocage.

import admin from 'firebase-admin';

// Deux façons de fournir les identifiants Firebase. La seconde existe parce que coller un
// JSON multiligne dans le champ "Value" de Vercel est capricieux — trois valeurs d'une
// seule ligne passent partout.
//
//   Option A (recommandée) : trois variables séparées
//     FIREBASE_PROJECT_ID    → champ "project_id" du fichier JSON
//     FIREBASE_CLIENT_EMAIL  → champ "client_email"
//     FIREBASE_PRIVATE_KEY   → champ "private_key" (la longue chaîne avec des \n dedans)
//
//   Option B : FIREBASE_SERVICE_ACCOUNT contenant le JSON entier.
//
// Si les deux sont présentes, l'option A gagne.
function credentials() {
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;

  if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
    return {
      projectId: FIREBASE_PROJECT_ID.trim(),
      clientEmail: FIREBASE_CLIENT_EMAIL.trim(),
      // Deux nettoyages indispensables : les guillemets que l'on copie souvent en même
      // temps que la valeur depuis le JSON, et les \n qui arrivent en tant que deux
      // caractères (antislash + n) alors qu'OpenSSL attend de vrais retours à la ligne.
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

function database() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(credentials()),
      databaseURL: process.env.FIREBASE_DB_URL,
    });
  }
  return admin.database();
}

export default async function handler(req, res) {
  // --- AUTOTEST ---
  // Ouvre https://ton-domaine/api/mollie-webhook?selftest=1 dans le navigateur pour
  // vérifier, sans attendre un vrai paiement, que les variables Firebase sont présentes,
  // lisibles, et qu'une écriture en base passe. Ne renvoie aucun secret : uniquement des
  // booléens et le message d'erreur éventuel.
  if (req.method === 'GET' && req.query && req.query.selftest) {
    const report = {
      MOLLIE_API_KEY: !!process.env.MOLLIE_API_KEY,
      FIREBASE_DB_URL: process.env.FIREBASE_DB_URL || null,
      // Option A — trois variables séparées
      FIREBASE_PROJECT_ID: !!process.env.FIREBASE_PROJECT_ID,
      FIREBASE_CLIENT_EMAIL: !!process.env.FIREBASE_CLIENT_EMAIL,
      FIREBASE_PRIVATE_KEY: !!process.env.FIREBASE_PRIVATE_KEY,
      // La clé doit commencer par cet en-tête : si c'est false alors que la variable
      // existe, c'est qu'on a copié autre chose que le champ private_key.
      privateKeyLooksValid: (process.env.FIREBASE_PRIVATE_KEY || '').includes('BEGIN PRIVATE KEY'),
      // Option B — JSON complet
      FIREBASE_SERVICE_ACCOUNT_present: !!process.env.FIREBASE_SERVICE_ACCOUNT,
      credentialsReadable: false,
      serviceAccountEmail: null,
      firebaseWrite: false,
      error: null,
    };
    try {
      const creds = credentials();
      report.credentialsReadable = true;
      report.serviceAccountEmail = creds.clientEmail || creds.client_email || null;
      // Écriture PUIS suppression immédiate : l'autotest doit prouver qu'il sait écrire
      // sans laisser de nœud `__selftest` traîner à la racine de la base.
      const probe = database().ref('__selftest');
      await probe.set({ at: Date.now() });
      await probe.remove();
      report.firebaseWrite = true;
    } catch (e) {
      report.error = e.message;
    }
    return res.status(200).json(report);
  }

  if (req.method !== 'POST') return res.status(405).end();

  // Mollie envoie l'id en form-urlencoded. Le corps ne contient QUE cet id — et on ne lui
  // fait pas confiance : n'importe qui peut poster ici. La vérité vient de l'appel
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

    // Un webhook arrive aussi pour les statuts 'failed', 'expired', 'canceled'. On répond
    // 200 (rien à faire, inutile que Mollie réessaie) sans rien débloquer.
    if (payment.status !== 'paid') return res.status(200).end();

    const { kind, vibeId, uid, eventId } = payment.metadata || {};
    if (!uid || !eventId) {
      console.error('Métadonnées incomplètes', paymentId, payment.metadata);
      return res.status(200).end();
    }

    const userRef = database().ref(`events/${eventId}/users/${uid}`);
    console.log('[webhook] paiement', paymentId, 'confirmé →', `events/${eventId}/users/${uid}`, kind, vibeId || '');

    // Le SDK Admin écrit en contournant les règles de sécurité : celles-ci peuvent donc
    // interdire ces champs au client sans gêner le webhook.
    if (kind === 'all') {
      await userRef.update({ unlockedAll: true });
    } else if (vibeId) {
      // Débloque le mood ET l'applique : l'utilisateur voit le changement arriver en
      // temps réel, même s'il a fermé l'onglet avant la fin du paiement.
      await userRef.update({ [`unlockedVibes/${vibeId}`]: true, vibe: vibeId });
    }

    // Trace d'audit : permet de rapprocher un déblocage d'un paiement en cas de litige,
    // et rend l'opération idempotente à l'œil nu si Mollie rejoue le webhook.
    await userRef.child(`payments/${paymentId}`).set({
      kind: kind || null,
      vibeId: vibeId || null,
      amount: payment.amount ? payment.amount.value : null,
      paidAt: payment.paidAt || null,
    });

    return res.status(200).end();
  } catch (e) {
    console.error(e);
    return res.status(500).end();
  }
}
