-- Migration: 002_tokenization_schema.sql
-- Tokenization platform: asset registry, token lifecycle, cap table,
-- compliance rules, corporate actions, and audit trail.

BEGIN;

-- ============================================================
-- ASSETS: Real-world and digital asset registry
-- ============================================================
CREATE TABLE assets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  external_id VARCHAR(255) UNIQUE NOT NULL,
  asset_type VARCHAR(50) NOT NULL CHECK (asset_type IN (
    'real_estate', 'commodity', 'security', 'art', 'fund', 'bond', 'digital'
  )),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  issuer_id UUID NOT NULL REFERENCES accounts(id),
  valuation BIGINT,
  valuation_currency VARCHAR(10),
  jurisdiction VARCHAR(10),
  legal_doc_refs JSONB DEFAULT '[]',
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'active', 'suspended', 'retired'
  )),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_assets_external_id ON assets(external_id);
CREATE INDEX idx_assets_issuer ON assets(issuer_id);
CREATE INDEX idx_assets_type ON assets(asset_type);
CREATE INDEX idx_assets_status ON assets(status);

-- ============================================================
-- TOKEN DEFINITIONS: On-chain token contracts
-- ============================================================
CREATE TABLE token_definitions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  asset_id UUID REFERENCES assets(id),
  treasury_account_id UUID NOT NULL REFERENCES accounts(id),
  symbol VARCHAR(20) NOT NULL,
  name VARCHAR(255) NOT NULL,
  token_standard VARCHAR(20) NOT NULL CHECK (token_standard IN ('ERC-20', 'ERC-721')),
  decimals INT NOT NULL DEFAULT 18 CHECK (decimals >= 0 AND decimals <= 18),
  max_supply BIGINT CHECK (max_supply IS NULL OR max_supply > 0),
  total_minted BIGINT NOT NULL DEFAULT 0 CHECK (total_minted >= 0),
  total_burned BIGINT NOT NULL DEFAULT 0 CHECK (total_burned >= 0),
  contract_address VARCHAR(255),
  chain VARCHAR(50),
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'active', 'paused', 'retired'
  )),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_token_defs_asset ON token_definitions(asset_id);
CREATE INDEX idx_token_defs_symbol ON token_definitions(symbol);
CREATE INDEX idx_token_defs_contract ON token_definitions(contract_address);
CREATE INDEX idx_token_defs_status ON token_definitions(status);

-- ============================================================
-- TOKEN HOLDERS: Cap table
-- ============================================================
CREATE TABLE token_holders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_id UUID NOT NULL REFERENCES token_definitions(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  holder_address VARCHAR(255),
  balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  ownership_bps INT NOT NULL DEFAULT 0 CHECK (ownership_bps >= 0 AND ownership_bps <= 10000),
  kyc_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (kyc_status IN (
    'pending', 'approved', 'rejected', 'expired'
  )),
  accredited_investor BOOLEAN NOT NULL DEFAULT FALSE,
  investor_jurisdiction VARCHAR(10),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'frozen', 'removed'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_token_holders_unique ON token_holders(token_id, account_id);
CREATE INDEX idx_token_holders_token ON token_holders(token_id);
CREATE INDEX idx_token_holders_account ON token_holders(account_id);
CREATE INDEX idx_token_holders_status ON token_holders(token_id, status);

-- ============================================================
-- TRANSFER RESTRICTIONS: Per-token compliance rules
-- ============================================================
CREATE TABLE transfer_restrictions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_id UUID NOT NULL REFERENCES token_definitions(id),
  restriction_type VARCHAR(30) NOT NULL CHECK (restriction_type IN (
    'whitelist', 'jurisdiction_block', 'lockup', 'max_holders',
    'min_holding', 'max_holding'
  )),
  config JSONB NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_restrictions_token ON transfer_restrictions(token_id);
CREATE INDEX idx_restrictions_active ON transfer_restrictions(token_id, active)
  WHERE active = TRUE;

-- ============================================================
-- WHITELIST ENTRIES: Address-level allow list per token
-- ============================================================
CREATE TABLE whitelist_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_id UUID NOT NULL REFERENCES token_definitions(id),
  address VARCHAR(255) NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_whitelist_token_address ON whitelist_entries(token_id, address);
CREATE INDEX idx_whitelist_token ON whitelist_entries(token_id);

-- ============================================================
-- TOKEN OPERATIONS: Append-only audit log
-- ============================================================
CREATE TABLE token_operations (
  id BIGSERIAL PRIMARY KEY,
  token_id UUID NOT NULL REFERENCES token_definitions(id),
  operation_type VARCHAR(30) NOT NULL CHECK (operation_type IN (
    'mint', 'burn', 'freeze', 'unfreeze', 'transfer', 'force_transfer'
  )),
  from_account_id UUID REFERENCES accounts(id),
  to_account_id UUID REFERENCES accounts(id),
  amount BIGINT,
  journal_entry_id UUID REFERENCES journal_entries(id),
  tx_blockchain_id UUID REFERENCES transactions_blockchain(id),
  operator_id VARCHAR(255),
  reason TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_token_ops_token ON token_operations(token_id);
CREATE INDEX idx_token_ops_type ON token_operations(token_id, operation_type);
CREATE INDEX idx_token_ops_journal ON token_operations(journal_entry_id);
CREATE INDEX idx_token_ops_created ON token_operations(created_at);

-- Append-only: reuse the existing prevent_ledger_mutation trigger function
CREATE TRIGGER trg_token_ops_no_update
  BEFORE UPDATE ON token_operations
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TRIGGER trg_token_ops_no_delete
  BEFORE DELETE ON token_operations
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

-- ============================================================
-- CORPORATE ACTIONS: Dividends, votes, splits
-- ============================================================
CREATE TABLE corporate_actions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_id UUID NOT NULL REFERENCES token_definitions(id),
  action_type VARCHAR(30) NOT NULL CHECK (action_type IN (
    'dividend', 'interest_payment', 'vote', 'stock_split'
  )),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  record_date TIMESTAMPTZ,
  payment_date TIMESTAMPTZ,
  per_token_amount BIGINT,
  vote_options JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'announced', 'record_set', 'processing', 'completed', 'cancelled'
  )),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_corp_actions_token ON corporate_actions(token_id);
