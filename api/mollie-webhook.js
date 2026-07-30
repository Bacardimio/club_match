// api/mollie-webhook.js
// Appelé par Mollie (pas par le navigateur) dès que le statut d'un paiement change.
// C'est le SEUL endroit du système qui a le droit d'écrire un déblocage.

import admin from 'firebase-admin';

function database() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
      databaseURL: process.env.FIREBASE_DB_URL,
    });
  }
  return admin.database();
}

export default async function handler(req, res) {
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
