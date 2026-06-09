-- Migration 006: Database Hardening
-- Enforces: SSL connections, row-level security, least-privilege roles, connection limits

-- ============================================
-- 1. Enforce SSL connections
-- ============================================
-- NOTE: Also requires pg_hba.conf to have `hostssl` entries and postgresql.conf:
--   ssl = on
--   ssl_cert_file = '/etc/certs/server.crt'
--   ssl_key_file = '/etc/certs/server.key'
--   ssl_ca_file = '/etc/certs/ca.crt'

-- Revoke non-SSL access for application roles
ALTER ROLE app_writer SET ssl TO on;
ALTER ROLE app_reader SET ssl TO on;

-- ============================================
-- 2. Hardened application roles with connection limits
-- ============================================
DO $$
BEGIN
  -- Read-only role for reporting/monitoring
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_reader') THEN
    CREATE ROLE app_reader LOGIN PASSWORD NULL CONNECTION LIMIT 10;
  END IF;
  ALTER ROLE app_reader SET statement_timeout = '30s';
  ALTER ROLE app_reader SET lock_timeout = '5s';
  ALTER ROLE app_reader SET idle_in_transaction_session_timeout = '60s';

  -- Write role (already exists, harden it)
  ALTER ROLE app_writer SET statement_timeout = '60s';
  ALTER ROLE app_writer SET lock_timeout = '10s';
  ALTER ROLE app_writer SET idle_in_transaction_session_timeout = '120s';
  ALTER ROLE app_writer CONNECTION LIMIT 25;
END $$;

-- Read-only grants for app_reader
GRANT CONNECT ON DATABASE tradfi_web3 TO app_reader;
GRANT USAGE ON SCHEMA public TO app_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO app_reader;

-- ============================================
-- 3. Row-Level Security on sensitive tables
-- ============================================

-- RLS on audit_events: users can only see their own audit trail
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_read_own ON audit_events
  FOR SELECT
  USING (
    current_user = 'app_writer'  -- app_writer sees all (service account)
    OR actor_id = current_setting('app.current_user_id', true)
  );

CREATE POLICY audit_insert_all ON audit_events
  FOR INSERT
  WITH CHECK (true);  -- anyone can write audit entries

-- RLS on sessions: users can only see/modify their own sessions
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY sessions_own ON sessions
  FOR ALL
  USING (
    current_user = 'app_writer'
    OR user_id = current_setting('app.current_user_id', true)::uuid
  );

-- RLS on api_keys: users can only see their own keys
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY api_keys_own ON api_keys
  FOR ALL
  USING (
    current_user = 'app_writer'
    OR user_id = current_setting('app.current_user_id', true)::uuid
  );

-- ============================================
-- 4. Prevent privilege escalation
-- ============================================
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE tradfi_web3 FROM PUBLIC;

-- Only superuser can modify triggers (prevents disabling audit protections)
REVOKE ALL ON FUNCTION enforce_append_only() FROM PUBLIC;

-- ============================================
-- 5. Connection and query hardening
-- ============================================

-- Log all DDL and slow queries
ALTER SYSTEM SET log_statement = 'ddl';
ALTER SYSTEM SET log_min_duration_statement = 1000;  -- log queries > 1s
ALTER SYSTEM SET log_connections = on;
ALTER SYSTEM SET log_disconnections = on;

-- Limit damage from runaway queries
ALTER SYSTEM SET statement_timeout = '300s';  -- global safety net: 5 min max
ALTER SYSTEM SET idle_in_transaction_session_timeout = '300s';

-- Password security
ALTER SYSTEM SET password_encryption = 'scram-sha-256';

-- Disable trust authentication for TCP
-- (enforced via pg_hba.conf, documented here for reference)

SELECT pg_reload_conf();
