require('dotenv').config();
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { OpenAI } = require('openai');
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIGURAÃÃO EXPRESS (exibe QR code no navegador)
// ============================================================
const app = express();
const PORT = process.env.PORT || 3000;

let qrCodeAtual = null;
let botPronto = false;
let ultimasMensagens = []; // debug: Ãºltimas 20 mensagens recebidas
let ultimosErros = [];     // debug: Ãºltimos 5 erros
let ultimoPollInfo = null; // debug: resultado do Ãºltimo poll

// Endpoint de debug â mostra o que o bot recebeu
app.get('/debug', (req, res) => {
  res.json({
    status: botPronto ? 'online' : 'offline',
    uptime_segundos: Math.round(process.uptime()),
    ultima_verificacao: new Date().toISOString(),
    ultimo_poll: ultimoPollInfo,
    ultimas_mensagens: ultimasMensagens,
    ultimos_erros: ultimosErros,
  });
});

app.get('/', async (req, res) => {
  if (botPronto) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h1>â Bot WhatsApp estÃ¡ online!</h1>
        <p>O bot estÃ¡ conectado e funcionando normalmente.</p>
      </body></html>
    `);
  }
  if (qrCodeAtual) {
    const qrImagem = await qrcode.toDataURL(qrCodeAtual);
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h1>ð± Escaneie o QR Code com seu WhatsApp</h1>
        <p>Abra o WhatsApp â <b>Aparelhos conectados</b> â <b>Conectar aparelho</b></p>
        <img src="${qrImagem}" style="width:280px;border:1px solid #ccc;border-radius:8px"/>
        <p><small>Se o QR expirar, recarregue a pÃ¡gina.</small></p>
        <meta http-equiv="refresh" content="30">
      </body></html>
    `);
  }
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h1>â³ Inicializando bot...</h1>
      <p>Aguarde alguns segundos e recarregue.</p>
      <meta http-equiv="refresh" content="3">
    </body></html>
  `);
});

app.listen(PORT, () => console.log(`ð Servidor rodando na porta ${PORT}`));

// ============================================================
// CLIENTE WHATSAPP
// ============================================================
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
    ],
  },
});

client.on('qr', (qr) => {
  qrCodeAtual = qr;
  qrcodeTerminal.generate(qr, { small: true });
  console.log('ð± QR Code gerado! Acesse a URL do bot para escanear.');
});

client.on('ready', () => {
  botPronto = true;
  qrCodeAtual = null;
  console.log('â Bot WhatsApp conectado e pronto!');
});

client.on('disconnected', (reason) => {
  botPronto = false;
  console.log('â ï¸ Bot desconectado:', reason);
});

// ============================================================
// HANDLER DE MENSAGENS â escuta apenas o grupo configurado
// ============================================================
async function processarMensagem(msg) {
  try {
    let texto = '';

    if (msg.type === 'ptt' || msg.type === 'audio') {
      console.log('ð¤ Ãudio recebido, transcrevendo...');
      await msg.reply('ð¤ Recebi seu Ã¡udio! Transcrevendo...');
      texto = await transcreverAudio(msg);
      if (!texto) {
        await msg.reply('â NÃ£o consegui transcrever o Ã¡udio. Tente novamente.');
        return;
      }
      console.log(`ð TranscriÃ§Ã£o: ${texto}`);
      await msg.reply(`ð *TranscriÃ§Ã£o:* ${texto}\n\nâ³ Processando...`);

    } else if (msg.type === 'chat' && msg.body?.trim()) {
      texto = msg.body.trim();

    } else {
      return;
    }

    const dados = await classificarEExtrair(texto);
    console.log('ð¤ ClassificaÃ§Ã£o:', JSON.stringify(dados));

    if (dados.tipo === 'compromisso') {
      await msg.reply('ð Criando evento no Google Agenda...');
      await criarEventoGoogle(dados);
      await msg.reply(
        `â *Compromisso criado!*\n\n` +
        `ð *${dados.titulo}*\n` +
        `ð ${formatarDataHora(dados.data_hora)}\n` +
        `â± DuraÃ§Ã£o: ${dados.duracao_minutos || 60} min\n` +
        `ð ${dados.local || 'Sem local definido'}\n` +
        `ð ${dados.descricao || ''}`
      );

    } else if (dados.tipo === 'tarefa') {
      await msg.reply('ð Criando card no Trello...');
      await criarCardTrello(dados);
      await msg.reply(
        `â *Tarefa criada no Trello!*\n\n` +
        `ð *${dados.titulo}*\n` +
        `ð´ Prioridade: ${dados.prioridade || 'mÃ©dia'}\n\n` +
        `ð¡ *SugestÃ£o de resoluÃ§Ã£o:*\n${dados.sugestao_resolucao}`
      );

    } else {
      await msg.reply(
        `ð¤ NÃ£o identifiquei como compromisso ou tarefa.\n\n` +
        `Tente ser mais especÃ­fico! Exemplos:\n` +
        `â¢ _"ReuniÃ£o com JoÃ£o amanhÃ£ Ã s 15h no escritÃ³rio"_\n` +
        `â¢ _"Preciso corrigir o bug de login no sistema"_`
      );
    }

  } catch (error) {
    console.error('â Erro ao processar mensagem:', error.message);
    const errEntry = { hora: new Date().toISOString(), erro: error.message };
    ultimosErros.unshift(errEntry);
    if (ultimosErros.length > 5) ultimosErros.pop();
    try {
      await msg.reply('â Ocorreu um erro interno: ' + error.message);
    } catch (e2) {
      console.error('â Falha ao enviar mensagem de erro:', e2.message);
    }
  }
}

// Prefixos das respostas do bot â evita reprocessar
const BOT_PREFIXES = ['ð¤', 'ð', 'ð', 'ð', 'â', 'ð¤', 'â', 'â³'];

// IDs de mensagens jÃ¡ processadas (evita duplicatas)
const processadas = new Set();

// POLLING: verifica mensagens novas no grupo a cada 5 segundos
// (substitui eventos que nÃ£o funcionam no ambiente Railway/Puppeteer)
let ultimoTimestamp = Math.floor(Date.now() / 1000); // segundos Unix

async function verificarMensagensNovas() {
  if (!botPronto) return;

  const nomeGrupo = process.env.WHATSAPP_GROUP;
  if (!nomeGrupo) return;

  try {
    const chats = await client.getChats();
    const grupos = chats.filter(c => c.isGroup).map(c => c.name);
    const grupo = chats.find(c => c.isGroup && c.name === nomeGrupo);

    ultimoPollInfo = {
      hora: new Date().toISOString(),
      total_chats: chats.length,
      grupos_encontrados: grupos,
      grupo_alvo: nomeGrupo,
      grupo_achou: !!grupo,
      ultimo_timestamp: ultimoTimestamp,
    };

    if (!grupo) {
      console.log('â ï¸ Grupo nÃ£o encontrado. Grupos disponÃ­veis:', grupos.join(', '));
      return;
    }

    const msgs = await grupo.fetchMessages({ limit: 10 });
    ultimoPollInfo.msgs_buscadas = msgs.length;
    ultimoPollInfo.timestamps_msgs = msgs.map(m => m.timestamp);

    for (const msg of msgs) {
      const msgId = msg.id._serialized;

      // SÃ³ mensagens mais novas que o Ãºltimo check
      if (msg.timestamp <= ultimoTimestamp) continue;
      // NÃ£o reprocessar
      if (processadas.has(msgId)) continue;

      processadas.add(msgId);

      // Limpar set antigo (manter sÃ³ os Ãºltimos 200)
      if (processadas.size > 200) {
        const [primeiro] = processadas;
        processadas.delete(primeiro);
      }

      // Ignorar respostas do prÃ³prio bot
      if (BOT_PREFIXES.some(p => msg.body?.startsWith(p))) continue;

      const debugEntry = {
        evento: 'poll',
        hora: new Date().toISOString(),
        fromMe: msg.fromMe,
        type: msg.type,
        body: msg.body?.substring(0, 80),
        author: msg.author,
      };
      ultimasMensagens.unshift(debugEntry);
      if (ultimasMensagens.length > 20) ultimasMensagens.pop();
      console.log('ð¨ poll:', JSON.stringify(debugEntry));

      await processarMensagem(msg);
    }

    ultimoTimestamp = Math.floor(Date.now() / 1000);
  } catch (err) {
    console.error('â Erro no polling:', err.message);
  }
}

// Inicia polling 10s apÃ³s o bot conectar (espera estabilizar)
client.on('ready', () => {
  setTimeout(() => {
    console.log('ð Iniciando polling de mensagens...');
    setInterval(verificarMensagensNovas, 5000);
  }, 10000);
});

client.initialize();

// ============================================================
// OPENAI â TRANSCRIÃÃO DE ÃUDIO
// ============================================================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function transcreverAudio(msg) {
  try {
    const media = await msg.downloadMedia();
    if (!media) return null;

    const buffer = Buffer.from(media.data, 'base64');
    const tmpPath = path.join('/tmp', `audio_${Date.now()}.ogg`);
    fs.writeFileSync(tmpPath, buffer);

    const transcricao = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
      language: 'pt',
    });

    fs.unlinkSync(tmpPath);
    return transcricao.text;
  } catch (err) {
    console.error('Erro na transcriÃ§Ã£o:', err.message);
    return null;
  }
}

// ============================================================
// OPENAI â CLASSIFICAÃÃO E EXTRAÃÃO DE DADOS
// ============================================================
async function classificarEExtrair(texto) {
  const agora = new Date().toLocaleString('pt-BR', {
    timeZone: process.env.TIMEZONE || 'America/Sao_Paulo',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const prompt = `Hoje Ã© ${agora}. Analise o texto abaixo e responda APENAS com JSON vÃ¡lido, sem markdown.

