# Blockchain Custody Infrastructure

> **SANDBOX / EDUCATIONAL USE ONLY — NOT FOR PRODUCTION**
> This codebase is a reference implementation designed for learning, prototyping, and architectural exploration. It is **not audited, not legally reviewed, and must not be used to custody real funds, manage real private keys, or process real financial transactions.** See the [Production Warning](#production-warning) section for full details.

Enterprise-grade blockchain infrastructure layer providing a custody-grade double-entry ledger (append-only, hash-chained, serializable isolation), Ethereum L1 integration (block indexing, reorg detection, finality tracking), wallet management with HSM/MPC signing pipelines, and event-driven architecture via transactional outbox → Kafka. All financial operations enforce ACID guarantees with database-level immutability triggers, cryptographic audit trails, and automated reconciliation.

## Table of Contents

- [Overview](#overview)
- [What This Does](#what-this-does)
- [Who This Benefits](#who-this-benefits)
- [Architecture](#architecture)
- [Core Components](#core-components)
- [Ledger Guarantees](#ledger-guarantees)
- [Database Schema](#database-schema)
- [API Reference](#api-reference)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Project Structure](#project-structure)
- [Production Warning](#production-warning)
- [License](#license)

## Overview

| Component | Detail |
|-----------|--------|
| Language | TypeScript (strict mode) |
| Database | PostgreSQL 16 (append-only ledger, serializable isolation) |
| Cache | Redis 7 (balance cache, nonce management, rate limiting) |
| Messaging | Apache Kafka via transactional outbox pattern |
| Blockchain | Ethereum L1 (ethers.js v6) |
| API | Express REST |
| Testing | Jest + ts-jest |
| Infrastructure | Docker Compose (Postgres, Redis, Kafka, Zookeeper) |

This system implements the **core backend infrastructure** of a digital-asset custody platform — the kind of system that underpins institutional custodians (BitGo, Fireblocks, Anchorage), crypto exchanges (Coinbase, Kraken), and fintech platforms building crypto-native banking products.

It handles the full operational lifecycle: custody-grade financial accounting, blockchain transaction creation and monitoring, wallet key management orchestration, chain event indexing with reorg resilience, and automated integrity verification — all through an event-driven architecture that guarantees no state change is ever lost.

## What This Does

### 1. Custody-Grade Financial Ledger

Every movement of funds is recorded as a balanced debit/credit pair in an immutable, hash-chained ledger. You cannot lose track of where money is, you cannot edit history, and you can cryptographically prove the records haven't been tampered with.

- **Double-entry accounting** — every transfer creates balanced debit + credit entries
- **Hash-chained audit trail** — SHA-256 chain links every entry to its predecessor
- **Append-only enforcement** — database triggers physically prevent UPDATE/DELETE on ledger rows
- **Serializable isolation** — the strongest ACID guarantee Postgres offers
- **Idempotency keys** — duplicate requests are safely deduplicated
- **Explicit reversals** — corrections are new mirror entries, never mutations

### 2. Ethereum L1 Integration

The system connects to Ethereum, watches for new blocks and events, submits signed transactions, tracks confirmation and finality, and handles chain-level edge cases that can cause fund loss if ignored.

- **Block-by-block indexing** — continuous ingestion of blocks and contract events
- **Reorg detection and recovery** — detects chain forks by verifying parent hash continuity, marks affected data, and re-indexes from the fork point
- **Finality tracking** — configurable confirmation threshold (default 12 blocks) distinguishing "confirmed" from "finalized"
- **Gas estimation** — EIP-1559 aware fee calculation
- **Stuck transaction detection** — alerts when submitted transactions haven't confirmed after 15 minutes

### 3. Wallet & Signing Pipeline

Manages blockchain wallets and orchestrates the transaction signing workflow, separating protocol logic from security controls.

- **Wallet lifecycle** — create, classify (hot/warm/cold/deposit), and monitor wallets
- **Transaction pipeline** — create → sign → submit → monitor → confirm
- **Nonce management** — Redis atomic increment prevents nonce collisions under concurrency
- **KMS/HSM integration interface** — pluggable signing service (local dev signer for testing, production uses MPC/HSM)
- **Reorg handling** — marks affected transactions when chain reorganizations occur

### 4. Event-Driven Architecture

Every state change is guaranteed to reach downstream systems through the transactional outbox pattern.

- **Transactional outbox** — events are written to the outbox table in the same database transaction as the state change
- **Kafka publishing** — a relay service polls unpublished events and delivers them to Kafka topics
- **At-least-once delivery** — guaranteed delivery; consumers must be idempotent
- **FOR UPDATE SKIP LOCKED** — concurrent-safe polling without blocking

### 5. Automated Reconciliation

Scheduled jobs independently verify system integrity without relying on application-layer correctness.

- **Balance reconciliation** — compares cached balances against reconstructed-from-ledger balances every 5 minutes
- **Hash chain verification** — walks every account's entry chain checking for broken links every 15 minutes
- **Alert on failure** — emits events to Kafka when discrepancies are detected

## Who This Benefits

### Institutional Clients

| Need | How This Addresses It |
|------|----------------------|
| **Regulatory audit trail** | Every fund movement is recorded in a hash-chained, append-only ledger with external reference traceability. The entire history can be reconstructed from raw entries. |
| **Counterparty risk elimination** | Serializable isolation + row-level locking ensures no double-spend, no race conditions, and no phantom reads — even under high concurrency. |
| **Operational resilience** | Reorg detection prevents silent fund loss from chain reorganizations. Stuck transaction detection prevents capital lockup. Circuit-breaker patterns prevent cascading RPC failures. |
| **Separation of duties** | Database-enforced least-privilege roles (reader vs. writer) ensure that read-only services cannot mutate ledger data at the infrastructure level. |
| **Multi-system integration** | The Kafka event bus allows compliance, reporting, notifications, and analytics systems to react to every state change without coupling to the core. |
| **Disaster recovery** | The append-only ledger + hash chain enables point-in-time reconstruction and cross-system reconciliation. |

### Retail Platforms

| Need | How This Addresses It |
|------|----------------------|
| **Correct balances at scale** | The balance cache provides O(1) lookups while the ledger provides provably correct derived balances. Reconciliation jobs catch any drift. |
| **Fast transaction processing** | Redis-backed nonce management and concurrent-safe ledger posting allow high-throughput transaction submission. |
| **Real-time event streaming** | Kafka events enable real-time notifications, portfolio updates, and activity feeds for end users. |
| **Multi-chain readiness** | The architecture cleanly separates chain-specific logic (adapters) from business logic (ledger, wallets). Adding new chains requires only a new adapter. |
| **Uptime under chain instability** | Reorg handling, stuck tx detection, and automated reconciliation mean the platform stays correct even when the underlying chain misbehaves. |

## Architecture

```
                    ┌──────────────────────────────────────────────────┐
                    │              REQUEST FLOW                        │
                    └──────────────────────────────────────────────────┘

    Client ──► Express API ──► Ledger Service ──► PostgreSQL
                   │                  │                 │
                   │                  │         ┌──────────────┐
                   │                  └────────►│ Outbox Table │
                   │                            └──────┬───────┘
                   │                                   │
                   │            ┌───────────────────────┘
                   │            ▼
                   │     Outbox Relay ──────────────────► Kafka Topics
                   │
                   ├──► Wallet Service ──► Redis (nonce) ──► Chain Service
                   │                                              │
                   │                                              ▼
                   │                                    Ethereum L1 (RPC)
                   │
                   ├──► Block Indexer ──► PostgreSQL (blocks, events)
                   │         │
                   │         └──► Reorg Detection ──► Recovery
                   │
                   └──► Reconciliation Service (cron)
                              │
                              ├──► Balance Verification
                              └──► Hash Chain Verification
```

### Data Flow

1. **API request** → Express validates and routes to the appropriate service
2. **Ledger posting** → Serializable transaction writes journal entry + ledger entries + balance cache update + outbox event — all atomically
3. **Outbox relay** → Background process polls unpublished events and delivers to Kafka
4. **Block indexer** → Continuously ingests blocks, stores events, detects reorgs
5. **Chain service** → Monitors submitted transactions, tracks confirmations, detects stuck txs
6. **Reconciliation** → Cron jobs verify balance integrity and hash chain continuity

## Core Components

### Ledger Service (`src/database/ledger-service.ts`)

The heart of the system. Posts double-entry journal entries with hash chaining, serializable isolation, idempotency, and atomic outbox writes. Supports explicit reversals for corrections.

### Wallet Service (`src/wallet/wallet-service.ts`)

Manages wallet registration, transaction creation (with Redis-backed atomic nonce allocation), lifecycle tracking (pending → signing → submitted → confirmed → failed → reorged), and reorg handling.

### Block Indexer (`src/indexer/block-indexer.ts`)

Continuously polls Ethereum for new blocks. Stores block metadata and contract events. Detects reorgs by verifying parent hash continuity. On reorg detection: marks affected blocks/events/transactions, resets to fork point, emits alert events.

### Chain Service (`src/chain/chain-service.ts`)

Handles transaction submission, gas estimation (EIP-1559), finality tracking with configurable confirmation threshold, and stuck transaction detection with alerting.

### Outbox Relay (`src/messaging/outbox-relay.ts`)

Polls the transactional outbox table using `FOR UPDATE SKIP LOCKED` for concurrent safety. Publishes to Kafka with an idempotent producer. Marks entries as published after successful delivery.

### Redis Cache (`src/cache/redis.ts`)

Provides balance caching (TTL-based read-through), atomic nonce management, sliding-window rate limiting, block height tracking, and transaction status caching.

### Reconciliation Service (`src/reconciliation/reconciliation-service.ts`)

Cron-scheduled jobs that verify:
- **Balance integrity** — cached balances match independently reconstructed balances from raw ledger entries
- **Hash chain integrity** — no broken links, no sequence gaps in the cryptographic chain

Emits Kafka events on failures for downstream alerting.

### API Layer (`src/api/app.ts`)

REST endpoints for:
- Posting journal entries and reversals
- Querying account balances and transaction history
- Creating wallets and submitting blockchain transactions
- Querying chain state, blocks, and indexed events
- Viewing reconciliation run history

## Ledger Guarantees

| Guarantee | Implementation |
|-----------|---------------|
| Append-only ledger | Postgres triggers block UPDATE/DELETE on `ledger_entries` with `RAISE EXCEPTION` |
| Double-entry accounting | Deferred constraint trigger validates `SUM(debits) = SUM(credits)` at COMMIT |
| Integer amounts only | `BIGINT` columns with `CHECK (amount != 0)` — no floating-point precision loss |
| Derived balances with cache | `balance_cache` table updated atomically in same transaction; independently reconstructable |
| Idempotency keys | `UNIQUE` constraint on `journal_entries.idempotency_key` |
| Database-enforced constraints | CHECK constraints on amounts, balances, directions, hash lengths |
| Serializable isolation | `BEGIN ISOLATION LEVEL SERIALIZABLE` + `SELECT ... FOR UPDATE` row locking |
| Reconciliation jobs | Cron-based balance + hash chain verification with automated alerting |
| Explicit reversals | Mirror entries posted; original marked as reversed (never mutated) |
| Least-privilege permissions | `ledger_reader` role (SELECT only), `ledger_writer` role (INSERT + limited UPDATE) |
| Balanced journal entries | Deferred constraint trigger rejects unbalanced entries at COMMIT |
| Atomic posting | Single serializable transaction for all lines + balance cache + outbox event |
| Historical reconstruction | `reconstructBalance()` re-derives any balance from raw ledger entries |
| UTC timestamps | `TIMESTAMPTZ` with `DEFAULT NOW()` on all tables |
| External reference traceability | `external_ref` + `external_ref_type` on journal entries |
| Cryptographic audit trail | SHA-256 hash chain validated by `trg_validate_hash_chain` trigger |
| ACID guarantees | Serializable isolation (I), WAL durability (D), CHECK constraints (C), single-transaction atomicity (A) |

## Database Schema

### Core Ledger Tables

- **`accounts`** — Account registry with type classification (asset, liability, equity, revenue, expense)
- **`journal_entries`** — Double-entry headers with idempotency keys and external references
- **`ledger_entries`** — Individual debit/credit lines with SHA-256 hash chain (append-only, trigger-enforced)
- **`balance_cache`** — Derived balance materialization for O(1) lookups

### Messaging

- **`outbox`** — Transactional outbox for guaranteed Kafka delivery

### Wallet & Chain

- **`wallets`** — Registered wallets with chain, address, type (hot/warm/cold/deposit), and KMS key reference
- **`transactions_blockchain`** — Full transaction lifecycle with status, confirmations, gas details, and block info

### Indexer

- **`indexed_blocks`** — Ingested block metadata with reorg status tracking
- **`indexed_events`** — Contract events linked to blocks, with processing status

### Operations

- **`reconciliation_runs`** — Reconciliation execution history with pass/fail status and discrepancy counts

## API Reference

### Ledger

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/journal` | Post a double-entry journal (requires `idempotencyKey` and balanced `lines`) |
| `POST` | `/api/v1/journal/:id/reverse` | Reverse a journal entry (posts mirror entries) |
| `GET` | `/api/v1/accounts/:id/balance` | Get cached balance for an account |
| `GET` | `/api/v1/accounts/:id/history` | Get ledger entry history (paginated) |

### Wallets

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/wallets` | Register a new wallet |
| `GET` | `/api/v1/wallets/:id` | Get wallet details |
| `POST` | `/api/v1/wallets/:id/transactions` | Create and queue a blockchain transaction |

### Chain

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/chain/state` | Get current chain state (block number, gas prices) |
| `GET` | `/api/v1/chain/tx/:hash` | Get transaction status with finality info |
| `POST` | `/api/v1/chain/estimate-gas` | Estimate gas for a transaction (EIP-1559) |

### Indexer

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/blocks` | List recently indexed blocks |
| `GET` | `/api/v1/blocks/:number` | Get a specific indexed block |
| `GET` | `/api/v1/events` | Query indexed events (filter by contract, event signature) |

### Operations

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/reconciliation/runs` | List recent reconciliation runs |
| `GET` | `/health` | System health check |

## Installation

### Prerequisites

- Node.js 20+
- Docker and Docker Compose (for infrastructure services)
- An Ethereum RPC endpoint (Infura, Alchemy, or local node)

### Quick Start

```bash
# Clone the repository
git clone https://github.com/pavondunbar/Blockchain-Custody-Infrastructure.git
cd Blockchain-Custody-Infrastructure

# Start infrastructure (Postgres, Redis, Kafka, Zookeeper)
docker compose up -d

# Install dependencies
npm install

# Create the tradfi_web3 database in Postgres
psql -h localhost -U postgres -c "CREATE DATABASE tradfi_web3;"

# Run database migrations (uses postgres/postgres admin credentials)
npm run migrate

# Fix outbox permissions (migration grants INSERT but relay needs UPDATE)
psql -h localhost -U postgres -d tradfi_web3 -c "GRANT SELECT, UPDATE ON outbox TO ledger_writer;"

# Start a local Ethereum node (choose one)
anvil

# Start the application
npm run dev
```

### Verify Installation

```bash
# Check health endpoint
curl http://localhost:3000/health

# Expected response:
# {"status":"ok","timestamp":"2026-06-04T23:00:00.000Z"}
```

## Usage

### Post a Journal Entry (Double-Entry Transfer)

```bash
curl -X POST http://localhost:3000/api/v1/journal \
  -H "Content-Type: application/json" \
  -d '{
    "idempotencyKey": "transfer-001",
    "description": "Client deposit",
    "externalRef": "wire-ref-12345",
    "externalRefType": "bank_wire",
    "lines": [
      {"accountId": "<asset-account-uuid>", "amount": "1000000", "direction": "debit"},
      {"accountId": "<liability-account-uuid>", "amount": "1000000", "direction": "credit"}
    ]
  }'
```

### Create a Wallet

```bash
curl -X POST http://localhost:3000/api/v1/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "<account-uuid>",
    "chain": "ethereum",
    "address": "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD45",
    "walletType": "hot",
    "keyId": "kms-key-ref-001"
  }'
```

### Submit a Transaction

```bash
curl -X POST http://localhost:3000/api/v1/wallets/<wallet-id>/transactions \
  -H "Content-Type: application/json" \
  -d '{
    "toAddress": "0x1234567890abcdef1234567890abcdef12345678",
    "amount": "1000000000000000000"
  }'
```

### Query Balance

```bash
curl http://localhost:3000/api/v1/accounts/<account-id>/balance
```

### Query Chain State

```bash
curl http://localhost:3000/api/v1/chain/state
```

## Configuration

All configuration is via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PG_HOST` | No | `localhost` | PostgreSQL host |
| `PG_PORT` | No | `5432` | PostgreSQL port |
| `PG_DATABASE` | No | `tradfi_web3` | PostgreSQL database name |
| `PG_USER` | No | `app_writer` | PostgreSQL user (least-privilege) |
| `PG_PASSWORD` | Yes | `password` | PostgreSQL password |
| `PG_POOL_MAX` | No | `20` | Connection pool size |
| `PG_ADMIN_USER` | No | `postgres` | Admin user for migrations |
| `PG_ADMIN_PASSWORD` | No | `postgres` | Admin password for migrations |
| `REDIS_HOST` | No | `localhost` | Redis host |
| `REDIS_PORT` | No | `6379` | Redis port |
| `REDIS_PASSWORD` | No | — | Redis password |
| `KAFKA_BROKERS` | No | `localhost:9092` | Comma-separated Kafka broker addresses |
| `KAFKA_CLIENT_ID` | No | `tradfi-web3` | Kafka client identifier |
| `ETH_RPC_URL` | No | `http://localhost:8545` | Ethereum JSON-RPC endpoint |
| `ETH_CHAIN_ID` | No | `1` | Ethereum chain ID |
| `ETH_CONFIRMATIONS` | No | `12` | Required block confirmations for finality |
| `PORT` | No | `3000` | API server port |
| `LOG_LEVEL` | No | `info` | Pino log level |

## Project Structure

```
src/
├── config.ts                              # Environment config + logger
├── index.ts                               # Service orchestrator (entrypoint)
├── database/
│   ├── migrations/
│   │   └── 001_ledger_schema.sql          # Full Postgres schema with triggers
│   ├── connection.ts                      # Pool + serializable transaction helper
│   ├── migrate.ts                         # Migration runner
│   └── ledger-service.ts                  # Double-entry posting engine
├── cache/
│   └── redis.ts                           # Balance cache, nonce mgr, rate limiter
├── messaging/
│   └── outbox-relay.ts                    # Transactional outbox → Kafka publisher
├── wallet/
│   └── wallet-service.ts                  # Wallet CRUD, tx pipeline, signing interface
├── indexer/
│   └── block-indexer.ts                   # Block ingestion, event indexing, reorg detection
├── chain/
│   └── chain-service.ts                   # Ethereum integration, finality, gas estimation
├── reconciliation/
│   └── reconciliation-service.ts          # Balance + hash chain verification cron jobs
└── api/
    └── app.ts                             # REST API (ledger, wallets, chain, blocks, events)

docker-compose.yml                         # Postgres 16, Redis 7, Kafka, Zookeeper
```

## Production Warning

**This project is explicitly NOT suitable for production use.** Blockchain custody infrastructure is among the most security-sensitive systems in financial technology. The following critical components are absent or require hardening:

| Missing Component | Risk if Absent |
|-------------------|----------------|
| Hardware Security Module (HSM) integration | Private keys stored in software are vulnerable to extraction |
| Real MPC threshold signing (FROST / GG20) | Single-point-of-failure key management |
| TLS termination & mutual authentication | Unencrypted service-to-service communication |
| Network segmentation & firewalling | Services reachable from unauthorized networks |
| Security audit & penetration testing | Unknown vulnerabilities in application logic |
| Backup & disaster recovery procedures | Data loss on hardware failure |
| Regulatory compliance (BitLicense, MiCA, state MTL) | Legal liability for operating without licenses |
| SOC 2 / ISO 27001 controls | No formal security controls framework |
| Production monitoring & alerting (PagerDuty, Datadog) | Incidents go undetected |
| Key ceremony & rotation procedures | Long-lived keys increase compromise window |
| Rate limiting & DDoS protection | API abuse and resource exhaustion |
| Input validation hardening | Injection and malformed data attacks |
| Multi-region deployment & failover | Single point of failure at infrastructure level |

> Building a production custody platform requires: licensed money transmission or e-money status, HSM or MPC infrastructure with certified key management, hot/cold wallet segregation, multi-signature approval workflows, real-time chain monitoring, regulatory compliance programs, SOC 2 Type II certification, incident response procedures, and insurance coverage. **Do not use this code to custody, manage, or transfer real digital assets or funds.**

## License

This project is licensed under the MIT License.

---

Built with ❤ ️ by [Pavon Dunbar](https://github.com/pavondunbar)
