# Institutional Web3 Infrastructure

> **SANDBOX / EDUCATIONAL USE ONLY — NOT FOR PRODUCTION**
> This codebase is a reference implementation designed for learning, prototyping, and architectural exploration. It is **not audited, not legally reviewed, and must not be used to custody real funds, manage real private keys, or process real financial transactions.** See the [Production Warning](#production-warning) section for full details.

Enterprise-grade blockchain infrastructure layer providing a custody-grade double-entry ledger (append-only, hash-chained, serializable isolation), Ethereum L1 integration (block indexing, reorg detection, finality tracking), wallet management with HSM/MPC signing pipelines, event-driven architecture via transactional outbox → Kafka with dead-letter queues, institutional controls (IAM, governance, compliance, risk management), settlement & clearing (DvP/PvP/netting), lending/margin/liquidation engine, FX conversion, price oracle, treasury management, and comprehensive monitoring with Prometheus metrics export. All financial operations enforce ACID guarantees with database-level immutability triggers, DB-enforced state machine transitions, cryptographic audit trails, and automated reconciliation.

## Table of Contents

- [Overview](#overview)
- [What This Does](#what-this-does)
- [Architecture](#architecture)
- [Core Components](#core-components)
- [Institutional Controls](#institutional-controls)
- [Ledger Guarantees](#ledger-guarantees)
- [Database Schema](#database-schema)
- [API Reference](#api-reference)
- [Installation](#installation)
- [Usage](#usage)
- [Testing](#testing)
- [Configuration](#configuration)
- [Project Structure](#project-structure)
- [Failure Scenarios](#failure-scenarios)
- [Production Warning](#production-warning)
- [License](#license)

## Overview

| Component | Detail |
|-----------|--------|
| Language | TypeScript (strict mode) |
| Database | PostgreSQL 16 (append-only ledger, serializable isolation, NUMERIC(38,18) precision) |
| Cache | Redis 7 (balance cache, nonce management, rate limiting, price oracle) |
| Messaging | Apache Kafka via transactional outbox pattern + Dead Letter Queue |
| Blockchain | Ethereum L1 (ethers.js v6) |
| API | Express REST + Prometheus /metrics |
| Testing | Jest + ts-jest (39 tests) |
| Infrastructure | Docker Compose (Postgres, Redis, Kafka, Zookeeper) |
| Monitoring | Prometheus-compatible metrics export, anomaly detection, SIEM integration |

This system implements the **core backend infrastructure** of a digital-asset custody platform — the kind of system that underpins institutional custodians (BitGo, Fireblocks, Anchorage), crypto exchanges (Coinbase, Kraken), and fintech platforms building crypto-native banking products.

## What This Does

### 1. Custody-Grade Financial Ledger

- **Double-entry accounting** — every transfer creates balanced debit + credit entries
- **Hash-chained audit trail** — SHA-256 chain links every entry to its predecessor
- **Append-only enforcement** — database triggers physically prevent UPDATE/DELETE
- **Serializable isolation** — the strongest ACID guarantee Postgres offers
- **Idempotency keys** — duplicate requests are safely deduplicated
- **Explicit reversals** — corrections are new mirror entries, never mutations
- **Decimal precision** — NUMERIC(38,18) columns for high-precision financial calculations

### 2. Ethereum L1 Integration

- **Block-by-block indexing** — continuous ingestion of blocks and contract events
- **Reorg detection and recovery** — detects chain forks, marks affected data, re-indexes
- **Finality tracking** — configurable confirmation threshold (default 12 blocks)
- **Gas estimation** — EIP-1559 aware fee calculation
- **Stuck transaction detection** — alerts after 15 minutes without confirmation

### 3. Wallet & Signing Pipeline

- **Wallet lifecycle** — create, classify (hot/warm/cold/deposit), and monitor
- **Transaction pipeline** — create → sign → submit → monitor → confirm
- **DB-enforced state machine** — trigger rejects invalid state transitions at database level
- **Nonce management** — Redis atomic increment prevents collisions
- **KMS/HSM/MPC integration** — pluggable signing with provider abstraction

### 4. Event-Driven Architecture with DLQ

- **Transactional outbox** — events written atomically with state changes
- **Kafka publishing** — relay service with idempotent producer
- **Dead Letter Queue** — failed messages captured with exponential backoff retry (5 attempts), manual reprocessing, and exhaustion tracking
- **FOR UPDATE SKIP LOCKED** — concurrent-safe polling

### 5. Identity & Access Management

- **Authentication** — password hashing (SHA-256 + salt), timing-safe comparison, session tokens
- **Multi-factor authentication** — TOTP-based MFA with backup codes
- **RBAC** — roles, permissions, resource:action grants
- **Account lockout** — 5 failed attempts triggers lock
- **API key management** — scoped keys with IP whitelist and rate limits
- **Separation of duties** — DB-level reader/writer role enforcement

### 6. Governance & Approval Workflows

- **Four-eyes principle** — maker and checker must be different actors
- **M-of-N approvals** — configurable threshold signing off on operations
- **Timelocks** — delayed execution for high-risk operations
- **Auto-expiry** — requests expire after configurable hours
- **Emergency kill switches** — instant feature shutdown with optional auto-reactivate

### 7. Compliance & Regulatory Controls

- **OFAC sanctions screening** — exact address match against SDN lists
- **Entity screening** — fuzzy name matching via pg_trgm similarity
- **Transaction screening** — velocity, amount, and frequency checks
- **Travel Rule** — FATF-compliant originator/beneficiary messaging
- **SAR filing** — Suspicious Activity Report creation and tracking
- **KYC status** — holder-level verification with whitelist enforcement

### 8. Risk Management

- **Velocity policies** — sliding-window transaction rate limits
- **Concentration policies** — percentage-of-supply exposure limits
- **Circuit breakers** — automatic service protection (closed → open → half_open)
- **Kill switches** — emergency feature shutdown
- **DB-enforced state machines** — invalid transitions rejected at trigger level

### 9. Key Management

- **HSM/MPC/KMS providers** — pluggable signing delegation
- **Key rotation** — 90-day policy with ceremony-based workflows
- **Sharding** — configurable shard count and threshold (M-of-N)
- **Geographic distribution** — multi-region key placement
- **Key ceremonies** — generation, rotation, recovery, destruction with attestation

### 10. Settlement & Clearing

- **Atomic DvP** — delivery-versus-payment in single serializable transaction
- **PvP settlement** — payment-versus-payment for FX
- **Netting** — reduces gross obligations to net with savings calculation
- **DB-enforced state machine** — settlement transitions validated by trigger
- **Cross-chain support** — settlement type for multi-chain operations

### 11. Lending, Margin & Liquidation

- **Loan origination** — collateral + loan with configurable interest rates
- **Daily interest accrual** — automated batch processing
- **LTV monitoring** — real-time loan-to-value ratio tracking
- **Margin calls** — automatic trigger when LTV exceeds threshold
- **Waterfall liquidation** — seize collateral → repay debt → penalty → return surplus
- **DB-enforced state machine** — loan transitions validated by trigger

### 12. FX Conversion Engine

- **Rate management** — bid/ask/mid/spread from multiple providers
- **Rate locking** — 30-second guaranteed quote with Redis TTL
- **Atomic PvP execution** — both legs settle or neither (serializable transaction)
- **Spread calculation** — configurable markup in basis points

### 13. Price Oracle

- **Multi-source aggregation** — accepts quotes from multiple providers
- **VWAP calculation** — volume-weighted average price
- **Median filtering** — statistical median for robustness
- **Outlier rejection** — discards quotes >10% from median
- **Staleness detection** — flags stale data when sources drop
- **Confidence scoring** — composite score based on source count and price agreement

### 14. Treasury Management

- **Portfolio management** — target allocations with drift detection
- **NAV calculation** — net asset value from position valuations
- **Rebalancing** — threshold-based rebalance action generation
- **Proof of reserves** — reserves-to-liabilities ratio verification

### 15. Monitoring & Observability

- **Prometheus metrics** — `/metrics` endpoint in standard text format (15+ metric types)
- **Anomaly detection** — z-score statistical deviation on sliding windows
- **SIEM export** — structured alert events for security tools
- **Fraud detection** — velocity, large transaction, and new destination checks
- **Configurable alerting** — threshold, anomaly, pattern, and absence rules with cooldown

### 16. Tokenization

- **Asset registration** — real estate, commodities, securities, bonds, funds
- **Token lifecycle** — create, activate, pause, mint, burn, transfer
- **Cap table** — holder tracking with balance history
- **Transfer restrictions** — whitelist, jurisdiction, lockup, max holders, min/max holding
- **Corporate actions** — dividends, votes, stock splits with record-date snapshots

### 17. Additional Institutional Features

- **Trust domains** — business unit isolation with cross-domain authorization
- **Asset lifecycle** — issuance, minting, burning, redemption, dividends, maturity
- **Vendor risk** — assessments, SLA monitoring, breach detection
- **Privacy** — ZK balance proofs, selective disclosure, data classification, retention
- **Infrastructure** — node health monitoring, load balancing, geographic failover
- **Field-level encryption** — AES-256-GCM for sensitive data at rest
- **Automated reconciliation** — balance + hash chain verification every 5/15 minutes

## Architecture

```
                    ┌──────────────────────────────────────────────────────────┐
                    │                    REQUEST FLOW                           │
                    └──────────────────────────────────────────────────────────┘

    Client ──► Express API ──► Auth Middleware ──► Service Layer ──► PostgreSQL
                   │                                    │                 │
                   │                                    │         ┌──────────────┐
                   │                                    └────────►│ Outbox Table │
                   │                                              └──────┬───────┘
                   │                                                     │
                   │                  ┌──────────────────────────────────┘
                   │                  ▼
                   │           Outbox Relay ────────────► Kafka Topics
                   │                  │
                   │                  └── (on failure) ──► Dead Letter Queue
                   │
                   ├──► Wallet Service ──► Key Mgmt ──► HSM/MPC Provider
                   │         │
                   │         └──► Redis (nonce) ──► Chain Service ──► Ethereum
                   │
                   ├──► Settlement Service ──► Atomic DvP/PvP/Netting
                   ├──► Lending Service ──► Margin Monitor ──► Liquidation
                   ├──► FX Service ──► Rate Lock ──► PvP Conversion
                   ├──► Price Oracle ──► VWAP/Median ──► Staleness Check
                   ├──► Block Indexer ──► Reorg Detection ──► Recovery
                   ├──► Reconciliation (cron) ──► Balance + Hash Verification
                   └──► Monitoring ──► Prometheus /metrics
                              │
                              ├──► Anomaly Detection (z-score)
                              └──► SIEM Export + Alerting
```

## Core Components

### Ledger Service (`src/database/ledger-service.ts`)
Double-entry journal entries with hash chaining, serializable isolation, idempotency, and atomic outbox writes.

### Wallet Service (`src/wallet/wallet-service.ts`)
Wallet registration, transaction creation with atomic nonce allocation, lifecycle tracking, and reorg handling.

### Block Indexer (`src/indexer/block-indexer.ts`)
Continuous block ingestion, event indexing, reorg detection via parent hash verification.

### Chain Service (`src/chain/chain-service.ts`)
Transaction submission, EIP-1559 gas estimation, finality tracking, stuck transaction detection.

### Outbox Relay (`src/messaging/outbox-relay.ts`)
Polls outbox with `FOR UPDATE SKIP LOCKED`, publishes to Kafka, routes failures to DLQ.

### DLQ Service (`src/messaging/dlq-service.ts`)
Exponential backoff retry (5 attempts), manual reprocessing, exhaustion tracking, DLQ Kafka topics.

### Key Management (`src/key-management/key-service.ts`)
HSM/MPC/KMS signing delegation, rotation workflows, sharding, geographic distribution, ceremonies.

### Settlement Service (`src/settlement/settlement-service.ts`)
Atomic DvP/PvP/FoP settlement, multilateral netting with savings calculation.

### Lending Service (`src/lending/lending-service.ts`)
Loan origination, interest accrual, LTV monitoring, margin calls, waterfall liquidation.

### FX Service (`src/fx/fx-service.ts`)
Rate management, rate locking, atomic PvP conversion, spread calculation.

### Price Oracle (`src/oracle/price-oracle-service.ts`)
Multi-source VWAP, median filtering, outlier rejection, staleness detection, confidence scoring.

### Metrics Exporter (`src/monitoring/metrics-exporter.ts`)
Prometheus-compatible `/metrics` endpoint with 15+ metric types.

### Monitoring Service (`src/monitoring/monitoring-service.ts`)
Alert rules, anomaly detection (z-score), fraud detection, SIEM export.

## Institutional Controls

### Security (`src/security/`)
- **auth-service.ts** — Authentication, RBAC, MFA, session management, API keys
- **audit-service.ts** — Append-only audit trail with actor context and risk levels
- **encryption-service.ts** — AES-256-GCM field-level encryption, PII masking

### Risk (`src/risk/`)
- **risk-service.ts** — Velocity, concentration, and exposure policy evaluation
- **circuit-breaker.ts** — Service protection + kill switch emergency shutdown

### Compliance (`src/compliance/`)
- **aml-service.ts** — OFAC screening, entity matching, Travel Rule, SAR filing

### Governance (`src/governance/`)
- **approval-service.ts** — Four-eyes, maker-checker, M-of-N approvals, timelocks

### Trust Domains (`src/trust-domains/`)
- **trust-domain-service.ts** — Isolation, cross-domain authorization, asset segregation

### Treasury (`src/treasury/`)
- **treasury-service.ts** — Portfolio NAV, rebalancing, proof of reserves

### Tokenization (`src/tokenization/`)
- **token-service.ts** — Mint/burn/transfer with compliance checks
- **compliance-service.ts** — Transfer restrictions, whitelisting, lockup
- **corporate-actions-service.ts** — Dividends, votes, stock splits
- **asset-service.ts** — Asset registration and lifecycle

### Other
- **vendor/vendor-risk-service.ts** — Vendor assessments, SLA monitoring
- **privacy/privacy-service.ts** — ZK proofs, selective disclosure, retention
- **infrastructure/infrastructure-service.ts** — Node health, load balancing, failover
- **asset-lifecycle/asset-lifecycle-service.ts** — Issuance, burning, dividends, maturity

## Ledger Guarantees

| Guarantee | Implementation |
|-----------|---------------|
| Append-only ledger | Postgres triggers block UPDATE/DELETE with `RAISE EXCEPTION` |
| Double-entry accounting | Deferred constraint trigger validates `SUM(debits) = SUM(credits)` at COMMIT |
| Decimal precision | `NUMERIC(38,18)` for oracle, lending, FX; `BIGINT` for core ledger |
| Derived balances with cache | `balance_cache` updated atomically; independently reconstructable |
| Idempotency keys | `UNIQUE` constraint on `journal_entries.idempotency_key` |
| DB-enforced state machines | Trigger functions reject invalid status transitions |
| Serializable isolation | `BEGIN ISOLATION LEVEL SERIALIZABLE` + `SELECT ... FOR UPDATE` |
| Dead Letter Queue | Failed Kafka publishes captured with retry tracking |
| Reconciliation jobs | Cron-based balance + hash chain verification with alerting |
| Cryptographic audit trail | SHA-256 hash chain validated by `trg_validate_hash_chain` trigger |

## Database Schema

### Core Ledger
- **`accounts`** — Account registry (asset, liability, equity, revenue, expense)
- **`journal_entries`** — Double-entry headers with idempotency keys
- **`ledger_entries`** — Debit/credit lines with SHA-256 hash chain (append-only)
- **`balance_cache`** — Derived balance materialization with `balance_precise` NUMERIC column

### Messaging
- **`outbox`** — Transactional outbox for guaranteed Kafka delivery
- **`dead_letter_queue`** — Failed messages with retry tracking and exponential backoff

### Wallet & Chain
- **`wallets`** — Registered wallets (hot/warm/cold/deposit) with KMS key reference
- **`transactions_blockchain`** — Full lifecycle with DB-enforced state machine trigger

### Settlement & Clearing
- **`settlement_instructions`** — DvP/PvP/FoP/internal/cross-chain with state machine trigger
- **`netting_groups`** — Multilateral netting calculations

### Lending
- **`loans`** — Loan records with LTV, margin/liquidation thresholds, state machine trigger
- **`price_quotes`** — Oracle price data with NUMERIC(38,18) precision
- **`fx_rates`** — FX bid/ask/mid/spread history
- **`fx_conversions`** — FX conversion records with rate lock

### IAM & Security
- **`users`** — User accounts with MFA, lockout tracking
- **`roles`**, **`permissions`**, **`user_roles`**, **`role_permissions`** — RBAC
- **`sessions`**, **`api_keys`** — Authentication tokens
- **`audit_events`** — Append-only audit trail (trigger-enforced)

### Governance
- **`approval_policies`** — M-of-N approval rules
- **`approval_requests`** — Pending approvals with state machine trigger
- **`approval_decisions`** — Individual approve/reject votes
- **`timelocks`** — Delayed execution for sensitive operations

### Compliance
- **`sanctions_lists`** — OFAC/UN/EU/UK sanctions entries
- **`screening_results`** — Address/entity/transaction screening outcomes
- **`suspicious_activity_reports`** — SAR filings
- **`travel_rule_messages`** — FATF Travel Rule compliance

### Risk & Operations
- **`risk_policies`** — Velocity, concentration, exposure policies
- **`risk_events`** — Triggered risk violations
- **`circuit_breaker_state`** — Service health tracking
- **`kill_switches`** — Emergency feature toggles
- **`alert_rules`**, **`alert_events`** — Monitoring and alerting

### Institutional
- **`key_metadata`**, **`key_ceremonies`** — Key management lifecycle
- **`trust_domains`**, **`cross_domain_policies`** — Isolation boundaries
- **`treasury_portfolios`**, **`treasury_positions`** — Portfolio management
- **`vendors`**, **`vendor_assessments`**, **`vendor_sla_metrics`** — Third-party risk
- **`legal_agreements`**, **`agreement_signatures`** — Legal framework
- **`contract_registry`**, **`contract_upgrades`** — Smart contract controls
- **`asset_lifecycle_events`** — Issuance/burning/dividend/maturity records
- **`data_classifications`**, **`retention_policies`**, **`disclosure_policies`** — Privacy

### Indexer
- **`indexed_blocks`** — Block metadata with reorg status
- **`indexed_events`** — Contract events with processing status

### Operations
- **`reconciliation_runs`** — Reconciliation execution history

## API Reference

> **Base URL:** `http://localhost:3000`
> Replace `:id`, `:keyId`, `:hash`, `:pair`, `:number`, `:name`, `:accountId`, `:address`, `:tokenId`, and `:restrictionId` with actual values. Total: **91 endpoints**.

### Auth / IAM APIs (`/api/v1/auth/`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/register` | Create new user account |
| `POST` | `/login` | Authenticate and receive session token |
| `POST` | `/logout` | Revoke current session (requires auth) |
| `POST` | `/api-keys` | Create scoped API key (requires auth) |
| `POST` | `/roles/assign` | Assign role to user (requires auth) |
| `POST` | `/roles/remove` | Remove role from user (requires auth) |
| `POST` | `/mfa/enable` | Enable MFA and receive backup codes (requires auth) |

#### Auth API curl Commands

```bash
# Registration & Login
curl -X POST http://localhost:3000/api/v1/auth/register -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"securepass","displayName":"User Name"}'
curl -X POST http://localhost:3000/api/v1/auth/login -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"securepass"}'

# Authenticated endpoints (pass Bearer token from login response)
curl -X POST http://localhost:3000/api/v1/auth/logout -H "Authorization: Bearer <token>"
curl -X POST http://localhost:3000/api/v1/auth/api-keys -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" -d '{"name":"my-key","scopes":["read:accounts","write:wallets"]}'
curl -X POST http://localhost:3000/api/v1/auth/roles/assign -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" -d '{"userId":"...","roleId":"...","justification":"..."}'
curl -X POST http://localhost:3000/api/v1/auth/roles/remove -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" -d '{"userId":"...","roleId":"..."}'
curl -X POST http://localhost:3000/api/v1/auth/mfa/enable -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" -d '{"secret":"TOTP_SECRET_BASE32"}'
```

### Core APIs

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | System health check |
| `GET` | `/metrics` | Prometheus metrics (text format) |
| `GET` | `/api/v1/accounts` | List accounts (paginated) |
| `POST` | `/api/v1/accounts` | Create account |
| `POST` | `/api/v1/journal` | Post double-entry journal |
| `POST` | `/api/v1/journal/:id/reverse` | Reverse a journal entry |
| `GET` | `/api/v1/accounts/:id/balance` | Get account balance |
| `GET` | `/api/v1/accounts/:id/history` | Get ledger history |
| `POST` | `/api/v1/wallets` | Register wallet |
| `GET` | `/api/v1/wallets/:id` | Get wallet by ID |
| `POST` | `/api/v1/wallets/:id/transactions` | Submit blockchain transaction |
| `GET` | `/api/v1/chain/state` | Current chain state |
| `GET` | `/api/v1/chain/tx/:hash` | Transaction status |
| `POST` | `/api/v1/chain/estimate-gas` | Gas estimation |
| `GET` | `/api/v1/blocks` | List indexed blocks |
| `GET` | `/api/v1/blocks/:number` | Get block by number |
| `GET` | `/api/v1/events` | Query indexed events |
| `GET` | `/api/v1/reconciliation/runs` | List reconciliation runs |

#### Core API curl Commands

```bash
# Health & Metrics
curl http://localhost:3000/health
curl http://localhost:3000/metrics

# Accounts
curl http://localhost:3000/api/v1/accounts
curl -X POST http://localhost:3000/api/v1/accounts -H "Content-Type: application/json" \
  -d '{"externalId":"acct-001","accountType":"asset","currency":"USD"}'
curl http://localhost:3000/api/v1/accounts/:id/balance
curl http://localhost:3000/api/v1/accounts/:id/history

# Ledger
curl -X POST http://localhost:3000/api/v1/journal -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/journal/:id/reverse

# Wallets
curl -X POST http://localhost:3000/api/v1/wallets -H "Content-Type: application/json" -d '{}'
curl http://localhost:3000/api/v1/wallets/:id
curl -X POST http://localhost:3000/api/v1/wallets/:id/transactions -H "Content-Type: application/json" -d '{}'

# Chain
curl http://localhost:3000/api/v1/chain/state
curl http://localhost:3000/api/v1/chain/tx/:hash
curl -X POST http://localhost:3000/api/v1/chain/estimate-gas -H "Content-Type: application/json" -d '{}'

# Indexer
curl http://localhost:3000/api/v1/blocks
curl http://localhost:3000/api/v1/blocks/:number
curl http://localhost:3000/api/v1/events

# Reconciliation
curl http://localhost:3000/api/v1/reconciliation/runs
```

### Asset APIs

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/assets` | Create asset |
| `GET` | `/api/v1/assets` | List assets (filterable by type/status) |
| `GET` | `/api/v1/assets/:id` | Get asset by ID |
| `PUT` | `/api/v1/assets/:id/valuation` | Update asset valuation |
| `POST` | `/api/v1/assets/:id/activate` | Activate asset |
| `POST` | `/api/v1/assets/:id/suspend` | Suspend asset |

#### Asset API curl Commands

```bash
curl -X POST http://localhost:3000/api/v1/assets -H "Content-Type: application/json" \
  -d '{"externalId":"asset-001","assetType":"real_estate","name":"Office Building","issuerId":"issuer-1"}'
curl http://localhost:3000/api/v1/assets
curl http://localhost:3000/api/v1/assets/:id
curl -X PUT http://localhost:3000/api/v1/assets/:id/valuation -H "Content-Type: application/json" \
  -d '{"valuation":"1000000","currency":"USD"}'
curl -X POST http://localhost:3000/api/v1/assets/:id/activate
curl -X POST http://localhost:3000/api/v1/assets/:id/suspend
```

### Tokenization APIs

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/tokens` | Create token |
| `GET` | `/api/v1/tokens` | List tokens (filterable by status/assetId) |
| `GET` | `/api/v1/tokens/:id` | Get token by ID |
| `POST` | `/api/v1/tokens/:id/activate` | Activate token |
| `POST` | `/api/v1/tokens/:id/pause` | Pause token |
| `POST` | `/api/v1/tokens/:id/mint` | Mint tokens |
| `POST` | `/api/v1/tokens/:id/burn` | Burn tokens |
| `POST` | `/api/v1/tokens/:id/transfer` | Transfer with compliance |
| `POST` | `/api/v1/tokens/:id/freeze` | Freeze holder |
| `POST` | `/api/v1/tokens/:id/unfreeze` | Unfreeze holder |
| `GET` | `/api/v1/tokens/:id/holders` | Cap table |
| `GET` | `/api/v1/tokens/:id/holders/:accountId` | Get specific holder balance |
| `GET` | `/api/v1/tokens/:id/operations` | Token operation history |
| `POST` | `/api/v1/tokens/:id/restrictions` | Add transfer restriction |
| `GET` | `/api/v1/tokens/:id/restrictions` | List transfer restrictions |
| `DELETE` | `/api/v1/tokens/:tokenId/restrictions/:restrictionId` | Remove restriction |
| `POST` | `/api/v1/tokens/:id/whitelist` | Add whitelist entry |
| `GET` | `/api/v1/tokens/:id/whitelist` | List whitelist entries |
| `DELETE` | `/api/v1/tokens/:tokenId/whitelist/:address` | Remove whitelist entry |
| `POST` | `/api/v1/tokens/:id/compliance-check` | Check transfer compliance |
| `POST` | `/api/v1/tokens/:id/actions` | Create corporate action |
| `GET` | `/api/v1/tokens/:id/actions` | List corporate actions |
| `GET` | `/api/v1/actions/:id` | Get corporate action |
| `POST` | `/api/v1/actions/:id/set-record` | Set record date (snapshot holders) |
| `POST` | `/api/v1/actions/:id/process` | Process distributions |
| `POST` | `/api/v1/actions/:id/vote` | Cast vote |
| `GET` | `/api/v1/actions/:id/results` | Get action results |
| `POST` | `/api/v1/actions/:id/cancel` | Cancel action |

#### Tokenization API curl Commands

```bash
# Token lifecycle
curl -X POST http://localhost:3000/api/v1/tokens -H "Content-Type: application/json" \
  -d '{"symbol":"BLDG","name":"Building Token","tokenStandard":"ERC-20","treasuryCurrency":"USD"}'
curl http://localhost:3000/api/v1/tokens
curl http://localhost:3000/api/v1/tokens/:id
curl -X POST http://localhost:3000/api/v1/tokens/:id/activate
curl -X POST http://localhost:3000/api/v1/tokens/:id/pause
curl -X POST http://localhost:3000/api/v1/tokens/:id/mint -H "Content-Type: application/json" \
  -d '{"toAccountId":"...","amount":"1000","idempotencyKey":"..."}'
curl -X POST http://localhost:3000/api/v1/tokens/:id/burn -H "Content-Type: application/json" \
  -d '{"fromAccountId":"...","amount":"100","idempotencyKey":"..."}'
curl -X POST http://localhost:3000/api/v1/tokens/:id/transfer -H "Content-Type: application/json" \
  -d '{"fromAccountId":"...","toAccountId":"...","amount":"50","idempotencyKey":"..."}'
curl -X POST http://localhost:3000/api/v1/tokens/:id/freeze -H "Content-Type: application/json" \
  -d '{"accountId":"..."}'
curl -X POST http://localhost:3000/api/v1/tokens/:id/unfreeze -H "Content-Type: application/json" \
  -d '{"accountId":"..."}'

# Cap table & operations
curl http://localhost:3000/api/v1/tokens/:id/holders
curl http://localhost:3000/api/v1/tokens/:id/holders/:accountId
curl http://localhost:3000/api/v1/tokens/:id/operations

# Compliance & restrictions
curl -X POST http://localhost:3000/api/v1/tokens/:id/restrictions -H "Content-Type: application/json" \
  -d '{"restrictionType":"whitelist","config":{}}'
curl http://localhost:3000/api/v1/tokens/:id/restrictions
curl -X DELETE http://localhost:3000/api/v1/tokens/:tokenId/restrictions/:restrictionId
curl -X POST http://localhost:3000/api/v1/tokens/:id/whitelist -H "Content-Type: application/json" \
  -d '{"address":"0x..."}'
curl http://localhost:3000/api/v1/tokens/:id/whitelist
curl -X DELETE http://localhost:3000/api/v1/tokens/:tokenId/whitelist/:address
curl -X POST http://localhost:3000/api/v1/tokens/:id/compliance-check -H "Content-Type: application/json" \
  -d '{"fromAccountId":"...","toAccountId":"...","amount":"100"}'

# Corporate actions
curl -X POST http://localhost:3000/api/v1/tokens/:id/actions -H "Content-Type: application/json" \
  -d '{"actionType":"dividend","title":"Q1 Dividend"}'
curl http://localhost:3000/api/v1/tokens/:id/actions
curl http://localhost:3000/api/v1/actions/:id
curl -X POST http://localhost:3000/api/v1/actions/:id/set-record
curl -X POST http://localhost:3000/api/v1/actions/:id/process
curl -X POST http://localhost:3000/api/v1/actions/:id/vote -H "Content-Type: application/json" \
  -d '{"accountId":"...","voteChoice":"approve"}'
curl http://localhost:3000/api/v1/actions/:id/results
curl -X POST http://localhost:3000/api/v1/actions/:id/cancel
```

### Institutional APIs (`/api/v1/institutional/`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/keys` | Register signing key |
| `POST` | `/keys/:keyId/rotate` | Initiate key rotation |
| `POST` | `/keys/:keyId/sign` | Sign with key |
| `GET` | `/keys/rotation-needed` | Keys needing rotation |
| `POST` | `/settlements` | Create settlement instruction |
| `POST` | `/settlements/:id/execute` | Execute atomic settlement |
| `POST` | `/settlements/netting` | Calculate netting |
| `GET` | `/settlements/pending` | List pending settlements |
| `POST` | `/treasury/portfolios` | Create treasury portfolio |
| `GET` | `/treasury/portfolios/:id/nav` | Calculate NAV |
| `GET` | `/treasury/portfolios/:id/rebalance` | Rebalance recommendations |
| `GET` | `/treasury/portfolios/:id/proof-of-reserves` | Proof of reserves |
| `POST` | `/monitoring/rules` | Create alert rule |
| `POST` | `/monitoring/evaluate` | Evaluate all alert rules |
| `GET` | `/monitoring/alerts` | Get unresolved alerts |
| `POST` | `/monitoring/alerts/:id/acknowledge` | Acknowledge alert |
| `GET` | `/monitoring/siem-export` | Export SIEM events |
| `POST` | `/trust-domains` | Create trust domain |
| `GET` | `/trust-domains` | List trust domains |
| `POST` | `/trust-domains/policies` | Create cross-domain policy |
| `POST` | `/trust-domains/authorize` | Cross-domain authorization |
| `POST` | `/asset-lifecycle/issue` | Issue asset |
| `POST` | `/asset-lifecycle/burn` | Burn asset |
| `POST` | `/asset-lifecycle/dividend` | Distribute dividend |
| `GET` | `/asset-lifecycle/:assetId/history` | Asset lifecycle history |
| `POST` | `/governance/policies` | Create approval policy |
| `POST` | `/governance/requests` | Submit for approval |
| `POST` | `/governance/requests/:id/approve` | Approve request |
| `POST` | `/governance/requests/:id/reject` | Reject request |
| `POST` | `/compliance/screen` | Screen address/entity |
| `POST` | `/compliance/travel-rule` | Create Travel Rule message |
| `POST` | `/compliance/sar` | File SAR |
| `POST` | `/risk/check` | Evaluate transaction risk |
| `POST` | `/risk/kill-switch` | Toggle kill switch |
| `POST` | `/vendors` | Register vendor |
| `POST` | `/vendors/:id/assessments` | Conduct vendor assessment |
| `POST` | `/vendors/:id/sla-metrics` | Record SLA metric |
| `GET` | `/vendors/needs-assessment` | Vendors needing reassessment |
| `POST` | `/privacy/zk-proof/balance` | Generate ZK balance proof |
| `POST` | `/privacy/selective-disclose` | Selective disclosure |
| `POST` | `/privacy/data-classification` | Classify data field |
| `POST` | `/privacy/enforce-retention` | Enforce retention policies |
| `POST` | `/infrastructure/nodes` | Register infra node |
| `GET` | `/infrastructure/nodes/:name/health` | Node health check |
| `GET` | `/infrastructure/capacity` | Capacity metrics |
| `POST` | `/infrastructure/failover` | Geographic failover |
| `GET` | `/dlq/stats` | DLQ statistics |
| `GET` | `/dlq/entries` | List DLQ entries |
| `POST` | `/dlq/:id/reprocess` | Reprocess DLQ entry |
| `POST` | `/oracle/quotes` | Submit price quote |
| `GET` | `/oracle/prices/:pair` | Get aggregated price (VWAP + median) |
| `GET` | `/oracle/prices` | Get all prices |
| `POST` | `/lending/loans` | Originate loan |
| `GET` | `/lending/loans` | List active loans |
| `POST` | `/lending/loans/:id/repay` | Repay loan |
| `POST` | `/lending/loans/:id/liquidate` | Execute liquidation |
| `POST` | `/lending/monitor` | Monitor LTV positions |
| `POST` | `/fx/rates` | Submit FX rate |
| `GET` | `/fx/rates/:pair` | Get FX rate for pair |
| `POST` | `/fx/quote` | Get locked FX quote |
| `POST` | `/fx/conversions/:id/execute` | Execute FX conversion |
| `GET` | `/fx/pairs` | List supported FX pairs |

#### Institutional API curl Commands

```bash
# Key Management
curl -X POST http://localhost:3000/api/v1/institutional/keys -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/keys/:keyId/rotate -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/keys/:keyId/sign -H "Content-Type: application/json" -d '{}'
curl http://localhost:3000/api/v1/institutional/keys/rotation-needed

# Settlement
curl -X POST http://localhost:3000/api/v1/institutional/settlements -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/settlements/:id/execute -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/settlements/netting -H "Content-Type: application/json" -d '{}'
curl http://localhost:3000/api/v1/institutional/settlements/pending

# Lending
curl -X POST http://localhost:3000/api/v1/institutional/lending/loans -H "Content-Type: application/json" -d '{}'
curl http://localhost:3000/api/v1/institutional/lending/loans
curl -X POST http://localhost:3000/api/v1/institutional/lending/loans/:id/repay -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/lending/loans/:id/liquidate -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/lending/monitor -H "Content-Type: application/json" -d '{}'

# FX
curl -X POST http://localhost:3000/api/v1/institutional/fx/rates -H "Content-Type: application/json" -d '{}'
curl http://localhost:3000/api/v1/institutional/fx/rates/:pair
curl -X POST http://localhost:3000/api/v1/institutional/fx/quote -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/fx/conversions/:id/execute -H "Content-Type: application/json" -d '{}'
curl http://localhost:3000/api/v1/institutional/fx/pairs

# Price Oracle
curl -X POST http://localhost:3000/api/v1/institutional/oracle/quotes -H "Content-Type: application/json" -d '{}'
curl http://localhost:3000/api/v1/institutional/oracle/prices/:pair
curl http://localhost:3000/api/v1/institutional/oracle/prices

# Treasury
curl -X POST http://localhost:3000/api/v1/institutional/treasury/portfolios -H "Content-Type: application/json" -d '{}'
curl http://localhost:3000/api/v1/institutional/treasury/portfolios/:id/nav
curl http://localhost:3000/api/v1/institutional/treasury/portfolios/:id/rebalance
curl http://localhost:3000/api/v1/institutional/treasury/portfolios/:id/proof-of-reserves

# Monitoring
curl -X POST http://localhost:3000/api/v1/institutional/monitoring/rules -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/monitoring/evaluate
curl http://localhost:3000/api/v1/institutional/monitoring/alerts
curl -X POST http://localhost:3000/api/v1/institutional/monitoring/alerts/:id/acknowledge -H "Content-Type: application/json" -d '{}'
curl http://localhost:3000/api/v1/institutional/monitoring/siem-export

# Trust Domains
curl -X POST http://localhost:3000/api/v1/institutional/trust-domains -H "Content-Type: application/json" -d '{}'
curl http://localhost:3000/api/v1/institutional/trust-domains
curl -X POST http://localhost:3000/api/v1/institutional/trust-domains/policies -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/trust-domains/authorize -H "Content-Type: application/json" -d '{}'

# Asset Lifecycle
curl -X POST http://localhost:3000/api/v1/institutional/asset-lifecycle/issue -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/asset-lifecycle/burn -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/asset-lifecycle/dividend -H "Content-Type: application/json" -d '{}'
curl http://localhost:3000/api/v1/institutional/asset-lifecycle/:assetId/history

# Governance
curl -X POST http://localhost:3000/api/v1/institutional/governance/policies -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/governance/requests -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/governance/requests/:id/approve -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/governance/requests/:id/reject -H "Content-Type: application/json" -d '{}'

# Compliance
curl -X POST http://localhost:3000/api/v1/institutional/compliance/screen -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/compliance/travel-rule -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/compliance/sar -H "Content-Type: application/json" -d '{}'

# Risk
curl -X POST http://localhost:3000/api/v1/institutional/risk/check -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/risk/kill-switch -H "Content-Type: application/json" -d '{}'

# Vendors
curl -X POST http://localhost:3000/api/v1/institutional/vendors -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/vendors/:id/assessments -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/vendors/:id/sla-metrics -H "Content-Type: application/json" -d '{}'
curl http://localhost:3000/api/v1/institutional/vendors/needs-assessment

# Privacy
curl -X POST http://localhost:3000/api/v1/institutional/privacy/zk-proof/balance -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/privacy/selective-disclose -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/privacy/data-classification -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:3000/api/v1/institutional/privacy/enforce-retention

# Infrastructure
curl -X POST http://localhost:3000/api/v1/institutional/infrastructure/nodes -H "Content-Type: application/json" -d '{}'
curl http://localhost:3000/api/v1/institutional/infrastructure/nodes/:name/health
curl http://localhost:3000/api/v1/institutional/infrastructure/capacity
curl -X POST http://localhost:3000/api/v1/institutional/infrastructure/failover -H "Content-Type: application/json" -d '{}'

# Dead Letter Queue
curl http://localhost:3000/api/v1/institutional/dlq/stats
curl http://localhost:3000/api/v1/institutional/dlq/entries
curl -X POST http://localhost:3000/api/v1/institutional/dlq/:id/reprocess
```

## Installation

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- An Ethereum RPC endpoint (Infura, Alchemy, or local node)

### Quick Start

```bash
git clone https://github.com/pavondunbar/Blockchain-Custody-Infrastructure.git
cd Blockchain-Custody-Infrastructure

docker compose up -d
npm install
psql -h localhost -U postgres -c "CREATE DATABASE tradfi_web3;"
npm run migrate
psql -h localhost -U postgres -d tradfi_web3 -c "GRANT SELECT, UPDATE ON outbox TO ledger_writer;"

# Fork Ethereum Mainnet (separate terminal)
anvil --fork-url [YOUR_RPC_URL] --chain-id 1337 --host 0.0.0.0 --port 8545

npm run dev
```

### Verify

```bash
curl http://localhost:3000/health
# {"status":"ok","timestamp":"..."}

curl http://localhost:3000/metrics
# Prometheus text format metrics
```

## Testing

```bash
npm test              # 39 tests across 3 suites
npx jest --coverage   # With coverage report
```

Test suites:
- **Ledger service** — balanced posting, hash chain, idempotency, reversals, double-spend prevention
- **Wallet service** — creation, nonce allocation, reorg handling, concurrency
- **Institutional services** — key management, settlement, treasury, monitoring, lending, FX, privacy, infrastructure, trust domains, asset lifecycle, vendor risk

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PG_HOST` | `localhost` | PostgreSQL host |
| `PG_PORT` | `5432` | PostgreSQL port |
| `PG_DATABASE` | `tradfi_web3` | Database name |
| `PG_USER` | `app_writer` | DB user (least-privilege) |
| `PG_PASSWORD` | `password` | DB password |
| `PG_POOL_MAX` | `20` | Connection pool size |
| `REDIS_HOST` | `localhost` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `KAFKA_BROKERS` | `localhost:9092` | Kafka brokers |
| `ETH_RPC_URL` | `http://localhost:8545` | Ethereum RPC |
| `ETH_CONFIRMATIONS` | `12` | Finality threshold |
| `PORT` | `3000` | API port |
| `LOG_LEVEL` | `info` | Pino log level |

## Project Structure

```
src/
├── config.ts                              # Environment config + logger
├── index.ts                               # Service orchestrator (entrypoint)
├── database/
│   ├── migrations/
│   │   ├── 001_ledger_schema.sql          # Core ledger with triggers
│   │   ├── 002_tokenization_schema.sql    # Token/asset tables
│   │   ├── 003_institutional_controls.sql # IAM, governance, risk, compliance, key mgmt
│   │   └── 004_systemic_gaps.sql          # DLQ, decimal precision, lending, FX, state machines
│   ├── connection.ts                      # Pool + serializable transaction helper
│   ├── migrate.ts                         # Migration runner
│   ├── ledger-service.ts                  # Double-entry posting engine
│   └── ledger-service.test.ts             # Ledger tests
├── cache/
│   └── redis.ts                           # Balance cache, nonce mgr, rate limiter
├── messaging/
│   ├── outbox-relay.ts                    # Outbox → Kafka with DLQ integration
│   └── dlq-service.ts                    # Dead Letter Queue with retry/reprocess
├── wallet/
│   ├── wallet-service.ts                  # Wallet CRUD, tx pipeline, signing
│   └── wallet-service.test.ts             # Wallet tests
├── indexer/
│   └── block-indexer.ts                   # Block ingestion, reorg detection
├── chain/
│   └── chain-service.ts                   # Ethereum integration, finality, gas
├── reconciliation/
│   └── reconciliation-service.ts          # Balance + hash chain verification
├── security/
│   ├── auth-service.ts                    # IAM, RBAC, MFA, sessions, API keys
│   ├── audit-service.ts                   # Append-only audit trail
│   └── encryption-service.ts             # AES-256-GCM field encryption
├── risk/
│   ├── risk-service.ts                    # Velocity/concentration/exposure policies
│   └── circuit-breaker.ts                # Circuit breakers + kill switches
├── compliance/
│   └── aml-service.ts                    # OFAC screening, Travel Rule, SAR
├── governance/
│   └── approval-service.ts              # Four-eyes, M-of-N, timelocks
├── key-management/
│   └── key-service.ts                   # HSM/MPC/KMS signing, rotation, sharding
├── settlement/
│   └── settlement-service.ts            # DvP/PvP/netting, atomic execution
├── lending/
│   └── lending-service.ts               # Loans, margin, liquidation
├── fx/
│   └── fx-service.ts                    # FX rates, locking, PvP conversion
├── oracle/
│   └── price-oracle-service.ts          # VWAP, median, outlier rejection
├── treasury/
│   └── treasury-service.ts             # NAV, rebalancing, proof of reserves
├── monitoring/
│   ├── monitoring-service.ts            # Alerting, anomaly detection, SIEM
│   └── metrics-exporter.ts             # Prometheus /metrics endpoint
├── trust-domains/
│   └── trust-domain-service.ts         # Isolation, cross-domain auth
├── asset-lifecycle/
│   └── asset-lifecycle-service.ts      # Issuance, burning, dividends, maturity
├── tokenization/
│   ├── types.ts                         # Shared types
│   ├── asset-service.ts                 # Asset registration
│   ├── token-service.ts                 # Mint/burn/transfer/freeze
│   ├── compliance-service.ts            # Transfer restrictions, whitelist
│   └── corporate-actions-service.ts     # Dividends, votes, splits
├── vendor/
│   └── vendor-risk-service.ts          # Assessments, SLA monitoring
├── privacy/
│   └── privacy-service.ts             # ZK proofs, selective disclosure
├── infrastructure/
│   └── infrastructure-service.ts       # Node health, load balancing, failover
├── institutional/
│   └── institutional-services.test.ts  # Institutional module tests
└── api/
    ├── app.ts                           # Express app + core routes + /metrics
    ├── auth-routes.ts                   # Auth/IAM API endpoints (register, login, MFA, RBAC)
    └── institutional-routes.ts         # All institutional API endpoints

docker-compose.yml                       # Postgres 16, Redis 7, Kafka, Zookeeper
.github/workflows/ci.yml                # CI: lint, build, test (Node 20/22)
```

## Failure Scenarios

### Chain Reorganization (Reorg) Handling

```
Block Indexer polls block N+1
  → Fetches block.parentHash
  → Compares against stored hash for block N
  → MISMATCH → reorg triggered → marks affected data → re-indexes from fork point
```

### Double-Spend Prevention

Three layers: application validation → `SELECT FOR UPDATE` row locking → serializable isolation (SSI conflict detection). It is physically impossible for two conflicting transactions to both commit.

### DB-Enforced State Machine Transitions

```sql
-- Example: transactions_blockchain can only go:
-- pending → signing/failed
-- signing → submitted/failed
-- submitted → confirmed/failed/reorged
-- confirmed → reorged (only)
-- failed/reorged → (terminal, no transitions)

CREATE TRIGGER trg_tx_state_machine
  BEFORE UPDATE OF status ON transactions_blockchain
  FOR EACH ROW EXECUTE FUNCTION enforce_tx_state_machine();
```

Similar triggers enforce valid transitions on `settlement_instructions`, `loans`, and `approval_requests`.

### Dead Letter Queue Recovery

```
Outbox publish fails → Message sent to DLQ table + Kafka DLQ topic
  → Exponential backoff: 1s, 2s, 4s, 8s, 16s
  → After 5 retries: status = 'exhausted' (requires manual intervention)
  → Manual reprocess via POST /api/v1/institutional/dlq/:id/reprocess
```

## Production Warning

**This project is explicitly NOT suitable for production use.** It is a reference implementation for learning and architectural exploration. Critical missing components include:

- Real HSM/MPC cryptographic integration (signing is stubbed)
- TLS termination & mutual authentication
- Network segmentation & firewalling
- Security audit & penetration testing
- Backup & disaster recovery procedures
- Regulatory compliance (BitLicense, MiCA, MTL)
- SOC 2 / ISO 27001 certification
- Production monitoring (PagerDuty, Datadog)
- Multi-region deployment
- Insurance coverage

> **Do not use this code to custody, manage, or transfer real digital assets or funds.**

## License

MIT License

---

Built with ❤️ by [Pavon Dunbar](https://github.com/pavondunbar)
