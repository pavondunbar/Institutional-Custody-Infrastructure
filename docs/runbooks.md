# Operational Runbooks — Institutional Custody Infrastructure

## Severity Levels

| Level | Response Time | Examples |
|-------|--------------|---------|
| SEV1  | 5 min        | Complete outage, data loss, security breach, stuck funds |
| SEV2  | 15 min       | Degraded service, single component failure, reorg detected |
| SEV3  | 1 hour       | Performance degradation, non-critical alerts, DLQ backlog |
| SEV4  | Next business day | Minor issues, cosmetic, non-customer-affecting |

---

## Runbook 1: Database Connection Pool Exhaustion

**Symptoms:** HTTP 503s, `pool exhausted` errors in logs, latency spike on all endpoints.

**Diagnosis:**
```bash
# Check active connections
psql -h $PG_HOST -U postgres -c "SELECT state, count(*) FROM pg_stat_activity GROUP BY state;"

# Check for long-running queries
psql -h $PG_HOST -U postgres -c "SELECT pid, now() - query_start AS duration, query FROM pg_stat_activity WHERE state = 'active' ORDER BY duration DESC LIMIT 10;"

# Check pool metrics
curl -s http://localhost:3000/metrics | grep pg_pool
```

**Resolution:**
1. If idle connections dominate: restart app (graceful via SIGTERM)
2. If long queries block: `SELECT pg_terminate_backend(<pid>);` for queries > 5 min
3. If sustained: increase `PG_POOL_MAX` (current: 20) — max safe value = (max_connections - 10) / num_app_instances
4. Check for serialization retries piling up (serializable isolation can cascade)

**Prevention:** Monitor `pg_stat_activity` count; alert at 80% of pool max.

---

## Runbook 2: Chain Reorganization Detected

**Symptoms:** `reorg triggered` in logs, `indexed_blocks` rows marked `reorged`, affected transactions show `reorged` status.

**Diagnosis:**
```bash
# Check reorg depth
psql -h $PG_HOST -U $PG_USER -d tradfi_web3 -c \
  "SELECT block_number, status FROM indexed_blocks WHERE status = 'reorged' ORDER BY block_number DESC LIMIT 20;"

# Check affected transactions
psql -h $PG_HOST -U $PG_USER -d tradfi_web3 -c \
  "SELECT id, status, block_number FROM transactions_blockchain WHERE status = 'reorged';"
```

**Resolution:**
1. If depth ≤ 12 blocks: automatic recovery — indexer re-indexes from fork point
2. If depth > 12 (affects finalized txs):
   - **SEV1 — page on-call immediately**
   - Halt outbound transaction processing: `POST /api/v1/institutional/risk/kill-switch -d '{"feature":"outbound_transactions","enabled":true}'`
   - Identify affected settlements and notify counterparties
   - Manual reconciliation: `POST /api/v1/reconciliation/runs` and review discrepancies
3. Document in incident log; adjust `ETH_CONFIRMATIONS` if needed

**Prevention:** Alert on reorg depth > 3 blocks.

---

## Runbook 3: Dead Letter Queue Backlog

**Symptoms:** DLQ entry count growing, `exhausted` entries appearing, Kafka consumer lag.

**Diagnosis:**
```bash
curl -s http://localhost:3000/api/v1/institutional/dlq/stats
curl -s http://localhost:3000/api/v1/institutional/dlq/entries | jq '.[] | select(.status=="exhausted")'
```

**Resolution:**
1. Check Kafka broker health: `kafka-broker-api-versions --bootstrap-server $KAFKA_BROKERS`
2. If Kafka is down: entries will retry automatically once Kafka recovers
3. If entries are `exhausted` (5 retries failed):
   - Inspect error: `curl http://localhost:3000/api/v1/institutional/dlq/entries | jq '.[0].lastError'`
   - Fix underlying issue (schema mismatch, topic deleted, etc.)
   - Reprocess: `POST /api/v1/institutional/dlq/:id/reprocess`
4. If backlog is large (>1000): check outbox relay is running, restart if needed

**Prevention:** Alert when DLQ count > 50 or any `exhausted` entries exist.

---

## Runbook 4: Stuck Blockchain Transactions

**Symptoms:** Transactions in `submitted` status for > 15 minutes, gas prices spiked.

**Diagnosis:**
```bash
psql -h $PG_HOST -U $PG_USER -d tradfi_web3 -c \
  "SELECT id, tx_hash, created_at, now() - created_at AS age FROM transactions_blockchain WHERE status = 'submitted' AND created_at < now() - interval '15 minutes';"

# Check current gas prices
curl -s http://localhost:3000/api/v1/chain/state | jq '.gasPrice'
```

**Resolution:**
1. Check if the chain node is synced: `curl http://localhost:3000/api/v1/chain/state`
2. If gas too low: submit replacement tx with same nonce + higher gas (speed-up)
3. If nonce gap: identify missing nonce, submit zero-value tx to fill gap
4. If node unresponsive: failover to backup RPC (`ETH_RPC_URL`)
5. Last resort: mark as `failed` and re-create with new nonce

**Prevention:** Alert on txs older than 15 min in `submitted` state.

---

## Runbook 5: Hash Chain Integrity Failure

**Symptoms:** Reconciliation run reports `hashChainValid: false`, alerts from monitoring.

