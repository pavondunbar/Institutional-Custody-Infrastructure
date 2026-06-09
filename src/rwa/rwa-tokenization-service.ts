import { db } from '../database/connection';
import { logger } from '../config';
import { v4 as uuidv4 } from 'uuid';

export type AccreditationStatus = 'pending' | 'verified' | 'expired' | 'rejected';
export type AccreditationType = 'income' | 'net_worth' | 'professional' | 'entity_qualified';
export type VerificationStatus = 'pending' | 'verified' | 'disputed' | 'stale';

export interface InvestorAccreditation {
  id: string;
  investorId: string;
  type: AccreditationType;
  status: AccreditationStatus;
  jurisdiction: string;
  verifiedAt: Date | null;
  expiresAt: Date;
  evidence: Record<string, unknown>;
}

export interface AssetVerification {
  id: string;
  assetId: string;
  verificationType: string;
  status: VerificationStatus;
  oracleSource: string;
  verifiedValue: string;
  currency: string;
  verifiedAt: Date;
  nextVerificationDue: Date;
  attestationHash: string;
}

export class RwaTokenizationService {
  async submitAccreditation(params: {
    investorId: string;
    type: AccreditationType;
    jurisdiction: string;
    evidence: Record<string, unknown>;
    validityDays?: number;
  }): Promise<InvestorAccreditation> {
    const id = uuidv4();
    const expiresAt = new Date(Date.now() + (params.validityDays || 365) * 86400_000);
    await db.query(
      `INSERT INTO investor_accreditations (id, investor_id, type, status, jurisdiction, expires_at, evidence)
       VALUES ($1,$2,$3,'pending',$4,$5,$6)`,
      [id, params.investorId, params.type, params.jurisdiction, expiresAt, JSON.stringify(params.evidence)]
    );
    logger.info({ id, investorId: params.investorId, type: params.type }, 'Accreditation submitted');
    return { id, investorId: params.investorId, type: params.type, status: 'pending', jurisdiction: params.jurisdiction, verifiedAt: null, expiresAt, evidence: params.evidence };
  }

  async verifyAccreditation(accreditationId: string, verifiedBy: string): Promise<void> {
    await db.query(
      `UPDATE investor_accreditations SET status='verified', verified_at=NOW(), verified_by=$2 WHERE id=$1 AND status='pending'`,
      [accreditationId, verifiedBy]
    );
  }

  async checkInvestorEligibility(investorId: string, assetId: string): Promise<{ eligible: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const { rows } = await db.query(
      `SELECT * FROM investor_accreditations WHERE investor_id=$1 AND status='verified' AND expires_at > NOW()`,
      [investorId]
    );
    if (!rows.length) reasons.push('No valid accreditation on file');

    // Check jurisdiction restrictions on asset
    const { rows: restrictions } = await db.query(
      `SELECT config FROM transfer_restrictions WHERE token_id=(SELECT id FROM token_definitions WHERE asset_id=$1 LIMIT 1) AND restriction_type='jurisdiction'`,
      [assetId]
    );
    if (restrictions.length && rows.length) {
      const allowedJurisdictions: string[] = JSON.parse(restrictions[0].config)?.allowed || [];
      const investorJurisdiction = rows[0].jurisdiction;
      if (allowedJurisdictions.length && !allowedJurisdictions.includes(investorJurisdiction)) {
        reasons.push(`Investor jurisdiction ${investorJurisdiction} not permitted`);
      }
    }
    return { eligible: reasons.length === 0, reasons };
  }

  async submitAssetVerification(params: {
    assetId: string;
    verificationType: string;
    oracleSource: string;
    verifiedValue: string;
    currency: string;
    verificationIntervalDays?: number;
  }): Promise<AssetVerification> {
    const id = uuidv4();
    const now = new Date();
    const nextDue = new Date(now.getTime() + (params.verificationIntervalDays || 90) * 86400_000);
    const attestationHash = require('crypto').createHash('sha256')
      .update(`${params.assetId}:${params.verifiedValue}:${now.toISOString()}`)
      .digest('hex');

    await db.query(
      `INSERT INTO asset_verifications (id, asset_id, verification_type, status, oracle_source, verified_value, currency, verified_at, next_verification_due, attestation_hash)
       VALUES ($1,$2,$3,'verified',$4,$5,$6,$7,$8,$9)`,
      [id, params.assetId, params.verificationType, params.oracleSource, params.verifiedValue, params.currency, now, nextDue, attestationHash]
    );
    logger.info({ id, assetId: params.assetId, value: params.verifiedValue }, 'Asset verification recorded');
    return { id, assetId: params.assetId, verificationType: params.verificationType, status: 'verified', oracleSource: params.oracleSource, verifiedValue: params.verifiedValue, currency: params.currency, verifiedAt: now, nextVerificationDue: nextDue, attestationHash };
  }

  async getStaleVerifications(): Promise<AssetVerification[]> {
    const { rows } = await db.query(
      `SELECT * FROM asset_verifications WHERE next_verification_due < NOW() AND status='verified'`
    );
    return rows;
  }
}
