# Operations

## Deploy an update

```bash
git pull
docker compose build app
docker compose run --rm app node scripts/migrate.mjs   # applies new migrations, re-applies grants
docker compose run --rm app node scripts/seed.mjs      # adds new default settings; never overwrites existing ones
docker compose up -d app
```

**n8n changes.** There is one workflow, *Infinity Digital Shop — WhatsApp AI Support*. Edit `n8n/code/src` or `n8n/workflow.mjs`, never the generated JSON. Then:

1. Run `npm run n8n:build && node n8n/workflow.mjs`.
2. Run the tests (below) and commit the result.
3. Apply it to the instance by importing `n8n/workflow/ids-whatsapp-ai-support.json` over the existing workflow, or through the n8n MCP tools.
4. Re-attach credentials if n8n asks, run **Run Connection Check**, then publish.

Before every deploy, run `npm run typecheck && npm test`:
- the unit tests run every Code node in a copy of n8n's Code sandbox, which has no `URL` or `fetch`;
- the integration tests plan every workflow query as `wa_n8n`, so a missing grant fails before production.

For workflow changes, also run the end-to-end suite. It runs the real workflow in a local n8n against PostgreSQL and a provider mock:

```bash
npm install --prefix .e2e/n8n n8n    # once; n8n 2.x needs Node 24 (set N8N_NODE)
N8N_NODE=/path/to/node24 node tests/e2e/run.mjs --setup
```

## Backup and restore

The application database is the only state that must be backed up. It holds chats, settings, knowledge and audit. n8n keeps no chat data: the workflow saves no production execution data (success or failure).

```bash
# nightly, e.g. cron: 30 2 * * *
DATABASE_URL=postgresql://wa_app:...@localhost/wa_support BACKUP_DIR=/var/backups/wa-support KEEP_DAYS=14 scripts/backup.sh
```

`backup.sh` works in this order:

1. Writes a `pg_dump` in custom format with mode 600.
2. Checks that the dump is readable (`pg_restore --list`).
3. Deletes dumps older than `KEEP_DAYS`.
4. Records the result as the `backup` health component, shown under **Operations → Connection health**.

Copy the backup directory off the host, for example with restic or rclone. The dumps contain personal data, so encrypt them at rest.

**Restore.** Test this every quarter, on a scratch database:

1. Stop the app and unpublish the n8n workflow.
2. Create an empty database with `db/roles.sql` (or `createdb -O wa_app wa_support`, plus the `citext` and `pg_trgm` extensions).
3. Run:

   ```bash
   DATABASE_URL=postgresql://wa_app:...@localhost/wa_support scripts/restore.sh /var/backups/wa-support/wa_support-<stamp>.dump
   ```

   The script refuses to restore into a database that already has tables. It re-applies the `wa_n8n` grants and sets `ai_enabled = false`.
4. Start the app, check **Operations**, publish the workflow, and turn AI on again deliberately.

## Daily operation

- **Inbox.** Conversations waiting for staff come first. Take over, reply, add notes, assign, tag.
  - A staff reply in AUTO mode takes the conversation over in the same transaction.
  - **Resume AI** hands the conversation back to AUTO. Admins can always do this; agents only if `agents_can_resume_ai` is on.
- **Drafts (COPILOT).** Approve, edit or discard. A draft becomes invalid when the customer writes again or the mode changes.
- **Order requests** (staff-handled). A request the AI recorded (refund, cancellation, address change, renewal, access issue) shows under *Order requests* in the customer panel. **Nothing is changed automatically.** Admins and owners:
  1. approve or reject the request;
  2. make the change themselves in WooCommerce (refunds go through the payment gateway there);
  3. record what happened: **I did it in WooCommerce** or **Not done**.
- **Knowledge.** H proposes updates every night. Nothing reaches the AI until an admin approves and publishes it under **Knowledge**.
- **Prompts.** New prompt versions must pass a run in *Settings → Prompts & test area* before they can be published.

## Controls

