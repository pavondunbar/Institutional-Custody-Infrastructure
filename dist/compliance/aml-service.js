"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AmlService = void 0;
const connection_1 = require("../database/connection");
const config_1 = require("../config");
/**
 * AML/Sanctions screening and suspicious activity reporting.
 * Integrates with sanctions lists (OFAC SDN, UN, EU, UK HMT).
 */
class AmlService {
    /**
     * Screen an address against all sanctions lists.
     */
    async screenAddress(address) {
        const normalizedAddr = address.toLowerCase();
        const result = await connection_1.db.query(`SELECT id, list_type, entity_name, entity_type
       FROM sanctions_lists
       WHERE addresses @> $1`, [JSON.stringify([normalizedAddr])]);
        if (result.rows.length > 0) {
            const match = result.rows[0];
            await this.recordScreening('address', address, match.id, 100, 'exact', 'flagged');
            config_1.logger.warn({ address: normalizedAddr, list: match.list_type }, 'Sanctions match found');
            return {
                matched: true,
                matchScore: 100,
                matchType: 'exact',
                sanctionsListId: match.id,
                details: {
                    listType: match.list_type,
                    entityName: match.entity_name,
                    entityType: match.entity_type,
                },
            };
        }
        await this.recordScreening('address', address, null, 0, null, 'cleared');
        return {
            matched: false,
            matchScore: 0,
            matchType: null,
            sanctionsListId: null,
            details: {},
        };
    }
    /**
     * Screen an entity name against sanctions lists (fuzzy matching).
     */
    async screenEntity(name) {
        const result = await connection_1.db.query(`SELECT id, list_type, entity_name, entity_type,
              similarity(entity_name, $1) as sim_score
       FROM sanctions_lists
       WHERE entity_name % $1
       ORDER BY sim_score DESC
       LIMIT 1`, [name]);
        if (result.rows.length > 0 && parseFloat(result.rows[0].sim_score) > 0.6) {
            const match = result.rows[0];
            const score = Math.round(parseFloat(match.sim_score) * 100);
            await this.recordScreening('counterparty', name, match.id, score, 'fuzzy', 'flagged');
            return {
                matched: true,
                matchScore: score,
                matchType: 'fuzzy',
                sanctionsListId: match.id,
                details: {
                    matchedName: match.entity_name,
                    listType: match.list_type,
                },
            };
        }
        await this.recordScreening('counterparty', name, null, 0, null, 'cleared');
        return {
            matched: false,
            matchScore: 0,
            matchType: null,
            sanctionsListId: null,
            details: {},
        };
    }
    /**
     * Screen a transaction for suspicious patterns.
     */
    async screenTransaction(params) {
        const indicators = [];
        if (params.toAddress) {
            const addrResult = await this.screenAddress(params.toAddress);
            if (addrResult.matched) {
                indicators.push('sanctioned_recipient_address');
            }
        }
        if (params.fromAddress) {
            const addrResult = await this.screenAddress(params.fromAddress);
            if (addrResult.matched) {
                indicators.push('sanctioned_sender_address');
            }
        }
        const threshold = BigInt(process.env.AML_THRESHOLD || '10000000000');
        if (params.amount >= threshold) {
            indicators.push('large_transaction');
        }
        const recentTxs = await connection_1.db.query(`SELECT COUNT(*) as cnt, COALESCE(SUM(amount), 0) as total
       FROM ledger_entries
       WHERE account_id = $1
         AND created_at > NOW() - INTERVAL '24 hours'`, [params.accountId]);
        const dailyCount = parseInt(recentTxs.rows[0].cnt);
        const dailyTotal = BigInt(recentTxs.rows[0].total);
        if (dailyCount > 50) {
            indicators.push('high_frequency_trading');
        }
        if (dailyTotal > threshold * 10n) {
            indicators.push('high_daily_volume');
        }
        if (indicators.length > 0) {
            await this.recordScreening('transaction', params.accountId, null, 0, null, 'flagged', { indicators, amount: params.amount.toString() });
        }
        return { flagged: indicators.length > 0, indicators };
    }
    /**
     * File a Suspicious Activity Report (SAR).
     */
    async fileSar(params) {
        const result = await connection_1.db.query(`INSERT INTO suspicious_activity_reports (
        report_type, subject_type, subject_id, description,
        amount, currency, indicators, related_transactions,
        filed_by, jurisdiction, status
      ) VALUES ('SAR', $1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft')
      RETURNING id`, [
            params.subjectType, params.subjectId, params.description,
            params.amount?.toString() || null, params.currency || null,
            JSON.stringify(params.indicators),
            JSON.stringify(params.relatedTransactions || []),
            params.filedBy, params.jurisdiction || null,
        ]);
        const sarId = result.rows[0].id;
        await connection_1.db.query(`INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('compliance', $1, 'sar.filed', $2)`, [sarId, JSON.stringify({ sarId, subjectType: params.subjectType })]);
        config_1.logger.warn({ sarId }, 'Suspicious activity report filed');
        return sarId;
    }
    /**
     * Create a Travel Rule message for cross-institution transfers.
     */
    async createTravelRuleMessage(params) {
        const result = await connection_1.db.query(`INSERT INTO travel_rule_messages (
        direction, transaction_id,
        originator_name, originator_account, originator_address, originator_institution,
        beneficiary_name, beneficiary_account, beneficiary_address, beneficiary_institution,
        amount, currency
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id`, [
            params.direction, params.transactionId || null,
            params.originatorName, params.originatorAccount,
            params.originatorAddress || null, params.originatorInstitution,
            params.beneficiaryName, params.beneficiaryAccount,
            params.beneficiaryAddress || null, params.beneficiaryInstitution,
            params.amount.toString(), params.currency,
        ]);
        return result.rows[0].id;
    }
    async getSars(status, limit = 50) {
        const params = [];
        let query = 'SELECT * FROM suspicious_activity_reports WHERE 1=1';
        if (status) {
            params.push(status);
            query += ` AND status = $${params.length}`;
        }
        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
        params.push(limit);
        const result = await connection_1.db.query(query, params);
        return result.rows;
    }
    async getScreeningResults(subjectId) {
        const result = await connection_1.db.query(`SELECT * FROM screening_results
       WHERE subject_id = $1
       ORDER BY created_at DESC LIMIT 50`, [subjectId]);
        return result.rows;
    }
    /**
     * Add an entry to a sanctions list.
     */
    async addSanctionsEntry(params) {
        const result = await connection_1.db.query(`INSERT INTO sanctions_lists (
        list_type, entity_name, entity_type, addresses,
        identifiers, source_url
      ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [
            params.listType,
            params.entityName || null,
            params.entityType || null,
            JSON.stringify((params.addresses || []).map(a => a.toLowerCase())),
            JSON.stringify(params.identifiers || {}),
            params.sourceUrl || null,
        ]);
        return result.rows[0].id;
    }
    async recordScreening(screeningType, subjectId, sanctionsListId, matchScore, matchType, status, details = {}) {
        await connection_1.db.query(`INSERT INTO screening_results (
        screening_type, subject_type, subject_id,
        sanctions_list_id, match_score, match_type, status, details
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
            screeningType, screeningType, subjectId,
            sanctionsListId, matchScore, matchType, status,
            JSON.stringify(details),
        ]);
    }
}
exports.AmlService = AmlService;
//# sourceMappingURL=aml-service.js.map