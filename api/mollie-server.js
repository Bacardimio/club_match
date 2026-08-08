/* ------------------------------------------------------------------
   Backend Mollie minimal — même principe que le flux SocialMeet.
   La clé API Mollie ne doit JAMAIS se trouver dans app.html.

   npm i express cors @mollie/api-client
   MOLLIE_API_KEY=live_xxx node mollie-server.js
------------------------------------------------------------------ */
import express from "express";
import cors from "cors";
import { createMollieClient } from "@mollie/api-client";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const mollie = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });
const PUBLIC_URL = process.env.PUBLIC_URL || "https://api.tondomaine.fr";

// Tarifs autorisés côté serveur (on ne fait jamais confiance au client)
const PACKS = {
  flash5: { value: "3.00", qty: 5, label: "Pack 5 flashs" },
  msg10:  { value: "2.00", qty: 10, label: "Pack 10 messages" }
};

/* 1. Création du paiement --------------------------------------- */
app.post("/api/mollie/create-payment", async (req, res) => {
  try {
    const { metadata = {}, redirectUrl } = req.body;
    const pack = PACKS[metadata.pack];
    if (!pack) return res.status(400).json({ error: "unknown pack" });

    const payment = await mollie.payments.create({
      amount: { currency: "EUR", value: pack.value }, // prix imposé côté serveur
      description: `${pack.label} — badge ${metadata.badge || "?"}`,
      redirectUrl,
      webhookUrl: `${PUBLIC_URL}/api/mollie/webhook`,
      metadata: {
        pack: metadata.pack,
        qty: pack.qty,
        event: metadata.event || "default",
        badge: metadata.badge || null,
        peer: metadata.peer || null
      }
    });

    res.json({ id: payment.id, checkoutUrl: payment.getCheckoutUrl() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "create failed" });
  }
});

/* 2. Vérification du statut (appelée au retour dans l'app) ------- */
app.get("/api/mollie/payment-status", async (req, res) => {
  try {
    const payment = await mollie.payments.get(req.query.id);
    res.json({
      status: payment.status,          // paid | open | canceled | expired | failed
      metadata: payment.metadata
    });
  } catch (e) {
    res.status(404).json({ error: "not found" });
  }
});

/* 3. Webhook Mollie — source de vérité ---------------------------
   Idéal : écrire le crédit dans Firebase (events/<event>/bonus/<badge>)
   avec le SDK Admin, pour que le quota suive l'utilisateur d'un
   appareil à l'autre et ne soit pas modifiable via localStorage.    */
app.post("/api/mollie/webhook", express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const payment = await mollie.payments.get(req.body.id);
    if (payment.isPaid()) {
      const { pack, qty, event, badge, peer } = payment.metadata;
      console.log("PAID", { pack, qty, event, badge, peer });
      // await admin.database().ref(...).transaction(v => (v || 0) + Number(qty));
    }
    res.sendStatus(200);
  } catch (e) {
    res.sendStatus(200); // Mollie réessaie si on renvoie une erreur
  }
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Mollie backend prêt")
);
