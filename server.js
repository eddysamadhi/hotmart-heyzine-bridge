import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ====== CONFIG (Railway env vars) ======
// 1) Um segredo que só você conhece (protege o endpoint)
const HOTMART_HOTTOK = process.env.HOTMART_HOTTOK;

// 2) API Key da Heyzine (Bearer)
const HEYZINE_API_KEY = process.env.HEYZINE_API_KEY;

// 3) Mapa Hotmart -> Heyzine (ajuste com seus dados reais)
const PRODUCT_MAP = {
  // Use product.id quando vier (ex.: 1234567)
  // "4774438": { name: "Udhar.pdf", url: "https://heyzine.com/flip-book/df5dc91fb8.html" },

  // Use ucode como fallback
  "fb056612-bcc6-4217-9e6d-2a5d1110ac2f": {
    name: "Udhar.pdf",
    url: "https://heyzine.com/flip-book/df5dc91fb8.html",
  },
};

// ====== Idempotência simples (memória) ======
// Em produção “forte”, use banco. Para começar, isso já evita duplicar em replays rápidos.
const processedTransactions = new Set();

// ====== Utils ======
function genPassword() {
  // senha forte e curta o suficiente para digitar (12 chars base64url)
  return crypto.randomBytes(9).toString("base64url");
}

function pickProductKey(payload) {
  const pid = payload?.data?.product?.id;
  const ucode = payload?.data?.product?.ucode;
  if (pid && pid !== 0) return String(pid);
  if (ucode) return String(ucode);
  return null;
}

async function heyzineAccessAdd({ name, user, password }) {
  const res = await fetch("https://heyzine.com/api1/access-add", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HEYZINE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      access_type: "user_pass",
      user,
      password,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Heyzine access-add failed (${res.status}): ${txt}`);
  }
  return res.json();
}

async function heyzineAccessRemove({ name, user }) {
  const res = await fetch("https://heyzine.com/api1/access-remove", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HEYZINE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, user }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Heyzine access-remove failed (${res.status}): ${txt}`);
  }
  return res.json();
}

// ====== Healthcheck ======
app.get("/", (req, res) => res.status(200).send("OK"));

// ====== Webhook Hotmart ======
app.post("/webhooks/hotmart", async (req, res) => {
  try {
    // 1) Segurança: rejeitar se segredo não bater
    const incomingHottok = req.header("x-hotmart-hottok") || req.header("X-HOTMART-HOTTOK");

    if (!HOTMART_HOTTOK || incomingHottok !== HOTMART_HOTTOK) {
      return res.status(401).send("Unauthorized");
    }

    const payload = req.body;

    const event = payload?.event;
    const buyerEmail = payload?.data?.buyer?.email;
    const transaction = payload?.data?.purchase?.transaction;
    const productKey = pickProductKey(payload);

    // 2) Validação mínima
    if (!event || !buyerEmail || !transaction || !productKey) {
      return res.status(400).send("Missing required fields");
    }

    const mapped = PRODUCT_MAP[productKey];
    if (!mapped) {
      // Não falhe o webhook: apenas ignore (ou logue) produtos não mapeados
      console.log("Unmapped productKey:", productKey);
      return res.status(200).send("OK");
    }

    // 3) Idempotência para eventos que criam acesso
    if (event === "PURCHASE_APPROVED") {
      if (processedTransactions.has(transaction)) {
        return res.status(200).send("OK");
      }
      processedTransactions.add(transaction);

      const password = genPassword();

      // 3.1) Cria acesso individual no Heyzine
      await heyzineAccessAdd({
        name: mapped.name,
        user: buyerEmail,
        password,
      });

      // 3.2) Envio de e-mail (implementar)
      // Aqui você envia: mapped.url + buyerEmail + password
      // sendEmail(buyerEmail, mapped.url, password);

      // Não logue CPF / endereço. Log mínimo:
      console.log(`Access granted: ${buyerEmail} -> ${mapped.name} (${transaction})`);

      return res.status(200).send("OK");
    }

    // 4) Eventos que revogam acesso
    if (
      event === "PURCHASE_REFUNDED" ||
      event === "CHARGEBACK" ||
      event === "PURCHASE_CANCELED"
    ) {
      await heyzineAccessRemove({
        name: mapped.name,
        user: buyerEmail,
      });

      console.log(`Access revoked: ${buyerEmail} -> ${mapped.name} (${transaction})`);
      return res.status(200).send("OK");
    }

    // 5) Outros eventos: só aceita
    return res.status(200).send("OK");
  } catch (err) {
    console.error(err);
    // Retornar 200 evita reenvios em loop; mas em fase de teste, você pode preferir 500.
    return res.status(200).send("OK");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