CREATE INDEX idx_corp_actions_status ON corporate_actions(status);
CREATE INDEX idx_corp_actions_record_date ON corporate_actions(record_date);

-- ============================================================
-- CORPORATE ACTION DISTRIBUTIONS: Per-holder records
-- ============================================================
CREATE TABLE corporate_action_distributions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  action_id UUID NOT NULL REFERENCES corporate_actions(id),
  holder_id UUID NOT NULL REFERENCES token_holders(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  eligible_balance BIGINT NOT NULL CHECK (eligible_balance >= 0),
  distribution_amount BIGINT,
  journal_entry_id UUID REFERENCES journal_entries(id),
  vote_choice VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processed', 'failed'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_distributions_action ON corporate_action_distributions(action_id);
CREATE INDEX idx_distributions_holder ON corporate_action_distributions(holder_id);
CREATE INDEX idx_distributions_status ON corporate_action_distributions(action_id, status);

-- ============================================================
-- ALTER reconciliation_runs to support token_balance run type
-- ============================================================
ALTER TABLE reconciliation_runs
  DROP CONSTRAINT IF EXISTS reconciliation_runs_run_type_check;

ALTER TABLE reconciliation_runs
  ADD CONSTRAINT reconciliation_runs_run_type_check
  CHECK (run_type IN ('balance', 'hash_chain', 'cross_system', 'token_balance'));

-- ============================================================
-- PERMISSIONS
-- ============================================================
-- Reader: SELECT on all new tables
GRANT SELECT ON assets TO ledger_reader;
GRANT SELECT ON token_definitions TO ledger_reader;
GRANT SELECT ON token_holders TO ledger_reader;
GRANT SELECT ON transfer_restrictions TO ledger_reader;
GRANT SELECT ON whitelist_entries TO ledger_reader;
GRANT SELECT ON token_operations TO ledger_reader;
GRANT SELECT ON corporate_actions TO ledger_reader;
GRANT SELECT ON corporate_action_distributions TO ledger_reader;

-- Writer: INSERT + UPDATE on mutable tables, INSERT-only on append-only tables
GRANT SELECT ON assets TO ledger_writer;
GRANT INSERT, UPDATE ON assets TO ledger_writer;
GRANT SELECT ON token_definitions TO ledger_writer;
GRANT INSERT, UPDATE ON token_definitions TO ledger_writer;
GRANT SELECT ON token_holders TO ledger_writer;
GRANT INSERT, UPDATE ON token_holders TO ledger_writer;
GRANT SELECT ON transfer_restrictions TO ledger_writer;
GRANT INSERT, UPDATE ON transfer_restrictions TO ledger_writer;
GRANT SELECT ON whitelist_entries TO ledger_writer;
GRANT INSERT, DELETE ON whitelist_entries TO ledger_writer;
GRANT SELECT ON token_operations TO ledger_writer;
GRANT INSERT ON token_operations TO ledger_writer;
GRANT SELECT ON corporate_actions TO ledger_writer;
GRANT INSERT, UPDATE ON corporate_actions TO ledger_writer;
GRANT SELECT ON corporate_action_distributions TO ledger_writer;
GRANT INSERT, UPDATE ON corporate_action_distributions TO ledger_writer;

-- Sequences for new serial columns
GRANT USAGE, SELECT ON SEQUENCE token_operations_id_seq TO ledger_writer;

COMMIT;
