import express from "express";
import crypto from "crypto";
import sgMail from "@sendgrid/mail";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ====== CONFIG (Railway env vars) ======
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM; // ex: contato@eddysamadhi.com
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || EMAIL_FROM;

// ✅ Auditoria (opcional): se setado, envia relatório do processamento
const EMAIL_AUDITORIA = process.env.EMAIL_AUDITORIA;

if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);

// 1) Um segredo que só você conhece (protege o endpoint)
const HOTMART_HOTTOK = process.env.HOTMART_HOTTOK;

// 2) API Key da Heyzine (Bearer)
const HEYZINE_API_KEY = process.env.HEYZINE_API_KEY;

// 3) Mapa Hotmart -> Heyzine (ajuste com seus dados reais)
const PRODUCT_MAP = {
    "7040305": {
    name: "149c95dbe08200def69527e27e4de9552dfa17f9.pdf",
    title: "Crônicas de Luthera - Gellian | versão colorida e estendida | leitura online Premium",
    url: "https://heyzine.com/flip-book/149c95dbe0.html",
  },
    "7062283": {
    name: "df5dc91fb87d2f5156abb23526e79c6a7692b147.pdf",
    title: "Crônicas de Luthera - Udhar | Leitura online Premium",
    url: "https://heyzine.com/flip-book/df5dc91fb8.html",
  },
    "7184211": {
    name: "64d61a857998bd6c8c18b2bb2620d1dce75ed067.pdf",
    title: "Crônicas de Luthera - Os Paladinos de Aterom | versão colorida e estendida | leitura online Premium",
    url: "https://heyzine.com/flip-book/64d61a8579.html",
  },
    "6978497": {
    name: "803ad25bde64f1abc27b33c30a6d43a881b5bb52.pdf",
    title: "Crônicas de Luthera - Avartrax | versão colorida e estendida | leitura online Premium",
    url: "https://heyzine.com/flip-book/803ad25bde.html",
  },
};

