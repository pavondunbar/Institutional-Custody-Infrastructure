import { db } from '../database/connection';
import { logger } from '../config';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

export type CredentialType = 'kyc_verified' | 'accredited_investor' | 'qualified_purchaser' | 'institutional' | 'jurisdiction_cleared';
export type PoolAccessLevel = 'none' | 'view' | 'trade' | 'provide_liquidity' | 'admin';

export interface VerifiableCredential {
  id: string;
  holderId: string;
  type: CredentialType;
  issuer: string;
  issuedAt: Date;
  expiresAt: Date;
  credentialHash: string;
  claims: Record<string, unknown>;
  revoked: boolean;
}

export interface PoolAccessPolicy {
  id: string;
  poolId: string;
  name: string;
  requiredCredentials: CredentialType[];
  minAccessLevel: PoolAccessLevel;
  maxParticipants: number | null;
  whitelistOnly: boolean;
}

export class PermissionedDefiService {
  async issueCredential(params: {
    holderId: string;
    type: CredentialType;
    issuer: string;
    validityDays: number;
    claims: Record<string, unknown>;
  }): Promise<VerifiableCredential> {
    const id = uuidv4();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + params.validityDays * 86400_000);
    const credentialHash = createHash('sha256')
      .update(JSON.stringify({ id, holderId: params.holderId, type: params.type, issuer: params.issuer, claims: params.claims, issuedAt }))
      .digest('hex');

    await db.query(
      `INSERT INTO verifiable_credentials (id, holder_id, type, issuer, issued_at, expires_at, credential_hash, claims, revoked)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)`,
      [id, params.holderId, params.type, params.issuer, issuedAt, expiresAt, credentialHash, JSON.stringify(params.claims)]
    );
    logger.info({ id, holderId: params.holderId, type: params.type }, 'Credential issued');
    return { id, holderId: params.holderId, type: params.type, issuer: params.issuer, issuedAt, expiresAt, credentialHash, claims: params.claims, revoked: false };
  }

  async verifyCredential(credentialId: string): Promise<{ valid: boolean; reasons: string[] }> {
    const { rows } = await db.query(`SELECT * FROM verifiable_credentials WHERE id=$1`, [credentialId]);
    if (!rows.length) return { valid: false, reasons: ['Credential not found'] };
    const cred = rows[0];
    const reasons: string[] = [];
    if (cred.revoked) reasons.push('Credential revoked');
    if (new Date(cred.expires_at) < new Date()) reasons.push('Credential expired');

    // Verify hash integrity
    const expectedHash = createHash('sha256')
      .update(JSON.stringify({ id: cred.id, holderId: cred.holder_id, type: cred.type, issuer: cred.issuer, claims: JSON.parse(cred.claims), issuedAt: new Date(cred.issued_at) }))
      .digest('hex');
    if (expectedHash !== cred.credential_hash) reasons.push('Hash integrity check failed');

    return { valid: reasons.length === 0, reasons };
  }

  async revokeCredential(credentialId: string, reason: string): Promise<void> {
    await db.query(`UPDATE verifiable_credentials SET revoked=true, revocation_reason=$2 WHERE id=$1`, [credentialId, reason]);
  }

  async createPoolAccessPolicy(params: {
    poolId: string;
    name: string;
    requiredCredentials: CredentialType[];
    minAccessLevel: PoolAccessLevel;
    maxParticipants?: number;
    whitelistOnly?: boolean;
  }): Promise<PoolAccessPolicy> {
    const id = uuidv4();
    await db.query(
      `INSERT INTO pool_access_policies (id, pool_id, name, required_credentials, min_access_level, max_participants, whitelist_only)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, params.poolId, params.name, JSON.stringify(params.requiredCredentials), params.minAccessLevel, params.maxParticipants || null, params.whitelistOnly || false]
    );
    return { id, poolId: params.poolId, name: params.name, requiredCredentials: params.requiredCredentials, minAccessLevel: params.minAccessLevel, maxParticipants: params.maxParticipants || null, whitelistOnly: params.whitelistOnly || false };
  }

  async checkPoolAccess(holderId: string, poolId: string): Promise<{ granted: boolean; accessLevel: PoolAccessLevel; missingCredentials: CredentialType[] }> {
    const { rows: policies } = await db.query(`SELECT * FROM pool_access_policies WHERE pool_id=$1`, [poolId]);
    if (!policies.length) return { granted: true, accessLevel: 'trade', missingCredentials: [] };
    const policy = policies[0];

    const required: CredentialType[] = JSON.parse(policy.required_credentials);
    const { rows: creds } = await db.query(
      `SELECT type FROM verifiable_credentials WHERE holder_id=$1 AND revoked=false AND expires_at > NOW()`,
      [holderId]
    );
    const heldTypes = creds.map(c => c.type);
    const missing = required.filter(r => !heldTypes.includes(r));

    // Check participant limit
    if (policy.max_participants) {
      const { rows: countRows } = await db.query(`SELECT COUNT(*) as cnt FROM pool_participants WHERE pool_id=$1`, [poolId]);
      if (parseInt(countRows[0].cnt) >= policy.max_participants) {
        return { granted: false, accessLevel: 'none', missingCredentials: missing };
      }
    }

    return { granted: missing.length === 0, accessLevel: missing.length === 0 ? policy.min_access_level : 'none', missingCredentials: missing };
  }

  async grantPoolAccess(holderId: string, poolId: string, accessLevel: PoolAccessLevel): Promise<void> {
    await db.query(
      `INSERT INTO pool_participants (id, pool_id, holder_id, access_level, granted_at) VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (pool_id, holder_id) DO UPDATE SET access_level=$4`,
      [uuidv4(), poolId, holderId, accessLevel]
    );
  }
}
