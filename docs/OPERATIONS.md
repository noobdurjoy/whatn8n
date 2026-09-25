# Operations

## Deploy an update

```bash
git pull
docker compose build app
docker compose run --rm app node scripts/migrate.mjs   # applies new migrations, re-applies grants
docker compose run --rm app node scripts/seed.mjs      # adds new default settings; never overwrites existing ones
docker compose up -d app
```

**n8n changes.** Edit `n8n/code/src` or `n8n/workflows.mjs` and never the generated JSON. Then:

1. Run `npm run n8n:build && node n8n/workflows.mjs`.
2. Commit the result.
3. Apply it to the instance, either by importing the changed `n8n/workflows/*.json` or through the n8n MCP tools.
4. Verify the instance against the repo:

   ```bash
   node scripts/verify-n8n-export.mjs exported/*.json   # every workflow must print OK
   ```

Before every deploy, run `npm run typecheck && npm test`. The integration tests plan every workflow query as `wa_n8n`, so a missing grant fails the tests before it can fail in production.

## Backup and restore

The application database is the only state that must be backed up. It holds chats, settings, knowledge and audit. n8n keeps no chat data, and its execution data for successful runs is off in C, I, J, A2 and B2.

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

1. Stop the app and unpublish the n8n workflows.
2. Create an empty database with `db/roles.sql` (or `createdb -O wa_app wa_support`, plus the `citext` and `pg_trgm` extensions).
3. Run:

   ```bash
   DATABASE_URL=postgresql://wa_app:...@localhost/wa_support scripts/restore.sh /var/backups/wa-support/wa_support-<stamp>.dump
   ```

   The script refuses to restore into a database that already has tables. It re-applies the `wa_n8n` grants and sets `ai_enabled = false`.
4. Start the app, check **Operations**, publish the workflows, and turn AI on again deliberately.

## Daily operation

- **Inbox.** Conversations waiting for staff come first. Take over, reply, add notes, assign, tag.
  - A staff reply in AUTO mode takes the conversation over in the same transaction.
  - **Resume AI** hands the conversation back to AUTO. Admins can always do this; agents only if `agents_can_resume_ai` is on.
- **Drafts (COPILOT).** Approve, edit or discard. A draft becomes invalid when the customer writes again or the mode changes.
- **Order requests.** A request the AI recorded shows under *Order requests* in the customer panel. Admins and owners:
  1. approve or reject the request;
  2. make the change in WooCommerce;
  3. click **Done in WooCommerce** or **Could not do it**.
- **Knowledge.** H proposes updates every night. Nothing reaches the AI until an admin approves and publishes it under **Knowledge**.
- **Prompts.** New prompt versions must pass a run in *Settings → Prompts & test area* before they can be published.

## Controls

| Control | Where | Effect |
| --- | --- | --- |
| **Turn AI off** | top bar (admin) | No new AI jobs; running jobs become stale; staff sending continues |
| **Stop all outgoing** | top bar (admin) | Emergency stop: every claim is refused, including staff replies, drafts, scheduled messages and retries. Incoming messages are still saved. Messages already with the provider cannot be recalled; the top bar shows how many are in flight |
| **Resume sending** | top bar (admin) | Queued messages are re-checked (mode, window, staleness) before sending |
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

**Send outcome unknown.** Every 5 minutes, I compares the message with Zernio's message list. It marks the message sent only when exactly one outgoing message with the same text exists. Otherwise it attaches the evidence to the alert. Check the customer's WhatsApp thread, then choose one of:

- **It was delivered**;
- **Retry**, which reuses the same Idempotency-Key and still passes every check;
- **Discard**.

Never retry without checking.

**Order request outcome unknown** (critical alert `order_op_unknown`). Check the order in WooCommerce, then record **Done in WooCommerce** or **Could not do it**. Recording the outcome resolves the alert.

**Webhooks stopped arriving.** Check these in order:

1. **Operations → Connection health**, and the Zernio account status.
2. An `account_disconnected` alert means reconnecting the number in Zernio.
3. `401` responses in the proxy log mean the webhook secret differs from `ZERNIO_WEBHOOK_SECRET`.

Stored events that were not processed are retried by the sweep (I, every minute, up to 10 attempts).

**n8n down.** Staff messages stay `queued` and AI jobs do not start, so nothing wrong is sent. When n8n returns:

- C's 15-second sweep sends the queued messages; each claim re-checks every control first.
- The backend sweep re-delivers routing calls that n8n missed.

**Database down.** The backend returns errors. n8n claims fail, so nothing is sent. Restore the database first, then check **Operations**.

**AI budget reached** (alert `ai_budget_reached`).

- New reply jobs hand their conversation to staff, with the fixed acknowledgment in AUTO mode.
- Vision, memory and learning skip their model calls.

Raise `ai_daily_budget_usd` in **Settings** if the spend is expected. The limit is a rolling 24 hours.

**Import earlier chat history.** An admin runs **J History Import** manually in n8n.

- It imports the history of every known WhatsApp conversation (up to 50 pages of 100 messages each) as *historical* messages.
- Historical messages are never answered and never count toward metrics.
- Running it twice does not duplicate messages.

**Personal data request.** From the customer panel:

- Export: `export_customer` (admin).
- Delete: `delete_customer` (owner, confirm with `DELETE`). It removes the customer's conversations, messages, attachments, image analyses, memories, identities, order links and raw webhook events. It keeps an anonymised customer row and audit entries without content.

## Retention

I applies `settings.retention` every day at 04:10 Asia/Dhaka:

| Data | Kept for |
| --- | --- |
| Message content | 730 days |
| Attachments | 180 days |
| Raw webhook payloads | 30 days |
| AI usage rows | 400 days |

Configure n8n's own execution pruning (`EXECUTIONS_DATA_PRUNE=true`, `EXECUTIONS_DATA_MAX_AGE`) on the n8n host.
