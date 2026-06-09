-- Migration 007: Domain Extensions
-- Tables for: custody, RWA, DvP, CCP, lending extensions, stablecoin, defi, compliance, fund NAV, bonds, ETF, unbanked

-- ============================================
-- Crypto Custody
-- ============================================
CREATE TABLE IF NOT EXISTS multisig_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  required_signatures INT NOT NULL,
  total_signers INT NOT NULL,
  signer_ids JSONB NOT NULL,
  applies_to_wallet_types JSONB NOT NULL,
  min_amount TEXT NOT NULL DEFAULT '0',
  max_amount TEXT,
  cooldown_minutes INT NOT NULL DEFAULT 60,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS withdrawal_whitelist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL,
  address TEXT NOT NULL,
  label TEXT NOT NULL,
  added_by TEXT NOT NULL,
  approved_by TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(wallet_id, address)
);

CREATE TABLE IF NOT EXISTS cold_storage_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_wallet_id UUID NOT NULL,
  destination_address TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount TEXT NOT NULL,
  policy_id UUID REFERENCES multisig_policies(id),
  status TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','approved','signing','broadcasting','confirmed','rejected')),
  required_signatures INT NOT NULL,
  signatures JSONB NOT NULL DEFAULT '[]',
  initiated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- RWA Tokenization
-- ============================================
CREATE TABLE IF NOT EXISTS investor_accreditations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income','net_worth','professional','entity_qualified')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','expired','rejected')),
  jurisdiction TEXT NOT NULL,
  verified_at TIMESTAMPTZ,
  verified_by TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS asset_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id TEXT NOT NULL,
  verification_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','disputed','stale')),
  oracle_source TEXT NOT NULL,
  verified_value TEXT NOT NULL,
  currency TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  next_verification_due TIMESTAMPTZ NOT NULL,
  attestation_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- DvP Settlement Extensions
-- ============================================
CREATE TABLE IF NOT EXISTS partial_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instruction_id UUID NOT NULL,
  settled_amount TEXT NOT NULL,
  remaining_amount TEXT NOT NULL,
  percentage NUMERIC NOT NULL,
  settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE settlement_instructions ADD COLUMN IF NOT EXISTS parent_instruction_id UUID;
ALTER TABLE settlement_instructions ADD COLUMN IF NOT EXISTS settled_amount TEXT;

CREATE TABLE IF NOT EXISTS buy_in_procedures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  failed_instruction_id UUID NOT NULL,
  failing_party_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  shortfall_amount TEXT NOT NULL,
  buy_in_price TEXT,
  status TEXT NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated','pending_execution','executed','cancelled')),
  deadline TIMESTAMPTZ NOT NULL,
  penalty_bps INT NOT NULL DEFAULT 100,
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- CCP Clearinghouse
-- ============================================
CREATE TABLE IF NOT EXISTS clearing_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','defaulting','terminated')),
  default_fund_contribution TEXT NOT NULL DEFAULT '0',
  initial_margin TEXT NOT NULL DEFAULT '0',
  variation_margin TEXT NOT NULL DEFAULT '0',
  position_limit TEXT NOT NULL DEFAULT '0',
  current_exposure TEXT NOT NULL DEFAULT '0',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS margin_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES clearing_members(id),
  margin_type TEXT NOT NULL CHECK (margin_type IN ('initial','variation')),
  amount TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','posted','failed')),
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS default_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES clearing_members(id),
  loss_amount TEXT NOT NULL,
  waterfall_steps JSONB NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stress_test_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_name TEXT NOT NULL,
  total_exposure TEXT NOT NULL,
  default_fund_adequacy NUMERIC NOT NULL,
  members_breaching JSONB NOT NULL DEFAULT '[]',
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- Lending Extensions
-- ============================================
CREATE TABLE IF NOT EXISTS haircut_schedules (
  asset TEXT PRIMARY KEY,
  haircut_pct NUMERIC NOT NULL,
  volatility_tier TEXT NOT NULL CHECK (volatility_tier IN ('low','medium','high')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS collateral_baskets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL,
  asset TEXT NOT NULL,
  amount TEXT NOT NULL,
  haircut_pct NUMERIC NOT NULL,
  effective_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rehypothecation_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collateral_id UUID NOT NULL UNIQUE,
  rehypothecation_pct NUMERIC NOT NULL DEFAULT 0,
  currently_rehypothecated TEXT NOT NULL DEFAULT '0',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS interest_rate_curves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  tenor_days JSONB NOT NULL,
  rates_bps JSONB NOT NULL,
  interpolation TEXT NOT NULL DEFAULT 'linear',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loan_syndications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL,
  total_amount TEXT NOT NULL,
  asset TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS syndication_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  syndication_id UUID NOT NULL REFERENCES loan_syndications(id),
  lender_id TEXT NOT NULL,
  commitment_amount TEXT NOT NULL,
  funded_amount TEXT NOT NULL DEFAULT '0',
  share_percentage NUMERIC NOT NULL
);

-- ============================================
-- Stablecoin Infrastructure
-- ============================================
CREATE TABLE IF NOT EXISTS stablecoin_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  op_type TEXT NOT NULL CHECK (op_type IN ('mint','redeem')),
  user_id TEXT NOT NULL,
  amount TEXT NOT NULL,
  collateral_amount TEXT NOT NULL,
  collateral_asset TEXT NOT NULL,
  fee TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','rejected')),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stablecoin_peg_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  current_price TEXT NOT NULL,
  target_price TEXT NOT NULL,
  deviation_bps INT NOT NULL,
  mechanism TEXT NOT NULL,
  reserve_ratio NUMERIC NOT NULL DEFAULT 1.0,
  last_action TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stablecoin_balances (
  user_id TEXT NOT NULL,
  balance TEXT NOT NULL DEFAULT '0',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id)
);

