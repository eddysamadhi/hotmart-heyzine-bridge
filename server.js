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
// Dica: durante a descoberta, considere liberar PURCHASE_COMPLETE também.
const DISCOVER_ONLY_EVENTS = new Set([
  "PURCHASE_APPROVED",
  // "PURCHASE_COMPLETE",
  // "PURCHASE_DELAYED",
]);

// 3) Mapa Hotmart -> Heyzine
// ✅ PRODUÇÃO: use SOMENTE ucode como chave.
// ✅ Agora suportamos "múltiplos produtos" na mesma compra via data.product.content.products[].
const PRODUCT_MAP = {
  "bedc6fed-33a3-47c7-a33e-c66f433c1500": {
    name: "149c95dbe08200def69527e27e4de9552dfa17f9.pdf",
    title:
      "Crônicas de Luthera - Gellian | versão colorida e estendida | leitura online Premium",
    url: "https://heyzine.com/flip-book/149c95dbe0.html",
  },
    "fb056612-bcc6-4217-9e6d-2a5d1110ac2f": {
    name: "df5dc91fb87d2f5156abb23526e79c6a7692b147.pdf",
    title: "Crônicas de Luthera - Udhar | Leitura online Premium",
    url: "https://heyzine.com/flip-book/df5dc91fb8.html",
  },
  "1468f9bc-eab3-4107-b387-29c2aba91b4d": {
    name: "50104cb2c3d7ee491f5be5f65929bb5c00a8c6e8.pdf",
    title:
      "Crônicas de Luthera - Os Paladinos de Aterom | versão colorida e estendida | leitura online Premium",
    url: "https://heyzine.com/flip-book/50104cb2c3.html",
  },
  "14223a24-e05c-4004-bfb8-864c66640c11": {
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

/**
 * ✅ Novo: extrai TODOS os produtos (ucodes) relevantes para a compra.
 * - Sempre inclui data.product.ucode (produto principal)
 * - Também inclui data.product.content.products[].ucode (itens agregados: bundles, order bump, físico etc.)
 * - Por padrão, IGNORA produtos físicos (is_physical_product === true), porque Heyzine é digital.
 * - Remove duplicados e valores vazios.
 */
function extractAllProductUcodes(payload, { includePhysical = false } = {}) {
  const out = [];

  const main = payload?.data?.product;
  if (main?.ucode) {
    // Alguns payloads podem ter is_physical_product no nível principal
    if (includePhysical || !main?.is_physical_product) out.push(String(main.ucode));
  }

  const contentProducts = main?.content?.products;
  if (Array.isArray(contentProducts)) {
    for (const p of contentProducts) {
      if (!p?.ucode) continue;
      const isPhysical = Boolean(p?.is_physical_product);
      if (!includePhysical && isPhysical) continue;
      out.push(String(p.ucode));
    }
  }

  // dedupe + sane
  return [...new Set(out.filter(Boolean))];
}

// Mantém utilidade para "discovery" (um produto principal apenas)
function extractProductIdentifiers(payload) {
  const product = payload?.data?.product || {};
  return {
    ucode: product?.ucode ? String(product.ucode) : null,
    name: product?.name || product?.title || null,
  };
}

// ====== Heyzine ======
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

// ====== Email ao comprador ======
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
    // - Agora também lista TODOS os produtos do payload (principal + content.products[])
    if (HOTMART_DISCOVER_UCODE) {
      if (event && DISCOVER_ONLY_EVENTS.size > 0 && !DISCOVER_ONLY_EVENTS.has(event)) {
        console.log("[DISCOVER_UCODE] Ignorado por evento:", event);
        return res.status(200).send("OK");
      }

      const mainProduct = extractProductIdentifiers(payload);
      const allUcodes = extractAllProductUcodes(payload, { includePhysical: true });

      console.log("[DISCOVER_UCODE] Capturado:", {
        event,
        transaction,
        buyerEmail,
        mainProduct,
        allProductsUcodes: allUcodes,
      });

      // Auditoria opcional
      try {
        await sendAuditEmail({
          event: `DISCOVER_UCODE:${event || "UNKNOWN"}`,
          buyerEmail,
          productTitle: mainProduct?.name || "(no product name)",
          transaction,
          password: "(n/a)",
          heyzineResult: { info: "Modo descoberta ativo: nenhuma ação Heyzine executada" },
          emailResult: { info: "Modo descoberta ativo: nenhum e-mail enviado ao comprador" },
          extra: { receivedAt, mainProduct, allProductsUcodes: allUcodes },
        });
      } catch (e) {
        console.error("[DISCOVER_UCODE] Falha ao enviar auditoria:", e?.message || e);
      }

      return res.status(200).send("OK");
    }

    // 2) Validação mínima (modo produção normal)
    // ✅ Agora processa uma lista (produto principal + itens content.products[]), ignorando físicos.
    const productUcodes = extractAllProductUcodes(payload, { includePhysical: false });

    console.log(">>> productUcodes (digital)", productUcodes);

    if (!event || !transaction || productUcodes.length === 0) {
      return res.status(400).send("Missing required fields (event/transaction/product.ucode[s])");
    }

    // ✅ Idempotência base por evento + transação (para replays)
    const baseIdempotencyKey = `${event}:${transaction}`;

    // 3) Eventos que criam acesso
    if (isApprovalEvent(event)) {
      // Se o evento já foi processado globalmente e duplicados não são permitidos, pula.
      // OBS: Como agora pode haver múltiplos produtos, controlamos também por produto.
      if (!ALLOW_DUPLICATE_TESTS && processedEvents.has(baseIdempotencyKey)) {
        console.log(`Duplicate approval skipped (base): ${baseIdempotencyKey}`);
        return res.status(200).send("OK");
      }

      // Uma senha por transação (login é o e-mail), serve para todos os flipbooks dessa compra.
      const password = genPassword();

      const heyzineResults = [];
      const unmappedUcodes = [];

      // Processa cada produto digital que esteja mapeado
      for (const ucode of productUcodes) {
        const mapped = PRODUCT_MAP[ucode];
        if (!mapped) {
          unmappedUcodes.push(ucode);
          continue;
        }

        // Idempotência por produto (evita duplicar liberação de um item específico)
        const perProductKey = `${baseIdempotencyKey}:${ucode}`;
        if (!ALLOW_DUPLICATE_TESTS && processedEvents.has(perProductKey)) {
          console.log(`Duplicate approval skipped (product): ${perProductKey}`);
          continue;
        }

        try {
          const r = await heyzineAccessAdd({
            name: mapped.name,
            user: buyerEmail,
            password,
          });
          heyzineResults.push({ ucode, ok: true, name: mapped.name, result: r });
          processedEvents.add(perProductKey);
        } catch (e) {
          console.error("Heyzine access-add failed:", e?.message || e);

          // Auditoria e 500 para permitir retry do webhook (falha relevante)
          await sendAuditEmail({
            event,
            buyerEmail,
            productTitle: mapped.title || mapped.name,
            transaction,
            password,
            heyzineResult: { ucode, error: e?.message || String(e) },
            emailResult: { info: "não enviado (heyzine falhou)" },
            extra: {
              receivedAt,
              baseIdempotencyKey,
              productUcodes,
              failingUcode: ucode,
              unmappedUcodes,
            },
          }).catch(() => {});

          return res.status(500).send("Heyzine error");
        }
      }

      // Marca o base como processado (se ao menos tentou/fez algo)
      processedEvents.add(baseIdempotencyKey);

      // Envio do email (ao comprador) — se falhar, não derruba o webhook
      // ✅ Se houver múltiplos livros, envia um e-mail só com lista de links.
      let emailResult = null;
      try {
        const granted = heyzineResults.filter((x) => x.ok);
        if (granted.length > 0) {
          const books = granted
            .map((x) => {
              const mapped = PRODUCT_MAP[x.ucode];
              return {
                title: mapped?.title || mapped?.name || x.ucode,
                url: mapped?.url || "(sem url)",
              };
            })
            .filter((b) => b.url && b.url !== "(sem url)");

          if (books.length === 1) {
            // mantém o e-mail padrão (compatível)
            emailResult = await sendAccessEmail({
              to: buyerEmail,
              bookTitle: books[0].title,
              flipbookUrl: books[0].url,
              password,
            });
          } else {
            // e-mail agregado (1 compra -> vários acessos)
            const subject = `Acesso liberado: ${books.length} itens`;
            const text = `Seu acesso foi liberado ✅

Login: ${buyerEmail}
Senha: ${password}

Itens liberados:
${books.map((b, i) => `${i + 1}) ${b.title}\n   ${b.url}`).join("\n\n")}

Suporte: ${SUPPORT_EMAIL}
`;
            const html = `
              <div style="font-family: Arial, sans-serif; line-height: 1.5">
                <h2>Seu acesso foi liberado ✅</h2>
                <p><strong>Login:</strong> ${buyerEmail}<br/>
                   <strong>Senha:</strong> ${password}</p>
                <h3>Itens liberados</h3>
                <ol>
                  ${books
                    .map(
                      (b) =>
                        `<li><strong>${b.title}</strong><br/><a href="${b.url}">${b.url}</a></li>`
                    )
                    .join("")}
                </ol>
                <p style="margin-top:16px">
                  Se houver qualquer problema, responda este e-mail ou fale com: ${SUPPORT_EMAIL}.
                </p>
              </div>`;

            const msg = { to: buyerEmail, from: EMAIL_FROM, subject, text, html };
            const [resp] = await sgMail.send(msg);
            emailResult = { statusCode: resp.statusCode };
          }

          console.log("Email sent:", emailResult);
        } else {
          emailResult = { info: "nenhum produto mapeado/liberado; e-mail não enviado" };
          console.log("Email skipped:", emailResult);
        }
      } catch (e) {
        emailResult = { error: e?.message || String(e) };
        console.error("Email send failed:", e?.message || e);
      }

      // Auditoria
      const titlesGranted = heyzineResults
        .filter((x) => x.ok)
        .map((x) => PRODUCT_MAP[x.ucode]?.title || PRODUCT_MAP[x.ucode]?.name || x.ucode);

      await sendAuditEmail({
        event,
        buyerEmail,
        productTitle:
          titlesGranted.length > 0
            ? `Itens liberados (${titlesGranted.length}): ${titlesGranted.join(" | ")}`
            : "(nenhum item liberado)",
        transaction,
        password,
        heyzineResult: { heyzineResults, unmappedUcodes },
        emailResult,
        extra: { receivedAt, baseIdempotencyKey, productUcodes },
      }).catch(() => {});

      console.log(
        `Access granted: ${buyerEmail} -> ${heyzineResults
          .filter((x) => x.ok)
          .map((x) => x.name)
          .join(", ")} (${transaction})`
      );

      // Mesmo que tenha unmapped, não falha o webhook
      if (unmappedUcodes.length > 0) {
        console.log("Unmapped product ucode(s):", unmappedUcodes);
      }

      return res.status(200).send("OK");
    }

    // 4) Eventos que revogam acesso
    if (isRevokeEvent(event)) {
      if (!ALLOW_DUPLICATE_TESTS && processedEvents.has(baseIdempotencyKey)) {
        console.log(`Duplicate revoke skipped (base): ${baseIdempotencyKey}`);
        return res.status(200).send("OK");
      }

      const revokeResults = [];
      const unmappedUcodes = [];

      for (const ucode of productUcodes) {
        const mapped = PRODUCT_MAP[ucode];
        if (!mapped) {
          unmappedUcodes.push(ucode);
          continue;
        }

        const perProductKey = `${baseIdempotencyKey}:${ucode}`;
        if (!ALLOW_DUPLICATE_TESTS && processedEvents.has(perProductKey)) {
          console.log(`Duplicate revoke skipped (product): ${perProductKey}`);
          continue;
        }

        try {
          const r = await heyzineAccessRemove({
            name: mapped.name,
            user: buyerEmail,
          });
          revokeResults.push({ ucode, ok: true, name: mapped.name, result: r });
          processedEvents.add(perProductKey);
        } catch (e) {
          console.error("Heyzine access-remove failed:", e?.message || e);

          await sendAuditEmail({
            event,
            buyerEmail,
            productTitle: mapped.title || mapped.name,
            transaction,
            password: "(n/a)",
            heyzineResult: { ucode, error: e?.message || String(e) },
            emailResult: { info: "revogação falhou (heyzine)" },
            extra: { receivedAt, baseIdempotencyKey, productUcodes, failingUcode: ucode },
          }).catch(() => {});

          return res.status(500).send("Heyzine error");
        }
      }

      processedEvents.add(baseIdempotencyKey);

      await sendAuditEmail({
        event,
        buyerEmail,
        productTitle: `Revogação concluída (${revokeResults.length})`,
        transaction,
        password: "(n/a)",
        heyzineResult: { revokeResults, unmappedUcodes },
        emailResult: { info: "revogação de acesso (sem envio ao comprador)" },
        extra: { receivedAt, baseIdempotencyKey, productUcodes },
      }).catch(() => {});

      console.log(
        `Access revoked: ${buyerEmail} -> ${revokeResults
          .filter((x) => x.ok)
          .map((x) => x.name)
          .join(", ")} (${transaction})`
      );

      if (unmappedUcodes.length > 0) {
        console.log("Unmapped product ucode(s):", unmappedUcodes);
      }

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
