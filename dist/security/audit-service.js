"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditService = void 0;
const connection_1 = require("../database/connection");
const config_1 = require("../config");
class AuditService {
    /**
     * Record an audit event with full actor context.
     * All state-changing operations should call this.
     */
    async record(auth, entry) {
        try {
            await connection_1.db.query(`INSERT INTO audit_events (
          event_type, actor_id, actor_email, actor_ip,
          resource_type, resource_id, action, details,
          risk_level, outcome, correlation_id, session_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [
                entry.eventType,
                auth?.user.id || null,
                auth?.user.email || null,
                auth?.user.ipAddress || null,
                entry.resourceType,
                entry.resourceId || null,
                entry.action,
                JSON.stringify(entry.details || {}),
                entry.riskLevel || 'low',
                entry.outcome || 'success',
                auth?.correlationId || null,
                auth?.user.sessionId || null,
            ]);
        }
        catch (err) {
            config_1.logger.error(err, 'Failed to record audit event');
        }
    }
    /**
     * Record a failed authentication attempt.
     */
    async recordAuthFailure(email, ipAddress, reason) {
        await this.record(null, {
            eventType: 'auth.login_failed',
            resourceType: 'user',
            resourceId: email,
            action: 'authenticate',
            details: { reason, ipAddress },
            riskLevel: 'medium',
            outcome: 'failure',
        });
    }
    /**
     * Record a permission denial.
     */
    async recordDenied(auth, resource, action, requiredPermission) {
        await this.record(auth, {
            eventType: 'auth.permission_denied',
            resourceType: resource,
            action,
            details: { requiredPermission },
            riskLevel: 'high',
            outcome: 'denied',
        });
    }
    /**
     * Query audit trail with filters.
     */
    async query(filters) {
        let query = 'SELECT * FROM audit_events WHERE 1=1';
        let countQuery = 'SELECT COUNT(*) as total FROM audit_events WHERE 1=1';
        const params = [];
        const countParams = [];
        const addFilter = (clause, value) => {
            params.push(value);
            countParams.push(value);
            query += ` AND ${clause} = $${params.length}`;
            countQuery += ` AND ${clause} = $${countParams.length}`;
        };
        if (filters.actorId)
            addFilter('actor_id', filters.actorId);
        if (filters.resourceType)
            addFilter('resource_type', filters.resourceType);
        if (filters.resourceId)
            addFilter('resource_id', filters.resourceId);
        if (filters.eventType)
            addFilter('event_type', filters.eventType);
        if (filters.riskLevel)
            addFilter('risk_level', filters.riskLevel);
        if (filters.outcome)
            addFilter('outcome', filters.outcome);
        if (filters.correlationId)
            addFilter('correlation_id', filters.correlationId);
        if (filters.fromDate) {
            params.push(filters.fromDate);
            countParams.push(filters.fromDate);
            query += ` AND created_at >= $${params.length}`;
            countQuery += ` AND created_at >= $${countParams.length}`;
        }
        if (filters.toDate) {
            params.push(filters.toDate);
            countParams.push(filters.toDate);
            query += ` AND created_at <= $${params.length}`;
            countQuery += ` AND created_at <= $${countParams.length}`;
        }
        const limit = Math.min(filters.limit || 50, 500);
        const offset = filters.offset || 0;
        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);
        const [events, count] = await Promise.all([
            connection_1.db.query(query, params),
            connection_1.db.query(countQuery, countParams),
        ]);
        return {
            events: events.rows,
            total: parseInt(count.rows[0].total),
        };
    }
    /**
     * Generate compliance evidence report for a time period.
     */
    async generateComplianceReport(fromDate, toDate) {
        const summary = await connection_1.db.query(`SELECT event_type, COUNT(*) as count
       FROM audit_events
       WHERE created_at >= $1 AND created_at <= $2
       GROUP BY event_type ORDER BY count DESC`, [fromDate, toDate]);
        const highRisk = await connection_1.db.query(`SELECT * FROM audit_events
       WHERE created_at >= $1 AND created_at <= $2
         AND risk_level IN ('high', 'critical')
       ORDER BY created_at DESC LIMIT 100`, [fromDate, toDate]);
        const authFailures = await connection_1.db.query(`SELECT COUNT(*) as count FROM audit_events
       WHERE created_at >= $1 AND created_at <= $2
         AND outcome = 'failure'
         AND event_type LIKE 'auth.%'`, [fromDate, toDate]);
        const deniedCount = await connection_1.db.query(`SELECT COUNT(*) as count FROM audit_events
       WHERE created_at >= $1 AND created_at <= $2
         AND outcome = 'denied'`, [fromDate, toDate]);
        const summaryMap = {};
        for (const row of summary.rows) {
            summaryMap[row.event_type] = parseInt(row.count);
        }
        return {
            period: { from: fromDate.toISOString(), to: toDate.toISOString() },
            summary: summaryMap,
            highRiskEvents: highRisk.rows,
            authFailures: parseInt(authFailures.rows[0].count),
            deniedAccess: parseInt(deniedCount.rows[0].count),
        };
    }
}
exports.AuditService = AuditService;
//# sourceMappingURL=audit-service.js.map