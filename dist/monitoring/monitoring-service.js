"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MonitoringService = void 0;
const connection_1 = require("../database/connection");
const redis_1 = require("../cache/redis");
const config_1 = require("../config");
/**
 * Monitoring & Observability: real-time monitoring, SIEM integration,
 * fraud/anomaly detection, chain analytics, alerting.
 */
class MonitoringService {
    async createAlertRule(params) {
        const result = await connection_1.db.query(`INSERT INTO alert_rules (name, category, condition_type, config, severity, notification_channels, cooldown_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [params.name, params.category, params.conditionType, JSON.stringify(params.config), params.severity, JSON.stringify(params.notificationChannels || ['log']), params.cooldownMinutes || 5]);
        return this.mapRule(result.rows[0]);
    }
    /**
     * Evaluate all active alert rules against current metrics.
     */
    async evaluateRules() {
        const rules = await connection_1.db.query(`SELECT * FROM alert_rules WHERE active=TRUE`);
        const fired = [];
        for (const rule of rules.rows) {
            const shouldFire = await this.evaluateCondition(rule);
            if (shouldFire) {
                const cooldownKey = `alert:cooldown:${rule.id}`;
                const inCooldown = await redis_1.redis.get(cooldownKey);
                if (inCooldown)
                    continue;
                const event = await this.fireAlert(rule, shouldFire);
                fired.push(event);
                await redis_1.redis.setex(cooldownKey, (rule.cooldown_minutes || 5) * 60, '1');
            }
        }
        if (fired.length > 0)
            config_1.logger.warn({ count: fired.length }, 'Alerts fired');
        return fired;
    }
    /**
     * Record a metric for anomaly detection (sliding window in Redis).
     */
    async recordMetric(metricName, value, tags) {
        const key = `metric:${metricName}`;
        const entry = JSON.stringify({ value, ts: Date.now(), tags });
        await redis_1.redis.lpush(key, entry);
        await redis_1.redis.ltrim(key, 0, 999); // Keep last 1000 samples
        await redis_1.redis.expire(key, 86400); // 24h TTL
    }
    /**
     * Detect anomalies using statistical deviation (z-score).
     */
    async detectAnomaly(metricName, currentValue, stdDevThreshold = 3) {
        const key = `metric:${metricName}`;
        const samples = await redis_1.redis.lrange(key, 0, -1);
        if (samples.length < 10)
            return false;
        const values = samples.map(s => JSON.parse(s).value);
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const stdDev = Math.sqrt(values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length);
        if (stdDev === 0)
            return false;
        const zScore = Math.abs(currentValue - mean) / stdDev;
        return zScore > stdDevThreshold;
    }
    /**
     * Monitor transaction for suspicious patterns (fraud detection).
     */
    async monitorTransaction(params) {
        const reasons = [];
        // Check velocity — too many txs from same address in short window
        const velocityKey = `velocity:${params.fromAddress}`;
        const count = await redis_1.redis.incr(velocityKey);
        if (count === 1)
            await redis_1.redis.expire(velocityKey, 3600);
        if (count > 50)
            reasons.push('high_velocity');
        // Check large transaction threshold
        const largeThreshold = BigInt('1000000000000000000000'); // 1000 ETH equivalent
        if (params.amount > largeThreshold)
            reasons.push('large_transaction');
        // Check if destination is new (never seen before)
        const destKey = `seen:${params.toAddress}`;
        const seen = await redis_1.redis.exists(destKey);
        if (!seen) {
            reasons.push('new_destination');
            await redis_1.redis.setex(destKey, 86400 * 30, '1');
        }
        if (reasons.length > 0) {
            config_1.logger.warn({ txId: params.txId, reasons }, 'Suspicious transaction detected');
        }
        return { suspicious: reasons.length > 0, reasons };
    }
    /**
     * SIEM event export format.
     */
    async exportSIEMEvents(since, limit = 1000) {
        const result = await connection_1.db.query(`SELECT ae.*, ar.name as rule_name, ar.category FROM alert_events ae JOIN alert_rules ar ON ae.rule_id=ar.id WHERE ae.created_at >= $1 ORDER BY ae.created_at DESC LIMIT $2`, [since, limit]);
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
    async acknowledgeAlert(alertId, userId) {
        await connection_1.db.query(`UPDATE alert_events SET acknowledged=TRUE, acknowledged_by=$1, acknowledged_at=NOW() WHERE id=$2`, [userId, alertId]);
    }
    async resolveAlert(alertId) {
        await connection_1.db.query(`UPDATE alert_events SET resolved=TRUE, resolved_at=NOW() WHERE id=$1`, [alertId]);
    }
    async getUnresolvedAlerts(severity) {
        const query = severity
            ? `SELECT * FROM alert_events WHERE resolved=FALSE AND severity=$1 ORDER BY created_at DESC`
            : `SELECT * FROM alert_events WHERE resolved=FALSE ORDER BY created_at DESC`;
        const result = await connection_1.db.query(query, severity ? [severity] : []);
        return result.rows.map(this.mapEvent);
    }
    async evaluateCondition(rule) {
        const config = rule.config;
        const conditionType = rule.condition_type;
        if (conditionType === 'threshold') {
            const metricName = config.metric;
            const threshold = config.threshold;
            const key = `metric:${metricName}`;
            const latest = await redis_1.redis.lindex(key, 0);
            if (!latest)
                return null;
            const value = JSON.parse(latest).value;
            if (config.operator === 'gt' && value > threshold)
                return { metricValue: value, thresholdValue: threshold };
            if (config.operator === 'lt' && value < threshold)
                return { metricValue: value, thresholdValue: threshold };
        }
        if (conditionType === 'anomaly') {
            const metricName = config.metric;
            const key = `metric:${metricName}`;
            const latest = await redis_1.redis.lindex(key, 0);
            if (!latest)
                return null;
            const value = JSON.parse(latest).value;
            const isAnomaly = await this.detectAnomaly(metricName, value, config.stddev_threshold || 3);
            if (isAnomaly)
                return { metricValue: value, thresholdValue: 0 };
        }
        return null;
    }
    async fireAlert(rule, condition) {
        const result = await connection_1.db.query(`INSERT INTO alert_events (rule_id, severity, title, description, metric_value, threshold_value)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [rule.id, rule.severity, `Alert: ${rule.name}`, `Rule ${rule.name} triggered`, condition.metricValue, condition.thresholdValue]);
        return this.mapEvent(result.rows[0]);
    }
    mapRule(row) {
        return { id: row.id, name: row.name, category: row.category, conditionType: row.condition_type, config: row.config, severity: row.severity, notificationChannels: row.notification_channels, cooldownMinutes: row.cooldown_minutes, active: row.active };
    }
    mapEvent(row) {
        return { id: row.id, ruleId: row.rule_id, severity: row.severity, title: row.title, description: row.description, metricValue: row.metric_value, thresholdValue: row.threshold_value, acknowledged: row.acknowledged, resolved: row.resolved };
    }
}
exports.MonitoringService = MonitoringService;
//# sourceMappingURL=monitoring-service.js.map