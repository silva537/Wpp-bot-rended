const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const express = require("express");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

// === CONFIGURAÇÕES EDITÁVEIS ===
const NUMERO_BOT = "5521965261365"; // Número do WhatsApp do bot (DDI + DDD + Número)
const MAX_USUARIOS = 20;
const LINK_DESTINO = "https://exemplo.com/seu-link";
const MENSAGEM_INFO =
  "Olá! Segue o link e as informações combinadas:\n" +
  "Aqui você coloca a breve informação que quiser.\n\n" +
  `Acesse: ${LINK_DESTINO}`;
// ===============================

const ARQUIVO_NUMEROS = path.join(__dirname, "numeros_salvos.json");
const PASTA_SESSAO = path.join(__dirname, "auth_info");

let codigoPareamento = null;
let statusBot = "iniciando";

function carregarNumeros() {
  if (!fs.existsSync(ARQUIVO_NUMEROS)) {
    fs.writeFileSync(ARQUIVO_NUMEROS, JSON.stringify([], null, 2));
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(ARQUIVO_NUMEROS, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function salvarNumero(numeroLimpo, jid) {
  const lista = carregarNumeros();
  const jaExiste = lista.some((item) => item.numero === numeroLimpo);

  if (jaExiste) {
    return { ok: false, motivo: "ja_registrado", total: lista.length };
  }

  if (lista.length >= MAX_USUARIOS) {
    return { ok: false, motivo: "limite_atingido", total: lista.length };
  }

  lista.push({
    numero: numeroLimpo,
    jid,
    registradoEm: new Date().toISOString()
  });

  fs.writeFileSync(ARQUIVO_NUMEROS, JSON.stringify(lista, null, 2));
  return { ok: true, total: lista.length };
}

function extrairNumero(jid) {
  if (!jid) return "";
  return jid.split("@")[0].split(":")[0].replace(/\D/g, "");
}

// Servidor HTTP para o Render e exibição do código de pareamento
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  const registrados = carregarNumeros();

  if (statusBot === "conectado") {
    return res.send(`
      <h2>Bot WhatsApp Online</h2>
      <p>Status: <b>Conectado</b></p>
      <p>Contatos armazenados: <b>${registrados.length} / ${MAX_USUARIOS}</b></p>
    `);
  }

  if (codigoPareamento) {
    return res.send(`
      <h2>Código de Pareamento WhatsApp</h2>
      <p>No seu celular, abra: <b>WhatsApp &gt; Aparelhos conectados &gt; Conectar aparelho &gt; Conectar com número de telefone</b></p>
      <div style="font-size:32px;font-weight:bold;letter-spacing:4px;padding:16px;background:#f0f0f0;display:inline-block;border-radius:8px;">
        ${codigoPareamento}
      </div>
      <p><small>Número configurado: +${NUMERO_BOT}</small></p>
    `);
  }

  return res.send(`
    <h2>Bot WhatsApp</h2>
    <p>Status atual: <b>${statusBot}</b>. Aguarde alguns segundos e atualize a página.</p>
  `);
});

app.listen(PORT, () => {
  console.log(`Servidor HTTP rodando na porta ${PORT}`);
});

async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState(PASTA_SESSAO);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    auth: state,
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"]
  });

  sock.ev.on("creds.update", saveCreds);

  // Solicita o código de pareamento se ainda não estiver registrado
  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(NUMERO_BOT);
        const formatado = code?.match(/.{1,4}/g)?.join("-") || code;
        codigoPareamento = formatado;
        statusBot = "aguardando_codigo";
        console.log("\n==========================================");
        console.log(`SEU CÓDIGO DE PAREAMENTO: ${formatado}`);
        console.log("==========================================\n");
      } catch (err) {
        console.error("Erro ao gerar código de pareamento:", err);
      }
    }, 3000);
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      codigoPareamento = null;
      statusBot = "conectado";
      console.log("WhatsApp conectado com sucesso!");
    }

    if (connection === "close") {
      statusBot = "desconectado";
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const deveReconectar = statusCode !== DisconnectReason.loggedOut;

      console.log("Conexão encerrada. Reconectar:", deveReconectar);
      if (deveReconectar) {
        setTimeout(() => iniciarBot(), 3000);
      } else {
        console.log("Sessão desconectada (loggedOut). Apague auth_info e reinicie.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") {
        continue;
      }

      const numero = extrairNumero(remoteJid);
      if (!numero) continue;

      const resultado = salvarNumero(numero, remoteJid);

      if (resultado.ok) {
        await sock.sendMessage(remoteJid, { text: MENSAGEM_INFO });
        console.log(`Enviado para ${numero} (${resultado.total}/${MAX_USUARIOS})`);
      } else if (resultado.motivo === "ja_registrado") {
        console.log(`Número ${numero} já estava registrado.`);
      } else if (resultado.motivo === "limite_atingido") {
        console.log(`Limite de ${MAX_USUARIOS} pessoas atingido. Número ${numero} não adicionado.`);
      }
    }
  });
}

iniciarBot().catch((err) => {
  console.error("Erro fatal ao iniciar o bot:", err);
});
