"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrustDomainService = void 0;
const connection_1 = require("../database/connection");
const config_1 = require("../config");
/**
 * Trust Domains: isolation of business units, segregation of custody environments,
 * customer asset segregation, independent signing domains, cross-domain authorization.
 */
class TrustDomainService {
    async createDomain(params) {
        const result = await connection_1.db.query(`INSERT INTO trust_domains (name, description, parent_domain_id, isolation_level, signing_domain_id, status)
       VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`, [params.name, params.description || null, params.parentDomainId || null, params.isolationLevel, params.signingDomainId || null]);
        config_1.logger.info({ id: result.rows[0].id, name: params.name }, 'Trust domain created');
        return this.mapDomain(result.rows[0]);
    }
    /**
     * Create cross-domain policy — defines what operations are permitted between domains.
     */
    async createCrossDomainPolicy(params) {
        const result = await connection_1.db.query(`INSERT INTO cross_domain_policies (source_domain_id, target_domain_id, trust_level, allowed_operations, requires_approval, max_amount)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [params.sourceDomainId, params.targetDomainId, params.trustLevel, JSON.stringify(params.allowedOperations), params.requiresApproval, params.maxAmount?.toString() || null]);
        return this.mapPolicy(result.rows[0]);
    }
    /**
     * Authorize a cross-domain operation — checks policies.
     */
    async authorizeCrossDomainOperation(params) {
        const result = await connection_1.db.query(`SELECT * FROM cross_domain_policies WHERE source_domain_id=$1 AND target_domain_id=$2 AND active=TRUE`, [params.sourceDomainId, params.targetDomainId]);
        if (result.rows.length === 0) {
            return { authorized: false, requiresApproval: false, reason: 'no_policy_defined' };
        }
        const policy = result.rows[0];
        const allowedOps = policy.allowed_operations;
        if (!allowedOps.includes(params.operation) && !allowedOps.includes('*')) {
            return { authorized: false, requiresApproval: false, reason: 'operation_not_allowed' };
        }
        if (policy.max_amount && params.amount && params.amount > BigInt(policy.max_amount)) {
            return { authorized: false, requiresApproval: false, reason: 'exceeds_amount_limit' };
        }
        return { authorized: true, requiresApproval: policy.requires_approval };
    }
    /**
     * Validate asset segregation — ensure customer assets are in correct domain.
     */
    async validateAssetSegregation(accountId, domainId) {
        const result = await connection_1.db.query(`SELECT 1 FROM accounts a JOIN trust_domain_accounts tda ON a.id=tda.account_id WHERE a.id=$1 AND tda.domain_id=$2`, [accountId, domainId]);
        return result.rows.length > 0;
    }
    /**
     * Assign account to a trust domain.
     */
    async assignAccountToDomain(accountId, domainId) {
        await connection_1.db.query(`INSERT INTO trust_domain_accounts (account_id, domain_id) VALUES ($1,$2) ON CONFLICT (account_id) DO UPDATE SET domain_id=$2`, [accountId, domainId]);
    }
    async getDomain(id) {
        const result = await connection_1.db.query(`SELECT * FROM trust_domains WHERE id=$1`, [id]);
        return result.rows[0] ? this.mapDomain(result.rows[0]) : null;
    }
    async listDomains() {
        const result = await connection_1.db.query(`SELECT * FROM trust_domains WHERE status='active' ORDER BY name`);
        return result.rows.map(this.mapDomain);
    }
    mapDomain(row) {
        return { id: row.id, name: row.name, description: row.description, parentDomainId: row.parent_domain_id, isolationLevel: row.isolation_level, signingDomainId: row.signing_domain_id, status: row.status };
    }
    mapPolicy(row) {
        return { id: row.id, sourceDomainId: row.source_domain_id, targetDomainId: row.target_domain_id, trustLevel: row.trust_level, allowedOperations: row.allowed_operations, requiresApproval: row.requires_approval, maxAmount: row.max_amount ? BigInt(row.max_amount) : undefined };
    }
}
exports.TrustDomainService = TrustDomainService;
//# sourceMappingURL=trust-domain-service.js.map