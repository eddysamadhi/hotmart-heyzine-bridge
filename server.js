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

// ✅ Modo "descoberta de ucode" (SAFE: não cria acesso, não remove, não envia email ao comprador)
const HOTMART_DISCOVER_UCODE = process.env.HOTMART_DISCOVER_UCODE === "true";

// (Opcional) limitar a descoberta a certos eventos (para evitar spam)
const DISCOVER_ONLY_EVENTS = new Set([
  "PURCHASE_APPROVED",
  // "PURCHASE_COMPLETE",
  // "PURCHASE_DELAYED",
]);

// 3) Mapa Hotmart -> Heyzine
// ✅ PRODUÇÃO: use SOMENTE ucode como chave (product.ucode).
const PRODUCT_MAP = {
  // ✅ Substitua as chaves abaixo pelos UCODES reais dos produtos na Hotmart.
  // EXEMPLO:
  // "UCODE-DO-GELLIAN": { ... }

  // (Mantive seus exemplos, mas AGORA como placeholder: TROQUE as chaves por ucode)
  "fb056612-bcc6-4217-9e6d-2a5d1110ac2f": {
    name: "149c95dbe08200def69527e27e4de9552dfa17f9.pdf",
    title:
      "Crônicas de Luthera - Gellian | versão colorida e estendida | leitura online Premium",
    url: "https://heyzine.com/flip-book/149c95dbe0.html",
  },
  "bedc6fed-33a3-47c7-a33e-c66f433c1500": {
    name: "df5dc91fb87d2f5156abb23526e79c6a7692b147.pdf",
    title: "Crônicas de Luthera - Udhar | Leitura online Premium",
    url: "https://heyzine.com/flip-book/df5dc91fb8.html",
  },
  "1468f9bc-eab3-4107-b387-29c2aba91b4d": {
    name: "64d61a857998bd6c8c18b2bb2620d1dce75ed067.pdf",
    title:
      "Crônicas de Luthera - Os Paladinos de Aterom | versão colorida e estendida | leitura online Premium",
    url: "https://heyzine.com/flip-book/64d61a8579.html",
  },
  "TROQUE_PARA_UCODE_6978497": {
    name: "803ad25bde64f1abc27b33c30a6d43a881b5bb52.pdf",
    title:
      "Crônicas de Luthera - Avartrax | versão colorida e estendida | leitura online Premium",
    url: "https://heyzine.com/flip-book/803ad25bde.html",
  },
};

// ✅ Correção: true significa "permitir duplicados"
const ALLOW_DUPLICATE_TESTS = process.env.ALLOW_DUPLICATE_TESTS === "true";

// ====== Idempotência simples (memória) ======
// Em produção “forte”, use banco (Redis/Postgres). Isso aqui evita duplicar em replays rápidos.
const processedEvents = new Set();

// ====== Utils ======
function genPassword() {
  // senha forte e curta o suficiente para digitar (12 chars base64url)
  return crypto.randomBytes(9).toString("base64url");
}

function extractProductIdentifiers(payload) {
  const product = payload?.data?.product || {};
  return {
    ucode: product?.ucode ? String(product.ucode) : null,
    name: product?.name || product?.title || null,
  };
}

// ✅ PRODUÇÃO: usa SOMENTE product.ucode como chave.
// (Se não vier ucode, trata como erro de payload.)
function pickProductKey(payload) {
  const ucode = payload?.data?.product?.ucode;
  return ucode ? String(ucode) : null;
}

function getHotmartHottok(req) {
  // Express trata headers de forma case-insensitive
  return req.get("X-HOTMART-HOTTOK") || req.get("x-hotmart-hottok");
}

function isApprovalEvent(event) {
  // Hotmart v2 tipicamente usa PURCHASE_*
  return event === "PURCHASE_APPROVED" || event === "PURCHASE_COMPLETE";
}

