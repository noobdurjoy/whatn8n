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
- Telegram, follow-ups and order notifications off;
- a daily AI budget of 5 USD;
- chat model `deepseek/deepseek-v4.1-flash`, vision model `qwen/qwen3.7-flash`.

## 4. First staff account and the dashboard

```bash
STAFF_PASSWORD='<12+ chars>' docker compose run --rm -e STAFF_PASSWORD app \
  node scripts/create-staff.mjs --email you@example.com --name "Your Name" --role owner
docker compose up -d app
```

Point the reverse proxy at `127.0.0.1:3000`. Open `APP_ORIGIN`, sign in, and add further staff under **Settings → Staff** (owners only).

## 5. n8n credentials

The workflow uses these credentials. In n8n, go to **Credentials → Add credential** and create each one with **exactly** this name, then tell the maintainer, or put its id into `n8n/credentials.json` and regenerate. Secret values are typed only into n8n's credential form.

| Credential name | Type | Fields |
| --- | --- | --- |
| `IDS WA · OpenRouter` | Header Auth | Name `Authorization`, Value `Bearer <OpenRouter key for this project>` |
| `IDS WA · Zernio` | Header Auth | Name `Authorization`, Value `Bearer <Zernio API key for this project>` |
| `IDS WA · Postgres (wa_n8n)` | Postgres | Host, database `wa_support`, user `wa_n8n` and its password; SSL on unless on a private network |
| `IDS WA · WooCommerce (read-only)` | WooCommerce API | URL `https://infinitydigitalshop.com`, consumer key and secret of a **Read**-only REST key (WooCommerce → Settings → Advanced → REST API) |
| `IDS WA · Inbound token (backend to n8n)` | Header Auth | Name `Authorization`, Value `Bearer <N8N_INTERNAL_TOKEN>` (n8n redacts this header from execution data) |
| `IDS WA · Backend token (n8n to backend)` | Header Auth | Name `X-Internal-Token`, Value = `BACKEND_INTERNAL_TOKEN` |
| `Telegram account` | Telegram | Already exists; used only when Telegram alerts are switched on |

Two recommendations:
- Give the OpenRouter key a credit limit in OpenRouter, so the key itself caps spending.
- Use keys separate from other projects, so they can be rotated independently.

## 6. The workflow

There is exactly one workflow: **Infinity Digital Shop — WhatsApp AI Support**. It is created on the instance by the maintainer through the n8n MCP tools. It can also be imported from `n8n/workflow/ids-whatsapp-ai-support.json` (**Workflows → Import from file**).

1. Attach the credentials from step 5 to their nodes. Nodes that use a credential show its name.
2. Open **Settings** on the workflow:
   - **Error workflow:** choose this same workflow. Its section 14 records failures.
   - Leave **Save successful/failed production executions** off, which is the default in the file. Execution data would contain customer images and message text; failures are recorded as dashboard alerts instead.
3. Run **Run Connection Check** (manual trigger, section 15). Every entry in `results` must say `ok: true` before you publish.
4. **Publish** the workflow.

Put `N8N_WEBHOOK_BASE` (e.g. `https://n8n.wamsg.site/webhook`) into `.env` and restart the app. The backend calls the webhook paths `wa-router`, `wa-ai-job`, `wa-dispatch` and `wa-woo-event`, all in this one workflow.

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
8. **AUTO.** Switch individual conversations to AUTO, or change `default_mode`, only when the drafts are consistently correct.
