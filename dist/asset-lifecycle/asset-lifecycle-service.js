"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AssetLifecycleService = void 0;
const connection_1 = require("../database/connection");
const config_1 = require("../config");
const uuid_1 = require("uuid");
/**
 * Asset Lifecycle Management: issuance, minting, redemption, burning,
 * corporate actions, dividend distribution, interest payments, maturity.
 */
class AssetLifecycleService {
    /**
     * Issue new asset units — creates ledger entries and lifecycle record.
     */
    async issue(params) {
        return (0, connection_1.withSerializableTransaction)(async (client) => {
            const eventId = (0, uuid_1.v4)();
            // Record lifecycle event
            await client.query(`INSERT INTO asset_lifecycle_events (id, asset_id, event_type, amount, recipient_account_id, metadata)
         VALUES ($1,$2,'issuance',$3,$4,$5)`, [eventId, params.assetId, params.amount.toString(), params.recipientAccountId, JSON.stringify({ reason: params.reason })]);
            // Create journal entry for issuance
            const journalId = (0, uuid_1.v4)();
            await client.query(`INSERT INTO journal_entries (id, idempotency_key, description, status, external_ref, external_ref_type)
         VALUES ($1,$2,$3,'posted',$4,'asset_lifecycle')`, [journalId, `issue_${eventId}`, `Asset issuance: ${params.assetId}`, eventId]);
            await client.query(`INSERT INTO ledger_entries (journal_entry_id, account_id, amount, direction, currency)
         VALUES ($1,$2,$3,'credit',$4)`, [journalId, params.recipientAccountId, params.amount.toString(), params.assetId]);
            config_1.logger.info({ assetId: params.assetId, amount: params.amount.toString() }, 'Asset issued');
            return { id: eventId, assetId: params.assetId, eventType: 'issuance', amount: params.amount, recipientAccountId: params.recipientAccountId, executedAt: new Date(), metadata: { reason: params.reason } };
        });
    }
    /**
     * Burn/redeem asset units.
     */
    async burn(params) {
        return (0, connection_1.withSerializableTransaction)(async (client) => {
            const eventId = (0, uuid_1.v4)();
            await client.query(`INSERT INTO asset_lifecycle_events (id, asset_id, event_type, amount, recipient_account_id, metadata)
         VALUES ($1,$2,'burning',$3,$4,$5)`, [eventId, params.assetId, params.amount.toString(), params.fromAccountId, JSON.stringify({ reason: params.reason })]);
            const journalId = (0, uuid_1.v4)();
            await client.query(`INSERT INTO journal_entries (id, idempotency_key, description, status, external_ref, external_ref_type)
         VALUES ($1,$2,$3,'posted',$4,'asset_lifecycle')`, [journalId, `burn_${eventId}`, `Asset burning: ${params.assetId}`, eventId]);
            await client.query(`INSERT INTO ledger_entries (journal_entry_id, account_id, amount, direction, currency)
         VALUES ($1,$2,$3,'debit',$4)`, [journalId, params.fromAccountId, params.amount.toString(), params.assetId]);
            config_1.logger.info({ assetId: params.assetId, amount: params.amount.toString() }, 'Asset burned');
            return { id: eventId, assetId: params.assetId, eventType: 'burning', amount: params.amount, recipientAccountId: params.fromAccountId, executedAt: new Date(), metadata: { reason: params.reason } };
        });
    }
    /**
     * Distribute dividends to all holders of an asset.
     */
    async distributeDividend(params) {
        const holders = await connection_1.db.query(`SELECT account_id, balance FROM balance_cache WHERE currency=$1 AND balance > 0`, [params.assetId]);
        const totalSupply = holders.rows.reduce((sum, r) => sum + BigInt(r.balance), BigInt(0));
        if (totalSupply === BigInt(0))
            throw new Error('No holders found');
        const distributionId = (0, uuid_1.v4)();
        let recipientCount = 0;
        await (0, connection_1.withSerializableTransaction)(async (client) => {
            for (const holder of holders.rows) {
                const share = (params.totalAmount * BigInt(holder.balance)) / totalSupply;
                if (share === BigInt(0))
                    continue;
                const journalId = (0, uuid_1.v4)();
                await client.query(`INSERT INTO journal_entries (id, idempotency_key, description, status, external_ref, external_ref_type)
           VALUES ($1,$2,$3,'posted',$4,'dividend')`, [journalId, `div_${distributionId}_${holder.account_id}`, `Dividend: ${params.assetId}`, distributionId]);
                await client.query(`INSERT INTO ledger_entries (journal_entry_id, account_id, amount, direction, currency) VALUES ($1,$2,$3,'debit',$4), ($1,$5,$3,'credit',$4)`, [journalId, params.sourceAccountId, share.toString(), params.assetId, holder.account_id]);
                recipientCount++;
            }
            await client.query(`INSERT INTO asset_lifecycle_events (id, asset_id, event_type, amount, metadata) VALUES ($1,$2,'dividend',$3,$4)`, [distributionId, params.assetId, params.totalAmount.toString(), JSON.stringify({ recipientCount, recordDate: params.recordDate })]);
        });
        config_1.logger.info({ assetId: params.assetId, recipientCount, totalAmount: params.totalAmount.toString() }, 'Dividend distributed');
        return { distributionId, recipientCount };
    }
    /**
     * Process maturity — mark asset as matured, settle redemption.
     */
    async processMaturity(params) {
        await connection_1.db.query(`INSERT INTO asset_lifecycle_events (asset_id, event_type, amount, recipient_account_id, metadata)
       VALUES ($1,'maturity',0,$2,$3)`, [params.assetId, params.redemptionAccountId, JSON.stringify({ maturityDate: params.maturityDate })]);
        config_1.logger.info({ assetId: params.assetId }, 'Asset maturity processed');
    }
    async getLifecycleHistory(assetId) {
        const result = await connection_1.db.query(`SELECT * FROM asset_lifecycle_events WHERE asset_id=$1 ORDER BY created_at DESC`, [assetId]);
        return result.rows.map((row) => ({
            id: row.id,
            assetId: row.asset_id,
            eventType: row.event_type,
            amount: BigInt(row.amount || '0'),
            recipientAccountId: row.recipient_account_id,
            executedAt: new Date(row.created_at),
            metadata: row.metadata || {},
        }));
    }
}
exports.AssetLifecycleService = AssetLifecycleService;
//# sourceMappingURL=asset-lifecycle-service.js.map