CREATE TABLE IF NOT EXISTS yield_distributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  distribution_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  amount TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- Permissioned DeFi
-- ============================================
CREATE TABLE IF NOT EXISTS verifiable_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holder_id TEXT NOT NULL,
  type TEXT NOT NULL,
  issuer TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  credential_hash TEXT NOT NULL,
  claims JSONB NOT NULL DEFAULT '{}',
  revoked BOOLEAN NOT NULL DEFAULT false,
  revocation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pool_access_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id TEXT NOT NULL,
  name TEXT NOT NULL,
  required_credentials JSONB NOT NULL DEFAULT '[]',
  min_access_level TEXT NOT NULL DEFAULT 'trade',
  max_participants INT,
  whitelist_only BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pool_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  access_level TEXT NOT NULL DEFAULT 'trade',
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(pool_id, holder_id)
);

-- ============================================
-- Onchain Compliance Extensions
-- ============================================
CREATE TABLE IF NOT EXISTS graph_analysis_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  root_address TEXT NOT NULL,
  nodes_analyzed INT NOT NULL,
  max_risk_score INT NOT NULL,
  analysis_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jurisdiction_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  threshold TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('block','flag','report','require_approval')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(jurisdiction, rule_type)
);

CREATE TABLE IF NOT EXISTS regulatory_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  record_count INT NOT NULL,
  format TEXT NOT NULL DEFAULT 'json',
  status TEXT NOT NULL DEFAULT 'generated' CHECK (status IN ('generated','submitted','accepted','rejected')),
  data JSONB
);

-- ============================================
-- Tokenized Fund NAV
-- ============================================
CREATE TABLE IF NOT EXISTS fund_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id TEXT NOT NULL,
  window_type TEXT NOT NULL CHECK (window_type IN ('subscription','redemption')),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','open','closed','processing','settled')),
  opens_at TIMESTAMPTZ NOT NULL,
  closes_at TIMESTAMPTZ NOT NULL,
  settlement_date TIMESTAMPTZ NOT NULL,
  nav_per_share TEXT,
  total_orders INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fund_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id TEXT NOT NULL,
  investor_id TEXT NOT NULL,
  order_type TEXT NOT NULL CHECK (order_type IN ('subscription','redemption')),
  amount TEXT NOT NULL,
  shares TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','settled','rejected')),
  window_id UUID REFERENCES fund_windows(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fund_performance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id TEXT NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  high_water_mark TEXT NOT NULL,
  performance_fee TEXT NOT NULL,
  fee_rate_bps INT NOT NULL,
  hurdle_rate_bps INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- Digital Bond Lifecycle
-- ============================================
CREATE TABLE IF NOT EXISTS bond_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bond_id TEXT NOT NULL UNIQUE,
  face_value TEXT NOT NULL,
  coupon_rate_bps INT NOT NULL,
  coupon_frequency TEXT NOT NULL,
  issue_date TIMESTAMPTZ NOT NULL,
  maturity_date TIMESTAMPTZ NOT NULL,
  day_count_convention TEXT NOT NULL DEFAULT '30/360',
  call_provisions JSONB NOT NULL DEFAULT '[]',
  put_provisions JSONB NOT NULL DEFAULT '[]',
  sinking_fund_schedule JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coupon_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bond_id TEXT NOT NULL,
  payment_date TIMESTAMPTZ NOT NULL,
  amount TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','paid','missed')),
  UNIQUE(bond_id, payment_date)
);

