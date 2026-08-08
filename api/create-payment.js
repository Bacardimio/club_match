// api/create-payment.js
// Endpoint UNIQUE partagé par SocialMeet et ClubMatchPro.
//
// C'est le produit acheté qui détermine l'app : chaque entrée du catalogue porte un
// champ `app`. Le client n'a donc rien à déclarer de plus qu'avant — le front SocialMeet
// existant continue d'envoyer exactement le même corps de requête qu'aujourd'hui.

// Le catalogue vit ICI et nulle part ailleurs. Un client qui posterait
// { kind: 'all', price: '0.01' } n'obtiendrait rien : le prix n'est jamais lu du corps
// de la requête.
const PRODUCTS = {
  // --- SocialMeet ---
  mood:   { app: 'socialmeet',   value: '1.00',           description: "SocialMeet — changement d'ambiance" },
  all:    { app: 'socialmeet',   value: '2.00',           description: 'SocialMeet — toutes les ambiances' },
  // --- ClubMatchPro ---
  flash5: { app: 'clubmatchpro', value: '3.00', qty: 5,   description: 'ClubMatchPro — 5 flashs supplémentaires' },
  msg10:  { app: 'clubmatchpro', value: '2.00', qty: 10,  description: 'ClubMatchPro — 10 messages supplémentaires' },
};

const VALID_VIBES = ['social', 'party', 'flirt', 'network'];

// Chemin de repli PAR APP. Il ne sert que si le client n'envoie pas de `returnPath`
// (vieille version en cache, requête bricolée) — mais dans ce cas précis, un repli
// unique renverrait un acheteur ClubMatchPro sur SocialMeet, ou l'inverse.
//
// APP_PATH (sans suffixe) reste lu en dernier recours, pour ne pas casser la config
// SocialMeet déjà en place.
function fallbackPathFor(app) {
  if (app === 'clubmatchpro') {
    return process.env.APP_PATH_CLUBMATCHPRO || '/app.html';
  }
  return process.env.APP_PATH_SOCIALMEET || process.env.APP_PATH || '/SocialMeet.html';
}

// Le localStorage ET le compte anonyme Firebase sont liés à l'ORIGINE. Renvoyer
// quelqu'un parti de `mon-domaine.com` vers `mon-projet.vercel.app` en fait un parfait
// inconnu au retour. On le ramène exactement d'où il vient, si cette origine est dans
// la liste blanche.
function resolveReturn(req, returnPath, app) {
  const allowed = (process.env.ALLOWED_ORIGINS || process.env.APP_URL || '')
    .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  const claimed = (req.headers.origin || '').replace(/\/$/, '');

  const origin = allowed.includes(claimed)
    ? claimed
    : (allowed[0] || `https://${req.headers.host}`);

  // Sans cette vérification, un `returnPath` du genre `//evil.com` transformerait notre
  // redirection en tremplin vers un site tiers.
  const path = (typeof returnPath === 'string'
    && returnPath.startsWith('/')
    && !returnPath.startsWith('//')
    && !returnPath.includes('..'))
      ? returnPath.split('?')[0]
      : fallbackPathFor(app);

  return { origin, path, allowed, claimed };
}

