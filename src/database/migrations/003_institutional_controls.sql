-- Migration: 003_institutional_controls.sql
-- Institutional web3 controls: IAM, governance, risk, compliance,
-- key management, settlement, monitoring, legal, vendor, and audit.

BEGIN;

-- ============================================================
-- IDENTITY & ACCESS MANAGEMENT
-- ============================================================

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'suspended', 'locked', 'deactivated'
  )),
  mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_secret VARCHAR(255),
  mfa_backup_codes JSONB,
  failed_login_attempts INT NOT NULL DEFAULT 0,
  last_login_at TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status);

CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  trust_domain VARCHAR(100),
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  max_transaction_limit BIGINT,
  daily_limit BIGINT,
  requires_mfa BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  resource VARCHAR(100) NOT NULL,
  action VARCHAR(50) NOT NULL,
  description TEXT,
  risk_level VARCHAR(20) NOT NULL DEFAULT 'low' CHECK (risk_level IN (
    'low', 'medium', 'high', 'critical'
  )),
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (resource, action)
);

CREATE TABLE user_roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id),
  role_id UUID NOT NULL REFERENCES roles(id),
  granted_by UUID REFERENCES users(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  justification TEXT,
  UNIQUE (user_id, role_id)
);

CREATE INDEX idx_user_roles_user ON user_roles(user_id);

CREATE TABLE role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id),
  permission_id UUID NOT NULL REFERENCES permissions(id),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id),
  token_hash VARCHAR(255) UNIQUE NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token_hash);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  name VARCHAR(255) NOT NULL,
  key_hash VARCHAR(255) UNIQUE NOT NULL,
  key_prefix VARCHAR(10) NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]',
  rate_limit_per_minute INT NOT NULL DEFAULT 100,
  ip_whitelist JSONB DEFAULT '[]',
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'revoked', 'expired'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);

-- ============================================================
-- AUDIT EVENTS (comprehensive audit trail with actor context)
-- ============================================================

CREATE TABLE audit_events (
  id BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  actor_id UUID REFERENCES users(id),
  actor_email VARCHAR(255),
  actor_ip VARCHAR(45),
  resource_type VARCHAR(100) NOT NULL,
  resource_id VARCHAR(255),
  action VARCHAR(50) NOT NULL,
  details JSONB DEFAULT '{}',
  risk_level VARCHAR(20) NOT NULL DEFAULT 'low' CHECK (risk_level IN (
    'low', 'medium', 'high', 'critical'
  )),
  outcome VARCHAR(20) NOT NULL DEFAULT 'success' CHECK (outcome IN (
    'success', 'failure', 'denied', 'error'
  )),
  correlation_id VARCHAR(255),
  session_id UUID REFERENCES sessions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_actor ON audit_events(actor_id);
CREATE INDEX idx_audit_resource ON audit_events(resource_type, resource_id);
CREATE INDEX idx_audit_type ON audit_events(event_type);
CREATE INDEX idx_audit_created ON audit_events(created_at);
CREATE INDEX idx_audit_risk ON audit_events(risk_level)
  WHERE risk_level IN ('high', 'critical');
CREATE INDEX idx_audit_correlation ON audit_events(correlation_id);

-- Append-only: no updates or deletes
CREATE TRIGGER trg_audit_no_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TRIGGER trg_audit_no_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

-- ============================================================
-- GOVERNANCE: Approval workflows (four-eyes, maker-checker, M-of-N)
-- ============================================================

CREATE TABLE approval_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  resource_type VARCHAR(100) NOT NULL,
  action VARCHAR(50) NOT NULL,
  min_approvers INT NOT NULL DEFAULT 1 CHECK (min_approvers >= 1),
  required_roles JSONB DEFAULT '[]',
  amount_threshold BIGINT,
  auto_reject_after_hours INT DEFAULT 24,
  requires_different_actors BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_approval_policies_resource ON approval_policies(resource_type, action);

CREATE TABLE approval_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  policy_id UUID NOT NULL REFERENCES approval_policies(id),
  requester_id UUID NOT NULL REFERENCES users(id),
  resource_type VARCHAR(100) NOT NULL,
  resource_id VARCHAR(255),
  action VARCHAR(50) NOT NULL,
  params JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'approved', 'rejected', 'expired', 'cancelled', 'executed'
  )),
  required_approvals INT NOT NULL DEFAULT 1,
  current_approvals INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_approval_requests_status ON approval_requests(status);
