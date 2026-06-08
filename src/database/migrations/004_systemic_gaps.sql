-- Migration: 004_systemic_gaps.sql
-- Adds: DLQ, decimal precision columns, price oracle, lending/margin,
-- FX engine, and DB-enforced state machine triggers.

BEGIN;

-- ============================================================
-- DEAD LETTER QUEUE
-- ============================================================

CREATE TABLE dead_letter_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  original_topic VARCHAR(255) NOT NULL,
  original_key VARCHAR(255),
  payload TEXT NOT NULL,
  error_message TEXT NOT NULL,
  retry_count INT NOT NULL DEFAULT 0,
  max_retries INT NOT NULL DEFAULT 5,
  next_retry_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'retrying', 'exhausted', 'resolved'
  )),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dlq_status_retry ON dead_letter_queue(status, next_retry_at)
  WHERE status = 'pending';
CREATE INDEX idx_dlq_topic ON dead_letter_queue(original_topic);

-- ============================================================
-- PRICE ORACLE
-- ============================================================

CREATE TABLE price_quotes (
  id BIGSERIAL PRIMARY KEY,
  source VARCHAR(100) NOT NULL,
  pair VARCHAR(50) NOT NULL,
  price NUMERIC(38,18) NOT NULL,
  volume NUMERIC(38,18) NOT NULL DEFAULT 0,
  quoted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_price_quotes_pair ON price_quotes(pair, quoted_at DESC);
CREATE INDEX idx_price_quotes_source ON price_quotes(source, pair);

-- ============================================================
-- LENDING / MARGIN / LIQUIDATION
-- ============================================================

CREATE TABLE loans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  borrower_id UUID NOT NULL REFERENCES users(id),
  collateral_account_id UUID NOT NULL REFERENCES accounts(id),
  loan_account_id UUID NOT NULL REFERENCES accounts(id),
  collateral_asset VARCHAR(50) NOT NULL,
  loan_asset VARCHAR(50) NOT NULL,
  collateral_amount NUMERIC(38,18) NOT NULL,
  loan_amount NUMERIC(38,18) NOT NULL,
  interest_rate_bps INT NOT NULL,
  accrued_interest NUMERIC(38,18) NOT NULL DEFAULT 0,
  ltv NUMERIC(10,6) NOT NULL,
  liquidation_threshold NUMERIC(10,6) NOT NULL DEFAULT 0.85,
  margin_call_threshold NUMERIC(10,6) NOT NULL DEFAULT 0.75,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'active', 'margin_call', 'liquidating', 'repaid', 'defaulted'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_loans_borrower ON loans(borrower_id);
CREATE INDEX idx_loans_status ON loans(status);
CREATE INDEX idx_loans_margin ON loans(status, ltv)
  WHERE status IN ('active', 'margin_call');

-- ============================================================
-- FX ENGINE
-- ============================================================

CREATE TABLE fx_rates (
  id BIGSERIAL PRIMARY KEY,
  pair VARCHAR(20) NOT NULL,
  bid NUMERIC(24,12) NOT NULL,
  ask NUMERIC(24,12) NOT NULL,
  mid NUMERIC(24,12) NOT NULL,
  spread_bps INT NOT NULL,
  source VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fx_rates_pair ON fx_rates(pair, created_at DESC);

CREATE TABLE fx_conversions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_currency VARCHAR(20) NOT NULL,
  to_currency VARCHAR(20) NOT NULL,
  from_amount NUMERIC(38,18) NOT NULL,
  to_amount NUMERIC(38,18) NOT NULL,
  rate NUMERIC(24,12) NOT NULL,
  spread_bps INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'quoted' CHECK (status IN (
    'quoted', 'executing', 'settled', 'failed', 'expired'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fx_conversions_status ON fx_conversions(status);

-- ============================================================
-- DECIMAL PRECISION COLUMNS (parallel to existing BIGINT columns)
-- ============================================================

-- Add NUMERIC columns alongside existing BIGINT for backward compatibility
ALTER TABLE balance_cache ADD COLUMN IF NOT EXISTS balance_precise NUMERIC(38,18);
ALTER TABLE treasury_positions ADD COLUMN IF NOT EXISTS quantity_precise NUMERIC(38,18);
ALTER TABLE treasury_positions ADD COLUMN IF NOT EXISTS current_value_precise NUMERIC(38,18);

-- ============================================================
-- DB-ENFORCED STATE MACHINE TRIGGERS
-- ============================================================

-- Wallet transaction state machine: only valid transitions allowed
CREATE OR REPLACE FUNCTION enforce_tx_state_machine()
RETURNS TRIGGER AS $$
BEGIN
  -- Valid transitions for transactions_blockchain.status
  IF OLD.status = 'pending' AND NEW.status NOT IN ('signing', 'failed') THEN
    RAISE EXCEPTION 'Invalid state transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'signing' AND NEW.status NOT IN ('submitted', 'failed') THEN
    RAISE EXCEPTION 'Invalid state transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'submitted' AND NEW.status NOT IN ('confirmed', 'failed', 'reorged') THEN
    RAISE EXCEPTION 'Invalid state transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'confirmed' AND NEW.status NOT IN ('reorged') THEN
    RAISE EXCEPTION 'Invalid state transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status IN ('failed', 'reorged') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Cannot transition from terminal state: %', OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tx_state_machine
  BEFORE UPDATE OF status ON transactions_blockchain
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION enforce_tx_state_machine();

-- Settlement state machine
CREATE OR REPLACE FUNCTION enforce_settlement_state_machine()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status NOT IN ('matched', 'settling', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid settlement transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'matched' AND NEW.status NOT IN ('settling', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid settlement transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'settling' AND NEW.status NOT IN ('settled', 'failed') THEN
    RAISE EXCEPTION 'Invalid settlement transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status IN ('settled', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'Cannot transition from terminal state: %', OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_settlement_state_machine
  BEFORE UPDATE OF status ON settlement_instructions
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION enforce_settlement_state_machine();

-- Loan state machine
CREATE OR REPLACE FUNCTION enforce_loan_state_machine()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status NOT IN ('active') THEN
    RAISE EXCEPTION 'Invalid loan transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'active' AND NEW.status NOT IN ('margin_call', 'liquidating', 'repaid') THEN
    RAISE EXCEPTION 'Invalid loan transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'margin_call' AND NEW.status NOT IN ('active', 'liquidating', 'repaid') THEN
    RAISE EXCEPTION 'Invalid loan transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'liquidating' AND NEW.status NOT IN ('repaid', 'defaulted') THEN
    RAISE EXCEPTION 'Invalid loan transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status IN ('repaid', 'defaulted') THEN
    RAISE EXCEPTION 'Cannot transition from terminal loan state: %', OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_loan_state_machine
  BEFORE UPDATE OF status ON loans
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION enforce_loan_state_machine();

-- Approval request state machine
CREATE OR REPLACE FUNCTION enforce_approval_state_machine()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status NOT IN ('approved', 'rejected', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid approval transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'approved' AND NEW.status NOT IN ('executed') THEN
    RAISE EXCEPTION 'Invalid approval transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status IN ('rejected', 'expired', 'cancelled', 'executed') THEN
    RAISE EXCEPTION 'Cannot transition from terminal approval state: %', OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_approval_state_machine
  BEFORE UPDATE OF status ON approval_requests
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION enforce_approval_state_machine();

-- ============================================================
-- PERMISSIONS
-- ============================================================

GRANT SELECT ON dead_letter_queue, price_quotes, loans, fx_rates, fx_conversions TO ledger_reader;
GRANT SELECT, INSERT, UPDATE ON dead_letter_queue, price_quotes, loans, fx_rates, fx_conversions TO ledger_writer;
GRANT USAGE, SELECT ON SEQUENCE price_quotes_id_seq TO ledger_writer;
GRANT USAGE, SELECT ON SEQUENCE fx_rates_id_seq TO ledger_writer;

COMMIT;
