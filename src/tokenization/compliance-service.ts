import { db } from '../database/connection';
import { TxClient } from '../database/connection';
import { whitelistCache } from '../cache/redis';
import { logger } from '../config';
import {
  ComplianceCheckResult,
  ComplianceViolation,
  AddRestrictionRequest,
  WhitelistAddressRequest,
  RestrictionType,
} from './types';

interface Restriction {
  id: string;
  token_id: string;
  restriction_type: RestrictionType;
  config: Record<string, unknown>;
}

export class ComplianceService {
  /**
   * Validate a transfer against all active restrictions for a token.
   * Called within a serializable transaction during mint/burn/transfer.
   */
  async validateTransfer(
    client: TxClient,
    tokenId: string,
    fromAccountId: string | null,
    toAccountId: string | null,
    amount: bigint,
  ): Promise<ComplianceCheckResult> {
    const restrictions = await client.query(
      `SELECT * FROM transfer_restrictions
       WHERE token_id = $1 AND active = TRUE`,
      [tokenId]
    );

    const violations: ComplianceViolation[] = [];

    for (const r of restrictions.rows as Restriction[]) {
      const violation = await this.checkRestriction(
        client, r, tokenId, fromAccountId, toAccountId, amount
      );
      if (violation) {
        violations.push(violation);
      }
    }

    return { allowed: violations.length === 0, violations };
  }

  private async checkRestriction(
    client: TxClient,
    restriction: Restriction,
    tokenId: string,
    fromAccountId: string | null,
    toAccountId: string | null,
    amount: bigint,
  ): Promise<ComplianceViolation | null> {
    switch (restriction.restriction_type) {
      case 'whitelist':
        return this.checkWhitelist(
          client, restriction, tokenId, fromAccountId, toAccountId
        );
      case 'jurisdiction_block':
        return this.checkJurisdiction(
          client, restriction, fromAccountId, toAccountId
        );
      case 'lockup':
        return this.checkLockup(restriction);
      case 'max_holders':
        return this.checkMaxHolders(
          client, restriction, tokenId, toAccountId
        );
      case 'min_holding':
        return this.checkMinHolding(
          client, restriction, tokenId, toAccountId, amount
        );
      case 'max_holding':
        return this.checkMaxHolding(
          client, restriction, tokenId, toAccountId, amount
        );
      default:
        return null;
    }
  }

  private async checkWhitelist(
    client: TxClient,
    restriction: Restriction,
    tokenId: string,
    fromAccountId: string | null,
    toAccountId: string | null,
  ): Promise<ComplianceViolation | null> {
    const accountsToCheck = [fromAccountId, toAccountId].filter(Boolean);

    for (const accountId of accountsToCheck) {
      const holder = await client.query(
        `SELECT holder_address FROM token_holders
         WHERE token_id = $1 AND account_id = $2`,
        [tokenId, accountId]
      );

      if (holder.rows.length === 0) continue;
      const address = holder.rows[0].holder_address;
      if (!address) continue;

      const whitelisted = await client.query(
        `SELECT id FROM whitelist_entries
         WHERE token_id = $1 AND address = $2
           AND valid_from <= NOW()
           AND (valid_until IS NULL OR valid_until > NOW())`,
        [tokenId, address]
      );

      if (whitelisted.rows.length === 0) {
        return {
          restrictionType: 'whitelist',
          restrictionId: restriction.id,
          message: `Address ${address} is not whitelisted for token ${tokenId}`,
        };
      }
    }
    return null;
  }

  private async checkJurisdiction(
    client: TxClient,
    restriction: Restriction,
    fromAccountId: string | null,
    toAccountId: string | null,
  ): Promise<ComplianceViolation | null> {
    const blocked = restriction.config.blocked_jurisdictions as string[] || [];
    const accountsToCheck = [fromAccountId, toAccountId].filter(Boolean);

    for (const accountId of accountsToCheck) {
      const holder = await client.query(
        `SELECT investor_jurisdiction FROM token_holders
         WHERE account_id = $1`,
        [accountId]
      );

      if (holder.rows.length === 0) continue;
      const jurisdiction = holder.rows[0].investor_jurisdiction;

      if (jurisdiction && blocked.includes(jurisdiction)) {
        return {
          restrictionType: 'jurisdiction_block',
          restrictionId: restriction.id,
          message: `Jurisdiction ${jurisdiction} is blocked`,
        };
      }
    }
    return null;
  }

  private checkLockup(
    restriction: Restriction,
  ): ComplianceViolation | null {
    const lockupUntil = restriction.config.lockup_until as string;
    if (lockupUntil && new Date(lockupUntil) > new Date()) {
      return {
        restrictionType: 'lockup',
        restrictionId: restriction.id,
        message: `Token is locked until ${lockupUntil}`,
      };
    }
    return null;
  }

