import express from "express";
import crypto from "crypto";
import { Resend } from "resend";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ====== CONFIG (Railway env vars) ======
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

const EMAIL_FROM = process.env.EMAIL_FROM; // ex: noreply@cronicasdeluthera.com.br
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || EMAIL_FROM;

// Auditoria opcional
const EMAIL_AUDITORIA = process.env.EMAIL_AUDITORIA;

// Segurança Hotmart
const HOTMART_HOTTOK = process.env.HOTMART_HOTTOK;

// API Key Heyzine
const HEYZINE_API_KEY = process.env.HEYZINE_API_KEY;

// Modo descoberta
const HOTMART_DISCOVER_UCODE = process.env.HOTMART_DISCOVER_UCODE === "true";

const DISCOVER_ONLY_EVENTS = new Set([
  "PURCHASE_APPROVED",
]);

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

const ALLOW_DUPLICATE_TESTS = process.env.ALLOW_DUPLICATE_TESTS === "true";

const processedEvents = new Set();

function genPassword() {
  return crypto.randomBytes(9).toString("base64url");
}

function getHotmartHottok(req) {
  return req.get("X-HOTMART-HOTTOK") || req.get("x-hotmart-hottok");
}

function isApprovalEvent(event) {
  return event === "PURCHASE_APPROVED" || event === "PURCHASE_COMPLETE";
}

function isRevokeEvent(event) {
  return (
    event === "PURCHASE_REFUNDED" ||
    event === "PURCHASE_CANCELED" ||
    event === "PURCHASE_CHARGEBACK" ||
    event === "REFUNDED" ||
    event === "CANCELED" ||
    event === "CHARGEBACK"
  );
}

function extractAllProductUcodes(payload, { includePhysical = false } = {}) {
  const out = [];

  const main = payload?.data?.product;
  if (main?.ucode) {
    if (includePhysical || !main?.is_physical_product) {
      out.push(String(main.ucode));
    }
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

  return [...new Set(out.filter(Boolean))];
}

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

// ====== Resend ======
async function sendEmail({ to, subject, text, html }) {
  if (!RESEND_API_KEY || !resend) throw new Error("Missing RESEND_API_KEY");
  if (!EMAIL_FROM) throw new Error("Missing EMAIL_FROM");

  const { data, error } = await resend.emails.send({
    from: EMAIL_FROM,
    to,
    subject,
    text,
    html,
  });

  if (error) {
    throw new Error(error.message || JSON.stringify(error));
  }

  return data;
}

// ====== Email ao comprador ======
async function sendAccessEmail({ to, bookTitle, flipbookUrl, password }) {
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

  return await sendEmail({ to, subject, text, html });
}

// ====== Email de auditoria ======
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

  await sendEmail({
    to: EMAIL_AUDITORIA,
    subject,
    text,
    html: `<pre>${text}</pre>`,
  });
}

// ====== Healthcheck ======
app.get("/", (req, res) => res.status(200).send("OK"));

