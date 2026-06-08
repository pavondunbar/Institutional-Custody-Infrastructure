"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ComplianceService = void 0;
const connection_1 = require("../database/connection");
const redis_1 = require("../cache/redis");
const config_1 = require("../config");
class ComplianceService {
    /**
     * Validate a transfer against all active restrictions for a token.
     * Called within a serializable transaction during mint/burn/transfer.
     */
    async validateTransfer(client, tokenId, fromAccountId, toAccountId, amount) {
        const restrictions = await client.query(`SELECT * FROM transfer_restrictions
       WHERE token_id = $1 AND active = TRUE`, [tokenId]);
        const violations = [];
        for (const r of restrictions.rows) {
            const violation = await this.checkRestriction(client, r, tokenId, fromAccountId, toAccountId, amount);
            if (violation) {
                violations.push(violation);
            }
        }
        return { allowed: violations.length === 0, violations };
    }
    async checkRestriction(client, restriction, tokenId, fromAccountId, toAccountId, amount) {
        switch (restriction.restriction_type) {
            case 'whitelist':
                return this.checkWhitelist(client, restriction, tokenId, fromAccountId, toAccountId);
            case 'jurisdiction_block':
                return this.checkJurisdiction(client, restriction, fromAccountId, toAccountId);
            case 'lockup':
                return this.checkLockup(restriction);
            case 'max_holders':
                return this.checkMaxHolders(client, restriction, tokenId, toAccountId);
            case 'min_holding':
                return this.checkMinHolding(client, restriction, tokenId, toAccountId, amount);
            case 'max_holding':
                return this.checkMaxHolding(client, restriction, tokenId, toAccountId, amount);
            default:
                return null;
        }
    }
    async checkWhitelist(client, restriction, tokenId, fromAccountId, toAccountId) {
        const accountsToCheck = [fromAccountId, toAccountId].filter(Boolean);
        for (const accountId of accountsToCheck) {
            const holder = await client.query(`SELECT holder_address FROM token_holders
         WHERE token_id = $1 AND account_id = $2`, [tokenId, accountId]);
            if (holder.rows.length === 0)
                continue;
            const address = holder.rows[0].holder_address;
            if (!address)
                continue;
            const whitelisted = await client.query(`SELECT id FROM whitelist_entries
         WHERE token_id = $1 AND address = $2
           AND valid_from <= NOW()
           AND (valid_until IS NULL OR valid_until > NOW())`, [tokenId, address]);
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
    async checkJurisdiction(client, restriction, fromAccountId, toAccountId) {
        const blocked = restriction.config.blocked_jurisdictions || [];
        const accountsToCheck = [fromAccountId, toAccountId].filter(Boolean);
        for (const accountId of accountsToCheck) {
            const holder = await client.query(`SELECT investor_jurisdiction FROM token_holders
         WHERE account_id = $1`, [accountId]);
            if (holder.rows.length === 0)
                continue;
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
    checkLockup(restriction) {
        const lockupUntil = restriction.config.lockup_until;
        if (lockupUntil && new Date(lockupUntil) > new Date()) {
            return {
                restrictionType: 'lockup',
                restrictionId: restriction.id,
                message: `Token is locked until ${lockupUntil}`,
            };
        }
        return null;
    }
    async checkMaxHolders(client, restriction, tokenId, toAccountId) {
        if (!toAccountId)
            return null;
        const maxHolders = restriction.config.max_holders;
        if (!maxHolders)
            return null;
        const existing = await client.query(`SELECT id FROM token_holders
       WHERE token_id = $1 AND account_id = $2 AND status = 'active'`, [tokenId, toAccountId]);
        if (existing.rows.length > 0)
            return null;
        const count = await client.query(`SELECT COUNT(*) as cnt FROM token_holders
       WHERE token_id = $1 AND status = 'active' AND balance > 0`, [tokenId]);
        if (parseInt(count.rows[0].cnt) >= maxHolders) {
            return {
                restrictionType: 'max_holders',
                restrictionId: restriction.id,
                message: `Maximum holder count of ${maxHolders} would be exceeded`,
            };
        }
        return null;
    }
    async checkMinHolding(client, restriction, tokenId, toAccountId, amount) {
        if (!toAccountId)
            return null;
        const minHolding = BigInt(restriction.config.min_holding || '0');
        if (minHolding === 0n)
            return null;
        const holder = await client.query(`SELECT balance FROM token_holders
       WHERE token_id = $1 AND account_id = $2`, [tokenId, toAccountId]);
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
    async checkMaxHolding(client, restriction, tokenId, toAccountId, amount) {
        if (!toAccountId)
            return null;
        const maxHolding = BigInt(restriction.config.max_holding || '0');
        if (maxHolding === 0n)
            return null;
        const holder = await client.query(`SELECT balance FROM token_holders
       WHERE token_id = $1 AND account_id = $2`, [tokenId, toAccountId]);
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
    async addRestriction(req) {
        const result = await connection_1.db.query(`INSERT INTO transfer_restrictions (token_id, restriction_type, config)
       VALUES ($1, $2, $3) RETURNING id`, [req.tokenId, req.restrictionType, JSON.stringify(req.config)]);
        config_1.logger.info({ tokenId: req.tokenId, type: req.restrictionType }, 'Transfer restriction added');
        return result.rows[0].id;
    }
    async removeRestriction(restrictionId) {
        await connection_1.db.query(`UPDATE transfer_restrictions SET active = FALSE, updated_at = NOW()
       WHERE id = $1`, [restrictionId]);
    }
    async getRestrictions(tokenId) {
        const result = await connection_1.db.query(`SELECT * FROM transfer_restrictions
       WHERE token_id = $1 AND active = TRUE
       ORDER BY created_at ASC`, [tokenId]);
        return result.rows;
    }
    async addWhitelistEntry(req) {
        const result = await connection_1.db.query(`INSERT INTO whitelist_entries (token_id, address, valid_from, valid_until)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token_id, address) DO UPDATE
         SET valid_from = EXCLUDED.valid_from,
             valid_until = EXCLUDED.valid_until
       RETURNING id`, [
            req.tokenId,
            req.address,
            req.validFrom || new Date(),
            req.validUntil || null,
        ]);
        await redis_1.whitelistCache.add(req.tokenId, req.address);
        return result.rows[0].id;
    }
    async removeWhitelistEntry(tokenId, address) {
        await connection_1.db.query(`DELETE FROM whitelist_entries
       WHERE token_id = $1 AND address = $2`, [tokenId, address]);
        await redis_1.whitelistCache.remove(tokenId, address);
    }
    async getWhitelistEntries(tokenId) {
        const result = await connection_1.db.query(`SELECT * FROM whitelist_entries
       WHERE token_id = $1
       ORDER BY created_at ASC`, [tokenId]);
        return result.rows;
    }
    /**
     * Standalone compliance check (not within a transaction).
     * Used by the API for pre-flight validation.
     */
    async checkCompliance(tokenId, fromAccountId, toAccountId, amount) {
        const client = await (await Promise.resolve().then(() => __importStar(require('../database/connection')))).db.connect();
        try {
            return await this.validateTransfer(client, tokenId, fromAccountId, toAccountId, amount);
        }
        finally {
            client.release();
        }
    }
}
exports.ComplianceService = ComplianceService;
//# sourceMappingURL=compliance-service.js.map