import express from "express";

const app = express();
app.use(express.json());

// Healthcheck
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

// Webhook Hotmart
app.post("/webhooks/hotmart", (req, res) => {
  console.log("Hotmart webhook recebido:");
  console.log(JSON.stringify(req.body, null, 2));

  res.status(200).send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