CREATE INDEX idx_approval_requests_requester ON approval_requests(requester_id);

CREATE TABLE approval_decisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id UUID NOT NULL REFERENCES approval_requests(id),
  approver_id UUID NOT NULL REFERENCES users(id),
  decision VARCHAR(20) NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, approver_id)
);

CREATE INDEX idx_approval_decisions_request ON approval_decisions(request_id);

-- ============================================================
-- GOVERNANCE: Timelocks
-- ============================================================

CREATE TABLE timelocks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operation_type VARCHAR(100) NOT NULL,
  resource_type VARCHAR(100) NOT NULL,
  resource_id VARCHAR(255),
  params JSONB NOT NULL DEFAULT '{}',
  delay_hours INT NOT NULL CHECK (delay_hours > 0),
  execute_after TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'executed', 'cancelled', 'overridden'
  )),
  created_by UUID NOT NULL REFERENCES users(id),
  cancelled_by UUID REFERENCES users(id),
  override_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_timelocks_status ON timelocks(status, execute_after);

-- ============================================================
-- RISK MANAGEMENT
-- ============================================================

CREATE TABLE risk_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  policy_type VARCHAR(50) NOT NULL CHECK (policy_type IN (
    'velocity', 'concentration', 'exposure', 'counterparty',
    'market', 'liquidity', 'operational'
  )),
  resource_type VARCHAR(100),
  config JSONB NOT NULL DEFAULT '{}',
  severity VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (severity IN (
    'low', 'medium', 'high', 'critical'
  )),
  action_on_breach VARCHAR(20) NOT NULL DEFAULT 'alert' CHECK (action_on_breach IN (
    'alert', 'block', 'require_approval', 'kill_switch'
  )),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_risk_policies_type ON risk_policies(policy_type);
CREATE INDEX idx_risk_policies_active ON risk_policies(active) WHERE active = TRUE;

