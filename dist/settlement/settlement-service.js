"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettlementService = void 0;
const connection_1 = require("../database/connection");
const config_1 = require("../config");
const uuid_1 = require("uuid");
/**
 * Settlement & Clearing Service: atomic settlement, DvP, PvP, netting, finality.
 */
class SettlementService {
    /**
     * Create a settlement instruction (DvP, PvP, FoP, internal, cross-chain).
     */
    async createInstruction(params) {
        const result = await connection_1.db.query(`INSERT INTO settlement_instructions (settlement_type, leg_a_account_id, leg_a_asset, leg_a_amount, leg_a_direction, leg_b_account_id, leg_b_asset, leg_b_amount, leg_b_direction, settlement_date, settlement_cycle, counterparty_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [params.settlementType, params.legA.accountId, params.legA.asset, params.legA.amount.toString(), params.legA.direction, params.legB?.accountId || null, params.legB?.asset || null, params.legB?.amount?.toString() || null, params.legB?.direction || null, params.settlementDate, params.settlementCycle || 'T+0', params.counterpartyRef || null]);
        config_1.logger.info({ id: result.rows[0].id, type: params.settlementType }, 'Settlement instruction created');
        return this.mapRow(result.rows[0]);
    }
    /**
     * Execute atomic settlement — both legs settle or neither does.
     */
    async executeSettlement(instructionId) {
        await (0, connection_1.withSerializableTransaction)(async (client) => {
            const { rows } = await client.query(`SELECT * FROM settlement_instructions WHERE id=$1 AND status IN ('pending','matched') FOR UPDATE`, [instructionId]);
            if (!rows[0])
                throw new Error('Instruction not found or not settleable');
            const instr = rows[0];
            // Mark as settling
            await client.query(`UPDATE settlement_instructions SET status='settling', updated_at=NOW() WHERE id=$1`, [instructionId]);
            // Create journal entries for both legs atomically
            const journalId = (0, uuid_1.v4)();
            await client.query(`INSERT INTO journal_entries (id, idempotency_key, description, status, external_ref, external_ref_type)
         VALUES ($1, $2, $3, 'posted', $4, 'settlement')`, [journalId, `settlement_${instructionId}`, `Settlement ${instr.settlement_type}: ${instructionId}`, instructionId]);
            // Leg A entry
            await client.query(`INSERT INTO ledger_entries (journal_entry_id, account_id, amount, direction, currency)
         VALUES ($1, $2, $3, $4, $5)`, [journalId, instr.leg_a_account_id, instr.leg_a_amount, instr.leg_a_direction === 'deliver' ? 'debit' : 'credit', instr.leg_a_asset]);
            // Leg B entry (if DvP or PvP)
            if (instr.leg_b_account_id) {
                await client.query(`INSERT INTO ledger_entries (journal_entry_id, account_id, amount, direction, currency)
           VALUES ($1, $2, $3, $4, $5)`, [journalId, instr.leg_b_account_id, instr.leg_b_amount, instr.leg_b_direction === 'deliver' ? 'debit' : 'credit', instr.leg_b_asset]);
            }
            // Mark settled
            await client.query(`UPDATE settlement_instructions SET status='settled', journal_entry_id=$1, updated_at=NOW() WHERE id=$2`, [journalId, instructionId]);
        });
        config_1.logger.info({ instructionId }, 'Settlement executed atomically');
    }
    /**
     * Calculate netting for a group of instructions — reduces gross to net obligations.
     */
    async calculateNetting(asset, date) {
        const nettingGroupId = (0, uuid_1.v4)();
        const instructions = await connection_1.db.query(`SELECT * FROM settlement_instructions WHERE leg_a_asset=$1 AND settlement_date::date=$2::date AND status='pending'`, [asset, date]);
        let grossAmount = BigInt(0);
        const netPositions = {};
        for (const instr of instructions.rows) {
            const amount = BigInt(instr.leg_a_amount);
            grossAmount += amount;
            const accountId = instr.leg_a_account_id;
            netPositions[accountId] = (netPositions[accountId] || BigInt(0)) + (instr.leg_a_direction === 'deliver' ? -amount : amount);
        }
        let netAmount = BigInt(0);
        for (const pos of Object.values(netPositions)) {
            netAmount += pos < BigInt(0) ? -pos : pos;
        }
        const savingsBps = grossAmount > BigInt(0) ? Number((BigInt(10000) * (grossAmount - netAmount)) / grossAmount) : 0;
        await connection_1.db.query(`INSERT INTO netting_groups (id, netting_date, asset, participant_count, gross_amount, net_amount, savings_bps, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'calculated')`, [nettingGroupId, date, asset, Object.keys(netPositions).length, grossAmount.toString(), netAmount.toString(), savingsBps]);
        // Link instructions to netting group
        const ids = instructions.rows.map((r) => r.id);
        if (ids.length > 0) {
            await connection_1.db.query(`UPDATE settlement_instructions SET netting_group_id=$1, status='matched' WHERE id = ANY($2)`, [nettingGroupId, ids]);
        }
        config_1.logger.info({ nettingGroupId, grossAmount: grossAmount.toString(), netAmount: netAmount.toString(), savingsBps }, 'Netting calculated');
        return { nettingGroupId, grossAmount, netAmount, savingsBps };
    }
    async getInstruction(id) {
        const result = await connection_1.db.query(`SELECT * FROM settlement_instructions WHERE id=$1`, [id]);
        return result.rows[0] ? this.mapRow(result.rows[0]) : null;
    }
    async getPendingSettlements() {
        const result = await connection_1.db.query(`SELECT * FROM settlement_instructions WHERE status IN ('pending','matched') AND settlement_date <= NOW() ORDER BY settlement_date`);
        return result.rows.map(this.mapRow);
    }
    mapRow(row) {
        return {
            id: row.id,
            settlementType: row.settlement_type,
            legA: { accountId: row.leg_a_account_id, asset: row.leg_a_asset, amount: BigInt(row.leg_a_amount), direction: row.leg_a_direction },
            legB: row.leg_b_account_id ? { accountId: row.leg_b_account_id, asset: row.leg_b_asset, amount: BigInt(row.leg_b_amount), direction: row.leg_b_direction } : undefined,
            settlementDate: new Date(row.settlement_date),
            settlementCycle: row.settlement_cycle,
            status: row.status,
            counterpartyRef: row.counterparty_ref,
            nettingGroupId: row.netting_group_id,
        };
    }
}
exports.SettlementService = SettlementService;
//# sourceMappingURL=settlement-service.js.map