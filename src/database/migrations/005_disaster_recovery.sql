-- 005: Disaster Recovery Tables
-- Backup records, restore points, failover events, and DR drill results

CREATE TABLE IF NOT EXISTS backup_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_type TEXT NOT NULL CHECK (backup_type IN ('full','incremental','wal_archive')),
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','failed','verified','expired')),
  region TEXT NOT NULL,
  size_bytes_estimate BIGINT DEFAULT 0,
  wal_position_start TEXT,
  wal_position_end TEXT,
  checksum_sha256 TEXT,
  encryption_key_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  metadata JSONB DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS restore_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id UUID NOT NULL REFERENCES backup_records(id),
  target_timestamp TIMESTAMPTZ,
  target_wal_position TEXT,
  status TEXT NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated','restoring','verifying','completed','failed')),
  initiated_by TEXT NOT NULL,
  approved_by TEXT,
  region TEXT NOT NULL,
  verification_result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS failover_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  failover_id TEXT UNIQUE NOT NULL,
  target_region TEXT NOT NULL,
  reason TEXT NOT NULL,
  initiated_by TEXT NOT NULL,
  forced BOOLEAN DEFAULT FALSE,
  replica_lag_ms NUMERIC DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated','in_progress','completed','failed','rolled_back')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS dr_drill_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drill_id TEXT UNIQUE NOT NULL,
  backup_id UUID NOT NULL REFERENCES backup_records(id),
  duration_ms INTEGER NOT NULL,
  meets_rto BOOLEAN NOT NULL,
  verification JSONB NOT NULL,
  initiated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_backup_records_status ON backup_records(status);
CREATE INDEX idx_backup_records_region ON backup_records(region);
CREATE INDEX idx_backup_records_expires ON backup_records(expires_at);
CREATE INDEX idx_restore_points_status ON restore_points(status);
CREATE INDEX idx_failover_events_region ON failover_events(target_region);