const ALLOW_DUPLICATE_TESTS = process.env.ALLOW_DUPLICATE_TESTS === "false";

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
  if (pid && pid !== 0) return String(pid);
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
    throw new Error(
      `Heyzine access-add failed (${res.status}): ${JSON.stringify(data)}`
    );
  }

  // 2) erro lógico (success:false)
  if (data?.success === false) {
    throw new Error(
      `Heyzine access-add failed (logical): ${JSON.stringify(data)}`
    );
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

async function sendAccessEmail({ to, bookTitle, flipbookUrl, password }) {
  if (!SENDGRID_API_KEY) throw new Error("Missing SENDGRID_API_KEY");
  if (!EMAIL_FROM) throw new Error("Missing EMAIL_FROM");

  const subject = `Acesso liberado: ${bookTitle}`;

  const text = `Seu acesso foi liberado ✅

Livro: ${bookTitle}
Link: ${flipbookUrl}

Login: ${to}
Senha: ${password}

Suporte: ${SUPPORT_EMAIL}
`;

  const html = `
  <div style="font-family: Arial, sans-serif; line-height: 1.5">
    <h2>Seu acesso foi liberado ✅</h2>
    <p><strong>Livro:</strong> ${bookTitle}</p>
    <p><strong>Link do flipbook:</strong><br/>
      <a href="${flipbookUrl}">${flipbookUrl}</a>
    </p>
    <p><strong>Login:</strong> ${to}<br/>
       <strong>Senha:</strong> ${password}</p>
    <p style="margin-top:16px">
      Se houver qualquer problema, responda este e-mail ou fale com: ${SUPPORT_EMAIL}.
    </p>
  </div>`;

  const msg = {
    to,
    from: EMAIL_FROM,
    subject,
    text,
    html,
  };

  const [resp] = await sgMail.send(msg);
  return { statusCode: resp.statusCode };
}

// ✅ Email de auditoria (condicional via env var EMAIL_AUDITORIA)
async function sendAuditEmail({
  event,
  buyerEmail,
  productTitle,
  transaction,
  password,
  heyzineResult,
  emailResult,
}) {
  if (!EMAIL_AUDITORIA) return;
  if (!SENDGRID_API_KEY || !EMAIL_FROM) return;

  const subject = `🧪 Webhook Hotmart — ${event} — ${transaction}`;

  const text = `Resultado do processamento do webhook

Evento: ${event}
Transação: ${transaction}

Produto: ${productTitle}
Comprador (buyer): ${buyerEmail}

Senha gerada:
${password}

Resultado Heyzine:
${JSON.stringify(heyzineResult, null, 2)}

Resultado Email comprador:
${JSON.stringify(emailResult, null, 2)}
`;

  const msg = {
    to: EMAIL_AUDITORIA,
    from: EMAIL_FROM,
    subject,
    text,
  };

  await sgMail.send(msg);
}

// ====== Healthcheck ======
app.get("/", (req, res) => res.status(200).send("OK"));

// ====== Webhook Hotmart ======
app.post("/webhooks/hotmart", async (req, res) => {
  try {
    // 1) Segurança: rejeitar se segredo não bater
    const incomingHottok =
      req.header("x-hotmart-hottok") || req.header("X-HOTMART-HOTTOK");

    if (!HOTMART_HOTTOK || incomingHottok !== HOTMART_HOTTOK) {
      return res.status(401).send("Unauthorized");
    }

    const payload = req.body;
    console.log(
      ">>> webhook",
      new Date().toISOString(),
      payload?.event,
      payload?.data?.purchase?.transaction
    );

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

    // 3) Eventos que criam acesso
    if (event === "PURCHASE_APPROVED") {
      // Idempotência para replays rápidos
      if (!ALLOW_DUPLICATE_TESTS && processedTransactions.has(transaction)) {
        console.log(`Duplicate PURCHASE_APPROVED skipped: ${transaction}`);
        return res.status(200).send("OK");
      }

      const password = genPassword();

      const heyzineResult = await heyzineAccessAdd({
        name: mapped.name,
        user: buyerEmail,
        password,
      });
      console.log("Heyzine access-add result:", heyzineResult);

      processedTransactions.add(transaction);

      // Envio do email (ao comprador)
      let emailResult = null;
      try {
        emailResult = await sendAccessEmail({
          to: buyerEmail,
          bookTitle: mapped.title || "Seu livro",
          flipbookUrl: mapped.url,
          password,
        });
        console.log("Email sent:", emailResult);
      } catch (e) {
        emailResult = { error: e?.message || String(e) };
        console.error("Email send failed:", e?.message || e);
        // Se quiser permitir reenvio em caso de falha de email:
        // processedTransactions.delete(transaction);
      }

      // ✅ Auditoria (se EMAIL_AUDITORIA estiver setado)
      try {
        await sendAuditEmail({
          event,
          buyerEmail,
          productTitle: mapped.title || mapped.name,
          transaction,
          password,
          heyzineResult,
          emailResult,
        });
        console.log("Audit email sent to:", EMAIL_AUDITORIA);
      } catch (e) {
        console.error("Audit email failed:", e?.message || e);
      }

      console.log(
        `Access granted: ${buyerEmail} -> ${mapped.name} (${transaction})`
      );
      return res.status(200).send("OK");
    }

    // 4) Eventos que revogam acesso
    if (
      event === "PURCHASE_REFUNDED" ||
      event === "CHARGEBACK" ||
      event === "PURCHASE_CANCELED"
    ) {
      const revokeResult = await heyzineAccessRemove({
        name: mapped.name,
        user: buyerEmail,
      });

      console.log("Heyzine access-remove result:", revokeResult);

      // (Opcional) Auditoria também para revogação
      try {
        await sendAuditEmail({
          event,
          buyerEmail,
          productTitle: mapped.title || mapped.name,
          transaction,
          password: "(n/a)",
          heyzineResult: revokeResult,
          emailResult: { info: "revogação de acesso (sem envio ao comprador)" },
        });
        console.log("Audit email sent to:", EMAIL_AUDITORIA);
      } catch (e) {
        console.error("Audit email failed:", e?.message || e);
      }

      console.log(
        `Access revoked: ${buyerEmail} -> ${mapped.name} (${transaction})`
      );
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