  private async checkMaxHolders(
    client: TxClient,
    restriction: Restriction,
    tokenId: string,
    toAccountId: string | null,
  ): Promise<ComplianceViolation | null> {
    if (!toAccountId) return null;

    const maxHolders = restriction.config.max_holders as number;
    if (!maxHolders) return null;

    const existing = await client.query(
      `SELECT id FROM token_holders
       WHERE token_id = $1 AND account_id = $2 AND status = 'active'`,
      [tokenId, toAccountId]
    );

    if (existing.rows.length > 0) return null;

    const count = await client.query(
      `SELECT COUNT(*) as cnt FROM token_holders
       WHERE token_id = $1 AND status = 'active' AND balance > 0`,
      [tokenId]
    );

    if (parseInt(count.rows[0].cnt) >= maxHolders) {
      return {
        restrictionType: 'max_holders',
        restrictionId: restriction.id,
        message: `Maximum holder count of ${maxHolders} would be exceeded`,
      };
    }
    return null;
  }

  private async checkMinHolding(
    client: TxClient,
    restriction: Restriction,
    tokenId: string,
    toAccountId: string | null,
    amount: bigint,
  ): Promise<ComplianceViolation | null> {
    if (!toAccountId) return null;

    const minHolding = BigInt(
      (restriction.config.min_holding as string) || '0'
    );
    if (minHolding === 0n) return null;

    const holder = await client.query(
      `SELECT balance FROM token_holders
       WHERE token_id = $1 AND account_id = $2`,
      [tokenId, toAccountId]
    );

    const currentBalance = holder.rows.length > 0
      ? BigInt(holder.rows[0].balance)
      : 0n;
    const newBalance = currentBalance + amount;

    if (newBalance < minHolding) {
      return {
        restrictionType: 'min_holding',
        restrictionId: restriction.id,
        message: `Resulting balance ${newBalance} below minimum ${minHolding}`,
      };
    }
    return null;
  }

  private async checkMaxHolding(
    client: TxClient,
    restriction: Restriction,
    tokenId: string,
    toAccountId: string | null,
    amount: bigint,
  ): Promise<ComplianceViolation | null> {
    if (!toAccountId) return null;

    const maxHolding = BigInt(
      (restriction.config.max_holding as string) || '0'
    );
    if (maxHolding === 0n) return null;

    const holder = await client.query(
      `SELECT balance FROM token_holders
       WHERE token_id = $1 AND account_id = $2`,
      [tokenId, toAccountId]
    );

    const currentBalance = holder.rows.length > 0
      ? BigInt(holder.rows[0].balance)
      : 0n;
    const newBalance = currentBalance + amount;

    if (newBalance > maxHolding) {
      return {
        restrictionType: 'max_holding',
        restrictionId: restriction.id,
        message: `Resulting balance ${newBalance} exceeds maximum ${maxHolding}`,
      };
    }
    return null;
  }

  async addRestriction(req: AddRestrictionRequest): Promise<string> {
    const result = await db.query(
      `INSERT INTO transfer_restrictions (token_id, restriction_type, config)
       VALUES ($1, $2, $3) RETURNING id`,
      [req.tokenId, req.restrictionType, JSON.stringify(req.config)]
    );

    logger.info(
      { tokenId: req.tokenId, type: req.restrictionType },
      'Transfer restriction added'
    );
    return result.rows[0].id;
  }

  async removeRestriction(restrictionId: string): Promise<void> {
    await db.query(
      `UPDATE transfer_restrictions SET active = FALSE, updated_at = NOW()
       WHERE id = $1`,
      [restrictionId]
    );
  }

  async getRestrictions(tokenId: string) {
    const result = await db.query(
      `SELECT * FROM transfer_restrictions
       WHERE token_id = $1 AND active = TRUE
       ORDER BY created_at ASC`,
      [tokenId]
    );
    return result.rows;
  }

  async addWhitelistEntry(req: WhitelistAddressRequest): Promise<string> {
    const result = await db.query(
      `INSERT INTO whitelist_entries (token_id, address, valid_from, valid_until)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token_id, address) DO UPDATE
         SET valid_from = EXCLUDED.valid_from,
             valid_until = EXCLUDED.valid_until
       RETURNING id`,
      [
        req.tokenId,
        req.address,
        req.validFrom || new Date(),
        req.validUntil || null,
      ]
    );

    await whitelistCache.add(req.tokenId, req.address);
    return result.rows[0].id;
  }

  async removeWhitelistEntry(
    tokenId: string,
    address: string,
  ): Promise<void> {
    await db.query(
      `DELETE FROM whitelist_entries
       WHERE token_id = $1 AND address = $2`,
      [tokenId, address]
    );
    await whitelistCache.remove(tokenId, address);
  }

  async getWhitelistEntries(tokenId: string) {
    const result = await db.query(
      `SELECT * FROM whitelist_entries
       WHERE token_id = $1
       ORDER BY created_at ASC`,
      [tokenId]
    );
    return result.rows;
  }

  /**
   * Standalone compliance check (not within a transaction).
   * Used by the API for pre-flight validation.
   */
  async checkCompliance(
    tokenId: string,
    fromAccountId: string | null,
    toAccountId: string | null,
    amount: bigint,
  ): Promise<ComplianceCheckResult> {
    const client = await (await import('../database/connection')).db.connect();
    try {
      return await this.validateTransfer(
        client, tokenId, fromAccountId, toAccountId, amount
      );
    } finally {
      client.release();
    }
  }
}
