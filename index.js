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

const app = express();
const PORT = process.env.PORT || 3000;

let qrCodeAtual = null;
let botPronto = false;
let ultimasMensagens = [];
let ultimosErros = [];

app.get('/debug', (req, res) => {
  res.json({
    status: botPronto ? 'online' : 'offline',
    uptime_segundos: Math.round(process.uptime()),
    ultima_verificacao: new Date().toISOString(),
    ultimas_mensagens: ultimasMensagens,
    ultimos_erros: ultimosErros,
  });
});

app.get('/', async (req, res) => {
  if (botPronto) {
    return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h1>Bot WhatsApp esta online!</h1><p>O bot esta conectado e funcionando normalmente.</p></body></html>');
  }
  if (qrCodeAtual) {
    const qrImagem = await qrcode.toDataURL(qrCodeAtual);
    return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h1>Escaneie o QR Code</h1><img src="' + qrImagem + '" style="width:280px"/><meta http-equiv="refresh" content="30"></body></html>');
  }
  res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h1>Inicializando bot...</h1><meta http-equiv="refresh" content="3"></body></html>');
});

app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-accelerated-2d-canvas','--no-first-run','--no-zygote','--single-process','--disable-gpu'],
  },
});

client.on('qr', (qr) => {
  qrCodeAtual = qr;
  qrcodeTerminal.generate(qr, { small: true });
  console.log('QR Code gerado! Acesse a URL do bot para escanear.');
});

client.on('ready', () => {
  botPronto = true;
  qrCodeAtual = null;
  console.log('Bot WhatsApp conectado e pronto!');
});

client.on('disconnected', (reason) => {
  botPronto = false;
  console.log('Bot desconectado:', reason);
});

const BOT_PREFIXES = ['Audio recebido', 'Transcricao', 'Criando evento', 'Criando card', 'Compromisso criado', 'Tarefa criada', 'Nao identifiquei', 'Ocorreu um erro', 'Recebi seu'];

client.on('message_create', async (msg) => {
  const debugEntry = {
    hora: new Date().toISOString(),
    fromMe: msg.fromMe,
    type: msg.type,
    body: msg.body ? msg.body.substring(0, 80) : null,
    from: msg.from,
  };
  ultimasMensagens.unshift(debugEntry);
  if (ultimasMensagens.length > 20) ultimasMensagens.pop();
  console.log('message_create: fromMe=' + msg.fromMe + ' type=' + msg.type + ' body=' + (msg.body || '').substring(0, 50));

  if (!msg.fromMe) return;
  if (BOT_PREFIXES.some(p => msg.body && msg.body.startsWith(p))) return;
  if (msg.from && msg.from.endsWith('@g.us')) return;

  try {
    let texto = '';

    if (msg.type === 'ptt' || msg.type === 'audio') {
      console.log('Audio recebido, transcrevendo...');
      await client.sendMessage(msg.from, 'Audio recebido! Transcrevendo...');
      texto = await transcreverAudio(msg);
      if (!texto) {
        await client.sendMessage(msg.from, 'Nao consegui transcrever o audio. Tente novamente.');
        return;
      }
      console.log('Transcricao: ' + texto);
      await client.sendMessage(msg.from, 'Transcricao: ' + texto + '\n\nProcessando...');
    } else if (msg.type === 'chat' && msg.body && msg.body.trim()) {
      texto = msg.body.trim();
    } else {
      return;
    }

    const dados = await classificarEExtrair(texto);
    console.log('Classificacao: ' + JSON.stringify(dados));

    if (dados.tipo === 'compromisso') {
      await client.sendMessage(msg.from, 'Criando evento no Google Agenda...');
      await criarEventoGoogle(dados);
      await client.sendMessage(msg.from, 'Compromisso criado!\n' + dados.titulo + '\n' + formatarDataHora(dados.data_hora));
    } else if (dados.tipo === 'tarefa') {
      await client.sendMessage(msg.from, 'Criando card no Trello...');
      await criarCardTrello(dados);
      await client.sendMessage(msg.from, 'Tarefa criada no Trello!\n' + dados.titulo + '\nSugestao: ' + dados.sugestao_resolucao);
    } else {
      await client.sendMessage(msg.from, 'Nao identifiquei como compromisso ou tarefa. Tente: "Reuniao com Joao amanha as 15h" ou "Preciso corrigir o bug de login"');
    }

  } catch (error) {
    console.error('Erro ao processar mensagem: ' + error.message);
    const errEntry = { hora: new Date().toISOString(), erro: error.message };
    ultimosErros.unshift(errEntry);
    if (ultimosErros.length > 5) ultimosErros.pop();
    try {
      await client.sendMessage(msg.from, 'Ocorreu um erro interno: ' + error.message);
    } catch (e2) {
      console.error('Falha ao enviar mensagem de erro: ' + e2.message);
    }
  }
});