CREATE TABLE IF NOT EXISTS bond_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bond_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_date TIMESTAMPTZ NOT NULL,
  amount TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- Bitcoin ETF
-- ============================================
CREATE TABLE IF NOT EXISTS btc_utxos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  txid TEXT NOT NULL,
  vout INT NOT NULL,
  amount TEXT NOT NULL,
  address TEXT NOT NULL,
  confirmations INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unspent' CHECK (status IN ('unspent','reserved','spent','pending_confirmation')),
  reserved_for_basket_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(txid, vout)
);

CREATE TABLE IF NOT EXISTS etf_baskets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('creation','redemption')),
  ap_id TEXT NOT NULL,
  btc_amount TEXT NOT NULL,
  shares_amount TEXT NOT NULL,
  nav_per_share TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','settling','settled','rejected')),
  utxo_ids JSONB NOT NULL DEFAULT '[]',
  approved_by TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS intraday_nav (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  btc_price TEXT NOT NULL,
  total_btc_held TEXT NOT NULL,
  total_shares TEXT NOT NULL,
  inav_per_share TEXT NOT NULL,
  premium_discount_bps INT NOT NULL DEFAULT 0
);

-- ============================================
-- Unbanked/Underbanked Infrastructure
-- ============================================
CREATE TABLE IF NOT EXISTS tiered_kyc_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE,
  current_tier TEXT NOT NULL DEFAULT 'tier0' CHECK (current_tier IN ('tier0','tier1','tier2','tier3')),
  daily_limit TEXT NOT NULL DEFAULT '50',
  monthly_limit TEXT NOT NULL DEFAULT '200',
  single_tx_limit TEXT NOT NULL DEFAULT '25',
  verifications JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS remittance_corridors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_country TEXT NOT NULL,
  destination_country TEXT NOT NULL,
  source_currency TEXT NOT NULL,
  destination_currency TEXT NOT NULL,
  fee_fixed TEXT NOT NULL DEFAULT '0',
  fee_percent_bps INT NOT NULL DEFAULT 0,
  exchange_rate_markup_bps INT NOT NULL DEFAULT 0,
  max_amount TEXT NOT NULL,
  estimated_delivery_minutes INT NOT NULL DEFAULT 60,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS remittance_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  corridor_id UUID NOT NULL REFERENCES remittance_corridors(id),
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  source_amount TEXT NOT NULL,
  destination_amount TEXT NOT NULL,
  fee TEXT NOT NULL,
  exchange_rate TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated','processing','completed','failed','refunded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- Indexes
-- ============================================
CREATE INDEX IF NOT EXISTS idx_investor_accreditations_investor ON investor_accreditations(investor_id, status);
CREATE INDEX IF NOT EXISTS idx_asset_verifications_asset ON asset_verifications(asset_id, status);
CREATE INDEX IF NOT EXISTS idx_clearing_members_status ON clearing_members(status);
CREATE INDEX IF NOT EXISTS idx_collateral_baskets_loan ON collateral_baskets(loan_id);
CREATE INDEX IF NOT EXISTS idx_stablecoin_ops_user ON stablecoin_operations(user_id, status);
CREATE INDEX IF NOT EXISTS idx_verifiable_credentials_holder ON verifiable_credentials(holder_id, type, revoked);
CREATE INDEX IF NOT EXISTS idx_jurisdiction_rules_jurisdiction ON jurisdiction_rules(jurisdiction, enabled);
CREATE INDEX IF NOT EXISTS idx_fund_windows_fund ON fund_windows(fund_id, status);
CREATE INDEX IF NOT EXISTS idx_fund_orders_window ON fund_orders(window_id, status);
CREATE INDEX IF NOT EXISTS idx_bond_terms_bond ON bond_terms(bond_id);
CREATE INDEX IF NOT EXISTS idx_btc_utxos_status ON btc_utxos(status, confirmations);
CREATE INDEX IF NOT EXISTS idx_etf_baskets_status ON etf_baskets(status);
CREATE INDEX IF NOT EXISTS idx_tiered_kyc_user ON tiered_kyc_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_remittance_transfers_sender ON remittance_transfers(sender_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pool_participants_pool ON pool_participants(pool_id, holder_id);