Texto: "${texto}"

REGRAS:
- Se for compromisso/evento/reuniÃ£o/consulta â tipo "compromisso"
- Se for tarefa/problema/bug/pendÃªncia â tipo "tarefa"
- Se nÃ£o identificar claramente â tipo "indefinido"

Para COMPROMISSO, retorne:
{
  "tipo": "compromisso",
  "titulo": "tÃ­tulo curto e claro do evento",
  "data_hora": "ISO 8601 com timezone, ex: 2024-03-25T14:00:00-03:00",
  "duracao_minutos": 60,
  "local": "local ou null",
  "descricao": "detalhes extras ou null"
}

Para TAREFA, retorne:
{
  "tipo": "tarefa",
  "titulo": "tÃ­tulo curto da tarefa",
  "descricao_problema": "descriÃ§Ã£o clara do problema",
  "sugestao_resolucao": "sugestÃ£o prÃ¡tica e detalhada de como resolver",
  "prioridade": "alta ou media ou baixa",
  "data_entrega": "ISO 8601 ou null"
}

Para INDEFINIDO, retorne:
{ "tipo": "indefinido" }`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.2,
  });

  return JSON.parse(response.choices[0].message.content);
}

// ============================================================
// GOOGLE CALENDAR
// ============================================================
function getGoogleAuth() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = 'http://localhost';

  const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  // Token salvo como variÃ¡vel de ambiente (JSON em string)
  const tokenJson = process.env.GOOGLE_TOKEN;
  if (!tokenJson) throw new Error('GOOGLE_TOKEN nÃ£o configurado. Rode: npm run auth');

  auth.setCredentials(JSON.parse(tokenJson));

  // Atualiza token automaticamente quando expirar
  auth.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      console.log('ð Token do Google atualizado.');
    }
  });

  return auth;
}

async function criarEventoGoogle(dados) {
  const auth = getGoogleAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const inicio = new Date(dados.data_hora);
  const duracao = (dados.duracao_minutos || 60) * 60 * 1000;
  const fim = new Date(inicio.getTime() + duracao);
  const tz = process.env.TIMEZONE || 'America/Sao_Paulo';

  const evento = {
    summary: dados.titulo,
    location: dados.local || '',
    description: dados.descricao || '',
    start: { dateTime: inicio.toISOString(), timeZone: tz },
    end: { dateTime: fim.toISOString(), timeZone: tz },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 30 },
        { method: 'popup', minutes: 10 },
      ],
    },
  };

  const result = await calendar.events.insert({ calendarId: 'primary', resource: evento });
  console.log('ð Evento criado:', result.data.htmlLink);
  return result.data;
}

// ============================================================
// TRELLO
// ============================================================
async function obterIdListaPendente() {
  const url = `https://api.trello.com/1/boards/${process.env.TRELLO_BOARD_ID}/lists`;
  const res = await axios.get(url, {
    params: {
      key: process.env.TRELLO_API_KEY,
      token: process.env.TRELLO_TOKEN,
    },
  });

  const lista = res.data.find((l) =>
    l.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes('pendente')
  );
  return lista ? lista.id : res.data[0].id;
}

