"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RiskService = void 0;
const connection_1 = require("../database/connection");
const redis_1 = require("../cache/redis");
class RiskService {
    /**
     * Evaluate all active risk policies for a transaction.
     */
    async evaluateTransaction(params) {
        const policies = await connection_1.db.query(`SELECT * FROM risk_policies WHERE active = TRUE
       ORDER BY severity DESC`);
        const violations = [];
        for (const policy of policies.rows) {
            const violation = await this.checkPolicy(policy, params);
            if (violation) {
                violations.push(violation);
            }
        }
        const blocked = violations.some(v => v.actionRequired === 'block');
        const highestSeverity = violations.length > 0
            ? violations[0].severity
            : 'low';
        if (violations.length > 0) {
            for (const v of violations) {
                await this.recordRiskEvent(v, params);
            }
        }
        return {
            allowed: !blocked,
            riskLevel: highestSeverity,
            violations,
        };
    }
    async checkPolicy(policy, params) {
        switch (policy.policy_type) {
            case 'velocity':
                return this.checkVelocity(policy, params);
            case 'concentration':
                return this.checkConcentration(policy, params);
            case 'exposure':
                return this.checkExposure(policy, params);
            default:
                return null;
        }
    }
    /**
     * Velocity check: max transactions/amount in a time window.
     */
    async checkVelocity(policy, params) {
        const windowMinutes = policy.config.window_minutes || 60;
        const maxCount = policy.config.max_count;
        const maxAmount = policy.config.max_amount
            ? BigInt(policy.config.max_amount)
            : undefined;
        const redisKey = `risk:velocity:${params.accountId}`;
        const now = Date.now();
        const windowStart = now - windowMinutes * 60 * 1000;
        const pipeline = redis_1.redis.pipeline();
        pipeline.zremrangebyscore(redisKey, 0, windowStart);
        pipeline.zadd(redisKey, now, `${now}:${params.amount.toString()}`);
        pipeline.zrangebyscore(redisKey, windowStart, now);
        pipeline.expire(redisKey, windowMinutes * 60);
        const results = await pipeline.exec();
        const entries = results?.[2]?.[1] || [];
        if (maxCount && entries.length > maxCount) {
            return {
                policyId: policy.id,
                policyType: 'velocity',
                severity: policy.severity,
                message: `Transaction count ${entries.length} exceeds limit ${maxCount} in ${windowMinutes}min window`,
                actionRequired: policy.action_on_breach,
            };
        }
        if (maxAmount) {
            const totalAmount = entries.reduce((sum, e) => {
                const amt = e.split(':')[1];
                return sum + (amt ? BigInt(amt) : 0n);
            }, 0n);
            if (totalAmount + params.amount > maxAmount) {
                return {
                    policyId: policy.id,
                    policyType: 'velocity',
                    severity: policy.severity,
                    message: `Total amount ${totalAmount + params.amount} exceeds limit ${maxAmount} in ${windowMinutes}min window`,
                    actionRequired: policy.action_on_breach,
                };
            }
        }
        return null;
    }
    /**
     * Concentration check: max % of total supply held by one account.
     */
    async checkConcentration(policy, params) {
        if (!params.tokenId)
            return null;
        const maxBps = policy.config.max_concentration_bps || 5000;
        const token = await connection_1.db.query('SELECT total_minted, total_burned FROM token_definitions WHERE id = $1', [params.tokenId]);
        if (token.rows.length === 0)
            return null;
        const totalSupply = BigInt(token.rows[0].total_minted)
            - BigInt(token.rows[0].total_burned);
        if (totalSupply === 0n)
            return null;
        const holder = await connection_1.db.query('SELECT balance FROM token_holders WHERE token_id = $1 AND account_id = $2', [params.tokenId, params.accountId]);
        const currentBalance = holder.rows.length > 0
            ? BigInt(holder.rows[0].balance)
            : 0n;
        const newBalance = currentBalance + params.amount;
        const concentrationBps = Number((newBalance * 10000n) / totalSupply);
        if (concentrationBps > maxBps) {
            return {
                policyId: policy.id,
                policyType: 'concentration',
                severity: policy.severity,
                message: `Concentration ${concentrationBps}bps exceeds limit ${maxBps}bps`,
                actionRequired: policy.action_on_breach,
            };
        }
        return null;
    }
    /**
     * Exposure check: max total value at risk for an account.
     */
    async checkExposure(policy, params) {
        const maxExposure = policy.config.max_exposure
            ? BigInt(policy.config.max_exposure)
            : undefined;
        if (!maxExposure)
            return null;
        const balance = await connection_1.db.query('SELECT COALESCE(SUM(balance), 0) as total FROM balance_cache WHERE account_id = $1', [params.accountId]);
        const currentExposure = BigInt(balance.rows[0].total);
        if (currentExposure + params.amount > maxExposure) {
            return {
                policyId: policy.id,
                policyType: 'exposure',
                severity: policy.severity,
                message: `Exposure ${currentExposure + params.amount} exceeds limit ${maxExposure}`,
                actionRequired: policy.action_on_breach,
            };
        }
        return null;
    }
    async recordRiskEvent(violation, params) {
        await connection_1.db.query(`INSERT INTO risk_events (
        policy_id, event_type, severity, resource_type,
        resource_id, details, action_taken
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
            violation.policyId,
            `risk.${violation.policyType}_breach`,
            violation.severity,
            'account',
            params.accountId,
            JSON.stringify({
                message: violation.message,
                amount: params.amount.toString(),
            }),
            violation.actionRequired,
        ]);
    }
    async createPolicy(params) {
        const result = await connection_1.db.query(`INSERT INTO risk_policies (name, policy_type, config, severity, action_on_breach)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`, [params.name, params.policyType, JSON.stringify(params.config),
            params.severity, params.actionOnBreach]);
        return result.rows[0].id;
    }
    async getPolicies() {
        const result = await connection_1.db.query('SELECT * FROM risk_policies ORDER BY severity DESC, created_at DESC');
        return result.rows;
    }
    async getUnresolvedEvents(limit = 50) {
        const result = await connection_1.db.query(`SELECT * FROM risk_events WHERE resolved = FALSE
       ORDER BY created_at DESC LIMIT $1`, [limit]);
        return result.rows;
    }
    async resolveEvent(eventId, resolvedBy) {
        await connection_1.db.query(`UPDATE risk_events SET resolved = TRUE, resolved_by = $1,
       resolved_at = NOW() WHERE id = $2`, [resolvedBy, eventId]);
    }
}
exports.RiskService = RiskService;
//# sourceMappingURL=risk-service.js.map