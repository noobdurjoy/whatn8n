# Setup

Work through the steps in order. AI answering stays **off** until the go-live checklist at the end.

## 1. Requirements

- A Linux host with Docker, or Node.js 22 plus PostgreSQL 16, for the dashboard/backend and its database.
- A TLS reverse proxy in front of the dashboard (Caddy, nginx or similar). The public origin is `APP_ORIGIN`.
- The n8n instance (`https://n8n.wamsg.site`). It must reach:
  - the application database as role `wa_n8n`, over a private network or TLS;
  - the dashboard URL (event sweep, history import, connection check).
- Accounts:
  - a Zernio API key and the WhatsApp number connected in Zernio;
  - an OpenRouter API key;
  - WooCommerce admin access, to create a read-only REST key and the webhooks.

## 2. Configuration

```bash
cp .env.example .env      # fill in every CHANGE_ME; never commit .env
openssl rand -hex 32      # generate each secret/token separately
```

`N8N_INTERNAL_TOKEN` and `BACKEND_INTERNAL_TOKEN` must be different values. Each one is also stored in an n8n credential (step 5). Generate them on the server and type or paste them only into `.env` and the n8n credential form, never into chat or tickets.

### Shared VPS (75.119.130.7)

That server already runs n8n in Docker (network `n8n_default`), another PostgreSQL on `127.0.0.1:5432`, another app on `:3000`, and nginx on ports 80/443. `deploy/vps/install.sh` fits around them:
- Docker project `ids-wa`; the database publishes no port and joins `n8n_default` as `ids-wa-db`;
- the dashboard listens on a free local port (3110–3199, stored as `IDS_APP_PORT` in `.compose.env`);
- the nginx site `support.wamsg.site` gets HTTPS from certbot.

It generates every secret on the server and asks for the owner login. It writes the values for the last three n8n credentials to `n8n-credentials.txt` (mode 600). It is safe to run again.

```bash
cd /opt/ids-whatsapp && git pull && bash deploy/vps/install.sh
```

## 3. Database

With Docker:

```bash
export POSTGRES_SUPERUSER_PASSWORD=...        # superuser, used only for this step
docker compose up -d db
docker compose exec -T db psql -U postgres -v app_pw="'<wa_app password>'" -v n8n_pw="'<wa_n8n password>'" < db/roles.sql
```

Without Docker, run `psql` as a superuser with the same `-v` arguments and `-f db/roles.sql`.

`roles.sql` creates:
- role `wa_app` (the backend);
- role `wa_n8n` (the workflow: granted functions only);
- the database `wa_support`;
- the extensions `citext` and `pg_trgm`.

Then run migrations and the seed as `wa_app`. Both are idempotent, so run them on every deploy:

```bash
docker compose build app
docker compose run --rm app node scripts/migrate.mjs     # or: npm run db:migrate
docker compose run --rm app node scripts/seed.mjs        # or: npm run db:seed
```

The seed writes safe defaults:
- AI answering off (`ai_enabled = false`);
- new conversations in COPILOT (`default_mode = COPILOT`);
- follow-ups and order notifications off;
- Telegram notifications configured per category but sent only after an owner pairs the bot;
- a daily AI budget of 5 USD;
- chat model `deepseek/deepseek-v4.1-flash`, vision model `stealth/space-bunny-alpha`.

## 4. First staff account and the dashboard

```bash
STAFF_PASSWORD='<12+ chars>' docker compose run --rm -e STAFF_PASSWORD app \
  node scripts/create-staff.mjs --email you@example.com --name "Your Name" --role owner
docker compose up -d app
```

Point the reverse proxy at `127.0.0.1:3000`. Open `APP_ORIGIN`, sign in, and add further staff under **Settings → Staff** (owners only).

## 5. n8n credentials

The workflow uses only the credentials below. They belong to this project alone: never reuse or change a credential of another project, and never paste a secret into chat, Git, the workflow JSON or a Telegram message. In n8n, go to **Credentials → Add credential**, create each one with **exactly** this name and type the secret into n8n's form. Afterwards, send the maintainer only the credential **names or ids** (the n8n URL of a credential ends with its id). The ids go into `n8n/credentials.json`, which never holds secret values.

