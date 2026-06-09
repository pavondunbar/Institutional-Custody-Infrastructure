import { db, withSerializableTransaction } from '../database/connection';
import { logger } from '../config';
import { v4 as uuidv4 } from 'uuid';

export interface HaircutSchedule {
  asset: string;
  haircutPct: number; // percentage reduction in collateral value
  volatilityTier: 'low' | 'medium' | 'high';
}

export interface CollateralBasket {
  loanId: string;
  items: { asset: string; amount: string; haircutPct: number; effectiveValue: string }[];
  totalEffectiveValue: string;
}

export interface InterestRateCurve {
  id: string;
  name: string;
  tenorDays: number[];
  ratesBps: number[];
  interpolation: 'linear' | 'cubic';
}

export interface SyndicationParticipant {
  lenderId: string;
  commitmentAmount: string;
  fundedAmount: string;
  sharePercentage: number;
}

export class LendingExtensionsService {
  // Default haircut schedules by volatility
  private readonly defaultHaircuts: HaircutSchedule[] = [
    { asset: 'BTC', haircutPct: 25, volatilityTier: 'high' },
    { asset: 'ETH', haircutPct: 30, volatilityTier: 'high' },
    { asset: 'USDC', haircutPct: 5, volatilityTier: 'low' },
    { asset: 'USDT', haircutPct: 5, volatilityTier: 'low' },
    { asset: 'US_TREASURY', haircutPct: 2, volatilityTier: 'low' },
  ];

  async getHaircutSchedule(asset?: string): Promise<HaircutSchedule[]> {
    const { rows } = await db.query(
      asset ? `SELECT * FROM haircut_schedules WHERE asset=$1` : `SELECT * FROM haircut_schedules`,
      asset ? [asset] : []
    );
    return rows.length ? rows.map(r => ({ asset: r.asset, haircutPct: r.haircut_pct, volatilityTier: r.volatility_tier })) : this.defaultHaircuts;
  }

  async setHaircut(asset: string, haircutPct: number, volatilityTier: 'low' | 'medium' | 'high'): Promise<void> {
    await db.query(
      `INSERT INTO haircut_schedules (asset, haircut_pct, volatility_tier, updated_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (asset) DO UPDATE SET haircut_pct=$2, volatility_tier=$3, updated_at=NOW()`,
      [asset, haircutPct, volatilityTier]
    );
  }

