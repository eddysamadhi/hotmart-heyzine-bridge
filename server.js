import express from "express";
import crypto from "crypto";
import { Resend } from "resend";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ====== CONFIG (Railway env vars) ======


// 1) Um segredo que só você conhece (protege o endpoint)
const HOTMART_HOTTOK = process.env.HOTMART_HOTTOK;

// 2) API Key da Heyzine (Bearer)
const HEYZINE_API_KEY = process.env.HEYZINE_API_KEY;

// 3) Mapa Hotmart -> Heyzine (ajuste com seus dados reais)
const PRODUCT_MAP = {
  "4774438": { name: "df5dc91fb87d2f5156abb23526e79c6a7692b147.pdf",
			  title: "Crônicas de Luthera - Udhar",
			  url: "https://heyzine.com/flip-book/df5dc91fb8.html" },
  "fb056612-bcc6-4217-9e6d-2a5d1110ac2f": { 
	  name: "df5dc91fb87d2f5156abb23526e79c6a7692b147.pdf", 
	  title: "Crônicas de Luthera - Udhar",
	  url: "https://heyzine.com/flip-book/df5dc91fb8.html" },
};

const ALLOW_DUPLICATE_TESTS = process.env.ALLOW_DUPLICATE_TESTS === "true";

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

  const data = await res.json().catch(async () => ({ raw: await res.text() }));

  // 1) erro HTTP
  if (!res.ok) {
    throw new Error(`Heyzine access-add failed (${res.status}): ${JSON.stringify(data)}`);
  }

  // 2) erro lógico (success:false)
  if (data?.success === false) {
    throw new Error(`Heyzine access-add failed (logical): ${JSON.stringify(data)}`);
  }

  return data;
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

  const data = await res.json().catch(async () => ({ raw: await res.text() }));

  // 1) erro HTTP
  if (!res.ok) {
    throw new Error(
      `Heyzine access-remove failed (${res.status}): ${JSON.stringify(data)}`
    );
  }

  // 2) erro lógico (HTTP 200 mas success:false)
  if (data?.success === false) {
    throw new Error(
      `Heyzine access-remove failed (logical): ${JSON.stringify(data)}`
    );
  }

  return data;
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
	console.log(">>> webhook", new Date().toISOString(), payload?.event, payload?.data?.purchase?.transaction);

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
	  if (!ALLOW_DUPLICATE_TESTS && processedTransactions.has(transaction)) {
	    console.log(`Duplicate PURCHASE_APPROVED skipped: ${transaction}`);
	    return res.status(200).send("OK");
	  }
	
	  const password = genPassword();
	
	 const result = await heyzineAccessAdd({
		  name: mapped.name,
		  user: buyerEmail,
		  password,
		});
		console.log("Heyzine access-add result:", result);

	
	  processedTransactions.add(transaction);
	
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
