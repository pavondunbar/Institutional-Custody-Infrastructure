import { db, withSerializableTransaction } from '../database/connection';
import { logger } from '../config';
import { v4 as uuidv4 } from 'uuid';

export type StablecoinOpType = 'mint' | 'redeem';
export type PegMechanism = 'overcollateralized' | 'algorithmic' | 'fiat_backed';

export interface MintRedemption {
  id: string;
  type: StablecoinOpType;
  userId: string;
  amount: string;
  collateralAmount: string;
  collateralAsset: string;
  status: 'pending' | 'processing' | 'completed' | 'rejected';
  fee: string;
}

export interface PegStatus {
  currentPrice: string;
  targetPrice: string;
  deviationBps: number;
  mechanism: PegMechanism;
  reserveRatio: number;
  lastStabilizationAction: string | null;
}

export interface YieldDistribution {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  totalYield: string;
  distributedTo: number;
  rateAnnualizedBps: number;
}

export class StablecoinService {
  private readonly mintFeeBps = 10;   // 0.1%
  private readonly redeemFeeBps = 10;
  private readonly targetPrice = '1000000'; // 1.00 with 6 decimals
  private readonly minReserveRatio = 1.0;   // 100% backed

  async requestMint(params: { userId: string; amount: string; collateralAsset: string; collateralAmount: string }): Promise<MintRedemption> {
    // Verify sufficient collateral
    const ratio = Number(BigInt(params.collateralAmount)) / Number(BigInt(params.amount));
    if (ratio < this.minReserveRatio) throw new Error(`Insufficient collateral: ratio ${ratio} < ${this.minReserveRatio}`);

    const fee = (BigInt(params.amount) * BigInt(this.mintFeeBps)) / 10000n;
    const id = uuidv4();
    await db.query(
      `INSERT INTO stablecoin_operations (id, op_type, user_id, amount, collateral_amount, collateral_asset, status, fee)
       VALUES ($1,'mint',$2,$3,$4,$5,'pending',$6)`,
      [id, params.userId, params.amount, params.collateralAmount, params.collateralAsset, fee.toString()]
    );
    logger.info({ id, amount: params.amount, type: 'mint' }, 'Mint request created');
    return { id, type: 'mint', userId: params.userId, amount: params.amount, collateralAmount: params.collateralAmount, collateralAsset: params.collateralAsset, status: 'pending', fee: fee.toString() };
  }

  async requestRedemption(params: { userId: string; amount: string }): Promise<MintRedemption> {
    const fee = (BigInt(params.amount) * BigInt(this.redeemFeeBps)) / 10000n;
    const netAmount = BigInt(params.amount) - fee;
    const id = uuidv4();
    await db.query(
      `INSERT INTO stablecoin_operations (id, op_type, user_id, amount, collateral_amount, collateral_asset, status, fee)
       VALUES ($1,'redeem',$2,$3,$4,'USD','pending',$5)`,
      [id, params.userId, params.amount, netAmount.toString(), fee.toString()]
    );
    logger.info({ id, amount: params.amount, type: 'redeem' }, 'Redemption request created');
    return { id, type: 'redeem', userId: params.userId, amount: params.amount, collateralAmount: netAmount.toString(), collateralAsset: 'USD', status: 'pending', fee: fee.toString() };
  }

  async processOperation(operationId: string): Promise<void> {
    await withSerializableTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM stablecoin_operations WHERE id=$1 AND status='pending' FOR UPDATE`, [operationId]
      );
      if (!rows.length) throw new Error('Operation not found or not pending');
      await client.query(`UPDATE stablecoin_operations SET status='completed', processed_at=NOW() WHERE id=$1`, [operationId]);
      await client.query(
        `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ('stablecoin',$1,$2,$3)`,
        [operationId, `stablecoin.${rows[0].op_type}.completed`, JSON.stringify({ id: operationId, amount: rows[0].amount })]
      );
    });
  }

  async getPegStatus(): Promise<PegStatus> {
    const { rows } = await db.query(
      `SELECT * FROM stablecoin_peg_state ORDER BY updated_at DESC LIMIT 1`
    );
    if (!rows.length) return { currentPrice: this.targetPrice, targetPrice: this.targetPrice, deviationBps: 0, mechanism: 'fiat_backed', reserveRatio: 1.0, lastStabilizationAction: null };
    const r = rows[0];
    return { currentPrice: r.current_price, targetPrice: r.target_price, deviationBps: r.deviation_bps, mechanism: r.mechanism, reserveRatio: parseFloat(r.reserve_ratio), lastStabilizationAction: r.last_action };
  }

  async updatePegPrice(currentPrice: string): Promise<{ actionTaken: string | null }> {
    const deviation = ((BigInt(currentPrice) - BigInt(this.targetPrice)) * 10000n) / BigInt(this.targetPrice);
    const deviationBps = Number(deviation);
    let action: string | null = null;

    // If depegged by more than 50bps, take stabilization action
    if (Math.abs(deviationBps) > 50) {
      action = deviationBps > 0 ? 'increase_supply' : 'contract_supply';
      logger.warn({ deviationBps, action }, 'Peg deviation detected, stabilization needed');
    }

    await db.query(
      `INSERT INTO stablecoin_peg_state (id, current_price, target_price, deviation_bps, mechanism, reserve_ratio, last_action, updated_at)
       VALUES ($1,$2,$3,$4,'fiat_backed',1.0,$5,NOW())`,
      [uuidv4(), currentPrice, this.targetPrice, deviationBps, action]
    );
    return { actionTaken: action };
  }

  async distributeYield(params: { periodStart: Date; periodEnd: Date; totalYield: string }): Promise<YieldDistribution> {
    const { rows: holders } = await db.query(
      `SELECT DISTINCT user_id, SUM(CAST(amount AS NUMERIC)) as balance FROM stablecoin_balances WHERE balance > 0 GROUP BY user_id`
    );
    if (!holders.length) throw new Error('No holders to distribute to');

    const totalSupply = holders.reduce((sum, h) => sum + BigInt(h.balance), 0n);
    const id = uuidv4();
    const daysInPeriod = (params.periodEnd.getTime() - params.periodStart.getTime()) / 86400_000;
    const annualizedRate = Math.round((Number(BigInt(params.totalYield)) / Number(totalSupply)) * (365 / daysInPeriod) * 10000);

    for (const holder of holders) {
      const share = (BigInt(params.totalYield) * BigInt(holder.balance)) / totalSupply;
      await db.query(
        `INSERT INTO yield_distributions (id, distribution_id, user_id, amount, period_start, period_end)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [uuidv4(), id, holder.user_id, share.toString(), params.periodStart, params.periodEnd]
      );
    }

    logger.info({ id, holders: holders.length, totalYield: params.totalYield }, 'Yield distributed');
    return { id, periodStart: params.periodStart, periodEnd: params.periodEnd, totalYield: params.totalYield, distributedTo: holders.length, rateAnnualizedBps: annualizedRate };
  }
}
