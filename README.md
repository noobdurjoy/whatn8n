# WhatsApp support and sales for Infinity Digital Shop

A WhatsApp customer support and sales system for the WooCommerce shop
[infinitydigitalshop.com](https://infinitydigitalshop.com). It has these parts:

- **Zernio** carries WhatsApp messages in and out.
- **n8n** runs the workflows (A–J plus an error handler).
- **PostgreSQL** holds all application data and every control decision. It is a separate database from n8n's own.
- **Next.js dashboard and backend** give staff a shared inbox: takeover, co-pilot drafts, approvals, knowledge review, metrics, emergency stop.
- **OpenRouter** provides the language models: a configurable DeepSeek chat model for replies, and `qwen/qwen3.7-flash` for reading customer images.

The system is built for safe operation. The database decides who may send what and when. Models only propose. A single dispatcher sends every outgoing message, and it re-checks mode, takeover, the emergency stop and the 24-hour window before each send. AI answering is **off** after installation.

| Document | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, workflows, control plane |
| [docs/SETUP.md](docs/SETUP.md) | Installation from zero, n8n credentials, webhooks, go-live checklist |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Deploy, backup and restore, daily operation, runbooks |
| [docs/SECURITY.md](docs/SECURITY.md) | Roles and capabilities, data handling, AI safety boundaries |
| [docs/METRICS.md](docs/METRICS.md) | Metric definitions |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | What was verified live and what was only tested with fixtures |

## Repository layout

```
src/                Next.js app: dashboard pages, API routes, backend libraries
db/                 roles.sql, migrations/ (0001–0010), grants.sql
n8n/workflows.mjs   Single source of truth for all n8n workflows (generator)
n8n/code/src        Code-node sources  →  n8n/code/dist (built by n8n/build.mjs)
n8n/workflows/      Generated importable workflow JSON + ids.json (instance ids)
prompts/            System prompts (seeded as versioned prompts)
scripts/            migrate, seed, staff:create, backup.sh, restore.sh, verifiers
fixtures/zernio/    Sanitized webhook fixtures (spec-based, not live captures)
tests/              Unit tests (code nodes, export fidelity) and integration tests (PostgreSQL)
```

## Quick commands

```bash
npm ci
npm run typecheck && npm test        # needs a local PostgreSQL for integration tests
npm run n8n:build && node n8n/workflows.mjs   # rebuild code nodes and workflow JSON
docker compose up -d --build          # PostgreSQL + dashboard (see docs/SETUP.md first)
```
