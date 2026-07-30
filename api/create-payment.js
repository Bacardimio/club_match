// api/create-payment.js
// Crée un paiement Mollie et renvoie l'URL de checkout au navigateur.
//
// Pourquoi côté serveur plutôt qu'un lien de paiement statique :
//   - les liens du dashboard Mollie sont à usage UNIQUE (le premier payeur les grille) ;
//   - le prix est décidé ici, donc le navigateur ne peut pas le changer ;
//   - l'URL de retour et le webhook sont construits à la volée, avec l'événement et le
//     produit acheté dedans.

// Le catalogue vit ICI et nulle part ailleurs. Un client qui posterait
// { kind: 'all', price: '0.01' } n'obtiendrait rien : le prix n'est jamais lu du corps
// de la requête.
const PRODUCTS = {
  mood: { value: '1.00', description: "SocialMeet — changement d'ambiance" },
  all:  { value: '2.00', description: 'SocialMeet — toutes les ambiances' },
};

const VALID_VIBES = ['social', 'party', 'flirt', 'network'];

// Décide vers quelle URL renvoyer l'utilisateur après le paiement.
//
// Point crucial : le localStorage ET le compte anonyme Firebase sont liés à l'ORIGINE.
// Renvoyer quelqu'un parti de `mon-domaine.com` vers `mon-projet.vercel.app` en fait un
// parfait inconnu au retour — nouvel uid, aucune photo, aucun déblocage visible, et le
// mood qu'il vient de payer reste orphelin sur son ancien compte. On le ramène donc
// exactement d'où il vient, à condition que cette origine soit dans la liste blanche.
function resolveReturn(req, returnPath) {
  const allowed = (process.env.ALLOWED_ORIGINS || process.env.APP_URL || '')
    .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  const claimed = (req.headers.origin || '').replace(/\/$/, '');

  // Dernier recours : l'hôte réellement appelé. Il vaut mieux que la liste blanche, mal
  // renseignée, envoie tout le monde sur un domaine mort.
  const origin = allowed.includes(claimed)
    ? claimed
    : (allowed[0] || `https://${req.headers.host}`);

  // Le chemin vient du client (l'app peut vivre à /SocialMeet.html, /app.html ou /).
  // On n'accepte qu'un chemin relatif simple : sans cette vérification, un `returnPath`
  // du genre `//evil.com` transformerait notre redirection en tremplin vers un site tiers.
  // Le repli APP_PATH ne sert que si le client n'envoie rien (ancienne version en cache) —
  // il ne doit surtout pas pointer sur la racine quand celle-ci est la page vitrine.
  const fallbackPath = process.env.APP_PATH || '/SocialMeet.html';
  const path = (typeof returnPath === 'string'
    && returnPath.startsWith('/')
    && !returnPath.startsWith('//')
    && !returnPath.includes('..'))
      ? returnPath.split('?')[0]
      : fallbackPath;

  return { origin, path, allowed, claimed };
}

export default async function handler(req, res) {
  // --- AUTOTEST ---
  // https://ton-domaine/api/create-payment?selftest=1&path=/SocialMeet.html
  // Montre l'URL de retour que la fonction fabriquerait, sans créer de paiement. À noter :
  // une navigation directe dans la barre d'adresse n'envoie pas d'en-tête Origin, donc le
  // champ `claimedOrigin` sera vide ici alors qu'il est renseigné lors d'un vrai appel.
  if (req.method === 'GET' && req.query && req.query.selftest) {
    const { origin, path, allowed, claimed } = resolveReturn(req, req.query.path);
    return res.status(200).json({
      MOLLIE_API_KEY: !!process.env.MOLLIE_API_KEY,
      APP_URL: process.env.APP_URL || null,
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || null,
      allowlistParsed: allowed,
      hostHeader: req.headers.host || null,
      claimedOrigin: claimed || null,
      resolvedOrigin: origin,
      resolvedPath: path,
      exampleRedirectUrl: `${origin}${path}?event=default&mollie_return=mood`,
      webhookUrl: `${origin}/api/mollie-webhook`,
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.MOLLIE_API_KEY) {
    return res.status(500).json({ error: 'MOLLIE_API_KEY absente des variables Vercel' });
  }

  const { kind, vibeId, uid, eventId, returnPath } = req.body || {};

  const product = PRODUCTS[kind];
  if (!product) return res.status(400).json({ error: 'kind invalide' });
  if (!uid || !eventId) return res.status(400).json({ error: 'uid ou eventId manquant' });
  if (kind === 'mood' && !VALID_VIBES.includes(vibeId)) {
    return res.status(400).json({ error: 'vibeId invalide' });
  }

  const { origin, path } = resolveReturn(req, returnPath);
  const redirectUrl = `${origin}${path}?event=${encodeURIComponent(eventId)}&mollie_return=${kind}`;

  // Journalisé pour que Vercel → Logs montre l'URL exacte en cas de 404 au retour.
  console.log('[create-payment]', kind, vibeId || '', '→ redirect', redirectUrl);

  const payload = {
    amount: { currency: 'EUR', value: product.value },
    description: product.description,
    redirectUrl,
    webhookUrl: `${origin}/api/mollie-webhook`,
    // Mollie nous rendra ces métadonnées telles quelles dans le webhook : c'est ainsi
    // qu'on saura qui débloquer, sans base de données intermédiaire.
    metadata: { kind, vibeId: vibeId || null, uid, eventId },
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