  async addCollateralToBasket(loanId: string, asset: string, amount: string): Promise<CollateralBasket> {
    const haircuts = await this.getHaircutSchedule(asset);
    const haircut = haircuts.find(h => h.asset === asset) || { haircutPct: 50 };
    const effectiveValue = (BigInt(amount) * BigInt(100 - haircut.haircutPct)) / 100n;

    await db.query(
      `INSERT INTO collateral_baskets (id, loan_id, asset, amount, haircut_pct, effective_value)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuidv4(), loanId, asset, amount, haircut.haircutPct, effectiveValue.toString()]
    );

    // Return updated basket
    const { rows } = await db.query(`SELECT * FROM collateral_baskets WHERE loan_id=$1`, [loanId]);
    const items = rows.map(r => ({ asset: r.asset, amount: r.amount, haircutPct: r.haircut_pct, effectiveValue: r.effective_value }));
    const totalEffective = items.reduce((sum, i) => sum + BigInt(i.effectiveValue), 0n);
    return { loanId, items, totalEffectiveValue: totalEffective.toString() };
  }

  async checkRehypothecationEligibility(collateralId: string): Promise<{ eligible: boolean; maxRehypothecationPct: number; currentlyRehypothecated: string }> {
    const { rows } = await db.query(
      `SELECT cb.*, rl.rehypothecation_pct, rl.currently_rehypothecated FROM collateral_baskets cb
       LEFT JOIN rehypothecation_ledger rl ON rl.collateral_id = cb.id WHERE cb.id=$1`, [collateralId]
    );
    if (!rows.length) throw new Error('Collateral not found');
    const row = rows[0];
    const maxPct = row.rehypothecation_pct || 0; // 0 means not allowed
    const current = row.currently_rehypothecated || '0';
    return { eligible: maxPct > 0, maxRehypothecationPct: maxPct, currentlyRehypothecated: current };
  }

  async setRehypothecationLimit(loanId: string, asset: string, maxPct: number): Promise<void> {
    if (maxPct < 0 || maxPct > 100) throw new Error('Rehypothecation limit must be 0-100%');
    const { rows } = await db.query(`SELECT id FROM collateral_baskets WHERE loan_id=$1 AND asset=$2`, [loanId, asset]);
    if (!rows.length) throw new Error('Collateral not found in basket');
    await db.query(
      `INSERT INTO rehypothecation_ledger (id, collateral_id, rehypothecation_pct, currently_rehypothecated)
       VALUES ($1,$2,$3,'0') ON CONFLICT (collateral_id) DO UPDATE SET rehypothecation_pct=$3`,
      [uuidv4(), rows[0].id, maxPct]
    );
  }

  async getInterestRateCurve(name: string): Promise<InterestRateCurve | null> {
    const { rows } = await db.query(`SELECT * FROM interest_rate_curves WHERE name=$1`, [name]);
    if (!rows.length) return null;
    return { id: rows[0].id, name: rows[0].name, tenorDays: JSON.parse(rows[0].tenor_days), ratesBps: JSON.parse(rows[0].rates_bps), interpolation: rows[0].interpolation };
  }

  async setInterestRateCurve(params: { name: string; tenorDays: number[]; ratesBps: number[]; interpolation: 'linear' | 'cubic' }): Promise<string> {
    if (params.tenorDays.length !== params.ratesBps.length) throw new Error('Tenor and rates arrays must match');
    const id = uuidv4();
    await db.query(
      `INSERT INTO interest_rate_curves (id, name, tenor_days, rates_bps, interpolation, updated_at) VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (name) DO UPDATE SET tenor_days=$3, rates_bps=$4, interpolation=$5, updated_at=NOW()`,
      [id, params.name, JSON.stringify(params.tenorDays), JSON.stringify(params.ratesBps), params.interpolation]
    );
    return id;
  }

  interpolateRate(curve: InterestRateCurve, tenorDays: number): number {
    const { tenorDays: tenors, ratesBps: rates } = curve;
    if (tenorDays <= tenors[0]) return rates[0];
    if (tenorDays >= tenors[tenors.length - 1]) return rates[rates.length - 1];
    for (let i = 0; i < tenors.length - 1; i++) {
      if (tenorDays >= tenors[i] && tenorDays <= tenors[i + 1]) {
        const t = (tenorDays - tenors[i]) / (tenors[i + 1] - tenors[i]);
        return Math.round(rates[i] + t * (rates[i + 1] - rates[i]));
      }
    }
    return rates[0];
  }

  async executePartialLiquidation(loanId: string, liquidationPct: number): Promise<{ liquidatedAmount: string; remainingCollateral: string }> {
    if (liquidationPct <= 0 || liquidationPct >= 100) throw new Error('Partial liquidation must be 1-99%');
    return await withSerializableTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM loans WHERE id=$1 AND status IN ('margin_call','liquidating') FOR UPDATE`, [loanId]);
      if (!rows.length) throw new Error('Loan not found or not in liquidatable state');
      const loan = rows[0];

      const collateral = BigInt(loan.collateral_amount);
      const liquidated = (collateral * BigInt(Math.round(liquidationPct * 100))) / 10000n;
      const remaining = collateral - liquidated;

      await client.query(`UPDATE loans SET collateral_amount=$2, status='active' WHERE id=$1`, [loanId, remaining.toString()]);
      await client.query(
        `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ('lending',$1,'loan.partial_liquidation',$2)`,
        [loanId, JSON.stringify({ loanId, liquidated: liquidated.toString(), remaining: remaining.toString(), pct: liquidationPct })]
      );
      logger.info({ loanId, liquidationPct }, 'Partial liquidation executed');
      return { liquidatedAmount: liquidated.toString(), remainingCollateral: remaining.toString() };
    });
  }

  async createSyndicatedLoan(params: {
    borrowerId: string;
    totalAmount: string;
    asset: string;
    interestRateBps: number;
    participants: { lenderId: string; commitmentAmount: string }[];
  }): Promise<{ syndicationId: string; loanId: string }> {
    const totalCommitment = params.participants.reduce((sum, p) => sum + BigInt(p.commitmentAmount), 0n);
    if (totalCommitment < BigInt(params.totalAmount)) throw new Error('Insufficient syndication commitments');

    const syndicationId = uuidv4();
    const loanId = uuidv4();

    await db.query(
      `INSERT INTO loan_syndications (id, loan_id, total_amount, asset, status, created_at) VALUES ($1,$2,$3,$4,'active',NOW())`,
      [syndicationId, loanId, params.totalAmount, params.asset]
    );

    for (const p of params.participants) {
      const share = (BigInt(p.commitmentAmount) * 10000n) / BigInt(params.totalAmount);
      await db.query(
        `INSERT INTO syndication_participants (id, syndication_id, lender_id, commitment_amount, funded_amount, share_percentage)
         VALUES ($1,$2,$3,$4,'0',$5)`,
        [uuidv4(), syndicationId, p.lenderId, p.commitmentAmount, Number(share) / 100]
      );
    }
    logger.info({ syndicationId, participants: params.participants.length }, 'Syndicated loan created');
    return { syndicationId, loanId };
  }
}
