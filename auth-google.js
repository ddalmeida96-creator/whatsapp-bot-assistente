/**
 * auth-google.js
 * Execute UMA VEZ localmente para gerar o token do Google Calendar.
 * Comando: npm run auth
 *
 * O script vai:
 * 1. Abrir o navegador automaticamente
 * 2. Você faz login e autoriza
 * 3. O token é salvo sozinho — sem precisar copiar nada!
 */

require('dotenv').config();
const { google } = require('googleapis');
const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const REDIRECT_URI = 'http://localhost:8080';

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('❌ Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no arquivo .env!');
    process.exit(1);
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = auth.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\n==========================================================');
  console.log('🌐 Abrindo o navegador para autorizar o Google Calendar...');
  console.log('==========================================================\n');

  // Abre o navegador automaticamente no Mac
  exec(`open "${authUrl}"`);

  // Inicia servidor local para capturar o código de retorno
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, REDIRECT_URI);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <html><body style="font-family:sans-serif;text-align:center;padding:40px">
          <h1>❌ Erro: ${error}</h1>
          <p>Feche esta aba e tente novamente.</p>
        </body></html>
      `);
      server.close();
      process.exit(1);
    }

    if (!code) return;

    try {
      const { tokens } = await auth.getToken(code);

      // Exibe mensagem de sucesso no navegador
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0fff4">
          <h1>✅ Autorizado com sucesso!</h1>
          <p>Pode fechar esta aba e voltar para o Terminal.</p>
        </body></html>
      `);

      // Salva token.json
      fs.writeFileSync('token.json', JSON.stringify(tokens, null, 2));

      console.log('✅ Token gerado com sucesso!\n');
      console.log('==========================================================');
      console.log('COPIE o texto abaixo (vai precisar no Railway):');
      console.log('==========================================================\n');
      console.log(JSON.stringify(tokens));
      console.log('\n==========================================================');
      console.log('Arquivo token.json salvo na pasta do bot.');

      server.close();
    } catch (err) {
      console.error('❌ Erro ao obter token:', err.message);
      res.writeHead(500);
      res.end('Erro ao obter token. Veja o Terminal.');
      server.close();
    }
  });

  server.listen(8080, () => {
    console.log('⏳ Aguardando autorização no navegador...\n');
  });
}

main();