CREATE TABLE risk_events (
  id BIGSERIAL PRIMARY KEY,
  policy_id UUID REFERENCES risk_policies(id),
  event_type VARCHAR(100) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'medium',
  resource_type VARCHAR(100),
  resource_id VARCHAR(255),
  actor_id UUID REFERENCES users(id),
  details JSONB NOT NULL DEFAULT '{}',
  action_taken VARCHAR(50),
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_risk_events_type ON risk_events(event_type);
CREATE INDEX idx_risk_events_severity ON risk_events(severity);
CREATE INDEX idx_risk_events_unresolved ON risk_events(resolved, created_at)
  WHERE resolved = FALSE;

CREATE TABLE circuit_breaker_state (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_name VARCHAR(100) UNIQUE NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'closed' CHECK (state IN (
    'closed', 'open', 'half_open'
  )),
  failure_count INT NOT NULL DEFAULT 0,
  success_count INT NOT NULL DEFAULT 0,
  failure_threshold INT NOT NULL DEFAULT 5,
  reset_timeout_seconds INT NOT NULL DEFAULT 60,
  last_failure_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  half_opened_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Kill switches for emergency shutdown of specific features
CREATE TABLE kill_switches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  feature VARCHAR(100) UNIQUE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  activated_by UUID REFERENCES users(id),
  activated_at TIMESTAMPTZ,
  reason TEXT,
  auto_reactivate_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- COMPLIANCE: AML/Sanctions/Travel Rule
-- ============================================================

CREATE TABLE sanctions_lists (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  list_type VARCHAR(50) NOT NULL CHECK (list_type IN (
    'OFAC_SDN', 'OFAC_SSI', 'UN', 'EU', 'UK_HMT', 'custom'
  )),
  entity_name VARCHAR(500),
  entity_type VARCHAR(50),
  addresses JSONB DEFAULT '[]',
  identifiers JSONB DEFAULT '{}',
  source_url TEXT,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sanctions_type ON sanctions_lists(list_type);
CREATE INDEX idx_sanctions_addresses ON sanctions_lists USING GIN (addresses);

CREATE TABLE screening_results (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  screening_type VARCHAR(50) NOT NULL CHECK (screening_type IN (
    'account', 'transaction', 'address', 'counterparty'
  )),
  subject_type VARCHAR(50) NOT NULL,
  subject_id VARCHAR(255) NOT NULL,
  sanctions_list_id UUID REFERENCES sanctions_lists(id),
  match_score DECIMAL(5,2),
  match_type VARCHAR(30) CHECK (match_type IN (
    'exact', 'fuzzy', 'partial', 'false_positive'
  )),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'cleared', 'flagged', 'escalated', 'false_positive'
  )),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_screening_subject ON screening_results(subject_type, subject_id);
CREATE INDEX idx_screening_status ON screening_results(status);

CREATE TABLE suspicious_activity_reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_type VARCHAR(50) NOT NULL CHECK (report_type IN (
    'SAR', 'CTR', 'STR', 'threshold_report'
  )),
  subject_type VARCHAR(50) NOT NULL,
  subject_id VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  amount BIGINT,
  currency VARCHAR(10),
  indicators JSONB DEFAULT '[]',
  related_transactions JSONB DEFAULT '[]',
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'filed', 'acknowledged', 'closed'
  )),
  filed_by UUID REFERENCES users(id),
  filed_at TIMESTAMPTZ,
  filing_reference VARCHAR(255),
  jurisdiction VARCHAR(10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sar_status ON suspicious_activity_reports(status);
CREATE INDEX idx_sar_subject ON suspicious_activity_reports(subject_type, subject_id);

CREATE TABLE travel_rule_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
  transaction_id UUID REFERENCES transactions_blockchain(id),
  originator_name VARCHAR(255),
  originator_account VARCHAR(255),
  originator_address TEXT,
  originator_institution VARCHAR(255),
  beneficiary_name VARCHAR(255),
  beneficiary_account VARCHAR(255),
  beneficiary_address TEXT,
  beneficiary_institution VARCHAR(255),
  amount BIGINT NOT NULL,
  currency VARCHAR(10) NOT NULL,
  protocol VARCHAR(50),
  protocol_message_id VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'sent', 'received', 'acknowledged', 'rejected'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_travel_rule_tx ON travel_rule_messages(transaction_id);
CREATE INDEX idx_travel_rule_status ON travel_rule_messages(status);

-- ============================================================
-- KEY MANAGEMENT
-- ============================================================

CREATE TABLE key_metadata (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key_id VARCHAR(255) UNIQUE NOT NULL,
  key_type VARCHAR(50) NOT NULL CHECK (key_type IN (
    'signing', 'encryption', 'authentication', 'master'
  )),
  algorithm VARCHAR(50) NOT NULL,
  provider VARCHAR(50) NOT NULL CHECK (provider IN (
    'hsm', 'mpc', 'kms', 'local_dev'
  )),
  purpose TEXT,
  chain VARCHAR(50),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'rotating', 'deprecated', 'destroyed'
  )),
  version INT NOT NULL DEFAULT 1,
  shard_count INT,
  shard_threshold INT,
  geographic_locations JSONB DEFAULT '[]',
  rotation_due_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  destroyed_at TIMESTAMPTZ
);

CREATE INDEX idx_key_metadata_key_id ON key_metadata(key_id);
CREATE INDEX idx_key_metadata_status ON key_metadata(status);

CREATE TABLE key_ceremonies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ceremony_type VARCHAR(50) NOT NULL CHECK (ceremony_type IN (
    'generation', 'rotation', 'recovery', 'destruction', 'shard_recombine'
  )),
  key_id UUID REFERENCES key_metadata(id),
  participants JSONB NOT NULL DEFAULT '[]',
  min_participants INT NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'initiated' CHECK (status IN (
    'initiated', 'in_progress', 'completed', 'failed', 'cancelled'
  )),
  attestation_hash VARCHAR(255),
  video_record_ref VARCHAR(500),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  details JSONB DEFAULT '{}'
);

CREATE INDEX idx_ceremonies_key ON key_ceremonies(key_id);
CREATE INDEX idx_ceremonies_status ON key_ceremonies(status);

-- ============================================================
-- SMART CONTRACT CONTROLS
-- ============================================================