async function criarCardTrello(dados) {
  const listaId = await obterIdListaPendente();

  const coresPrioridade = { alta: 'red', media: 'yellow', baixa: 'green' };
  const cor = coresPrioridade[dados.prioridade] || 'yellow';

  const descricao =
    `## ð Problema\n${dados.descricao_problema}\n\n` +
    `## ð¡ SugestÃ£o de ResoluÃ§Ã£o\n${dados.sugestao_resolucao}`;

  // Cria o card
  const resCard = await axios.post('https://api.trello.com/1/cards', null, {
    params: {
      key: process.env.TRELLO_API_KEY,
      token: process.env.TRELLO_TOKEN,
      idList: listaId,
      name: dados.titulo,
      desc: descricao,
      due: dados.data_entrega || null,
    },
  });

  const cardId = resCard.data.id;
  console.log('ð Card criado:', resCard.data.shortUrl);

  // Adiciona label de prioridade
  try {
    await axios.post(`https://api.trello.com/1/cards/${cardId}/labels`, null, {
      params: {
        key: process.env.TRELLO_API_KEY,
        token: process.env.TRELLO_TOKEN,
        color: cor,
        name: `Prioridade ${dados.prioridade || 'mÃ©dia'}`,
      },
    });
  } catch (_) { /* label Ã© opcional */ }

  return resCard.data;
}

// ============================================================
// HELPERS
// ============================================================
function formatarDataHora(isoString) {
  try {
    return new Date(isoString).toLocaleString('pt-BR', {
      timeZone: process.env.TIMEZONE || 'America/Sao_Paulo',
      weekday: 'long', day: '2-digit', month: 'long',
      year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch (_) {
    return isoString;
  }
}
