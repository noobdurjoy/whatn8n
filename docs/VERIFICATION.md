# Verification

This page separates three things:
- what has been proven against the live services;
- what was tested only locally, with real PostgreSQL but mocked providers;
- what has not been exercised yet.

No other test results are claimed.

## Live state (2026-09-26)

- **Workflow:** **Infinity Digital Shop — WhatsApp AI Support** (`CAUTLyiBxlIyAydL` on `n8n.wamsg.site`) is **published**, with 299 nodes. Its error workflow is itself, and only it may call itself. `scripts/verify-n8n-export.mjs` compares an export of the live copy with `n8n/workflow/ids-whatsapp-ai-support.json` and prints **OK**: nodes, parameters, all Code, credentials and connections match.
- **Database and dashboard:** they run on the shared VPS with `deploy/vps/install.sh`. https://support.wamsg.site/api/health returns `{"ok":true}`. The n8n maintenance heartbeat is `ok`.
- **Observation mode:**
  - AI answering is **on** and new conversations start in **COPILOT**, so the AI only writes drafts.
  - The automatic handoff message is **off**.
  - Sending is **on**, but only a staff action (a dashboard reply or approval, or a Telegram **✅ Approve & send**) queues a message to a customer.
  - Each draft reaches the owner on Telegram as "AI draft reply (NOT sent to the customer)", with the customer's message and **Approve / Decline** buttons.
- **Telegram admin:** @IDSShopAdminBot is authorized for Telegram user id 5553863175, the owner, by numeric id and private chat id. It delivered the go-live notice. Button presses (`callback_query`) are part of the bot's webhook updates.

## Verified live

| Item | How |
| --- | --- |
| Connection check (published workflow) | **All checks pass** (execution 127, 2026-09-26). It sends nothing to WhatsApp and changes nothing. <ul><li>**IDS OpenRouter** chat: `deepseek/deepseek-v4.1-flash` calls `search_products`.</li><li>**IDS OpenRouter** vision: `stealth/space-bunny-alpha` reads a real 684 KB shop product image.</li><li>**IDS Zernio**: 1 WhatsApp account.</li><li>**IDS WooCommerce Read**: REST product read.</li><li>WooCommerce Store API: BDT prices.</li><li>PostgreSQL as `wa_n8n`, over the private Docker network (`ids-wa-db`).</li><li>Backend health and backend token.</li></ul> |
| Vision model `stealth/space-bunny-alpha` | Chosen by the owner to replace `qwen/qwen3.7-flash`. That model kept answering `{}` or ran out of tokens while reasoning (executions 96, 100–103). The new model got a real shop product image with the exact production request: JSON mode, reasoning budget 256, `require_parameters`. It passed executions 107, 108 and 109: the validator passed, the type was `product_photo`, and it read "Netflix Gift Card Bangladesh". The live setting `models.vision_model` is set to it |
| OpenRouter chat model `deepseek/deepseek-v4.1-flash` | Tool calling with the allowlisted tools, structured JSON answers, usage and cost fields |
| WooCommerce Store API (public) | Product search, details and variations for infinitydigitalshop.com. <ul><li>Prices are in minor units (BDT, 2 decimals).</li><li>`add_to_cart.url` carries the exact variation.</li></ul> |
| Telegram delivery | A `deployment` notification queued in the database was claimed by the published workflow and sent by @IDSShopAdminBot: status `sent` after 1 attempt |
| Credentials | All 8 IDS credentials exist and are bound by id; no node uses another project's credential. The last three (Postgres, Inbound Token, Backend Token) were created on the VPS from its generated secrets with `n8n import:credentials`, so no secret passed through chat |
| VPS deployment | `deploy/vps/install.sh` works around the other services on the host: <ul><li>no database port is published;</li><li>the dashboard runs on `127.0.0.1:3110`;</li><li>nginx serves it on `75.119.130.7:443` with a Let's Encrypt certificate;</li><li>migrations 0001–0014 are applied.</li></ul> |

## Verified locally (real PostgreSQL 16, real n8n, mocked providers)

| Item | How |
| --- | --- |
| Schema, migrations 0001–0014, grants | Applied from scratch on every integration test run |
| Control rules | Integration tests against the real database cover: <ul><li>dedupe;</li><li>takeover atomicity;</li><li>stale AI results discarded;</li><li>no AI send after takeover;</li><li>emergency stop;</li><li>24 h window;</li><li>unknown send outcomes;</li><li>drafts;</li><li>human-echo origin detection;</li><li>order operations;</li><li>AI budget handoff;</li><li>Telegram pairing, authorization, command capabilities, stock-change locking, notices, notes and notification categories</li></ul> |
| Draft buttons (0014) | <ul><li>The draft notification carries Approve and Decline.</li><li>Approve queues exactly that draft, once; a second press is refused as `draft_approved`.</li><li>Decline rejects the draft.</li><li>A stale draft is refused as `stale_draft`, with nothing queued.</li><li>A stranger's button press is rejected before any decision.</li><li>A text update cannot be replayed as a button press.</li><li>The workflow role still cannot call `approve_draft` directly.</li></ul> |
| n8n Code nodes | Every generated Code node runs in unit tests inside a VM that has the n8n sandbox globals. This includes button-press input reduction and the Telegram reply texts |
| End-to-end workflow run | `tests/e2e/run.mjs`: local n8n 2.40.7, PostgreSQL, the Next.js backend, and HTTPS mocks of Zernio, OpenRouter, WooCommerce and Telegram. **Run 8: 29 passed, 0 failed.** The draft buttons were added after run 8 and are covered by the integration tests above |
| Dashboard | Redesigned (2026-09-26). Built with `next build` and checked in a real browser (Playwright/Chromium) against the e2e database in light, dark and mobile (390 px) layouts. Screenshots are in `docs/screenshots/` |
| Totals | `npm run typecheck` clean; `npm test` **259 tests passing** |

## Not yet exercised

| Item | Why | What to do |
| --- | --- | --- |
| Zernio webhook (inbound WhatsApp) | The webhook must be added in the Zernio dashboard. There is no verified API for it here, and an existing webhook of another integration must not be overwritten. Until it exists, no customer message reaches the system | In Zernio, add a webhook to `https://support.wamsg.site/api/webhooks/zernio` with the `ZERNIO_WEBHOOK_SECRET` from `/opt/ids-whatsapp/n8n-credentials.txt` (SETUP §7) |
| Zernio send, media and message list with a real customer | Built from Zernio's published spec; nothing has been sent to a customer | The first **Approve & send** on a real draft is the first live send; try it first with a test phone |
| Approve / Decline on a real draft | Depends on the Zernio webhook above | After the webhook exists, message the shop from a test phone and press the buttons |
| WooCommerce stock write | The Read/Write key exists but has not written anything; stock writes were tested only against the mock | Run one stock change on a test product from Telegram |