// ====== Webhook Hotmart ======
app.post("/webhooks/hotmart", async (req, res) => {
  const receivedAt = new Date().toISOString();

  try {
    const incomingHottok = getHotmartHottok(req);

    if (!HOTMART_HOTTOK || incomingHottok !== HOTMART_HOTTOK) {
      return res.status(401).send("Unauthorized");
    }

    const payload = req.body;

    const event = payload?.event;
    const buyerEmail = payload?.data?.buyer?.email || "(no buyer email)";
    const transaction =
      payload?.data?.purchase?.transaction || "(no transaction)";

    console.log(">>> webhook", receivedAt, event, transaction);

    if (HOTMART_DISCOVER_UCODE) {
      if (
        event &&
        DISCOVER_ONLY_EVENTS.size > 0 &&
        !DISCOVER_ONLY_EVENTS.has(event)
      ) {
        console.log("[DISCOVER_UCODE] Ignorado por evento:", event);
        return res.status(200).send("OK");
      }

      const mainProduct = extractProductIdentifiers(payload);
      const allUcodes = extractAllProductUcodes(payload, {
        includePhysical: true,
      });

      console.log("[DISCOVER_UCODE] Capturado:", {
        event,
        transaction,
        buyerEmail,
        mainProduct,
        allProductsUcodes: allUcodes,
      });

      try {
        await sendAuditEmail({
          event: `DISCOVER_UCODE:${event || "UNKNOWN"}`,
          buyerEmail,
          productTitle: mainProduct?.name || "(no product name)",
          transaction,
          password: "(n/a)",
          heyzineResult: {
            info: "Modo descoberta ativo: nenhuma ação Heyzine executada",
          },
          emailResult: {
            info: "Modo descoberta ativo: nenhum e-mail enviado ao comprador",
          },
          extra: { receivedAt, mainProduct, allProductsUcodes: allUcodes },
        });
      } catch (e) {
        console.error(
          "[DISCOVER_UCODE] Falha ao enviar auditoria:",
          e?.message || e
        );
      }

      return res.status(200).send("OK");
    }

    const productUcodes = extractAllProductUcodes(payload, {
      includePhysical: false,
    });

    console.log(">>> productUcodes (digital)", productUcodes);

    if (!event || !transaction || productUcodes.length === 0) {
      return res
        .status(400)
        .send("Missing required fields (event/transaction/product.ucode[s])");
    }

    const baseIdempotencyKey = `${event}:${transaction}`;

    if (isApprovalEvent(event)) {
      if (!ALLOW_DUPLICATE_TESTS && processedEvents.has(baseIdempotencyKey)) {
        console.log(`Duplicate approval skipped (base): ${baseIdempotencyKey}`);
        return res.status(200).send("OK");
      }

      const password = genPassword();

      const heyzineResults = [];
      const unmappedUcodes = [];

      for (const ucode of productUcodes) {
        const mapped = PRODUCT_MAP[ucode];
        if (!mapped) {
          unmappedUcodes.push(ucode);
          continue;
        }

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

          heyzineResults.push({
            ucode,
            ok: true,
            name: mapped.name,
            result: r,
          });

          processedEvents.add(perProductKey);
        } catch (e) {
          console.error("Heyzine access-add failed:", e?.message || e);

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

      processedEvents.add(baseIdempotencyKey);

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
            emailResult = await sendAccessEmail({
              to: buyerEmail,
              bookTitle: books[0].title,
              flipbookUrl: books[0].url,
              password,
            });
          } else {
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

            emailResult = await sendEmail({
              to: buyerEmail,
              subject,
              text,
              html,
            });
          }

          console.log("Email sent:", emailResult);
        } else {
          emailResult = {
            info: "nenhum produto mapeado/liberado; e-mail não enviado",
          };
          console.log("Email skipped:", emailResult);
        }
      } catch (e) {
        emailResult = { error: e?.message || String(e) };
        console.error("Email send failed:", e?.message || e);
      }

      const titlesGranted = heyzineResults
        .filter((x) => x.ok)
        .map(
          (x) =>
            PRODUCT_MAP[x.ucode]?.title ||
            PRODUCT_MAP[x.ucode]?.name ||
            x.ucode
        );

      await sendAuditEmail({
        event,
        buyerEmail,
        productTitle:
          titlesGranted.length > 0
            ? `Itens liberados (${titlesGranted.length}): ${titlesGranted.join(
                " | "
              )}`
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

      if (unmappedUcodes.length > 0) {
        console.log("Unmapped product ucode(s):", unmappedUcodes);
      }

      return res.status(200).send("OK");
    }

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

          revokeResults.push({
            ucode,
            ok: true,
            name: mapped.name,
            result: r,
          });

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
            extra: {
              receivedAt,
              baseIdempotencyKey,
              productUcodes,
              failingUcode: ucode,
            },
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

    return res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook fatal error:", err);
    return res.status(500).send("Internal error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
