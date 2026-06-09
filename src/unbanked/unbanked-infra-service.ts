import { db } from '../database/connection';
import { logger } from '../config';
import { v4 as uuidv4 } from 'uuid';

export type KycTier = 'tier0' | 'tier1' | 'tier2' | 'tier3';
export type RemittanceStatus = 'initiated' | 'processing' | 'completed' | 'failed' | 'refunded';

export interface TieredKycProfile {
  id: string;
  userId: string;
  currentTier: KycTier;
  limits: { dailyLimit: string; monthlyLimit: string; singleTxLimit: string };
  verifications: { type: string; verified: boolean; verifiedAt: Date | null }[];
  upgradeEligible: boolean;
}

export interface RemittanceCorridor {
  id: string;
  sourceCountry: string;
  destinationCountry: string;
  sourceCurrency: string;
  destinationCurrency: string;
  feeFixedAmount: string;
  feePercentBps: number;
  exchangeRateMarkupBps: number;
  maxAmount: string;
  estimatedDeliveryMinutes: number;
  enabled: boolean;
}

export interface RemittanceTransfer {
  id: string;
  corridorId: string;
  senderId: string;
  recipientId: string;
  sourceAmount: string;
  destinationAmount: string;
  fee: string;
  exchangeRate: string;
  status: RemittanceStatus;
}

// Tier configuration: progressive access based on KYC level
const TIER_LIMITS: Record<KycTier, { daily: string; monthly: string; single: string }> = {
  tier0: { daily: '50', monthly: '200', single: '25' },       // Phone number only
  tier1: { daily: '500', monthly: '2000', single: '200' },    // + ID document
  tier2: { daily: '5000', monthly: '20000', single: '5000' }, // + address proof
  tier3: { daily: '50000', monthly: '200000', single: '50000' }, // Full KYC
};

const TIER_REQUIREMENTS: Record<KycTier, string[]> = {
  tier0: ['phone_number'],
  tier1: ['phone_number', 'id_document'],
  tier2: ['phone_number', 'id_document', 'address_proof'],
  tier3: ['phone_number', 'id_document', 'address_proof', 'source_of_funds', 'liveness_check'],
};