| Credential name | Type | Fields |
| --- | --- | --- |
| `IDS OpenRouter` | Header Auth | Name `Authorization`, Value `Bearer <a new OpenRouter key made for this project>` |
| `IDS Zernio` | Header Auth | Name `Authorization`, Value `Bearer <a new Zernio API key made for this project>` |
| `IDS Telegram Admin` | Telegram API | Access Token of the **new** bot from step 6a (leave Base URL as `https://api.telegram.org`) |
| `IDS Postgres (wa_n8n)` | Postgres | Host, database `wa_support`, user `wa_n8n` and its password; SSL on unless on a private network |
| `IDS WooCommerce Read` | WooCommerce API | URL `https://infinitydigitalshop.com`, key + secret of a REST key with **Read** permission |
| `IDS WooCommerce Stock` | WooCommerce API | Same URL, key + secret of a **second** REST key with **Read/Write** permission (used by exactly one node, *Write Stock*) |
| `IDS Inbound Token (backend to n8n)` | Header Auth | Name `Authorization`, Value `Bearer <N8N_INTERNAL_TOKEN>` |
| `IDS Backend Token (n8n to backend)` | Header Auth | Name `X-Internal-Token`, Value = `BACKEND_INTERNAL_TOKEN` |

How to create the keys:
- **OpenRouter:** openrouter.ai → Keys → *Create key*, name it `IDS WhatsApp`, and set a **credit limit** so the key itself caps spending. The chat model is the DeepSeek model configured in the dashboard (Settings → AI models); images always use `stealth/space-bunny-alpha`. Both use this one key; nothing falls back to another key.
- **Zernio:** Zernio dashboard → API keys → create a key for this project.
- **WooCommerce:** WooCommerce → Settings → Advanced → REST API → *Add key* twice (one Read, one Read/Write), each for a shop admin user. The Read/Write key is only ever sent to `PUT /wp-json/wc/v3/products/{id}` or `/products/{id}/variations/{id}` with a body holding `stock_quantity` **or** `stock_status`; no node can reach orders, payments or other product fields with it. Revoke it in WooCommerce to disable Telegram stock changes entirely.
- **Tokens:** `N8N_INTERNAL_TOKEN` and `BACKEND_INTERNAL_TOKEN` are two different random values (e.g. `openssl rand -hex 32`), created only for these webhooks and never reused as an API key.

Webhook secrets are separate from API keys. The Telegram webhook secret is generated by n8n itself when the workflow is published and checked on every update (`X-Telegram-Bot-Api-Secret-Token`); the Zernio and WooCommerce webhook secrets are the `ZERNIO_WEBHOOK_SECRET` and `WOO_WEBHOOK_SECRET` values in `.env`.

## 6. The workflow

There is exactly one workflow: **Infinity Digital Shop — WhatsApp AI Support**. The maintainer creates it on the instance through the n8n MCP tools. It can also be imported from `n8n/workflow/ids-whatsapp-ai-support.json` (**Workflows → Import from file**).

1. Attach the credentials from step 5. Every node that needs one shows the credential name.
2. Open the workflow's **Settings**:
   - **Error workflow:** choose this same workflow. Its errors section records failures as dashboard alerts (and Telegram notifications).
   - **This workflow can be called by:** *Selected workflows*, and select this same workflow only. n8n runs an error workflow as a "call", so the self-reference is required; nothing else can call it.
   - Leave **Save successful/failed production executions** off, as set in the file. Execution data would contain customer images, message text and request headers. (Execution-data redaction needs a paid n8n licence, so not saving is the protection.)
3. Run **Run Connection Check** (manual trigger). Every entry in `results` must say `ok: true` before you publish.
4. **Publish** the workflow. Publishing registers the Telegram webhook of the `IDS Telegram Admin` bot; because that bot is new and used by nothing else, no other integration's webhook is replaced.

Put `N8N_WEBHOOK_BASE` (e.g. `https://n8n.wamsg.site/webhook`) into `.env` and restart the app. The backend calls the webhook paths `wa-router`, `wa-ai-job`, `wa-dispatch` and `wa-woo-event`, all in this one workflow.

### 6a. The Telegram admin bot