export default async function handler(req, res) {
  // --- AUTOTEST ---
  // https://ton-domaine/api/create-payment?selftest=1
  // Ajoute &kind=flash5 (ou &kind=mood) pour voir le repli appliqué à cette app,
  // et &path=/app.html pour simuler un returnPath envoyé par le client.
  // Une navigation directe dans la barre d'adresse n'envoie pas d'en-tête Origin :
  // `claimedOrigin` sera vide ici alors qu'il est renseigné lors d'un vrai appel.
  if (req.method === 'GET' && req.query && req.query.selftest) {
    const kind = req.query.kind || 'mood';
    const app = (PRODUCTS[kind] || {}).app || 'socialmeet';
    const { origin, path, allowed, claimed } = resolveReturn(req, req.query.path, app);
    return res.status(200).json({
      MOLLIE_API_KEY: !!process.env.MOLLIE_API_KEY,
      APP_URL: process.env.APP_URL || null,
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || null,
      allowlistParsed: allowed,
      hostHeader: req.headers.host || null,
      claimedOrigin: claimed || null,
      catalogue: Object.fromEntries(
        Object.entries(PRODUCTS).map(([k, p]) => [k, `${p.app} — ${p.value} EUR`])
      ),
      fallbackPaths: {
        socialmeet: fallbackPathFor('socialmeet'),
        clubmatchpro: fallbackPathFor('clubmatchpro'),
      },
      testedKind: kind,
      testedApp: app,
      resolvedOrigin: origin,
      resolvedPath: path,
      exampleRedirectUrl: `${origin}${path}?event=default&mollie_return=${kind}`,
      webhookUrl: `${origin}/api/mollie-webhook`,
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.MOLLIE_API_KEY) {
    return res.status(500).json({ error: 'MOLLIE_API_KEY absente des variables Vercel' });
  }

  const { kind, vibeId, uid, badge, peer, eventId, returnPath } = req.body || {};

  const product = PRODUCTS[kind];
  if (!product) return res.status(400).json({ error: 'kind invalide' });
  if (!eventId) return res.status(400).json({ error: 'eventId manquant' });

  // Chaque app a sa propre notion d'identité : uid Firebase pour SocialMeet,
  // numéro de badge pour ClubMatchPro.
  let metadata;

  if (product.app === 'socialmeet') {
    if (!uid) return res.status(400).json({ error: 'uid manquant' });
    if (kind === 'mood' && !VALID_VIBES.includes(vibeId)) {
      return res.status(400).json({ error: 'vibeId invalide' });
    }
    metadata = { app: 'socialmeet', kind, vibeId: vibeId || null, uid, eventId };
  } else {
    // Les badges sont des nombres 0–200 : on refuse tout le reste, ces valeurs
    // deviendront des clés Firebase.
    const ok = v => /^\d{1,3}$/.test(String(v)) && Number(v) <= 200;
    if (!badge) return res.status(400).json({ error: 'badge manquant' });
    if (!ok(badge)) return res.status(400).json({ error: 'badge invalide' });
    // Un pack de messages est attaché à UNE conversation : il faut le badge d'en face.
    if (kind === 'msg10' && !ok(peer)) {
      return res.status(400).json({ error: 'peer invalide' });
    }
    metadata = {
      app: 'clubmatchpro',
      kind,
      qty: String(product.qty),
      badge: String(badge),
      peer: peer ? String(peer) : null,
      eventId,
    };
  }

  const { origin, path } = resolveReturn(req, returnPath, product.app);
  const redirectUrl = `${origin}${path}?event=${encodeURIComponent(eventId)}&mollie_return=${kind}`;

  // Journalisé pour que Vercel → Logs montre l'URL exacte en cas de 404 au retour.
  console.log('[create-payment]', product.app, kind, vibeId || badge || '', '→ redirect', redirectUrl);

  const payload = {
    amount: { currency: 'EUR', value: product.value },
    description: product.description,
    redirectUrl,
    webhookUrl: `${origin}/api/mollie-webhook`,
    // Mollie nous rendra ces métadonnées telles quelles dans le webhook : c'est ainsi
    // qu'on saura quoi débloquer, et dans quelle app, sans base intermédiaire.
    metadata,
  };

  try {
    const r = await fetch('https://api.mollie.com/v2/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.MOLLIE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const payment = await r.json();
    if (!r.ok) {
      console.error('Mollie a refusé la création :', payment);
      return res.status(502).json({ error: payment.detail || 'Création du paiement refusée' });
    }

    return res.status(200).json({
      checkoutUrl: payment._links.checkout.href,
      paymentId: payment.id,
    });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: 'Mollie injoignable' });
  }
}
