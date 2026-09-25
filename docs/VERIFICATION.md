# Verification

This page separates three things:
- what has been proven against the live services;
- what was tested only locally, with real PostgreSQL but mocked providers;
- what has not been exercised yet.

No other test results are claimed.

## Verified live

| Item | How |
| --- | --- |
| OpenRouter chat model `deepseek/deepseek-v4.1-flash` | Real calls: tool calling with the allowlisted tools, structured JSON answers, usage and cost fields. Repeated with **IDS OpenRouter** (below) |
| OpenRouter vision model `qwen/qwen3.7-flash` | A real image sent as a base64 data URL; valid JSON observations accepted by the validator. Repeated with **IDS OpenRouter** (below) |
| WooCommerce Store API (public) | Product search, product details and variations for infinitydigitalshop.com, fetched from n8n. Confirmed facts: <ul><li>prices are in minor units (BDT, 2 decimals);</li><li>variation items carry `parent` and `variation`, with empty `attributes`;</li><li>`add_to_cart.url` has the exact variation query.</li></ul> |
| Connection check with the IDS credentials | Run on the instance (execution 98, 2026-09-25). It sends nothing to WhatsApp and changes nothing. Passed: <ul><li>**IDS OpenRouter** chat (`deepseek/deepseek-v4.1-flash` called `search_products` with `{"query":"netflix"}`, usage returned);</li><li>**IDS OpenRouter** vision (`qwen/qwen3.7-flash` given a real 684 KB shop product image, validator passed, `product_photo`, read "Netflix Gift Card Bangladesh");</li><li>**IDS Zernio** (1 account, 1 WhatsApp account);</li><li>**IDS WooCommerce Read** (REST product read);</li><li>WooCommerce Store API (products with BDT prices).</li></ul>Failed only because they are not deployed yet: PostgreSQL, backend health, backend token. Execution 96 had found that Qwen spent 393 of 400 tokens reasoning and answered `{}`. Both vision requests now use low, hidden reasoning and a 1200-token limit. Execution 97 hit a provider 429; execution 98 passed |
| Workflow upload | The single workflow **Infinity Digital Shop — WhatsApp AI Support** exists on `n8n.wamsg.site` as `CAUTLyiBxlIyAydL`, **unpublished**. All 292 nodes are present. The Telegram nodes are bound by id to **IDS Telegram Admin** (@IDSShopAdminBot); the model nodes to **IDS OpenRouter**, the Zernio nodes to **IDS Zernio**, the WooCommerce nodes to **IDS WooCommerce Read**, and *Write Stock* alone to **IDS WooCommerce Stock**. No node is bound to another project's credential |

## Verified locally (real PostgreSQL 16, real n8n, mocked providers)

| Item | How |
| --- | --- |
| Schema, migrations 0001–0013, grants | Applied from scratch on every integration test run |
| Control rules | Integration tests against the real database cover: <ul><li>dedupe;</li><li>takeover atomicity;</li><li>stale AI results discarded;</li><li>no AI send after takeover;</li><li>emergency stop;</li><li>24 h window;</li><li>unknown send outcomes;</li><li>drafts;</li><li>human-echo origin detection;</li><li>order operations;</li><li>AI budget handoff;</li><li>Telegram pairing, authorization, command capabilities, stock-change locking, notices, notes and notification categories</li></ul> |
| n8n Code nodes | Every generated Code node runs in unit tests inside a VM that has the n8n sandbox globals. This includes the Telegram parser, the proposed-action validator, stock resolution and planning, and the Write Stock body (only stock fields can be sent) |
| End-to-end workflow run | `tests/e2e/run.mjs` imports the generated workflow into a local n8n 2.40.7. Around it run PostgreSQL, the Next.js backend and an HTTPS mock of Zernio, OpenRouter, WooCommerce and Telegram. **Run 8: 29 passed, 0 failed.** It covers: <ul><li>customer intake, AUTO, COPILOT and HUMAN;</li><li>vision;</li><li>dispatch refusals;</li><li>Telegram pairing and unauthorized users;</li><li>forwarded messages ignored;</li><li>stock set/add/out-of-stock with read-back;</li><li>ambiguous products;</li><li>Remember/Temporary/Note;</li><li>Telegram reply through the dispatcher (with takeover);</li><li>notifications;</li><li>the connection check;</li><li>no secrets in execution data</li></ul> |
| Totals | `npm run typecheck` clean; `npm test` **255 tests passing** |

## Not yet exercised

Each of these needs the owner's credentials or a deployment.

| Item | Why | What to do |
| --- | --- | --- |
| IDS credentials | Still missing in n8n: IDS Postgres (wa_n8n), IDS Inbound Token and IDS Backend Token (they need the deployed database and backend) | SETUP §5; then send the credential names back so the nodes can be bound by id |
| Telegram bot | No bot token yet, so the bot username is unknown and pairing is untested live | Create the bot with @BotFather, store its token as **IDS Telegram Admin**, then pair (SETUP §6a) |
| Database and dashboard hosting | Not deployed. From this environment SSH to the VPS is blocked, so it cannot be deployed from here | Run `docker compose up -d` on the VPS (SETUP §3–4) |
| Zernio webhook, send, media, message list | Built from Zernio's published spec; no live message sent | Go-live checklist with a test phone. Keep automatic replies off until COPILOT is verified |
| WooCommerce stock write | The Read/Write key exists but has not written anything; stock writes were tested only against the mock | After go-live, run one stock change on a test product from Telegram |
| Connection check on the instance | Needs the credentials above | Run "Run Connection Check"; every row must show `ok: true` |
| Publishing and error workflow | Publish only after the checks above pass. The error workflow can be set only after publishing. (The 14 old `WA ·` workflows and the earlier draft were never published and have been archived at the owner's request; only this workflow and the Facebook + Instagram autopost remain.) | SETUP §6 |
