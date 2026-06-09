import { db, withSerializableTransaction } from '../database/connection';
import { logger } from '../config';
import { v4 as uuidv4 } from 'uuid';

export type BuyInStatus = 'initiated' | 'pending_execution' | 'executed' | 'cancelled';

export interface PartialSettlementResult {
  instructionId: string;
  settledAmount: string;
  remainingAmount: string;
  settlementPercentage: number;
  partialId: string;
}

export interface BuyInProcedure {
  id: string;
  failedInstructionId: string;
  failingPartyId: string;
  asset: string;
  shortfallAmount: string;
  buyInPrice: string | null;
  status: BuyInStatus;
  deadline: Date;
  penaltyBps: number;
}

export class DvpSettlementService {
  private readonly defaultBuyInPenaltyBps = 100; // 1% penalty
  private readonly buyInDeadlineHours = 48;

  async executePartialSettlement(instructionId: string, availablePercentage: number): Promise<PartialSettlementResult> {
    if (availablePercentage <= 0 || availablePercentage >= 100) throw new Error('Partial must be between 0-100%');

    return await withSerializableTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM settlement_instructions WHERE id=$1 AND status IN ('pending','matched') FOR UPDATE`, [instructionId]
      );
      if (!rows.length) throw new Error('Instruction not found or not eligible');
      const instr = rows[0];

      const originalAmount = BigInt(instr.leg_a_amount);
      const settledAmount = (originalAmount * BigInt(Math.round(availablePercentage * 100))) / 10000n;
      const remainingAmount = originalAmount - settledAmount;
      const partialId = uuidv4();

      // Record partial settlement
      await client.query(
        `INSERT INTO partial_settlements (id, instruction_id, settled_amount, remaining_amount, percentage, settled_at)
         VALUES ($1,$2,$3,$4,$5,NOW())`,
        [partialId, instructionId, settledAmount.toString(), remainingAmount.toString(), availablePercentage]
      );

      // Create residual instruction for the remainder
      await client.query(
        `INSERT INTO settlement_instructions (settlement_type, leg_a_account_id, leg_a_asset, leg_a_amount, leg_a_direction, leg_b_account_id, leg_b_asset, leg_b_amount, leg_b_direction, settlement_date, settlement_cycle, counterparty_ref, parent_instruction_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [instr.settlement_type, instr.leg_a_account_id, instr.leg_a_asset, remainingAmount.toString(), instr.leg_a_direction, instr.leg_b_account_id, instr.leg_b_asset, remainingAmount.toString(), instr.leg_b_direction, instr.settlement_date, instr.settlement_cycle, instr.counterparty_ref, instructionId]
      );

      // Mark original as partially settled
      await client.query(`UPDATE settlement_instructions SET status='settled', settled_amount=$2 WHERE id=$1`, [instructionId, settledAmount.toString()]);

      logger.info({ instructionId, settledPct: availablePercentage }, 'Partial settlement executed');
      return { instructionId, settledAmount: settledAmount.toString(), remainingAmount: remainingAmount.toString(), settlementPercentage: availablePercentage, partialId };
    });
  }

  async initiateFailureHandling(instructionId: string): Promise<BuyInProcedure> {
    const { rows } = await db.query(`SELECT * FROM settlement_instructions WHERE id=$1`, [instructionId]);
    if (!rows.length) throw new Error('Instruction not found');
    const instr = rows[0];

    const id = uuidv4();
    const deadline = new Date(Date.now() + this.buyInDeadlineHours * 3600_000);

    await db.query(
      `INSERT INTO buy_in_procedures (id, failed_instruction_id, failing_party_id, asset, shortfall_amount, status, deadline, penalty_bps)
       VALUES ($1,$2,$3,$4,$5,'initiated',$6,$7)`,
      [id, instructionId, instr.leg_a_account_id, instr.leg_a_asset, instr.leg_a_amount, deadline, this.defaultBuyInPenaltyBps]
    );

    // Mark instruction as failed
    await db.query(`UPDATE settlement_instructions SET status='failed' WHERE id=$1 AND status IN ('pending','matched')`, [instructionId]);

    logger.info({ id, instructionId, deadline }, 'Buy-in procedure initiated');
    return { id, failedInstructionId: instructionId, failingPartyId: instr.leg_a_account_id, asset: instr.leg_a_asset, shortfallAmount: instr.leg_a_amount, buyInPrice: null, status: 'initiated', deadline, penaltyBps: this.defaultBuyInPenaltyBps };
  }

  async executeBuyIn(buyInId: string, marketPrice: string): Promise<void> {
    await withSerializableTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM buy_in_procedures WHERE id=$1 AND status='initiated' FOR UPDATE`, [buyInId]);
      if (!rows.length) throw new Error('Buy-in not found or not in initiated state');
      const buyIn = rows[0];

      const penalty = (BigInt(buyIn.shortfall_amount) * BigInt(buyIn.penalty_bps)) / 10000n;

      await client.query(`UPDATE buy_in_procedures SET status='executed', buy_in_price=$2, executed_at=NOW() WHERE id=$1`, [buyInId, marketPrice]);

      // Record penalty via outbox for ledger posting
      await client.query(
        `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('settlement', $1, 'buy_in.executed', $2)`,
        [buyInId, JSON.stringify({ buyInId, failingParty: buyIn.failing_party_id, penalty: penalty.toString(), marketPrice })]
      );
      logger.info({ buyInId, penalty: penalty.toString() }, 'Buy-in executed');
    });
  }

  async getFailedSettlements(since?: Date): Promise<unknown[]> {
    const { rows } = await db.query(
      `SELECT si.*, bp.id as buy_in_id, bp.status as buy_in_status FROM settlement_instructions si
       LEFT JOIN buy_in_procedures bp ON bp.failed_instruction_id = si.id
       WHERE si.status='failed' AND si.created_at >= $1 ORDER BY si.created_at DESC`,
      [since || new Date(Date.now() - 7 * 86400_000)]
    );
    return rows;
  }
}
