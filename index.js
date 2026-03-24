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
// CONFIGURAÇÃO EXPRESS (exibe QR code no navegador)
// ============================================================
const app = express();
const PORT = process.env.PORT || 3000;

let qrCodeAtual = null;
let botPronto = false;

app.get('/', async (req, res) => {
  if (botPronto) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h1>✅ Bot WhatsApp está online!</h1>
        <p>O bot está conectado e funcionando normalmente.</p>
      </body></html>
    `);
  }
  if (qrCodeAtual) {
    const qrImagem = await qrcode.toDataURL(qrCodeAtual);
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h1>📱 Escaneie o QR Code com seu WhatsApp</h1>
        <p>Abra o WhatsApp → <b>Aparelhos conectados</b> → <b>Conectar aparelho</b></p>
        <img src="${qrImagem}" style="width:280px;border:1px solid #ccc;border-radius:8px"/>
        <p><small>Se o QR expirar, recarregue a página.</small></p>
        <meta http-equiv="refresh" content="30">
      </body></html>
    `);
  }
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h1>⏳ Inicializando bot...</h1>
      <p>Aguarde alguns segundos e recarregue.</p>
      <meta http-equiv="refresh" content="3">
    </body></html>
  `);
});

app.listen(PORT, () => console.log(`🌐 Servidor rodando na porta ${PORT}`));

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
  console.log('📱 QR Code gerado! Acesse a URL do bot para escanear.');
});

client.on('ready', () => {
  botPronto = true;
  qrCodeAtual = null;
  console.log('✅ Bot WhatsApp conectado e pronto!');
});

client.on('disconnected', (reason) => {
  botPronto = false;
  console.log('⚠️ Bot desconectado:', reason);
});

// ============================================================
// HANDLER DE MENSAGENS
// ============================================================
client.on('message', async (msg) => {
  // Ignora mensagens de grupos (mude para false se quiser responder em grupos)
  if (msg.isGroupMsg) return;

  try {
    let texto = '';

    // Áudio / mensagem de voz
    if (msg.type === 'ptt' || msg.type === 'audio') {
      console.log('🎤 Áudio recebido, transcrevendo...');
      await msg.reply('🎤 Recebi seu áudio! Transcrevendo...');
      texto = await transcreverAudio(msg);
      if (!texto) {
        await msg.reply('❌ Não consegui transcrever o áudio. Tente novamente.');
        return;
      }
      console.log(`📝 Transcrição: ${texto}`);
      await msg.reply(`📝 *Transcrição:* ${texto}\n\n⏳ Processando...`);

    // Mensagem de texto
    } else if (msg.type === 'chat' && msg.body.trim()) {
      texto = msg.body.trim();

    } else {
      return; // ignora outros tipos (imagem, vídeo, etc.)
    }

    // Classifica e extrai dados
    const dados = await classificarEExtrair(texto);
    console.log('🤖 Classificação:', JSON.stringify(dados));

    if (dados.tipo === 'compromisso') {
      await msg.reply('📅 Criando evento no Google Agenda...');
      await criarEventoGoogle(dados);
      await msg.reply(
        `✅ *Compromisso criado!*\n\n` +
        `📌 *${dados.titulo}*\n` +
        `🗓 ${formatarDataHora(dados.data_hora)}\n` +
        `⏱ Duração: ${dados.duracao_minutos || 60} min\n` +
        `📍 ${dados.local || 'Sem local definido'}\n` +
        `📝 ${dados.descricao || ''}`
      );

    } else if (dados.tipo === 'tarefa') {
      await msg.reply('📋 Criando card no Trello...');
      await criarCardTrello(dados);
      await msg.reply(
        `✅ *Tarefa criada no Trello!*\n\n` +
        `📌 *${dados.titulo}*\n` +
        `🔴 Prioridade: ${dados.prioridade || 'média'}\n\n` +
        `💡 *Sugestão de resolução:*\n${dados.sugestao_resolucao}`
      );

    } else {
      await msg.reply(
        `🤔 Não identifiquei como compromisso ou tarefa.\n\n` +
        `Tente ser mais específico! Exemplos:\n` +
        `• _"Reunião com João amanhã às 15h no escritório"_\n` +
        `• _"Preciso corrigir o bug de login no sistema"_`
      );
    }

  } catch (error) {
    console.error('❌ Erro ao processar mensagem:', error);
    await msg.reply('❌ Ocorreu um erro interno. Tente novamente em alguns segundos.');
  }
});

client.initialize();

// ============================================================
// OPENAI — TRANSCRIÇÃO DE ÁUDIO
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
    console.error('Erro na transcrição:', err.message);
    return null;
  }
}

// ============================================================
// OPENAI — CLASSIFICAÇÃO E EXTRAÇÃO DE DADOS
// ============================================================
async function classificarEExtrair(texto) {
  const agora = new Date().toLocaleString('pt-BR', {
    timeZone: process.env.TIMEZONE || 'America/Sao_Paulo',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const prompt = `Hoje é ${agora}. Analise o texto abaixo e responda APENAS com JSON válido, sem markdown.

Texto: "${texto}"

REGRAS:
- Se for compromisso/evento/reunião/consulta → tipo "compromisso"
- Se for tarefa/problema/bug/pendência → tipo "tarefa"
- Se não identificar claramente → tipo "indefinido"

Para COMPROMISSO, retorne:
{
  "tipo": "compromisso",
  "titulo": "título curto e claro do evento",
  "data_hora": "ISO 8601 com timezone, ex: 2024-03-25T14:00:00-03:00",
  "duracao_minutos": 60,
  "local": "local ou null",
  "descricao": "detalhes extras ou null"
}

Para TAREFA, retorne:
{
  "tipo": "tarefa",
  "titulo": "título curto da tarefa",
  "descricao_problema": "descrição clara do problema",
  "sugestao_resolucao": "sugestão prática e detalhada de como resolver",
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

  // Token salvo como variável de ambiente (JSON em string)
  const tokenJson = process.env.GOOGLE_TOKEN;
  if (!tokenJson) throw new Error('GOOGLE_TOKEN não configurado. Rode: npm run auth');

  auth.setCredentials(JSON.parse(tokenJson));

  // Atualiza token automaticamente quando expirar
  auth.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      console.log('🔄 Token do Google atualizado.');
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
  console.log('📅 Evento criado:', result.data.htmlLink);
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
    `## 🔍 Problema\n${dados.descricao_problema}\n\n` +
    `## 💡 Sugestão de Resolução\n${dados.sugestao_resolucao}`;

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
  console.log('📋 Card criado:', resCard.data.shortUrl);

  // Adiciona label de prioridade
  try {
    await axios.post(`https://api.trello.com/1/cards/${cardId}/labels`, null, {
      params: {
        key: process.env.TRELLO_API_KEY,
        token: process.env.TRELLO_TOKEN,
        color: cor,
        name: `Prioridade ${dados.prioridade || 'média'}`,
      },
    });
  } catch (_) { /* label é opcional */ }

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
