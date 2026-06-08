import { db } from '../database/connection';
import { redis } from '../cache/redis';
import { logger } from '../config';

export type AlertCategory = 'security' | 'compliance' | 'operational' | 'financial' | 'performance' | 'chain';
export type ConditionType = 'threshold' | 'anomaly' | 'pattern' | 'absence' | 'rate_change';
export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface AlertRule {
  id: string;
  name: string;
  category: AlertCategory;
  conditionType: ConditionType;
  config: Record<string, unknown>;
  severity: AlertSeverity;
  notificationChannels: string[];
  cooldownMinutes: number;
  active: boolean;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  severity: AlertSeverity;
  title: string;
  description?: string;
  metricValue?: number;
  thresholdValue?: number;
  acknowledged: boolean;
  resolved: boolean;
}

/**
 * Monitoring & Observability: real-time monitoring, SIEM integration,
 * fraud/anomaly detection, chain analytics, alerting.
 */
export class MonitoringService {
  async createAlertRule(params: { name: string; category: AlertCategory; conditionType: ConditionType; config: Record<string, unknown>; severity: AlertSeverity; notificationChannels?: string[]; cooldownMinutes?: number }): Promise<AlertRule> {
    const result = await db.query(
      `INSERT INTO alert_rules (name, category, condition_type, config, severity, notification_channels, cooldown_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [params.name, params.category, params.conditionType, JSON.stringify(params.config), params.severity, JSON.stringify(params.notificationChannels || ['log']), params.cooldownMinutes || 5]
    );
    return this.mapRule(result.rows[0]);
  }

  /**
   * Evaluate all active alert rules against current metrics.
   */
  async evaluateRules(): Promise<AlertEvent[]> {
    const rules = await db.query(`SELECT * FROM alert_rules WHERE active=TRUE`);
    const fired: AlertEvent[] = [];

    for (const rule of rules.rows) {
      const shouldFire = await this.evaluateCondition(rule);
      if (shouldFire) {
        const cooldownKey = `alert:cooldown:${rule.id}`;
        const inCooldown = await redis.get(cooldownKey);
        if (inCooldown) continue;

        const event = await this.fireAlert(rule, shouldFire);
        fired.push(event);
        await redis.setex(cooldownKey, (rule.cooldown_minutes || 5) * 60, '1');
      }
    }

    if (fired.length > 0) logger.warn({ count: fired.length }, 'Alerts fired');
    return fired;
  }

  /**
   * Record a metric for anomaly detection (sliding window in Redis).
   */
  async recordMetric(metricName: string, value: number, tags?: Record<string, string>): Promise<void> {
    const key = `metric:${metricName}`;
    const entry = JSON.stringify({ value, ts: Date.now(), tags });
    await redis.lpush(key, entry);
    await redis.ltrim(key, 0, 999); // Keep last 1000 samples
    await redis.expire(key, 86400); // 24h TTL
  }

  /**
   * Detect anomalies using statistical deviation (z-score).
   */
  async detectAnomaly(metricName: string, currentValue: number, stdDevThreshold = 3): Promise<boolean> {
    const key = `metric:${metricName}`;
    const samples = await redis.lrange(key, 0, -1);
    if (samples.length < 10) return false;

    const values = samples.map(s => JSON.parse(s).value as number);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const stdDev = Math.sqrt(values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length);

    if (stdDev === 0) return false;
    const zScore = Math.abs(currentValue - mean) / stdDev;
    return zScore > stdDevThreshold;
  }

  /**
   * Monitor transaction for suspicious patterns (fraud detection).
   */
  async monitorTransaction(params: { txId: string; fromAddress: string; toAddress: string; amount: bigint; chain: string }): Promise<{ suspicious: boolean; reasons: string[] }> {
    const reasons: string[] = [];

    // Check velocity — too many txs from same address in short window
    const velocityKey = `velocity:${params.fromAddress}`;
    const count = await redis.incr(velocityKey);
    if (count === 1) await redis.expire(velocityKey, 3600);
    if (count > 50) reasons.push('high_velocity');

    // Check large transaction threshold
    const largeThreshold = BigInt('1000000000000000000000'); // 1000 ETH equivalent
    if (params.amount > largeThreshold) reasons.push('large_transaction');

    // Check if destination is new (never seen before)
    const destKey = `seen:${params.toAddress}`;
    const seen = await redis.exists(destKey);
    if (!seen) {
      reasons.push('new_destination');
      await redis.setex(destKey, 86400 * 30, '1');
    }

    if (reasons.length > 0) {
      logger.warn({ txId: params.txId, reasons }, 'Suspicious transaction detected');
    }
    return { suspicious: reasons.length > 0, reasons };
  }

  /**
   * SIEM event export format.
   */
  async exportSIEMEvents(since: Date, limit = 1000): Promise<Array<Record<string, unknown>>> {
    const result = await db.query(
      `SELECT ae.*, ar.name as rule_name, ar.category FROM alert_events ae JOIN alert_rules ar ON ae.rule_id=ar.id WHERE ae.created_at >= $1 ORDER BY ae.created_at DESC LIMIT $2`,
      [since, limit]
    );
    return result.rows.map(row => ({
      timestamp: row.created_at,
      severity: row.severity,
      category: row.category,
      ruleName: row.rule_name,
      title: row.title,
      description: row.description,
      metricValue: row.metric_value,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
    }));
  }

  async acknowledgeAlert(alertId: string, userId: string): Promise<void> {
    await db.query(`UPDATE alert_events SET acknowledged=TRUE, acknowledged_by=$1, acknowledged_at=NOW() WHERE id=$2`, [userId, alertId]);
  }

  async resolveAlert(alertId: string): Promise<void> {
    await db.query(`UPDATE alert_events SET resolved=TRUE, resolved_at=NOW() WHERE id=$1`, [alertId]);
  }

  async getUnresolvedAlerts(severity?: AlertSeverity): Promise<AlertEvent[]> {
    const query = severity
      ? `SELECT * FROM alert_events WHERE resolved=FALSE AND severity=$1 ORDER BY created_at DESC`
      : `SELECT * FROM alert_events WHERE resolved=FALSE ORDER BY created_at DESC`;
    const result = await db.query(query, severity ? [severity] : []);
    return result.rows.map(this.mapEvent);
  }

  private async evaluateCondition(rule: Record<string, unknown>): Promise<{ metricValue: number; thresholdValue: number } | null> {
    const config = rule.config as Record<string, unknown>;
    const conditionType = rule.condition_type as string;

    if (conditionType === 'threshold') {
      const metricName = config.metric as string;
      const threshold = config.threshold as number;
      const key = `metric:${metricName}`;
      const latest = await redis.lindex(key, 0);
      if (!latest) return null;
      const value = JSON.parse(latest).value as number;
      if (config.operator === 'gt' && value > threshold) return { metricValue: value, thresholdValue: threshold };
      if (config.operator === 'lt' && value < threshold) return { metricValue: value, thresholdValue: threshold };
    }

    if (conditionType === 'anomaly') {
      const metricName = config.metric as string;
      const key = `metric:${metricName}`;
      const latest = await redis.lindex(key, 0);
      if (!latest) return null;
      const value = JSON.parse(latest).value as number;
      const isAnomaly = await this.detectAnomaly(metricName, value, (config.stddev_threshold as number) || 3);
      if (isAnomaly) return { metricValue: value, thresholdValue: 0 };
    }

    return null;
  }

  private async fireAlert(rule: Record<string, unknown>, condition: { metricValue: number; thresholdValue: number }): Promise<AlertEvent> {
    const result = await db.query(
      `INSERT INTO alert_events (rule_id, severity, title, description, metric_value, threshold_value)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [rule.id, rule.severity, `Alert: ${rule.name}`, `Rule ${rule.name} triggered`, condition.metricValue, condition.thresholdValue]
    );
    return this.mapEvent(result.rows[0]);
  }

  private mapRule(row: Record<string, unknown>): AlertRule {
    return { id: row.id as string, name: row.name as string, category: row.category as AlertCategory, conditionType: row.condition_type as ConditionType, config: row.config as Record<string, unknown>, severity: row.severity as AlertSeverity, notificationChannels: row.notification_channels as string[], cooldownMinutes: row.cooldown_minutes as number, active: row.active as boolean };
  }

  private mapEvent(row: Record<string, unknown>): AlertEvent {
    return { id: row.id as string, ruleId: row.rule_id as string, severity: row.severity as AlertSeverity, title: row.title as string, description: row.description as string | undefined, metricValue: row.metric_value as number | undefined, thresholdValue: row.threshold_value as number | undefined, acknowledged: row.acknowledged as boolean, resolved: row.resolved as boolean };
  }
}
