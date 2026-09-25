-- Run ONCE as a PostgreSQL superuser, before migrations, with real passwords:
--   psql -v app_pw="'...'" -v n8n_pw="'...'" -f db/roles.sql
-- The application database must be separate from n8n's own database.

CREATE ROLE wa_app LOGIN PASSWORD :app_pw;
CREATE ROLE wa_n8n LOGIN PASSWORD :n8n_pw;
CREATE DATABASE wa_support OWNER wa_app;
\connect wa_support
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CREATE, USAGE ON SCHEMA public TO wa_app;
-- Extensions need superuser on most hosts; create them here.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Run migrations afterwards as wa_app (npm run db:migrate). Migration 0004
-- grants wa_n8n exactly the functions and tables it needs; re-run
-- `psql -f db/grants.sql` if you create wa_n8n after migrating.