export class UnbankedInfraService {
  async createProfile(userId: string, phoneVerified: boolean): Promise<TieredKycProfile> {
    const tier: KycTier = phoneVerified ? 'tier0' : 'tier0';
    const id = uuidv4();
    const limits = TIER_LIMITS[tier];
    const verifications = [{ type: 'phone_number', verified: phoneVerified, verifiedAt: phoneVerified ? new Date() : null }];

    await db.query(
      `INSERT INTO tiered_kyc_profiles (id, user_id, current_tier, daily_limit, monthly_limit, single_tx_limit, verifications)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, userId, tier, limits.daily, limits.monthly, limits.single, JSON.stringify(verifications)]
    );
    return { id, userId, currentTier: tier, limits: { dailyLimit: limits.daily, monthlyLimit: limits.monthly, singleTxLimit: limits.single }, verifications, upgradeEligible: false };
  }

  async submitVerification(userId: string, verificationType: string): Promise<{ newTier: KycTier | null; upgraded: boolean }> {
    const { rows } = await db.query(`SELECT * FROM tiered_kyc_profiles WHERE user_id=$1`, [userId]);
    if (!rows.length) throw new Error('Profile not found');
    const profile = rows[0];

    const verifications: { type: string; verified: boolean; verifiedAt: Date | null }[] = JSON.parse(profile.verifications);
    const existing = verifications.find(v => v.type === verificationType);
    if (existing) { existing.verified = true; existing.verifiedAt = new Date(); }
    else verifications.push({ type: verificationType, verified: true, verifiedAt: new Date() });

    // Determine new tier
    const verifiedTypes = verifications.filter(v => v.verified).map(v => v.type);
    let newTier: KycTier = 'tier0';
    for (const [tier, reqs] of Object.entries(TIER_REQUIREMENTS).reverse()) {
      if (reqs.every(r => verifiedTypes.includes(r))) { newTier = tier as KycTier; break; }
    }

    const upgraded = newTier !== profile.current_tier;
    const limits = TIER_LIMITS[newTier];
    await db.query(
      `UPDATE tiered_kyc_profiles SET current_tier=$2, daily_limit=$3, monthly_limit=$4, single_tx_limit=$5, verifications=$6 WHERE user_id=$1`,
      [userId, newTier, limits.daily, limits.monthly, limits.single, JSON.stringify(verifications)]
    );

    if (upgraded) logger.info({ userId, from: profile.current_tier, to: newTier }, 'KYC tier upgraded');
    return { newTier: upgraded ? newTier : null, upgraded };
  }

  async checkTransactionLimit(userId: string, amount: string): Promise<{ allowed: boolean; reason?: string }> {
    const { rows } = await db.query(`SELECT * FROM tiered_kyc_profiles WHERE user_id=$1`, [userId]);
    if (!rows.length) return { allowed: false, reason: 'No KYC profile' };
    const profile = rows[0];

    if (BigInt(amount) > BigInt(profile.single_tx_limit)) return { allowed: false, reason: `Exceeds single transaction limit of ${profile.single_tx_limit} for ${profile.current_tier}` };

    // Check daily volume
    const { rows: dailyRows } = await db.query(
      `SELECT COALESCE(SUM(CAST(source_amount AS NUMERIC)),0) as daily FROM remittance_transfers WHERE sender_id=$1 AND created_at > NOW() - interval '24 hours' AND status != 'failed'`, [userId]
    );
    if (BigInt(Math.floor(Number(dailyRows[0].daily))) + BigInt(amount) > BigInt(profile.daily_limit)) {
      return { allowed: false, reason: `Would exceed daily limit of ${profile.daily_limit}` };
    }
    return { allowed: true };
  }

  async createCorridor(params: {
    sourceCountry: string; destinationCountry: string; sourceCurrency: string; destinationCurrency: string;
    feeFixedAmount: string; feePercentBps: number; exchangeRateMarkupBps: number; maxAmount: string; estimatedDeliveryMinutes: number;
  }): Promise<RemittanceCorridor> {
    const id = uuidv4();
    await db.query(
      `INSERT INTO remittance_corridors (id, source_country, destination_country, source_currency, destination_currency, fee_fixed, fee_percent_bps, exchange_rate_markup_bps, max_amount, estimated_delivery_minutes, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
      [id, params.sourceCountry, params.destinationCountry, params.sourceCurrency, params.destinationCurrency, params.feeFixedAmount, params.feePercentBps, params.exchangeRateMarkupBps, params.maxAmount, params.estimatedDeliveryMinutes]
    );
    return { id, ...params, enabled: true };
  }

  async initiateRemittance(params: {
    corridorId: string; senderId: string; recipientId: string; sourceAmount: string; exchangeRate: string;
  }): Promise<RemittanceTransfer> {
    // Validate sender limits
    const limitCheck = await this.checkTransactionLimit(params.senderId, params.sourceAmount);
    if (!limitCheck.allowed) throw new Error(limitCheck.reason!);

    const { rows: corridors } = await db.query(`SELECT * FROM remittance_corridors WHERE id=$1 AND enabled=true`, [params.corridorId]);
    if (!corridors.length) throw new Error('Corridor not found or disabled');
    const corridor = corridors[0];

    if (BigInt(params.sourceAmount) > BigInt(corridor.max_amount)) throw new Error('Exceeds corridor maximum');

    const fee = BigInt(corridor.fee_fixed) + (BigInt(params.sourceAmount) * BigInt(corridor.fee_percent_bps)) / 10000n;
    const netAmount = BigInt(params.sourceAmount) - fee;
    const destinationAmount = (netAmount * BigInt(params.exchangeRate)) / 1000000n;

    const id = uuidv4();
    await db.query(
      `INSERT INTO remittance_transfers (id, corridor_id, sender_id, recipient_id, source_amount, destination_amount, fee, exchange_rate, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'initiated',NOW())`,
      [id, params.corridorId, params.senderId, params.recipientId, params.sourceAmount, destinationAmount.toString(), fee.toString(), params.exchangeRate]
    );
    return { id, corridorId: params.corridorId, senderId: params.senderId, recipientId: params.recipientId, sourceAmount: params.sourceAmount, destinationAmount: destinationAmount.toString(), fee: fee.toString(), exchangeRate: params.exchangeRate, status: 'initiated' };
  }

  // Low-bandwidth support: compact JSON responses for feature phones / USSD
  formatForLowBandwidth(data: Record<string, unknown>): string {
    // Strip nulls, shorten keys, minimize payload
    const compact: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value === null || value === undefined) continue;
      const shortKey = key.replace(/([A-Z])/g, '_$1').toLowerCase().slice(0, 8);
      compact[shortKey] = typeof value === 'string' && value.length > 20 ? value.slice(0, 20) : value;
    }
    return JSON.stringify(compact);
  }

  async getBalanceUssd(userId: string): Promise<string> {
    const { rows } = await db.query(`SELECT current_tier, daily_limit, single_tx_limit FROM tiered_kyc_profiles WHERE user_id=$1`, [userId]);
    if (!rows.length) return 'ERR:NO_ACCT';
    const { rows: balanceRows } = await db.query(`SELECT COALESCE(balance_precise,0) as bal FROM balance_cache WHERE account_id=$1 LIMIT 1`, [userId]);
    const bal = balanceRows.length ? balanceRows[0].bal : '0';
    return `BAL:${bal} LIM:${rows[0].single_tx_limit} TIER:${rows[0].current_tier}`;
  }
}
