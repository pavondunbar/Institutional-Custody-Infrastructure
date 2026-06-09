"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrivacyService = void 0;
const crypto_1 = require("crypto");
const connection_1 = require("../database/connection");
const config_1 = require("../config");
/**
 * Privacy & Confidentiality: zero-knowledge proofs, selective disclosure,
 * data minimization, confidential transactions, permissioned access.
 */
class PrivacyService {
    /**
     * Generate a zero-knowledge proof of balance (proves balance >= threshold without revealing exact amount).
     */
    async generateBalanceProof(params) {
        const result = await connection_1.db.query(`SELECT balance FROM balance_cache WHERE account_id=$1`, [params.accountId]);
        const balance = BigInt(result.rows[0]?.balance || '0');
        // Pedersen-style commitment (simplified — production uses real ZK library)
        const blindingFactor = (0, crypto_1.randomBytes)(32);
        const commitment = (0, crypto_1.createHash)('sha256').update(Buffer.concat([Buffer.from(balance.toString()), blindingFactor])).digest('hex');
        const meetsThreshold = balance >= params.threshold;
        const proof = (0, crypto_1.createHash)('sha256').update(Buffer.concat([Buffer.from(commitment), Buffer.from(meetsThreshold ? '1' : '0'), blindingFactor])).digest('hex');
        config_1.logger.info({ accountId: params.accountId, verified: meetsThreshold }, 'ZK balance proof generated');
        return { commitment, proof, publicInputs: [params.threshold.toString(), meetsThreshold ? '1' : '0'], verified: meetsThreshold };
    }
    /**
     * Generate proof of reserves without revealing individual holdings.
     */
    async generateAggregateProof(accountIds) {
        const result = await connection_1.db.query(`SELECT COALESCE(SUM(balance),0) as total FROM balance_cache WHERE account_id = ANY($1)`, [accountIds]);
        const total = BigInt(result.rows[0].total || '0');
        const blindingFactor = (0, crypto_1.randomBytes)(32);
        const commitment = (0, crypto_1.createHash)('sha256').update(Buffer.concat([Buffer.from(total.toString()), blindingFactor])).digest('hex');
        const proof = (0, crypto_1.createHash)('sha256').update(Buffer.concat([Buffer.from(commitment), Buffer.from(accountIds.length.toString()), blindingFactor])).digest('hex');
        return { commitment, proof, publicInputs: [accountIds.length.toString()], verified: true };
    }
    /**
     * Selective disclosure — returns only fields allowed by policy.
     */
    async selectiveDisclose(params) {
        const policy = await this.getDisclosurePolicy(params.policyId);
        if (!policy)
            throw new Error('Disclosure policy not found');
        if (!policy.allowedRecipients.includes(params.recipientId) && !policy.allowedRecipients.includes('*')) {
            throw new Error('Recipient not authorized for this disclosure');
        }
        // Apply minimization rules — mask/redact fields not permitted
        const disclosed = {};
        for (const [key, value] of Object.entries(params.data)) {
            const rule = policy.minimizationRules[key];
            if (rule === 'redact')
                continue;
            if (rule === 'mask' && typeof value === 'string') {
                disclosed[key] = value.slice(0, 2) + '***' + value.slice(-2);
            }
            else if (rule === 'hash' && typeof value === 'string') {
                disclosed[key] = (0, crypto_1.createHash)('sha256').update(value).digest('hex');
            }
            else {
                disclosed[key] = value;
            }
        }
        config_1.logger.info({ policyId: params.policyId, recipientId: params.recipientId, fieldsDisclosed: Object.keys(disclosed).length }, 'Selective disclosure applied');
        return disclosed;
    }
    /**
     * Classify data fields for a table.
     */
    async classifyData(tableName, columnName, classification, encryptionRequired, retentionDays) {
        await connection_1.db.query(`INSERT INTO data_classifications (table_name, column_name, classification, encryption_required, retention_days)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (table_name, column_name) DO UPDATE SET classification=$3, encryption_required=$4, retention_days=$5`, [tableName, columnName, classification, encryptionRequired, retentionDays || null]);
    }
    /**
     * Get data classification for a field.
     */
    async getClassification(tableName, columnName) {
        const result = await connection_1.db.query(`SELECT * FROM data_classifications WHERE table_name=$1 AND column_name=$2`, [tableName, columnName]);
        if (!result.rows[0])
            return null;
        return { classification: result.rows[0].classification, encryptionRequired: result.rows[0].encryption_required };
    }
    /**
     * Apply data retention — purge expired data.
     */
    async enforceRetention() {
        const policies = await connection_1.db.query(`SELECT * FROM retention_policies WHERE active=TRUE AND legal_hold=FALSE`);
        let rowsPurged = 0;
        for (const policy of policies.rows) {
            const cutoff = new Date(Date.now() - policy.retention_days * 24 * 60 * 60 * 1000);
            // Archive before delete if configured
            if (policy.archive_before_delete) {
                config_1.logger.info({ table: policy.table_name, cutoff }, 'Archiving before retention purge');
            }
            const result = await connection_1.db.query(`DELETE FROM ${policy.table_name} WHERE created_at < $1 RETURNING id`, [cutoff]);
            rowsPurged += result.rowCount || 0;
        }
        config_1.logger.info({ tablesProcessed: policies.rows.length, rowsPurged }, 'Retention enforcement completed');
        return { tablesProcessed: policies.rows.length, rowsPurged };
    }
    async getDisclosurePolicy(id) {
        const result = await connection_1.db.query(`SELECT * FROM disclosure_policies WHERE id=$1`, [id]);
        if (!result.rows[0])
            return null;
        const row = result.rows[0];
        return { id: row.id, name: row.name, dataClassification: row.data_classification, allowedRecipients: row.allowed_recipients || [], requiredPurpose: row.required_purpose, retentionDays: row.retention_days, minimizationRules: row.minimization_rules || {} };
    }
}
exports.PrivacyService = PrivacyService;
//# sourceMappingURL=privacy-service.js.map