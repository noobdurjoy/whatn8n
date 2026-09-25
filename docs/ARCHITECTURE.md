# Architecture

## Components

```mermaid
flowchart LR
  WA[WhatsApp customer] <--> Z[Zernio]
  Z -- signed webhook --> BE[Backend<br/>Next.js API]
  WOO[WooCommerce] -- signed webhook --> BE
  BE <--> DB[(PostgreSQL<br/>wa_support)]
  BE -- event / job / outbound ids<br/>X-Internal-Token --> WF[n8n: ONE workflow<br/>Infinity Digital Shop — WhatsApp AI Support]
  WF -- restricted role wa_n8n<br/>granted functions only --> DB
  WF -- send / media / history --> Z
  WF -- DeepSeek chat + Qwen vision --> OR[OpenRouter]
  WF -- Store API + REST read-only --> WOO
  WF -- event sweep, history import --> BE
  STAFF[Staff browser] -- session cookie + CSRF --> BE
  WF -. alerts .-> TG[Telegram, optional]
  MON[Uptime monitor] -. /api/health/n8n .-> BE
```

- **Backend (Next.js, `src/`).**
  - Receives the Zernio and WooCommerce webhooks and verifies their HMAC over the raw body.
  - Stores the event durably, acknowledges it, then applies it in one transaction:
    - customer identity;
    - the message;
    - duplicate detection;
    - origin detection for outgoing echoes;
    - human-request detection and the resulting takeover.
  - Serves the dashboard and its authenticated API. Every staff action goes through a capability check (`src/lib/permissions.ts`), and the database checks it again (`app.require_cap`).
- **PostgreSQL (`db/`).** Schema `app` holds everything: conversations, messages, the outbox, AI jobs, drafts, knowledge, memories, order requests, alerts, audit, metrics and settings. The control rules are SQL functions, for example:
  - `claim_event_route`
  - `start_ai_job`
  - `submit_ai_result`
  - `claim_outbound`
  - `record_send_result`
  - `take_over`
  - `set_global_controls`

  Because the rules live in the database, the backend and n8n cannot disagree about them.
- **n8n: exactly one workflow**, *Infinity Digital Shop — WhatsApp AI Support*.
  - It has no sub-workflows, no Execute Workflow or workflow-tool nodes, no separate error workflow, and no calls to its own webhooks.
  - It connects to PostgreSQL as `wa_n8n`, which may only execute the functions listed in `db/grants.sql`.
  - It holds the provider credentials.

## The workflow

The workflow is generated from `n8n/workflow.mjs`. Code nodes come from `n8n/code/src`, and the importable file is `n8n/workflow/ids-whatsapp-ai-support.json`. On the canvas, each section below is a labelled band with a note.

| # | Section | Entry | What it does |
| --- | --- | --- | --- |
| 1 | Event intake & routing | webhook `wa-router` | Claims the stored event **once** (`claim_event_route`), so a re-delivery stops at *Valid?*. Downloads media first, then routes on the stored decision plus the conversation's **current** mode: AI reply, handoff acknowledgement, staff alert |
| 2 | Customer media download | from 1 or 12 | Zernio's authenticated media endpoint only (`https://zernio.com/api/v1/…`, checked strictly). Type and size are checked; all results are stored in one database call |
| 3 | AI reply (DeepSeek) | from 1; webhook `wa-ai-job` for staff assist / sandbox | Burst debounce, `start_ai_job`, scoped redacted context, up to 3 model rounds plus 1 repair, server-side validation, `submit_ai_result` |
| 4 | AI tool calls | loops from 3 | One tool call per loop iteration. Arguments are re-validated. *Tool Return* sends each result back to its round |
| 5 | Image analysis (Qwen) | from 4 | The customer's stored attachment is sent as a base64 data URL with the question. Output is validated JSON observations; stale jobs are skipped; results are reused for the same image, model and prompt |
| 6 | WooCommerce tools | from 4 | Store API search, details and variations; hosted-checkout links; order status **only for a verified owner**; staff-handled order requests |
| 7 | Outgoing dispatch | webhook `wa-dispatch`, every 15 s, and from 1, 3, 9, 12 | **The only sending path.** A queue and a loop; `claim_outbound` re-checks every control right before each send; Idempotency-Key; unknown outcomes are recorded, never retried blindly |
| 8 | Staff alerts | from 1, 3, 12 | Telegram notifications with facts and a dashboard link only (off by default) |
| 9 | WooCommerce sync | webhook `wa-woo-event`, every 6 h | Product and order references; optional order-status messages through 7 |
| 10 | Memory & summaries | every 10 min, looped | Per-conversation summaries and customer-stated preferences, scoped to that customer |
| 11 | Daily knowledge proposals | 03:15 Asia/Dhaka | Redacted review of resolved chats. Produces **pending** proposals only; an admin must approve them |
| 12 | Recovery & maintenance | every 1 min / 5 min / daily | Heartbeat, lease expiry, backend event sweep, alert forwarding, interrupted-job recovery, overdue reminders, pending media, unknown-send reconciliation, retention |
| 13 | History import | manual | Earlier Zernio history for known conversations, stored as historical messages (never answered) |
| 14 | Error recording | Error Trigger (the workflow is its own error workflow) | A failure becomes a dashboard alert, which 12 forwards to staff |
| 15 | Connection check | manual | Read-only live check of every credential and service |

