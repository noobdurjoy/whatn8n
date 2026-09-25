-- 0010_order_op_outcome.sql
-- Approved order operations are carried out by staff in WooCommerce (refunds
-- go through the payment gateway there). The proposals the AI records are free
-- text, so nothing executes them automatically. Staff record the outcome here.

BEGIN;
SET search_path = app, public;

CREATE FUNCTION app.record_order_operation_outcome(p_id uuid, p_staff uuid, p_outcome text, p_woo_order_id bigint DEFAULT NULL,
                                                   p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE p app.pending_order_operations;
BEGIN
  PERFORM app.require_cap(p_staff, 'order_approve');
  IF p_outcome NOT IN ('succeeded', 'failed') THEN RAISE EXCEPTION 'invalid outcome' USING ERRCODE = '22023'; END IF;
  SELECT * INTO p FROM app.pending_order_operations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation not found' USING ERRCODE = 'P0002'; END IF;
  -- 'unknown' comes from an interrupted execution and is settled the same way,
  -- after staff check the order in WooCommerce.
  IF p.status NOT IN ('approved', 'unknown') THEN RETURN jsonb_build_object('ok', false, 'reason', 'status_' || p.status); END IF;
  UPDATE app.pending_order_operations SET status = 'executing', updated_at = now() WHERE id = p_id;
  PERFORM app.finish_order_operation(p_id, p_outcome, p_woo_order_id,
                                     jsonb_build_object('recorded_by', p_staff, 'note', left(p_note, 500)));
  PERFORM app.audit('staff', p_staff, 'order_op.outcome_recorded', 'order_operation', p_id::text,
                    jsonb_build_object('type', p.op_type, 'outcome', p_outcome, 'woo_order_id', coalesce(p_woo_order_id, p.woo_order_id)));
  UPDATE app.alerts SET resolved_at = now(), resolved_by = p_staff
   WHERE resolved_at IS NULL AND kind = 'order_op_unknown' AND details ->> 'operation_id' = p.operation_id;
  RETURN jsonb_build_object('ok', true, 'status', p_outcome);
END $$;

INSERT INTO app.schema_migrations (version) VALUES ('0010_order_op_outcome');
COMMIT;
