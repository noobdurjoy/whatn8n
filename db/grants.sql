-- db/grants.sql: idempotent grants for the n8n workflow role (wa_n8n).
-- scripts/migrate.mjs runs this after every migration run.

-- Every app function runs with its owner's rights and a fixed search_path,
-- and nobody may execute it unless granted explicitly (PUBLIC is revoked).
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER SET search_path = app, pg_temp', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wa_n8n') THEN
    -- Functions default to no EXECUTE for PUBLIC (migration 0004).
    GRANT USAGE ON SCHEMA app TO wa_n8n;
    GRANT EXECUTE ON FUNCTION
      app.start_ai_job(uuid, text, uuid, bigint, uuid),
      app.ai_job_is_current(uuid),
      app.submit_ai_result(uuid, text, text, text, jsonb, jsonb),
      app.fail_ai_job(uuid, text),
      app.take_over(uuid, text, uuid, text, jsonb, boolean),
      app.set_automation_hold(uuid, text, jsonb),
      app.claim_outbound(uuid, text),
      app.record_send_result(uuid, integer, text, integer, text, jsonb, jsonb, integer),
      app.expire_send_leases(),
      app.resolve_unknown_send(uuid, text, uuid, text, jsonb),
      app.get_ai_context(uuid, integer),
      app.search_knowledge(text, integer),
      app.escalation_state(uuid),
      app.find_image_analysis(uuid, text, text),
      app.get_attachment_for_job(uuid, uuid),
      app.record_ai_usage(uuid, text, jsonb),
      app.ai_budget_status(),
      app.store_image_analysis(uuid, uuid, text, text, text, text, jsonb, text, uuid),
      app.store_attachment_blob(uuid, text, text, integer, text[]),
      app.mark_attachment_fetch_failed(uuid, text, text),
      app.upsert_customer_memory(uuid, text, text, uuid, text),
      app.upsert_conversation_summary(uuid, text, jsonb, jsonb, timestamptz),
      app.order_access_for_job(uuid, bigint),
      app.propose_order_operation(uuid, text, text, bigint, jsonb, jsonb),
      app.confirm_order_operation(uuid, text, uuid),
      app.claim_order_operation(uuid),
      app.finish_order_operation(uuid, text, bigint, jsonb),
      app.submit_knowledge_proposal(text, uuid, text, text, text, text, jsonb, jsonb, text),
      app.raise_alert(text, text, text, jsonb, text),
      app.setting(text), app.setting_bool(text, boolean), app.setting_int(text, integer)
    TO wa_n8n;
    -- Read access needed by the workflows, and the WooCommerce sync tables.
    GRANT SELECT ON app.settings, app.prompt_versions, app.conversations, app.messages, app.attachments,
                    app.channel_accounts, app.outbound_messages, app.webhook_events, app.ai_jobs, app.ai_drafts,
                    app.feedback, app.knowledge_documents, app.knowledge_versions, app.woo_products, app.woo_order_refs,
                    app.pending_order_operations, app.health_checks, app.alerts, app.order_verifications
      TO wa_n8n;
    GRANT INSERT, UPDATE, DELETE ON app.woo_products, app.woo_order_refs TO wa_n8n;
    GRANT INSERT, UPDATE ON app.health_checks, app.order_verifications TO wa_n8n;
    GRANT UPDATE (processing_status, attempts, next_attempt_at, last_error, processed_at) ON app.webhook_events TO wa_n8n;
    GRANT UPDATE (notified_at) ON app.alerts TO wa_n8n;
  END IF;
END $$;