client.initialize();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function transcreverAudio(msg) {
  try {
    const media = await msg.downloadMedia();
    if (!media) return null;
    const buffer = Buffer.from(media.data, 'base64');
    const tmpPath = path.join('/tmp', 'audio_' + Date.now() + '.ogg');
    fs.writeFileSync(tmpPath, buffer);
    const transcricao = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
      language: 'pt',
    });
    fs.unlinkSync(tmpPath);
    return transcricao.text;
  } catch (err) {
    console.error('Erro na transcricao: ' + err.message);
    return null;
  }
}

async function classificarEExtrair(texto) {
  const agora = new Date().toLocaleString('pt-BR', {
    timeZone: process.env.TIMEZONE || 'America/Sao_Paulo',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const prompt = 'Hoje eh ' + agora + '. Analise o texto abaixo e responda APENAS com JSON valido, sem markdown.\n\nTexto: "' + texto + '"\n\nREGRAS:\n- Se for compromisso/evento/reuniao/consulta -> tipo "compromisso"\n- Se for tarefa/problema/bug/pendencia -> tipo "tarefa"\n- Se nao identificar claramente -> tipo "indefinido"\n\nPara COMPROMISSO, retorne:\n{\n  "tipo": "compromisso",\n  "titulo": "titulo curto e claro do evento",\n  "data_hora": "ISO 8601 com timezone, ex: 2024-03-25T14:00:00-03:00",\n  "duracao_minutos": 60,\n  "local": "local ou null",\n  "descricao": "detalhes extras ou null"\n}\n\nPara TAREFA, retorne:\n{\n  "tipo": "tarefa",\n  "titulo": "titulo curto da tarefa",\n  "descricao_problema": "descricao clara do problema",\n  "sugestao_resolucao": "sugestao pratica e detalhada de como resolver",\n  "prioridade": "alta ou media ou baixa",\n  "data_entrega": "ISO 8601 ou null"\n}\n\nPara INDEFINIDO, retorne:\n{ "tipo": "indefinido" }';

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.2,
  });

  return JSON.parse(response.choices[0].message.content);
}

function getGoogleAuth() {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, 'http://localhost');
  const tokenJson = process.env.GOOGLE_TOKEN;
  if (!tokenJson) throw new Error('GOOGLE_TOKEN nao configurado');
  auth.setCredentials(JSON.parse(tokenJson));
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
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }, { method: 'popup', minutes: 10 }] },
  };
  const result = await calendar.events.insert({ calendarId: 'primary', resource: evento });
  console.log('Evento criado: ' + result.data.htmlLink);
  return result.data;
}

async function obterIdListaPendente() {
  const res = await axios.get('https://api.trello.com/1/boards/' + process.env.TRELLO_BOARD_ID + '/lists', {
    params: { key: process.env.TRELLO_API_KEY, token: process.env.TRELLO_TOKEN },
  });
  const lista = res.data.find(l => l.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes('pendente'));
  return lista ? lista.id : res.data[0].id;
}

async function criarCardTrello(dados) {
  const listaId = await obterIdListaPendente();
  const coresPrioridade = { alta: 'red', media: 'yellow', baixa: 'green' };
  const cor = coresPrioridade[dados.prioridade] || 'yellow';
  const descricao = '## Problema\n' + dados.descricao_problema + '\n\n## Sugestao de Resolucao\n' + dados.sugestao_resolucao;
  const resCard = await axios.post('https://api.trello.com/1/cards', null, {
    params: { key: process.env.TRELLO_API_KEY, token: process.env.TRELLO_TOKEN, idList: listaId, name: dados.titulo, desc: descricao, due: dados.data_entrega || null },
  });
  const cardId = resCard.data.id;
  console.log('Card criado: ' + resCard.data.shortUrl);
  try {
    await axios.post('https://api.trello.com/1/cards/' + cardId + '/labels', null, {
      params: { key: process.env.TRELLO_API_KEY, token: process.env.TRELLO_TOKEN, color: cor, name: 'Prioridade ' + (dados.prioridade || 'media') },
    });
  } catch (_) {}
  return resCard.data;
}

function formatarDataHora(isoString) {
  try {
    return new Date(isoString).toLocaleString('pt-BR', {
      timeZone: process.env.TIMEZONE || 'America/Sao_Paulo',
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch (_) { return isoString; }
}
