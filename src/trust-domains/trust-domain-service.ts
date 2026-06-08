import { db } from '../database/connection';
import { logger } from '../config';

export type TrustLevel = 'full' | 'limited' | 'none';

export interface TrustDomain {
  id: string;
  name: string;
  description?: string;
  parentDomainId?: string;
  isolationLevel: 'full' | 'shared' | 'hybrid';
  signingDomainId?: string;
  status: 'active' | 'suspended' | 'decommissioned';
}

export interface CrossDomainPolicy {
  id: string;
  sourceDomainId: string;
  targetDomainId: string;
  trustLevel: TrustLevel;
  allowedOperations: string[];
  requiresApproval: boolean;
  maxAmount?: bigint;
}

/**
 * Trust Domains: isolation of business units, segregation of custody environments,
 * customer asset segregation, independent signing domains, cross-domain authorization.
 */
export class TrustDomainService {
  async createDomain(params: { name: string; description?: string; parentDomainId?: string; isolationLevel: 'full' | 'shared' | 'hybrid'; signingDomainId?: string }): Promise<TrustDomain> {
    const result = await db.query(
      `INSERT INTO trust_domains (name, description, parent_domain_id, isolation_level, signing_domain_id, status)
       VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`,
      [params.name, params.description || null, params.parentDomainId || null, params.isolationLevel, params.signingDomainId || null]
    );
    logger.info({ id: result.rows[0].id, name: params.name }, 'Trust domain created');
    return this.mapDomain(result.rows[0]);
  }

  /**
   * Create cross-domain policy — defines what operations are permitted between domains.
   */
  async createCrossDomainPolicy(params: { sourceDomainId: string; targetDomainId: string; trustLevel: TrustLevel; allowedOperations: string[]; requiresApproval: boolean; maxAmount?: bigint }): Promise<CrossDomainPolicy> {
    const result = await db.query(
      `INSERT INTO cross_domain_policies (source_domain_id, target_domain_id, trust_level, allowed_operations, requires_approval, max_amount)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [params.sourceDomainId, params.targetDomainId, params.trustLevel, JSON.stringify(params.allowedOperations), params.requiresApproval, params.maxAmount?.toString() || null]
    );
    return this.mapPolicy(result.rows[0]);
  }

  /**
   * Authorize a cross-domain operation — checks policies.
   */
  async authorizeCrossDomainOperation(params: { sourceDomainId: string; targetDomainId: string; operation: string; amount?: bigint }): Promise<{ authorized: boolean; requiresApproval: boolean; reason?: string }> {
    const result = await db.query(
      `SELECT * FROM cross_domain_policies WHERE source_domain_id=$1 AND target_domain_id=$2 AND active=TRUE`,
      [params.sourceDomainId, params.targetDomainId]
    );

    if (result.rows.length === 0) {
      return { authorized: false, requiresApproval: false, reason: 'no_policy_defined' };
    }

    const policy = result.rows[0];
    const allowedOps = policy.allowed_operations as string[];

    if (!allowedOps.includes(params.operation) && !allowedOps.includes('*')) {
      return { authorized: false, requiresApproval: false, reason: 'operation_not_allowed' };
    }

    if (policy.max_amount && params.amount && params.amount > BigInt(policy.max_amount)) {
      return { authorized: false, requiresApproval: false, reason: 'exceeds_amount_limit' };
    }

    return { authorized: true, requiresApproval: policy.requires_approval };
  }

  /**
   * Validate asset segregation — ensure customer assets are in correct domain.
   */
  async validateAssetSegregation(accountId: string, domainId: string): Promise<boolean> {
    const result = await db.query(
      `SELECT 1 FROM accounts a JOIN trust_domain_accounts tda ON a.id=tda.account_id WHERE a.id=$1 AND tda.domain_id=$2`,
      [accountId, domainId]
    );
    return result.rows.length > 0;
  }

  /**
   * Assign account to a trust domain.
   */
  async assignAccountToDomain(accountId: string, domainId: string): Promise<void> {
    await db.query(
      `INSERT INTO trust_domain_accounts (account_id, domain_id) VALUES ($1,$2) ON CONFLICT (account_id) DO UPDATE SET domain_id=$2`,
      [accountId, domainId]
    );
  }

  async getDomain(id: string): Promise<TrustDomain | null> {
    const result = await db.query(`SELECT * FROM trust_domains WHERE id=$1`, [id]);
    return result.rows[0] ? this.mapDomain(result.rows[0]) : null;
  }

  async listDomains(): Promise<TrustDomain[]> {
    const result = await db.query(`SELECT * FROM trust_domains WHERE status='active' ORDER BY name`);
    return result.rows.map(this.mapDomain);
  }

  private mapDomain(row: Record<string, unknown>): TrustDomain {
    return { id: row.id as string, name: row.name as string, description: row.description as string | undefined, parentDomainId: row.parent_domain_id as string | undefined, isolationLevel: row.isolation_level as 'full' | 'shared' | 'hybrid', signingDomainId: row.signing_domain_id as string | undefined, status: row.status as 'active' | 'suspended' | 'decommissioned' };
  }

  private mapPolicy(row: Record<string, unknown>): CrossDomainPolicy {
    return { id: row.id as string, sourceDomainId: row.source_domain_id as string, targetDomainId: row.target_domain_id as string, trustLevel: row.trust_level as TrustLevel, allowedOperations: row.allowed_operations as string[], requiresApproval: row.requires_approval as boolean, maxAmount: row.max_amount ? BigInt(row.max_amount as string) : undefined };
  }
}
