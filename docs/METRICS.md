# Metrics

**Operations → Metrics** (capability `view_metrics`) shows `app.metrics(from, to)` for the selected number of days. The same data is available at `GET /api/metrics?days=N`.

Three rules apply to all metrics:

- **Sandbox conversations** (the test area) are excluded everywhere.
- **Historical messages** (imported by J) are excluded from the response metrics.
- **Missing usage data** is never counted as zero.

## What is a customer burst?

A burst is a customer's messages sent within 10 minutes of each other; it counts as one question. Response metrics count per burst, so "hi / price? / netflix" sent together is one question, not three. A burst is **answered** by the first outgoing message after it from the AI, staff, or a human replying outside the dashboard (the Business app or the Zernio inbox). Automated notices do not count as an answer.

## Definitions

| Key | Definition |
| --- | --- |
| `first_response_seconds_median` / `_p90` | Median and 90th percentile of the time from the start of a customer burst in the window to the first answer. Only answered bursts count |
| `unanswered_customer_bursts` | Bursts in the window with no answer yet |
| `unresolved_conversations` | Conversations currently `open` or `pending` (a current count, not windowed) |
| `waiting_for_staff` | Open or pending conversations currently in the staff queue with nobody assigned (current count) |
| `handoffs` | Switches to HUMAN in the window, grouped by reason, for example: `staff_reply`, `staff_take_over`, `ai_handoff`, `customer_requested_human`, `external_human_reply`, `ai_budget_reached` |
| `messages_sent` | Outgoing messages in the window by author: `ai`, `staff`, `system`, `external_human`, … |
| `drafts` | Co-pilot drafts created in the window, by current status: `pending_review`, `approved`, `rejected`, `invalidated` |
| `customer_feedback_avg` | Average customer rating in the window. Empty when there is no feedback |
| `ai_cost_usd` | Sum of the cost OpenRouter reported for model calls in the window. Calls without usage data are **not** included; see the next row |
| `ai_calls` | Model calls recorded in the window (chat, vision, summaries, learning) |
| `ai_calls_usage_unavailable` | Calls whose response had no usage data. When this is above 0, `ai_cost_usd` is a lower bound |
| `orders_created_in_chat` | Order-creation operations that succeeded. The current flow uses WooCommerce's hosted checkout, so the AI never creates orders and this stays 0 unless that policy changes |
| `orders_chat_assisted_paid` | Paid WooCommerce orders (paid date in the window) linked to a customer who wrote to us in the 72 hours before payment. It shows association, not attribution. "Paid" comes only from WooCommerce |

## Health (not metrics)

**Operations → Connection health** lists the latest status for each component:

- the database;
- n8n maintenance (written every minute by I);
- backup;
- WhatsApp accounts.

Alerts appear under **Open alerts**. They are forwarded to Telegram when `notifications.telegram_enabled` is on.
