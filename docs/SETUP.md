# Setup

Work through the steps in order. AI answering stays **off** until step 9.

## 1. Requirements

- A Linux host with Docker, or Node.js 22 plus PostgreSQL 16.
- A TLS reverse proxy in front of the dashboard (Caddy, nginx or similar). The public origin is `APP_ORIGIN`.
- The existing n8n instance (`https://n8n.wamsg.site`). It must be able to reach two things:
  - the application database, as role `wa_n8n`, over a private network or TLS;
  - the dashboard URL (for the event sweep and the history import).
- A Zernio account with the WhatsApp number connected, an OpenRouter key, and WooCommerce admin access.

## 2. Configuration

```bash
cp .env.example .env      # fill in every CHANGE_ME; never commit .env
openssl rand -hex 32      # generate each secret/token separately
```

`N8N_INTERNAL_TOKEN` and `BACKEND_INTERNAL_TOKEN` must be different values. Each one is copied into a credential in n8n (step 5).

## 3. Database

With Docker:

```bash
export POSTGRES_SUPERUSER_PASSWORD=...        # superuser, used only for this step
docker compose up -d db
docker compose exec -T db psql -U postgres -v app_pw="'<wa_app password>'" -v n8n_pw="'<wa_n8n password>'" < db/roles.sql
```

Without Docker, run `psql` as a superuser with the same `-v` arguments and `-f db/roles.sql`.

`roles.sql` creates:

- the roles `wa_app` (the backend) and `wa_n8n` (the workflows);
- the database `wa_support`;
- the `citext` and `pg_trgm` extensions.

Then apply the migrations and the seed as `wa_app`. Both are idempotent, so they are safe to run on every deploy:

```bash
docker compose build app
docker compose run --rm app node scripts/migrate.mjs     # or: npm run db:migrate
docker compose run --rm app node scripts/seed.mjs        # or: npm run db:seed
```

The seed writes safe defaults:

- `ai_enabled = false`;
- `default_mode = COPILOT`;
- Telegram, follow-ups and order notifications all off;
- a daily AI budget of 5 USD;
- the chat model `deepseek/deepseek-v4.1-flash` and the vision model `qwen/qwen3.7-flash`.

Change these later in **Settings**.

## 4. First staff account and the dashboard

```bash
STAFF_PASSWORD='<12+ chars>' docker compose run --rm -e STAFF_PASSWORD app \
  node scripts/create-staff.mjs --email you@example.com --name "Your Name" --role owner
docker compose up -d app
```

Point the reverse proxy at `127.0.0.1:3000`, then open `APP_ORIGIN` and sign in. Add further staff under **Settings → Staff** (owners only).

## 5. n8n credentials

The 14 workflows already exist on the instance. They are **unpublished**, and their ids are in `n8n/workflows/ids.json`. These credentials already exist and are attached:

- Zernio (`Custom Auth account`)
- OpenRouter
- Telegram

Create the four new credentials below in n8n (**Credentials → New**), then select them on the nodes listed:

| Credential name | Type | Value | Attach to |
| --- | --- | --- | --- |
| `WA Postgres (wa_n8n)` | Postgres | host / `wa_support` / user `wa_n8n` / its password; SSL on if not on a private network | **Every** Postgres node in every WA workflow |
| `WA WooCommerce` | WooCommerce API | Consumer key and secret with **Read** permission (WooCommerce → Settings → Advanced → REST API), URL `https://infinitydigitalshop.com` | E: *Get Order* (the only node that uses it) |
| `WA Internal Token` | Header Auth | Name `X-Internal-Token`, value = `N8N_INTERNAL_TOKEN` | The Webhook trigger nodes in A (`wa-router`), B (`wa-ai-job`), C (`wa-dispatch`), F (`wa-woo-event`) |
| `WA Backend Internal Token` | Header Auth | Name `X-Internal-Token`, value = `BACKEND_INTERNAL_TOKEN` | I: *Sweep Events*; J: *Store History Page* |

A read-only WooCommerce key is enough. Nothing in the system writes to WooCommerce: order changes are made by staff in WooCommerce itself.

Put `N8N_WEBHOOK_BASE` in `.env`: the production webhook base, for example `https://n8n.wamsg.site/webhook`. Restart the app after changing it.

## 6. Publish the workflows

Publish in this order. Sub-workflows come before the workflows that call them.

1. **Z Error Handler**
2. D Notifications, C Dispatcher, A2 Media Download, E WooCommerce Tools, B2 Image Analysis, B1 Tool Runner, B AI Reply, A Router
3. F Woo Sync, G Memory, H Daily Learning, I Maintenance

After Z is published, open **Settings** on each of the other workflows and set its **Error workflow** to *WA · Z Error Handler*. (This could not be set remotely: n8n requires the error workflow to be published first.)

J History Import stays unpublished. Run it manually when needed (see OPERATIONS).

## 7. Zernio webhook

In Zernio, add a webhook to `https://<APP_ORIGIN>/api/webhooks/zernio`:

- Use the same secret as `ZERNIO_WEBHOOK_SECRET`.
- Subscribe to message received, sent, delivered, read and failed; reaction received; conversation control changed; account disconnected.

The backend rejects deliveries with a missing or wrong `X-Zernio-Signature`.

The WhatsApp account row appears in the dashboard after the first event, and it starts **disabled**. Enable it in **Operations → Connection health** once you have confirmed it is the right number.

**Capture real fixtures.** The files in `fixtures/zernio` are based on Zernio's published spec, not on captured traffic. After the webhook is live:

1. Export a few rows from `app.webhook_events` (`payload` column).
2. Remove the personal data.
3. Commit them next to the existing fixtures.
4. Run `npm test`.

## 8. WooCommerce webhooks

Under WooCommerce → Settings → Advanced → Webhooks, add the following, all with delivery URL `https://<APP_ORIGIN>/api/webhooks/woocommerce` and secret `WOO_WEBHOOK_SECRET`:

- *Product created*
- *Product updated*
- *Product deleted*
- *Order created*
- *Order updated*

## 9. Go-live checklist

Complete these steps with `ai_enabled` still off:

1. **Health.** **Operations → Connection health** shows the database ok, n8n maintenance ok (I runs every minute), and no open critical alerts.
2. **Inbound.** Send a WhatsApp message from a test phone. It appears in the inbox and the conversation is in COPILOT.
3. **Staff send.** Reply from the dashboard. The message is delivered and the status becomes sent, then delivered.
4. **Takeover.** Reply to the test phone from the WhatsApp Business app or the Zernio inbox. The conversation switches to HUMAN (origin detection).
5. **Emergency stop.** Press **Stop all outgoing** in the top bar, try a staff reply, and confirm it is held. Then press **Resume sending**.
6. **Test area.** Use **Settings → Prompts & test area** (admin) to run the real reply workflow against a sandbox conversation that can never send to WhatsApp.
7. **Enable AI.** Press **Turn AI on** in the top bar (admin) and keep the default mode on COPILOT. Review drafts for a few days.
8. **AUTO.** Switch individual conversations to AUTO, or change `default_mode`, only once the drafts are consistently correct.

Optional: set `notifications.telegram_enabled` and `telegram_chat_id` in **Settings** to get alerts in Telegram.