CREATE TABLE contract_registry (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  chain VARCHAR(50) NOT NULL,
  address VARCHAR(255) NOT NULL,
  contract_type VARCHAR(50) NOT NULL CHECK (contract_type IN (
    'token', 'proxy', 'multisig', 'timelock', 'governance', 'custom'
  )),
  abi JSONB,
  bytecode_hash VARCHAR(255),
  compiler_version VARCHAR(50),
  audit_status VARCHAR(20) NOT NULL DEFAULT 'unaudited' CHECK (audit_status IN (
    'unaudited', 'in_audit', 'audited', 'failed_audit'
  )),
  audit_reports JSONB DEFAULT '[]',
  is_paused BOOLEAN NOT NULL DEFAULT FALSE,
  paused_by UUID REFERENCES users(id),
  paused_at TIMESTAMPTZ,
  owner_address VARCHAR(255),
  proxy_implementation VARCHAR(255),
  deployed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_contract_registry_chain_addr
  ON contract_registry(chain, address);
CREATE INDEX idx_contract_registry_type ON contract_registry(contract_type);

CREATE TABLE contract_upgrades (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id UUID NOT NULL REFERENCES contract_registry(id),
  new_implementation VARCHAR(255) NOT NULL,
  new_bytecode_hash VARCHAR(255),
  reason TEXT NOT NULL,
  proposed_by UUID NOT NULL REFERENCES users(id),
  timelock_id UUID REFERENCES timelocks(id),
  approval_request_id UUID REFERENCES approval_requests(id),
  status VARCHAR(20) NOT NULL DEFAULT 'proposed' CHECK (status IN (
    'proposed', 'approved', 'timelocked', 'executed', 'rejected', 'cancelled'
  )),
  executed_tx_hash VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_contract_upgrades_contract ON contract_upgrades(contract_id);
CREATE INDEX idx_contract_upgrades_status ON contract_upgrades(status);

-- ============================================================
-- SETTLEMENT & CLEARING
-- ============================================================

CREATE TABLE settlement_instructions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  settlement_type VARCHAR(30) NOT NULL CHECK (settlement_type IN (
    'dvp', 'pvp', 'fop', 'internal', 'cross_chain'
  )),
  leg_a_account_id UUID REFERENCES accounts(id),
  leg_a_asset VARCHAR(100) NOT NULL,
  leg_a_amount BIGINT NOT NULL,
  leg_a_direction VARCHAR(10) NOT NULL CHECK (leg_a_direction IN ('deliver', 'receive')),
  leg_b_account_id UUID REFERENCES accounts(id),
  leg_b_asset VARCHAR(100),
  leg_b_amount BIGINT,
  leg_b_direction VARCHAR(10) CHECK (leg_b_direction IN ('deliver', 'receive')),
  settlement_date TIMESTAMPTZ NOT NULL,
  settlement_cycle VARCHAR(10) DEFAULT 'T+0',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'matched', 'settling', 'settled', 'failed', 'cancelled'
  )),
  journal_entry_id UUID REFERENCES journal_entries(id),
  counterparty_ref VARCHAR(255),
  netting_group_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_settlement_status ON settlement_instructions(status);
CREATE INDEX idx_settlement_date ON settlement_instructions(settlement_date);
CREATE INDEX idx_settlement_netting ON settlement_instructions(netting_group_id);

CREATE TABLE netting_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  netting_date DATE NOT NULL,
  asset VARCHAR(100) NOT NULL,
  participant_count INT NOT NULL DEFAULT 0,
  gross_amount BIGINT NOT NULL DEFAULT 0,
  net_amount BIGINT NOT NULL DEFAULT 0,
  savings_bps INT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'calculated', 'settled', 'failed'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- TREASURY MANAGEMENT
-- ============================================================