function isRevokeEvent(event) {
  // aceitar tanto família PURCHASE_* quanto nomes curtos (compat)
  return (
    event === "PURCHASE_REFUNDED" ||
    event === "PURCHASE_CANCELED" ||
    event === "PURCHASE_CHARGEBACK" ||
    event === "REFUNDED" ||
    event === "CANCELED" ||
    event === "CHARGEBACK"
  );
}

async function heyzineAccessAdd({ name, user, password }) {
  if (!HEYZINE_API_KEY) throw new Error("Missing HEYZINE_API_KEY");

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

  if (!res.ok) {
    throw new Error(
      `Heyzine access-add failed (${res.status}): ${JSON.stringify(data)}`
    );
  }

  if (data?.success === false) {
    throw new Error(
      `Heyzine access-add failed (logical): ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function heyzineAccessRemove({ name, user }) {
  if (!HEYZINE_API_KEY) throw new Error("Missing HEYZINE_API_KEY");

  const res = await fetch("https://heyzine.com/api1/access-remove", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HEYZINE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, user }),
  });

  const data = await res.json().catch(async () => ({ raw: await res.text() }));

  if (!res.ok) {
    throw new Error(
      `Heyzine access-remove failed (${res.status}): ${JSON.stringify(data)}`
    );
  }

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

  const msg = { to, from: EMAIL_FROM, subject, text, html };

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
  extra,
}) {
  if (!EMAIL_AUDITORIA) return;
  if (!SENDGRID_API_KEY || !EMAIL_FROM) return;

  const subject = `🧪 Webhook Hotmart — ${event} — ${transaction}`;

  const text = `Resultado do processamento do webhook

Evento: ${event}
Transação: ${transaction}

Produto: ${productTitle}
Comprador (buyer): ${buyerEmail}

Senha:
${password}

Resultado Heyzine:
${JSON.stringify(heyzineResult, null, 2)}

Resultado Email comprador:
${JSON.stringify(emailResult, null, 2)}

Extra:
${extra ? JSON.stringify(extra, null, 2) : "(n/a)"}
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
  const receivedAt = new Date().toISOString();

  try {
    // 1) Segurança: rejeitar se segredo não bater
    const incomingHottok = getHotmartHottok(req);

    if (!HOTMART_HOTTOK || incomingHottok !== HOTMART_HOTTOK) {
      return res.status(401).send("Unauthorized");
    }

    const payload = req.body;

    const event = payload?.event;
    const buyerEmail = payload?.data?.buyer?.email || "(no buyer email)";
    const transaction = payload?.data?.purchase?.transaction || "(no transaction)";

    // Log base (não despeja payload inteiro)
    console.log(">>> webhook", receivedAt, event, transaction);

    // ✅ MODO DESCOBERTA DE UCODE (SAFE)
    // - Não cria acesso
    // - Não remove acesso
    // - Não envia email ao comprador
    // - Apenas registra ucode do produto (log + auditoria opcional)
    if (HOTMART_DISCOVER_UCODE) {
      if (event && DISCOVER_ONLY_EVENTS.size > 0 && !DISCOVER_ONLY_EVENTS.has(event)) {
        console.log("[DISCOVER_UCODE] Ignorado por evento:", event);
        return res.status(200).send("OK");
      }

      const productIds = extractProductIdentifiers(payload);

      console.log("[DISCOVER_UCODE] Capturado:", {
        event,
        transaction,
        buyerEmail,
        product: productIds,
      });

      // Auditoria opcional
      try {
        await sendAuditEmail({
          event: `DISCOVER_UCODE:${event || "UNKNOWN"}`,
          buyerEmail,
          productTitle: productIds?.name || "(no product name)",
          transaction,
          password: "(n/a)",
          heyzineResult: { info: "Modo descoberta ativo: nenhuma ação Heyzine executada" },
          emailResult: { info: "Modo descoberta ativo: nenhum e-mail enviado ao comprador" },
          extra: { receivedAt, product: productIds },
        });
      } catch (e) {
        console.error("[DISCOVER_UCODE] Falha ao enviar auditoria:", e?.message || e);
      }

      return res.status(200).send("OK");
    }

    // 2) Validação mínima (modo produção normal)
    const productKey = pickProductKey(payload);

    console.log(">>> productKey (ucode)", productKey);

    if (!event || !transaction || !productKey) {
      return res.status(400).send("Missing required fields (event/transaction/product.ucode)");
    }

    const mapped = PRODUCT_MAP[productKey];
    if (!mapped) {
      console.log("Unmapped product ucode:", productKey);
      // Não falha webhook — apenas ignora
      return res.status(200).send("OK");
    }

    // ✅ Idempotência por evento + transação
    const idempotencyKey = `${event}:${transaction}`;

    // 3) Eventos que criam acesso
    if (isApprovalEvent(event)) {
      if (!ALLOW_DUPLICATE_TESTS && processedEvents.has(idempotencyKey)) {
        console.log(`Duplicate approval skipped: ${idempotencyKey}`);
        return res.status(200).send("OK");
      }

      const password = genPassword();

      // Se Heyzine falhar, retornamos 500 para permitir retry do webhook
      let heyzineResult;
      try {
        heyzineResult = await heyzineAccessAdd({
          name: mapped.name,
          user: buyerEmail,
          password,
        });
      } catch (e) {
        console.error("Heyzine access-add failed:", e?.message || e);

        await sendAuditEmail({
          event,
          buyerEmail,
          productTitle: mapped.title || mapped.name,
          transaction,
          password,
          heyzineResult: { error: e?.message || String(e) },
          emailResult: { info: "não enviado (heyzine falhou)" },
          extra: { idempotencyKey, receivedAt, productUcode: productKey },
        }).catch(() => {});

        return res.status(500).send("Heyzine error");
      }

      processedEvents.add(idempotencyKey);

      // Envio do email (ao comprador) — se falhar, não derruba o webhook
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
      }

      // Auditoria
      await sendAuditEmail({
        event,
        buyerEmail,
        productTitle: mapped.title || mapped.name,
        transaction,
        password,
        heyzineResult,
        emailResult,
        extra: { idempotencyKey, receivedAt, productUcode: productKey },
      }).catch(() => {});

      console.log(
        `Access granted: ${buyerEmail} -> ${mapped.name} (${transaction})`
      );
      return res.status(200).send("OK");
    }

    // 4) Eventos que revogam acesso
    if (isRevokeEvent(event)) {
      if (!ALLOW_DUPLICATE_TESTS && processedEvents.has(idempotencyKey)) {
        console.log(`Duplicate revoke skipped: ${idempotencyKey}`);
        return res.status(200).send("OK");
      }

      let revokeResult;
      try {
        revokeResult = await heyzineAccessRemove({
          name: mapped.name,
          user: buyerEmail,
        });
      } catch (e) {
        console.error("Heyzine access-remove failed:", e?.message || e);

        await sendAuditEmail({
          event,
          buyerEmail,
          productTitle: mapped.title || mapped.name,
          transaction,
          password: "(n/a)",
          heyzineResult: { error: e?.message || String(e) },
          emailResult: { info: "revogação falhou (heyzine)" },
          extra: { idempotencyKey, receivedAt, productUcode: productKey },
        }).catch(() => {});

        return res.status(500).send("Heyzine error");
      }

      processedEvents.add(idempotencyKey);

      await sendAuditEmail({
        event,
        buyerEmail,
        productTitle: mapped.title || mapped.name,
        transaction,
        password: "(n/a)",
        heyzineResult: revokeResult,
        emailResult: { info: "revogação de acesso (sem envio ao comprador)" },
        extra: { idempotencyKey, receivedAt, productUcode: productKey },
      }).catch(() => {});

      console.log(
        `Access revoked: ${buyerEmail} -> ${mapped.name} (${transaction})`
      );
      return res.status(200).send("OK");
    }

    // 5) Outros eventos: só aceita
    return res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook fatal error:", err);
    // Preferível 500 para permitir retry em erro inesperado
    return res.status(500).send("Internal error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