| Control | Where | Effect |
| --- | --- | --- |
| **Turn AI off** | top bar (admin) | No new AI jobs; running jobs become stale; staff sending continues |
| **Stop all outgoing** | top bar (admin) | Emergency stop: every claim is refused, including staff replies, drafts, scheduled messages and retries. Incoming messages are still saved. Messages already with the provider cannot be recalled; the top bar shows how many are in flight |
| **Resume sending** | top bar (admin) | New messages are sent again. Messages that were queued or attempted during the stop stay **canceled**; resuming never releases them. Re-send by hand whatever is still needed |
| Take over / Resume AI | conversation header | Per conversation |
| Reviewed — allow AI again | conversation header | Clears an AI pause caused by an unknown outgoing origin |

## Runbooks

**Customer says they got no reply.** Open the conversation and check the outbound list.

| Status | Meaning |
| --- | --- |
| `blocked` | Cannot be sent; the message shows the reason, for example outside the 24 h window or the emergency stop |
| `failed` | The provider rejected it |
| `unknown` | Timeout or 5xx; see the next runbook |

If there is no row at all, check **Operations → Open alerts**, then the n8n executions of A and B.

**Send outcome unknown.** Every 5 minutes, the maintenance branch compares the message with Zernio's message list. It marks the message sent only when exactly one outgoing message with the same text exists. Otherwise it attaches the evidence to the alert. Check the customer's WhatsApp thread, then choose one of:

- **It was delivered**;
- **Retry**, which reuses the same Idempotency-Key and still passes every check;
- **Discard**.

Never retry without checking.

**Order request outcome unknown** (critical alert `order_op_unknown`). Check the order in WooCommerce, then record **I did it in WooCommerce** or **Not done**. Recording the outcome resolves the alert.

**Webhooks stopped arriving.** Check these in order:

1. **Operations → Connection health**, and the Zernio account status.
2. An `account_disconnected` alert means reconnecting the number in Zernio.
3. `401` responses in the proxy log mean the webhook secret differs from `ZERNIO_WEBHOOK_SECRET`.

Stored events that were not processed are retried by the event sweep (every minute, up to 10 attempts).

**n8n down** (**Automation offline** in the top bar; `/api/health/n8n` returns 503). Staff messages stay `queued` and AI jobs do not start, so nothing wrong is sent. Check that n8n is running and that the workflow is published. When n8n returns:

- C's 15-second sweep sends the queued messages; each claim re-checks every control first.
- The backend sweep re-delivers routing calls that n8n missed.

**AI reply interrupted** (alert `ai_job_interrupted`). n8n restarted or crashed while a reply was being generated. After 10 minutes the maintenance branch marks the job failed and hands the conversation to staff (with the fixed acknowledgement in AUTO). Answer the customer from the dashboard.

**Workflow error** (alert `workflow_error`). The alert names the failing node and the n8n execution id. Production execution data is not saved (privacy), so reproduce it with *Run Connection Check*, or a manual test on the test phone, before changing anything.

**Database down.** The backend returns errors. n8n claims fail, so nothing is sent. Restore the database first, then check **Operations**.

**AI budget reached** (alert `ai_budget_reached`).

- New reply jobs hand their conversation to staff, with the fixed acknowledgment in AUTO mode.
- Vision, memory and learning skip their model calls.

Raise `ai_daily_budget_usd` in **Settings** if the spend is expected. The limit is a rolling 24 hours.

**Import earlier chat history.** An admin opens the workflow in n8n and runs **Run History Import** (manual trigger, section 13).
- It imports the history of every known WhatsApp conversation (up to 50 pages of 100 messages each) as *historical* messages.
- Historical messages are never answered and never count toward metrics.
- Running it twice does not duplicate messages.

**Personal data request.** From the customer panel:

- Export: `export_customer` (admin).
- Delete: `delete_customer` (owner, confirm with `DELETE`). It removes the customer's conversations, messages, attachments, image analyses, memories, identities, order links and raw webhook events. It keeps an anonymised customer row and audit entries without content.

## Retention

The maintenance branch applies `settings.retention` every day at 04:10 Asia/Dhaka:

| Data | Kept for |
| --- | --- |
| Message content | 730 days |
| Attachments | 180 days |
| Raw webhook payloads | 30 days |
| AI usage rows | 400 days |

Configure n8n's own execution pruning (`EXECUTIONS_DATA_PRUNE=true`, `EXECUTIONS_DATA_MAX_AGE`) on the n8n host.
