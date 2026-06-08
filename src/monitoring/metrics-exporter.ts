import { Request, Response } from 'express';
import { db } from '../database/connection';
import { redis } from '../cache/redis';

interface MetricEntry {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  value: number;
  labels?: Record<string, string>;
}

/**
 * Prometheus-compatible metrics exporter.
 * Exposes /metrics endpoint in OpenMetrics/Prometheus text format.
 */
export class MetricsExporter {
  /**
   * Collect all metrics and return Prometheus text format.
   */
  async collect(): Promise<string> {
    const metrics: MetricEntry[] = [];

    // --- Database metrics ---
    const dbStats = await db.query(`SELECT count(*) as active FROM pg_stat_activity WHERE state='active'`);
    metrics.push({ name: 'db_connections_active', help: 'Active database connections', type: 'gauge', value: parseInt(dbStats.rows[0].active) });

    // --- Ledger metrics ---
    const journalCount = await db.query(`SELECT count(*)::int as c FROM journal_entries`);
    metrics.push({ name: 'ledger_journal_entries_total', help: 'Total journal entries', type: 'counter', value: journalCount.rows[0].c });

    const ledgerCount = await db.query(`SELECT count(*)::int as c FROM ledger_entries`);
    metrics.push({ name: 'ledger_entries_total', help: 'Total ledger entries', type: 'counter', value: ledgerCount.rows[0].c });

    // --- Outbox metrics ---
    const outboxPending = await db.query(`SELECT count(*)::int as c FROM outbox WHERE published=FALSE`);
    metrics.push({ name: 'outbox_pending_messages', help: 'Unpublished outbox messages', type: 'gauge', value: outboxPending.rows[0].c });

    // --- DLQ metrics ---
    const dlqStats = await db.query(`SELECT status, count(*)::int as c FROM dead_letter_queue GROUP BY status`);
    for (const row of dlqStats.rows) {
      metrics.push({ name: 'dlq_messages', help: 'DLQ messages by status', type: 'gauge', value: row.c, labels: { status: row.status } });
    }

    // --- Transaction metrics ---
    const txStats = await db.query(`SELECT status, count(*)::int as c FROM transactions_blockchain GROUP BY status`);
    for (const row of txStats.rows) {
      metrics.push({ name: 'blockchain_transactions', help: 'Blockchain transactions by status', type: 'gauge', value: row.c, labels: { status: row.status } });
    }

    // --- Wallet metrics ---
    const walletStats = await db.query(`SELECT wallet_type, count(*)::int as c FROM wallets GROUP BY wallet_type`);
    for (const row of walletStats.rows) {
      metrics.push({ name: 'wallets_total', help: 'Wallets by type', type: 'gauge', value: row.c, labels: { type: row.wallet_type } });
    }

    // --- Risk metrics ---
    const riskEvents = await db.query(`SELECT severity, count(*)::int as c FROM risk_events WHERE resolved=FALSE GROUP BY severity`);
    for (const row of riskEvents.rows) {
      metrics.push({ name: 'risk_events_unresolved', help: 'Unresolved risk events', type: 'gauge', value: row.c, labels: { severity: row.severity } });
    }

    // --- Alert metrics ---
    const alertsUnresolved = await db.query(`SELECT severity, count(*)::int as c FROM alert_events WHERE resolved=FALSE GROUP BY severity`);
    for (const row of alertsUnresolved.rows) {
      metrics.push({ name: 'alerts_unresolved', help: 'Unresolved alerts', type: 'gauge', value: row.c, labels: { severity: row.severity } });
    }

    // --- Settlement metrics ---
    const settlementStats = await db.query(`SELECT status, count(*)::int as c FROM settlement_instructions GROUP BY status`);
    for (const row of settlementStats.rows) {
      metrics.push({ name: 'settlements', help: 'Settlement instructions by status', type: 'gauge', value: row.c, labels: { status: row.status } });
    }

    // --- Reconciliation metrics ---
    const lastRecon = await db.query(`SELECT run_type, status, started_at FROM reconciliation_runs ORDER BY started_at DESC LIMIT 5`);
    for (const row of lastRecon.rows) {
      metrics.push({ name: 'reconciliation_last_run_success', help: 'Last reconciliation success (1=pass, 0=fail)', type: 'gauge', value: row.status === 'passed' ? 1 : 0, labels: { type: row.run_type } });
    }

    // --- Redis metrics ---
    const redisInfo = await redis.info('memory');
    const memMatch = redisInfo.match(/used_memory:(\d+)/);
    if (memMatch) {
      metrics.push({ name: 'redis_used_memory_bytes', help: 'Redis memory usage', type: 'gauge', value: parseInt(memMatch[1]) });
    }

    // --- Lending metrics ---
    try {
      const loanStats = await db.query(`SELECT status, count(*)::int as c FROM loans GROUP BY status`);
      for (const row of loanStats.rows) {
        metrics.push({ name: 'loans', help: 'Loans by status', type: 'gauge', value: row.c, labels: { status: row.status } });
      }
    } catch { /* table may not exist yet */ }

    return this.format(metrics);
  }

  /**
   * Express handler for /metrics endpoint.
   */
  handler() {
    return async (_req: Request, res: Response) => {
      try {
        const body = await this.collect();
        res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.send(body);
      } catch (err) {
        res.status(500).send('# Error collecting metrics\n');
      }
    };
  }

  private format(metrics: MetricEntry[]): string {
    const lines: string[] = [];
    for (const m of metrics) {
      lines.push(`# HELP ${m.name} ${m.help}`);
      lines.push(`# TYPE ${m.name} ${m.type}`);
      if (m.labels && Object.keys(m.labels).length > 0) {
        const labelStr = Object.entries(m.labels).map(([k, v]) => `${k}="${v}"`).join(',');
        lines.push(`${m.name}{${labelStr}} ${m.value}`);
      } else {
        lines.push(`${m.name} ${m.value}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}