1. In Telegram, open **@BotFather** → `/newbot`. Give it a name (e.g. *IDS Shop Admin*) and a username ending in `bot`. Do **not** reuse the bot of another project: publishing sets this bot's webhook.
2. Recommended in BotFather: `/setjoingroups` → *Disable* (the bot answers private chats only anyway) and `/setprivacy` → *Enable*.
3. Put the token into the `IDS Telegram Admin` credential (step 5) and publish the workflow.
4. **Pair the owner:** sign in to the dashboard as the owner → **Settings → Telegram → Create pairing code**. Send `/pair CODE` to the bot in a private chat within 10 minutes. The code works once and only a hash is stored. Alternatively an owner can authorize an owner/admin account by its **numeric Telegram user id** in the same tab.
5. Send `/help` to the bot. Anyone else who writes to it gets "This is a private bot." at most once a day; their text is not stored and never reaches an AI model.
6. Choose which notifications you want (immediately, in the 21:00 daily summary, or off) in **Settings → Telegram**.

Example commands (English, Bangla or Banglish):
- `Set stock for SKU SPOTIFY-1M to 5` · `Add 3 units to product 123` · `Remove 2 units from SKU NF-1M` · `Netflix 1 month is out of stock`
- `Remember: support hours are 10am to 10pm.` (permanent, customer-facing)
- `Temporary: Netflix delivery is delayed until tomorrow 6pm.` (the bot asks for an expiry if you give none)
- `/notices` · `Remove the temporary Netflix delivery notice`
- `Note: supplier is late this week` (private; never shown to customers or the AI)
- `Reply to 017XXXXXXXX: your exact message` (sent as a human reply; AI stops for that chat)
- `/status` · `cancel`

## 7. Zernio webhook

In Zernio, add a webhook to `https://<APP_ORIGIN>/api/webhooks/zernio` with the same secret as `ZERNIO_WEBHOOK_SECRET`. Subscribe to:
- message received, sent, delivered, read and failed;
- reaction received;
- conversation control changed;
- account disconnected.

Deliveries with a missing or wrong `X-Zernio-Signature` are rejected.

The WhatsApp account row appears after the first event, **disabled**. Enable it in **Operations → Connection health** once you've confirmed it is the right number.

## 8. WooCommerce webhooks

Under WooCommerce → Settings → Advanced → Webhooks, add *Product created/updated/deleted* and *Order created/updated*. Use delivery URL `https://<APP_ORIGIN>/api/webhooks/woocommerce` and secret `WOO_WEBHOOK_SECRET`.

## 9. Monitoring n8n itself

A workflow cannot report that n8n is down. Point an uptime monitor at `https://<APP_ORIGIN>/api/health/n8n`. It returns `503` when the workflow's heartbeat is older than 3 minutes. The dashboard top bar shows **Automation offline** in the same situation.

## 10. Go-live checklist

Complete these steps with AI answering still off, using a **designated test phone** (never a customer):

1. **Health.** *Run Connection Check* is all ok, and **Operations → Connection health** shows the database, n8n maintenance and backup ok.
2. **Inbound.** Message the shop from the test phone. The message appears in the inbox and the conversation is in COPILOT.
3. **Staff send.** Reply from the dashboard. It is delivered, and its status goes sent → delivered.
4. **Takeover.** Reply to the test phone from the WhatsApp Business app or the Zernio inbox. The conversation switches to HUMAN.
5. **Emergency stop.** Press **Stop all outgoing**, try a staff reply, and confirm it is held. Then press **Resume sending**.
6. **Test area.** Use **Settings → Prompts & test area** to run the real reply workflow against the sandbox conversation. It can never send to WhatsApp.
7. **Turn AI on, in COPILOT.** Press **Turn AI on** and keep the default mode on COPILOT. Review drafts from the test phone first, then from real customers for a few days.
8. **Telegram.** Pair the owner (step 6a), send `/status`, and try `Reply to <test phone>: test` — the test phone receives exactly that text and the bot reports accepted, then delivered. Try a stock command only on a **test product** first and check the value in WooCommerce.
9. **AUTO.** Switch individual conversations to AUTO, or change `default_mode`, only when the drafts are consistently correct.