**How one workflow replaces the old sub-workflow calls.**
- Where the old design called a sub-workflow once per item, a **Loop Over Items** node (batch size 1) walks the items through the shared branch, and every path returns to the loop. There are loops for tool calls (one per round), dispatch, summaries, reconciliation and history import.
- Each entry point normalizes its input before a shared branch: *Dispatch Queue*, *Media Request*, *Notify Request*, *Reply Request*, *Tool Call*.
- No Merge node waits for two triggers.
- Media download is strictly sequential before routing. n8n does not guarantee the order in which a Switch's outputs run, so the AI must not start until the image is stored.

## Message lifecycle

1. **Inbound.** `POST /api/webhooks/zernio`:
   1. The backend verifies the signature, stores the event under a dedupe key, returns `200`, and applies the event in one transaction.
   2. It calls `wa-router` with the event id.
   3. If that call fails, the event sweep (section 12, every minute) re-delivers it.
2. **Routing (section 1).** The workflow claims the event. It downloads any media, then decides from the database state what to do:
   - the mode (AUTO, COPILOT or HUMAN);
   - the global AI switch;
   - holds;
   - takeover.

   AI work starts only through `start_ai_job`, which records `mode_version` and `revision`.
3. **AI reply (sections 3 to 6).** DeepSeek sees redacted context and has only the allowlisted tools. `submit_ai_result` discards the result if the mode, a takeover or a newer customer message changed anything since the job started. Otherwise:
   - AUTO: the reply goes to the outbox;
   - COPILOT: it becomes a draft for staff;
   - otherwise: the conversation is handed off.
4. **Outbound (section 7).**
   - Every message becomes a row in `app.outbound_messages` and is claimed by `claim_outbound`, which re-checks every control and takes a lease.
   - A timeout or 5xx result is recorded as **unknown**. Section 12 reconciles it against Zernio's message list, or a person decides.
5. **Handoff.**
   - A takeover is one atomic update. It sets HUMAN mode, cancels queued AI sends, invalidates drafts and cancels running AI jobs.
   - It can be triggered by a staff reply, a customer asking for a person, or a human replying from the Zernio inbox or the Business app.
   - A send already accepted by Zernio cannot be recalled. It may still arrive after a takeover or an emergency stop, and the dashboard marks such messages as in flight.

## Order requests

The AI can only record a request with `propose_order_change`: refund, cancellation, address change, renewal or access issue. The order must first be verified as belonging to that customer. These are **staff-handled**:
1. An admin approves or rejects the request in the dashboard.
2. They make the change **in WooCommerce themselves**. Refunds go through the payment gateway there.
3. They record the result: **I did it in WooCommerce** or **Not done**.

Nothing in the workflow changes an order. The WooCommerce credential is read-only.

Purchases use WooCommerce's hosted checkout link for the exact product and variation. Payment status comes only from WooCommerce, never from a customer's claim or a screenshot.

## Failure behaviour

- **Database or permission check unavailable:** claims fail, so nothing is sent.
- **Emergency stop** (`sending_enabled = false`): every claim is refused. This covers staff replies, drafts, acknowledgements, retries and order-operation claims.
- **Daily AI budget used up:** B hands the conversation to staff (fixed acknowledgement in AUTO, one alert per day). Vision, memory and learning skip their model calls.
- **n8n restart or crash mid-reply:** the job stays `running`. After 10 minutes, section 12 fails it and hands the conversation to staff.
- **n8n down entirely:**
  - Nothing is sent or answered automatically, and the workflow cannot report its own outage.
  - The dashboard shows **Automation offline** once the heartbeat is older than 3 minutes.
  - `GET /api/health/n8n` returns `503` for an external uptime monitor.
- **Model usage missing** from a response: stored as *unavailable*, never as zero.
