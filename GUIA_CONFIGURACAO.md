# 🤖 Guia de Configuração — WhatsApp Bot Assistente

## O que o bot faz
- Recebe **mensagens de voz** no WhatsApp → transcreve com IA
- Identifica **compromissos** → cria evento no Google Agenda (com lembretes)
- Identifica **tarefas** → cria card no Trello (coluna Pendente, com sugestão de resolução)
- Funciona também com **mensagens de texto**

---

## Pré-requisitos
- Node.js 18+ instalado no computador
- Conta no Railway (railway.app) — plano gratuito suficiente
- Chave da OpenAI (platform.openai.com)

---

## PASSO 1 — Instalar dependências localmente

```bash
npm install
```

---

## PASSO 2 — Criar o arquivo .env

Copie o arquivo `.env.example` e renomeie para `.env`:

```bash
cp .env.example .env
```

Preencha apenas a `OPENAI_API_KEY` por enquanto (as outras já estão preenchidas).

---

## PASSO 3 — Gerar o token do Google Calendar (UMA VEZ só)

Execute:

```bash
npm run auth
```

O script vai:
1. Gerar um link — abra no navegador
2. Faça login com sua conta Google e autorize
3. Você será redirecionado para uma página com erro — isso é normal!
4. Copie o trecho `code=XXXXXX` da URL
5. Cole no terminal quando pedido
6. O token será exibido — guarde-o para o passo 5

---

## PASSO 4 — Deploy no Railway

1. Acesse [railway.app](https://railway.app) e crie uma conta
2. Clique em **New Project → Deploy from GitHub**
   - Faça upload da pasta `whatsapp-bot-node` como repositório
   - Ou use o Railway CLI: `railway up`
3. O Railway vai detectar o `Procfile` automaticamente

---

## PASSO 5 — Configurar variáveis de ambiente no Railway

No painel do Railway, vá em **Variables** e adicione:

| Variável | Valor |
|----------|-------|
| `OPENAI_API_KEY` | sua chave da OpenAI |
| `GOOGLE_CLIENT_ID` | já está no .env.example |
| `GOOGLE_CLIENT_SECRET` | já está no .env.example |
| `GOOGLE_TOKEN` | o JSON gerado no passo 3 (tudo em uma linha) |
| `TRELLO_API_KEY` | já está no .env.example |
| `TRELLO_TOKEN` | já está no .env.example |
| `TRELLO_BOARD_ID` | já está no .env.example |
| `TIMEZONE` | `America/Sao_Paulo` |

---

## PASSO 6 — Escanear o QR Code

1. Após o deploy, o Railway vai fornecer uma URL pública (ex: `https://seu-bot.up.railway.app`)
2. Acesse essa URL no navegador
3. Vai aparecer um QR Code
4. Abra o WhatsApp no celular → **Aparelhos conectados** → **Conectar aparelho**
5. Escaneie o QR Code

✅ **Pronto! O bot está online.**

---

## Como usar

**Envie uma mensagem de voz ou texto para seu próprio número:**

| Tipo | Exemplo |
|------|---------|
| Compromisso | _"Reunião com o cliente João amanhã às 14h no escritório"_ |
| Compromisso | _"Consulta médica sexta-feira às 10h30"_ |
| Tarefa | _"Preciso corrigir o bug de login no sistema"_ |
| Tarefa | _"Resolver problema de lentidão no relatório financeiro"_ |

---

## Observações importantes

- **Grupos:** O bot ignora mensagens de grupos por padrão. Para ativar, edite a linha `if (msg.isGroupMsg) return;` no `index.js`
- **Sessão:** Se o bot desconectar, acesse a URL novamente e escaneie o QR
- **Áudio:** Funciona com mensagens de voz gravadas diretamente no WhatsApp
- **Idioma:** O bot entende português brasileiro por padrão
