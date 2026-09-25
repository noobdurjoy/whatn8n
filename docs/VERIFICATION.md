# Verification

This page states what has been proven against the live services, what was tested only with local fixtures or mocks, and what has not been exercised yet. No other test results are claimed.

## Verified live

| Item | How |
| --- | --- |
| OpenRouter chat model `deepseek/deepseek-v4.1-flash` | Real calls through the n8n OpenRouter credential: tool calling with the allowlisted tools, JSON-structured final answers, usage and cost fields returned |
| OpenRouter vision model `qwen/qwen3.7-flash` | A real image sent as a base64 data URL with the vision prompt. Returned valid JSON observations, which the vision validator accepted |
| WooCommerce Store API (public) | Product search, product details and variations for infinitydigitalshop.com fetched from n8n. Confirmed facts: prices in minor units (BDT, 2 decimals); variation items carry `parent` and `variation` with empty `attributes`; `add_to_cart.url` has the exact variation query. Checkout links are built from that URL |
| n8n workflow creation | All 14 WA workflows exist on `n8n.wamsg.site`, **unpublished**. `scripts/verify-n8n-export.mjs` compares the instance copy with the repo (node types and versions, parameters, every Code node's JavaScript, credential references, settings, connections); all 14 print OK. The 4 temporary probe workflows were archived |

## Verified locally (real PostgreSQL 16, fixtures and mocks for providers)

| Item | How |
| --- | --- |
| Schema, migrations 0001–0011, grants | Applied from scratch on every integration test run |
| Control rules | Integration tests (`tests/integration/controls.test.ts`) cover these rules against the real database: <ul><li>dedupe;</li><li>takeover atomicity;</li><li>stale AI results discarded after a mode change or new message;</li><li>no AI send after takeover;</li><li>emergency stop;</li><li>24 h window;</li><li>unknown send outcomes;</li><li>drafts;</li><li>origin detection of human echoes;</li><li>order operations;</li><li>AI budget handoff</li></ul> |
| Least privilege for n8n | Every SQL statement in every workflow is planned (`EXPLAIN`) as role `wa_n8n`. A negative check confirmed that a function without a grant fails |
| Role matrix | Database and backend capability lists compared for every role |
| n8n Code nodes | Every generated Code node runs in unit tests with a mocked n8n runtime (`$input`, `$()`, helpers): vision, tool runner, dispatcher, Woo formatting (live-shaped fixtures), media download checks, memory and learning redaction, the reply chain, and export fidelity |
| Webhook to dashboard | Local server fed with the Zernio fixtures: signature check, intake, inbox, takeover, replies queued; API smoke test; screenshots in `docs/screenshots/` |
| Deployment files | Next.js standalone build contains its runtime dependencies (`pg`, `@node-rs/argon2`). `backup.sh` and `restore.sh` were run end to end, including the refusal to restore over a non-empty database |

Current totals: `npm run typecheck` clean, `npm test` **180 tests passing**.

## Not yet exercised (needs the owner's accounts or a deployment)

| Item | Why | What to do |
| --- | --- | --- |
| Zernio webhook delivery | No WhatsApp webhook subscription existed. The fixtures follow Zernio's published spec, not captured traffic | SETUP §7, then capture sanitized real fixtures |
| Zernio send, media download, message list | Endpoints and payloads are taken from Zernio's official SDK spec, and the credential exists in n8n, but no message was sent to a real customer | Go-live checklist steps 2–5 with a test phone |
| WooCommerce REST (order lookup) | No REST key in n8n yet | Create `WA WooCommerce` (read-only), then ask the AI about a test order from the phone that placed it |
| n8n ↔ application database | `WA Postgres (wa_n8n)` does not exist yet, so no workflow has run on the instance | SETUP §5–6 |
| Error workflow linking | n8n accepts an error workflow only once it is published | SETUP §6 |
| Telegram alerts | Credential exists; notifications are off by default | Set `notifications.telegram_enabled` and `telegram_chat_id` |
| Production host, TLS, backups off-host | No deployment target was provided | OPERATIONS |
