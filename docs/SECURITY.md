# Security

## Principles

- **Credentials stay on servers.**
  - Zernio, OpenRouter, WooCommerce and Telegram credentials live only in n8n's credential store.
  - The database password and the webhook secrets live only in the backend's `.env`.
  - The browser never receives a credential.
- **The database decides.** SQL functions enforce mode changes, takeover, send authorization, drafts, order-operation approval and knowledge publishing. The backend checks capabilities, and the database checks them again (`app.require_cap`).
- **Models propose; they never authorize.** A model output is data. It becomes a message only through `submit_ai_result` and the dispatcher's `claim_outbound`, both of which re-check:
  - the mode and `mode_version`;
  - the conversation revision;
  - the global switches;
  - the automation hold;
  - the 24-hour window;
  - rate limits.
- **One outbound path.** Workflow C sends:
  - AI replies;
  - staff replies;
  - approved drafts;
  - handoff acknowledgments;
  - scheduled and system messages;
  - retries.

  No other workflow or node calls the Zernio send endpoint.
- **Fail closed.** If the database or a permission check is unavailable, the claim fails and nothing is sent.

## Roles and capabilities

The same matrix is defined in `app.role_capabilities()` and `src/lib/permissions.ts`, and a test checks that the two are identical.

| Capability | Agent | Admin | Owner |
| --- | :-: | :-: | :-: |
| view, reply, note, takeover, set_copilot, approve_draft, assign_self, tag, tickets, request_ai_assist, view_orders | ✓ | ✓ | ✓ |
| resume_ai (hand a conversation back to AUTO) | only if `agents_can_resume_ai` | ✓ | ✓ |
| assign_any, global_ai, emergency_stop | | ✓ | ✓ |
| knowledge_review, settings, prompts, canned_manage | | ✓ | ✓ |
| export_customer, reconcile_send, order_approve, clear_hold | | ✓ | ✓ |
| view_audit, view_metrics, history_import | | ✓ | ✓ |
| delete_customer, manage_staff | | | ✓ |

Some settings are marked *owner only*. Every privileged action is written to `app.audit_log`, including:

- mode changes;
- global controls;
- approvals;
- settings and prompt changes;
- exports and deletions;
- staff changes.

## Authentication

- Staff passwords are hashed with Argon2 (`@node-rs/argon2`, 19 MiB memory, 2 passes) and must be at least 12 characters.
- Sessions:
  - are server-side;
  - use an `HttpOnly`, `SameSite=Strict` cookie, which is `Secure` when `COOKIE_SECURE=true`;
  - expire after `SESSION_TTL_HOURS`.
- Every state-changing request needs the per-session CSRF token (`X-CSRF-Token`).
- Webhooks:
  - Zernio: HMAC-SHA256 over the raw body (`X-Zernio-Signature`);
  - WooCommerce: base64 HMAC (`X-WC-Webhook-Signature`);
  - both compared in constant time.
- Backend → n8n and n8n → backend: separate random tokens in `X-Internal-Token` (Header Auth credentials in n8n).
- n8n → database: role `wa_n8n` can only execute the functions listed in `db/grants.sql`. Its only direct writes are:
  - alert notification timestamps;
  - health rows.

## AI boundaries

- **Allowlisted tools only:**
  - `search_products`, `get_product_details`;
  - `create_checkout_link`;
  - `verify_order_access`, `get_order_status`;
  - `propose_order_change`;
  - `search_knowledge`;
  - `analyze_image`;
  - `support_reply`, the final answer or handoff decision.
- Every tool argument is validated against a schema, and ids and quantities are range-checked.
- The model has no SQL, no arbitrary HTTP, and never sees credentials.
- **Untrusted content.** These are all passed as data and marked as such:
  - customer messages;
  - image contents;
  - product descriptions;
  - retrieved knowledge.

  They cannot change the mode, grant permissions, approve refunds or confirm payment.
- **Orders.** Private order details are shown only after ownership is verified. An order number alone is not enough: the order must already be linked to this customer, or its billing phone must equal the WhatsApp number the customer is writing from. A failed check does not reveal whether the order exists, and billing address, email and phone are never returned. Payment status comes only from WooCommerce. A customer's claim or a payment screenshot never marks an order paid; the vision prompt and the output validator both enforce this. Refunds, cancellations, address changes, renewals and access fixes are proposals that staff approve and carry out in WooCommerce.
- **Links.** A reply may contain only URLs that came from this turn's tool results (shop-domain product and checkout links) or approved knowledge. The validator rejects any other URL.
- **Vision.** Images are read from our own database and sent as base64 data URLs. Provider media URLs, file names and tokens are never put in prompts. The vision model returns observations only: it cannot send messages or call tools. Stale results (a newer message or a mode change arrived) are discarded.
- **No internal reasoning reaches customers.** Reasoning fields are dropped. Replies that claim to have looked at an image when none was analysed are rejected.
- **Output validation** (`shared/validate.js`). An AI reply gets one repair attempt, and is otherwise never sent (AUTO hands off to staff; COPILOT makes no draft) when it:
  - leaks internal content;
  - claims to have viewed an image that was not analysed;
  - says an order is paid without a WooCommerce-verified paid order;
  - quotes a price without live tool data;
  - contains a URL that is not allowed;
  - replies in HUMAN mode;
  - cites a reference that was not in the context.

## Data handling

- **Redaction.** Before text reaches a model context, a summary, a memory, a knowledge proposal or a routine log, API keys, passwords, OTPs, card numbers and login-token links are removed (`shared/redact.js`).
- **Knowledge.** Raw private chats are never put in the shared knowledge index. H proposes generalized, redacted entries with evidence references. An admin approves them, then publishes them.
- **Attachments.**
  - Downloaded only through Zernio's authenticated media endpoint, on the fixed host `zernio.com`, and never from URLs found inside messages.
  - The MIME type is checked against the allowlist, the size limit is enforced, and the content is hashed and stored in the database.
  - Staff open attachments only through the authenticated `/api/attachments/:id`.
  - Staff uploads are type- and size-checked the same way.
- **Logs.** The backend logs contain event ids and error codes, not message bodies. n8n does not save data for successful runs in C, I, J, A2 or B2.
- **Retention and deletion.** See OPERATIONS (Retention, Personal data request).

## Reporting a problem

If you suspect a leaked credential:

1. Rotate it in the provider's console.
2. Update the n8n credential or `.env`.
3. Restart the app.
4. Check `app.audit_log` and the n8n executions for the affected period.