**Diagnosis:**
```bash
# Find the break point
psql -h $PG_HOST -U $PG_USER -d tradfi_web3 -c "
  SELECT le.id, le.sequence_number, le.entry_hash, le.previous_hash
  FROM ledger_entries le
  WHERE le.previous_hash != (
    SELECT entry_hash FROM ledger_entries WHERE sequence_number = le.sequence_number - 1
  )
  LIMIT 5;
"
```

**Resolution:**
1. **SEV1 — this indicates data tampering or corruption**
2. Immediately activate kill switch for all financial operations
3. Preserve evidence: `pg_dump tradfi_web3 > /secure/evidence_$(date +%s).sql`
4. Compare against last verified backup
5. If corruption (hardware): restore from backup to point before corruption
6. If tampering: escalate to security team, engage forensics

**Prevention:** Run reconciliation every 5 minutes; alert on any failure.

---

## Runbook 6: Memory/CPU Exhaustion

**Symptoms:** OOM kills, slow responses, container restarts.

**Diagnosis:**
```bash
# ECS
aws ecs describe-services --cluster custody-production --services custody-app | jq '.services[0].runningCount'

# Check metrics
curl -s http://localhost:3000/metrics | grep -E "(process_heap|nodejs_active)"

# Check for memory leaks
curl -s http://localhost:3000/metrics | grep "process_resident_memory_bytes"
```

**Resolution:**
1. If single instance: ECS auto-replaces; check deployment logs
2. If all instances: likely a memory leak from recent deploy — rollback
3. Short-term: increase task memory in Terraform (`memory = "4096"`)
4. If caused by large query results: add pagination limits

**Prevention:** Alert at 80% memory utilization. Profile after each release.

---

## Runbook 7: Redis Failure

**Symptoms:** Nonce allocation fails, balance cache stale, rate limiting not working, FX rate locks fail.

**Diagnosis:**
```bash
redis-cli -h $REDIS_HOST ping
redis-cli -h $REDIS_HOST info replication
redis-cli -h $REDIS_HOST info memory
```

**Resolution:**
1. If replica failover: ElastiCache handles automatically (30s window)
2. If complete failure:
   - App continues with degraded mode (direct DB reads for balances)
   - Nonce allocation falls back to DB sequence
   - Rate limiting disabled (accept risk or enable kill switch)
3. Do NOT restart app while Redis is down (nonce gaps possible)
4. After recovery: verify nonce continuity, reconcile balance cache

**Prevention:** ElastiCache multi-AZ with automatic failover. Alert on replication lag.

---

## Runbook 8: Security Breach / Unauthorized Access

**Symptoms:** Audit log shows unexpected actions, failed auth spike, API key used from unknown IP.

**Immediate Actions (SEV1):**
1. Activate all kill switches: `POST /api/v1/institutional/risk/kill-switch -d '{"feature":"all","enabled":true}'`
2. Revoke all active sessions: `DELETE FROM sessions;`
3. Rotate all API keys
4. Block suspicious IPs at ALB/WAF level
5. Preserve audit trail: `pg_dump -t audit_events -t sessions -t api_keys tradfi_web3 > /secure/breach_evidence.sql`

**Investigation:**
```bash
# Recent failed logins
psql -c "SELECT * FROM audit_events WHERE event_type = 'auth.login_failed' AND created_at > now() - interval '1 hour' ORDER BY created_at DESC;"

# Unusual API key usage
psql -c "SELECT * FROM audit_events WHERE actor_id IN (SELECT id FROM api_keys WHERE last_used_ip NOT IN (SELECT unnest(ip_whitelist) FROM api_keys)) AND created_at > now() - interval '24 hours';"
```

**Recovery:**
1. Determine blast radius
2. Force password reset for affected users
3. Issue new API keys with tighter IP restrictions
4. Review and harden RBAC permissions
5. File incident report

---

## Runbook 9: Circuit Breaker Tripped

**Symptoms:** Service returning 503 for specific operations, circuit breaker in `open` state.

**Diagnosis:**
```bash
psql -c "SELECT * FROM circuit_breaker_state WHERE state = 'open';"
curl -s http://localhost:3000/metrics | grep circuit_breaker
```

**Resolution:**
1. Identify which downstream is failing (DB, Redis, chain RPC, Kafka)
2. Fix underlying issue (see relevant runbook)
3. Circuit breaker auto-transitions to `half_open` after cooldown (default 30s)
4. If manual reset needed: update state in DB to `closed` and reset failure count

**Prevention:** Tune thresholds per service. Monitor trip frequency.

---

## Incident Response Template

```
## Incident: [TITLE]
**Severity:** SEV[1-4]
**Detected:** [timestamp]
**Resolved:** [timestamp]
**Duration:** [minutes]
**On-call:** [name]

### Impact
[What was affected, how many users/transactions]

### Timeline
- HH:MM — Alert fired
- HH:MM — On-call acknowledged
- HH:MM — Root cause identified
- HH:MM — Fix applied
- HH:MM — Service restored
- HH:MM — All-clear confirmed

### Root Cause
[Brief technical explanation]

### Resolution
[What was done to fix it]

### Action Items
- [ ] [Preventive measure 1]
- [ ] [Preventive measure 2]
```