CREATE TABLE treasury_portfolios (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  strategy VARCHAR(50) NOT NULL CHECK (strategy IN (
    'conservative', 'balanced', 'growth', 'custom'
  )),
  target_allocations JSONB NOT NULL DEFAULT '{}',
  actual_allocations JSONB NOT NULL DEFAULT '{}',
  total_value BIGINT NOT NULL DEFAULT 0,
  rebalance_threshold_bps INT NOT NULL DEFAULT 500,
  last_rebalanced_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'frozen', 'liquidating', 'closed'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE treasury_positions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  portfolio_id UUID NOT NULL REFERENCES treasury_portfolios(id),
  asset_type VARCHAR(50) NOT NULL,
  asset_id VARCHAR(255) NOT NULL,
  quantity BIGINT NOT NULL DEFAULT 0,
  cost_basis BIGINT NOT NULL DEFAULT 0,
  current_value BIGINT NOT NULL DEFAULT 0,
  unrealized_pnl BIGINT NOT NULL DEFAULT 0,
  account_id UUID REFERENCES accounts(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_treasury_positions_portfolio
  ON treasury_positions(portfolio_id);

-- ============================================================
-- MONITORING & ALERTING
-- ============================================================

CREATE TABLE alert_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  category VARCHAR(50) NOT NULL CHECK (category IN (
    'security', 'compliance', 'operational', 'financial',
    'performance', 'chain'
  )),
  condition_type VARCHAR(50) NOT NULL CHECK (condition_type IN (
    'threshold', 'anomaly', 'pattern', 'absence', 'rate_change'
  )),
  config JSONB NOT NULL DEFAULT '{}',
  severity VARCHAR(20) NOT NULL DEFAULT 'medium',
  notification_channels JSONB DEFAULT '["log"]',
  cooldown_minutes INT NOT NULL DEFAULT 5,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE alert_events (
  id BIGSERIAL PRIMARY KEY,
  rule_id UUID NOT NULL REFERENCES alert_rules(id),
  severity VARCHAR(20) NOT NULL,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  resource_type VARCHAR(100),
  resource_id VARCHAR(255),
  metric_value DECIMAL(20,4),
  threshold_value DECIMAL(20,4),
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_by UUID REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alert_events_rule ON alert_events(rule_id);
CREATE INDEX idx_alert_events_unresolved ON alert_events(resolved, created_at)
  WHERE resolved = FALSE;
CREATE INDEX idx_alert_events_severity ON alert_events(severity);

-- ============================================================
-- LEGAL FRAMEWORKS
-- ============================================================

CREATE TABLE legal_agreements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agreement_type VARCHAR(50) NOT NULL CHECK (agreement_type IN (
    'custody', 'service', 'nda', 'dpa', 'terms_of_service',
    'subscription', 'advisory', 'licensing'
  )),
  title VARCHAR(500) NOT NULL,
  counterparty_name VARCHAR(255),
  counterparty_id VARCHAR(255),
  version VARCHAR(20) NOT NULL DEFAULT '1.0',
  document_hash VARCHAR(255),
  document_url TEXT,
  jurisdiction VARCHAR(10),
  effective_date DATE,
  expiry_date DATE,
  auto_renew BOOLEAN NOT NULL DEFAULT FALSE,
  renewal_notice_days INT DEFAULT 30,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'pending_signature', 'active', 'expired',
    'terminated', 'superseded'
  )),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_legal_agreements_type ON legal_agreements(agreement_type);
CREATE INDEX idx_legal_agreements_status ON legal_agreements(status);
CREATE INDEX idx_legal_agreements_expiry ON legal_agreements(expiry_date);

CREATE TABLE agreement_signatures (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agreement_id UUID NOT NULL REFERENCES legal_agreements(id),
  signer_name VARCHAR(255) NOT NULL,
  signer_email VARCHAR(255),
  signer_title VARCHAR(255),
  signature_type VARCHAR(30) NOT NULL CHECK (signature_type IN (
    'electronic', 'digital', 'wet_ink', 'qualified_electronic'
  )),
  signature_hash VARCHAR(255),
  signed_at TIMESTAMPTZ,
  ip_address VARCHAR(45),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'signed', 'declined', 'expired'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agreement_sigs_agreement ON agreement_signatures(agreement_id);

-- ============================================================
-- VENDOR & THIRD-PARTY RISK
-- ============================================================

CREATE TABLE vendors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  vendor_type VARCHAR(50) NOT NULL CHECK (vendor_type IN (
    'custodian', 'oracle', 'rpc_provider', 'kms_provider',
    'audit_firm', 'legal', 'insurance', 'infrastructure', 'other'
  )),
  risk_tier VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (risk_tier IN (
    'low', 'medium', 'high', 'critical'
  )),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'under_review', 'suspended', 'terminated'
  )),
  primary_contact_name VARCHAR(255),
  primary_contact_email VARCHAR(255),
  agreement_id UUID REFERENCES legal_agreements(id),
  last_assessment_date DATE,
  next_assessment_date DATE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_vendors_type ON vendors(vendor_type);
