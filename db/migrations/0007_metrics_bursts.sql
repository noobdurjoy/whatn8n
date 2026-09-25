-- 0007_metrics_bursts.sql
-- WhatsApp timestamps have whole-second precision, so two messages in one
-- burst can share sent_at. Order bursts by (sent_at, recorded_at).

BEGIN;
SET search_path = app, public;

CREATE OR REPLACE FUNCTION app.metrics(p_from timestamptz, p_to timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  WITH inbound AS (
    SELECT m.conversation_id, m.sent_at,
           (SELECT min(o.sent_at) FROM app.messages o
             WHERE o.conversation_id = m.conversation_id AND o.direction = 'outbound'
               AND o.author_type IN ('ai', 'staff', 'external_human') AND o.sent_at >= m.sent_at) AS answered_at
    FROM app.messages m
    JOIN app.conversations cv ON cv.id = m.conversation_id AND NOT cv.is_sandbox
    WHERE m.direction = 'inbound' AND NOT m.is_historical AND m.sent_at BETWEEN p_from AND p_to
      AND NOT EXISTS (SELECT 1 FROM app.messages p WHERE p.conversation_id = m.conversation_id AND p.direction = 'inbound'
                        AND (p.sent_at, p.recorded_at) < (m.sent_at, m.recorded_at)
                        AND p.sent_at > m.sent_at - interval '10 minutes')
  )
  SELECT jsonb_build_object(
    'window', jsonb_build_object('from', p_from, 'to', p_to),
    'first_response_seconds_median', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM answered_at - sent_at))
                                      FROM inbound WHERE answered_at IS NOT NULL),
    'first_response_seconds_p90', (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM answered_at - sent_at))
                                   FROM inbound WHERE answered_at IS NOT NULL),
    'unanswered_customer_bursts', (SELECT count(*) FROM inbound WHERE answered_at IS NULL),
    'unresolved_conversations', (SELECT count(*) FROM app.conversations WHERE status IN ('open', 'pending') AND NOT is_sandbox),
    'waiting_for_staff', (SELECT count(*) FROM app.conversations WHERE queue_state = 'waiting_staff' AND status IN ('open', 'pending')),
    'handoffs', (SELECT jsonb_object_agg(reason, n) FROM (
                   SELECT split_part(reason, ':', 1) AS reason, count(*) AS n FROM app.mode_changes
                   WHERE to_mode = 'HUMAN' AND at BETWEEN p_from AND p_to GROUP BY 1) h),
    'messages_sent', (SELECT jsonb_object_agg(author_type, n) FROM (
                        SELECT author_type, count(*) AS n FROM app.messages m JOIN app.conversations cv ON cv.id = m.conversation_id
                        WHERE direction = 'outbound' AND NOT cv.is_sandbox AND sent_at BETWEEN p_from AND p_to GROUP BY 1) s),
    'drafts', (SELECT jsonb_object_agg(status, n) FROM (
                 SELECT d.status, count(*) AS n FROM app.ai_drafts d JOIN app.conversations cv ON cv.id = d.conversation_id
                 WHERE NOT cv.is_sandbox AND d.created_at BETWEEN p_from AND p_to GROUP BY 1) d),
    'customer_feedback_avg', (SELECT avg(rating) FROM app.feedback WHERE source = 'customer' AND rating IS NOT NULL
                                AND created_at BETWEEN p_from AND p_to),
    'ai_cost_usd', (SELECT sum(cost_usd) FROM app.ai_usage WHERE created_at BETWEEN p_from AND p_to),
    'ai_calls', (SELECT count(*) FROM app.ai_usage WHERE created_at BETWEEN p_from AND p_to),
    'ai_calls_usage_unavailable', (SELECT count(*) FROM app.ai_usage WHERE created_at BETWEEN p_from AND p_to AND NOT usage_available),
    'orders_created_in_chat', (SELECT count(*) FROM app.pending_order_operations
                               WHERE op_type = 'create_order' AND status = 'succeeded' AND updated_at BETWEEN p_from AND p_to),
    'orders_chat_assisted_paid', (SELECT count(DISTINCT r.woo_order_id) FROM app.woo_order_refs r
                                  JOIN app.order_links l ON l.woo_order_id = r.woo_order_id AND l.revoked_at IS NULL
                                  JOIN app.conversations c ON c.customer_id = l.customer_id
                                  WHERE r.date_paid BETWEEN p_from AND p_to
                                    AND EXISTS (SELECT 1 FROM app.messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound'
                                                  AND m.sent_at BETWEEN r.date_paid - interval '72 hours' AND r.date_paid))
  )
$$;
REVOKE ALL ON FUNCTION app.metrics(timestamptz, timestamptz) FROM PUBLIC;

INSERT INTO app.schema_migrations (version) VALUES ('0007_metrics_bursts');
COMMIT;
