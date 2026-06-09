"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KillSwitchService = exports.CircuitBreaker = void 0;
const connection_1 = require("../database/connection");
const config_1 = require("../config");
/**
 * Circuit breaker pattern for service protection.
 * States: closed (normal) -> open (failing) -> half_open (testing) -> closed
 */
class CircuitBreaker {
    async getState(serviceName) {
        const result = await connection_1.db.query('SELECT * FROM circuit_breaker_state WHERE service_name = $1', [serviceName]);
        if (result.rows.length === 0) {
            await connection_1.db.query(`INSERT INTO circuit_breaker_state (service_name, state)
         VALUES ($1, 'closed')
         ON CONFLICT (service_name) DO NOTHING`, [serviceName]);
            return { state: 'closed', failureCount: 0 };
        }
        const row = result.rows[0];
        if (row.state === 'open' && row.opened_at) {
            const elapsed = Date.now() - new Date(row.opened_at).getTime();
            if (elapsed > row.reset_timeout_seconds * 1000) {
                await this.transition(serviceName, 'half_open');
                return { state: 'half_open', failureCount: row.failure_count };
            }
        }
        return { state: row.state, failureCount: row.failure_count };
    }
    /**
     * Check if a service call is allowed.
     */
    async isAllowed(serviceName) {
        const { state } = await this.getState(serviceName);
        return state !== 'open';
    }
    /**
     * Record a successful call.
     */
    async recordSuccess(serviceName) {
        const { state } = await this.getState(serviceName);
        if (state === 'half_open') {
            await connection_1.db.query(`UPDATE circuit_breaker_state
         SET state = 'closed', failure_count = 0, success_count = success_count + 1,
             opened_at = NULL, half_opened_at = NULL, updated_at = NOW()
         WHERE service_name = $1`, [serviceName]);
            config_1.logger.info({ service: serviceName }, 'Circuit breaker closed after recovery');
        }
        else {
            await connection_1.db.query(`UPDATE circuit_breaker_state
         SET success_count = success_count + 1, updated_at = NOW()
         WHERE service_name = $1`, [serviceName]);
        }
    }
    /**
     * Record a failed call. Opens the circuit if threshold exceeded.
     */
    async recordFailure(serviceName) {
        const result = await connection_1.db.query(`UPDATE circuit_breaker_state
       SET failure_count = failure_count + 1, last_failure_at = NOW(), updated_at = NOW()
       WHERE service_name = $1
       RETURNING failure_count, failure_threshold, state`, [serviceName]);
        if (result.rows.length === 0)
            return;
        const row = result.rows[0];
        if (row.failure_count >= row.failure_threshold && row.state !== 'open') {
            await this.transition(serviceName, 'open');
            config_1.logger.warn({ service: serviceName, failures: row.failure_count }, 'Circuit breaker opened');
        }
    }
    /**
     * Force the circuit to a specific state.
     */
    async forceState(serviceName, state) {
        await this.transition(serviceName, state);
        config_1.logger.info({ service: serviceName, state }, 'Circuit breaker state forced');
    }
    /**
     * Reset the circuit breaker to closed state.
     */
    async reset(serviceName) {
        await connection_1.db.query(`UPDATE circuit_breaker_state
       SET state = 'closed', failure_count = 0, success_count = 0,
           opened_at = NULL, half_opened_at = NULL, updated_at = NOW()
       WHERE service_name = $1`, [serviceName]);
    }
    async getAllStates() {
        const result = await connection_1.db.query('SELECT * FROM circuit_breaker_state ORDER BY service_name');
        return result.rows;
    }
    async transition(serviceName, newState) {
        const updates = [`state = '${newState}'`, 'updated_at = NOW()'];
        if (newState === 'open') {
            updates.push('opened_at = NOW()');
        }
        else if (newState === 'half_open') {
            updates.push('half_opened_at = NOW()');
        }
        await connection_1.db.query(`UPDATE circuit_breaker_state SET ${updates.join(', ')}
       WHERE service_name = $1`, [serviceName]);
    }
}
exports.CircuitBreaker = CircuitBreaker;
/**
 * Kill switch service for emergency feature shutdown.
 */
class KillSwitchService {
    async isActive(feature) {
        const result = await connection_1.db.query(`SELECT active FROM kill_switches WHERE feature = $1`, [feature]);
        if (result.rows.length === 0)
            return false;
        const row = result.rows[0];
        if (row.active && row.auto_reactivate_at) {
            if (new Date(row.auto_reactivate_at) < new Date()) {
                await this.deactivate(feature);
                return false;
            }
        }
        return row.active;
    }
    async activate(feature, userId, reason, autoReactivateAfterHours) {
        const autoReactivateAt = autoReactivateAfterHours
            ? new Date(Date.now() + autoReactivateAfterHours * 3600000)
            : null;
        await connection_1.db.query(`INSERT INTO kill_switches (feature, active, activated_by, activated_at, reason, auto_reactivate_at)
       VALUES ($1, TRUE, $2, NOW(), $3, $4)
       ON CONFLICT (feature) DO UPDATE
         SET active = TRUE, activated_by = EXCLUDED.activated_by,
             activated_at = NOW(), reason = EXCLUDED.reason,
             auto_reactivate_at = EXCLUDED.auto_reactivate_at`, [feature, userId, reason, autoReactivateAt]);
        config_1.logger.warn({ feature, reason }, 'Kill switch activated');
    }
    async deactivate(feature) {
        await connection_1.db.query(`UPDATE kill_switches SET active = FALSE WHERE feature = $1`, [feature]);
        config_1.logger.info({ feature }, 'Kill switch deactivated');
    }
    async getAllSwitches() {
        const result = await connection_1.db.query('SELECT * FROM kill_switches ORDER BY feature');
        return result.rows;
    }
}
exports.KillSwitchService = KillSwitchService;
//# sourceMappingURL=circuit-breaker.js.map