CREATE INDEX idx_vendors_risk ON vendors(risk_tier);

CREATE TABLE vendor_assessments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id UUID NOT NULL REFERENCES vendors(id),
  assessment_type VARCHAR(50) NOT NULL CHECK (assessment_type IN (
    'initial', 'periodic', 'incident', 'renewal'
  )),
  assessor_id UUID REFERENCES users(id),
  overall_score INT CHECK (overall_score >= 0 AND overall_score <= 100),
  categories JSONB DEFAULT '{}',
  findings JSONB DEFAULT '[]',
  recommendations JSONB DEFAULT '[]',
  risk_rating VARCHAR(20),
  status VARCHAR(20) NOT NULL DEFAULT 'in_progress' CHECK (status IN (
    'in_progress', 'completed', 'requires_action'
  )),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_vendor_assessments_vendor ON vendor_assessments(vendor_id);

CREATE TABLE vendor_sla_metrics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id UUID NOT NULL REFERENCES vendors(id),
  metric_name VARCHAR(100) NOT NULL,
  target_value DECIMAL(10,4) NOT NULL,
  actual_value DECIMAL(10,4),
  measurement_period_start DATE NOT NULL,
  measurement_period_end DATE NOT NULL,
  in_compliance BOOLEAN,
  breach_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sla_metrics_vendor ON vendor_sla_metrics(vendor_id);

-- ============================================================
-- DATA MANAGEMENT & PRIVACY
-- ============================================================

CREATE TABLE data_classifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_name VARCHAR(100) NOT NULL,
  column_name VARCHAR(100) NOT NULL,
  classification VARCHAR(30) NOT NULL CHECK (classification IN (
    'public', 'internal', 'confidential', 'restricted', 'pii', 'phi'
  )),
  encryption_required BOOLEAN NOT NULL DEFAULT FALSE,
  masking_rule VARCHAR(50),
  retention_days INT,
  legal_basis TEXT,
  UNIQUE (table_name, column_name)
);

CREATE TABLE retention_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_name VARCHAR(100) NOT NULL,
  retention_days INT NOT NULL,
  archive_before_delete BOOLEAN NOT NULL DEFAULT TRUE,
  legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
  last_purge_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- PERMISSIONS FOR NEW TABLES
-- ============================================================

-- Reader grants
GRANT SELECT ON users, roles, permissions, user_roles, role_permissions TO ledger_reader;
GRANT SELECT ON sessions, api_keys TO ledger_reader;
GRANT SELECT ON audit_events TO ledger_reader;
GRANT SELECT ON approval_policies, approval_requests, approval_decisions TO ledger_reader;
GRANT SELECT ON timelocks TO ledger_reader;
GRANT SELECT ON risk_policies, risk_events, circuit_breaker_state, kill_switches TO ledger_reader;
GRANT SELECT ON sanctions_lists, screening_results TO ledger_reader;
GRANT SELECT ON suspicious_activity_reports, travel_rule_messages TO ledger_reader;
GRANT SELECT ON key_metadata, key_ceremonies TO ledger_reader;
GRANT SELECT ON contract_registry, contract_upgrades TO ledger_reader;
GRANT SELECT ON settlement_instructions, netting_groups TO ledger_reader;
GRANT SELECT ON treasury_portfolios, treasury_positions TO ledger_reader;
GRANT SELECT ON alert_rules, alert_events TO ledger_reader;
GRANT SELECT ON legal_agreements, agreement_signatures TO ledger_reader;
GRANT SELECT ON vendors, vendor_assessments, vendor_sla_metrics TO ledger_reader;
GRANT SELECT ON data_classifications, retention_policies TO ledger_reader;

-- Writer grants
GRANT SELECT, INSERT, UPDATE ON users, roles, permissions, user_roles, role_permissions TO ledger_writer;
GRANT SELECT, INSERT, UPDATE ON sessions, api_keys TO ledger_writer;
GRANT SELECT, INSERT ON audit_events TO ledger_writer;
GRANT SELECT, INSERT, UPDATE ON approval_policies, approval_requests, approval_decisions TO ledger_writer;
GRANT SELECT, INSERT, UPDATE ON timelocks TO ledger_writer;
GRANT SELECT, INSERT, UPDATE ON risk_policies, risk_events, circuit_breaker_state, kill_switches TO ledger_writer;
GRANT SELECT, INSERT, UPDATE ON sanctions_lists, screening_results TO ledger_writer;
GRANT SELECT, INSERT, UPDATE ON suspicious_activity_reports, travel_rule_messages TO ledger_writer;
GRANT SELECT, INSERT, UPDATE ON key_metadata, key_ceremonies TO ledger_writer;
GRANT SELECT, INSERT, UPDATE ON contract_registry, contract_upgrades TO ledger_writer;
GRANT SELECT, INSERT, UPDATE ON settlement_instructions, netting_groups TO ledger_writer;
GRANT SELECT, INSERT, UPDATE ON treasury_portfolios, treasury_positions TO ledger_writer;
GRANT SELECT, INSERT, UPDATE ON alert_rules, alert_events TO ledger_writer;
GRANT SELECT, INSERT, UPDATE ON legal_agreements, agreement_signatures TO ledger_writer;
GRANT SELECT, INSERT, UPDATE ON vendors, vendor_assessments, vendor_sla_metrics TO ledger_writer;
GRANT SELECT, INSERT, UPDATE ON data_classifications, retention_policies TO ledger_writer;

-- Sequence grants
GRANT USAGE, SELECT ON SEQUENCE audit_events_id_seq TO ledger_writer;
GRANT USAGE, SELECT ON SEQUENCE risk_events_id_seq TO ledger_writer;
GRANT USAGE, SELECT ON SEQUENCE alert_events_id_seq TO ledger_writer;

-- ============================================================
-- TRUST DOMAINS
-- ============================================================

CREATE TABLE trust_domains (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  parent_domain_id UUID REFERENCES trust_domains(id),
  isolation_level VARCHAR(20) NOT NULL DEFAULT 'full' CHECK (isolation_level IN ('full', 'shared', 'hybrid')),
  signing_domain_id VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'decommissioned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE cross_domain_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_domain_id UUID NOT NULL REFERENCES trust_domains(id),
  target_domain_id UUID NOT NULL REFERENCES trust_domains(id),
  trust_level VARCHAR(20) NOT NULL CHECK (trust_level IN ('full', 'limited', 'none')),
  allowed_operations JSONB NOT NULL DEFAULT '[]',
  requires_approval BOOLEAN NOT NULL DEFAULT TRUE,
  max_amount BIGINT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE trust_domain_accounts (
  account_id UUID PRIMARY KEY REFERENCES accounts(id),
  domain_id UUID NOT NULL REFERENCES trust_domains(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- ASSET LIFECYCLE EVENTS
-- ============================================================

CREATE TABLE asset_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  asset_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(30) NOT NULL CHECK (event_type IN (
    'issuance', 'minting', 'redemption', 'burning', 'corporate_action',
    'dividend', 'interest_payment', 'maturity'
  )),
  amount BIGINT NOT NULL DEFAULT 0,
  recipient_account_id UUID REFERENCES accounts(id),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lifecycle_events_asset ON asset_lifecycle_events(asset_id);
CREATE INDEX idx_lifecycle_events_type ON asset_lifecycle_events(event_type);

-- ============================================================
-- DISCLOSURE POLICIES (Privacy)
-- ============================================================

CREATE TABLE disclosure_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  data_classification VARCHAR(30) NOT NULL CHECK (data_classification IN (
    'public', 'internal', 'confidential', 'restricted', 'pii', 'phi'
  )),
  allowed_recipients JSONB NOT NULL DEFAULT '[]',
  required_purpose TEXT,
  retention_days INT NOT NULL DEFAULT 365,
  minimization_rules JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Grants for new tables
GRANT SELECT ON trust_domains, cross_domain_policies, trust_domain_accounts TO ledger_reader;
GRANT SELECT ON asset_lifecycle_events, disclosure_policies TO ledger_reader;
GRANT SELECT, INSERT, UPDATE ON trust_domains, cross_domain_policies, trust_domain_accounts TO ledger_writer;
GRANT SELECT, INSERT, UPDATE ON asset_lifecycle_events, disclosure_policies TO ledger_writer;

COMMIT;
