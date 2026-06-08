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
exports.TokenService = void 0;
const uuid_1 = require("uuid");
const connection_1 = require("../database/connection");
const connection_2 = require("../database/connection");
const redis_1 = require("../cache/redis");
const config_1 = require("../config");
const compliance_service_1 = require("./compliance-service");
class TokenService {
    compliance = new compliance_service_1.ComplianceService();
    async createToken(req) {
        return (0, connection_1.withSerializableTransaction)(async (client) => {
            const treasuryExtId = `treasury:token:${req.symbol}:${(0, uuid_1.v4)()}`;
            const treasuryResult = await client.query(`INSERT INTO accounts (external_id, account_type, currency, metadata)
         VALUES ($1, 'asset', $2, $3) RETURNING id`, [
                treasuryExtId,
                req.treasuryCurrency,
                JSON.stringify({ purpose: 'token_treasury', symbol: req.symbol }),
            ]);
            const treasuryAccountId = treasuryResult.rows[0].id;
            const tokenResult = await client.query(`INSERT INTO token_definitions (
          asset_id, treasury_account_id, symbol, name,
          token_standard, decimals, max_supply,
          contract_address, chain, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id`, [
                req.assetId || null,
                treasuryAccountId,
                req.symbol,
                req.name,
                req.tokenStandard,
                req.decimals ?? 18,
                req.maxSupply?.toString() || null,
                req.contractAddress || null,
                req.chain || null,
                JSON.stringify(req.metadata || {}),
            ]);
            const tokenId = tokenResult.rows[0].id;
            await client.query(`INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('token', $1, 'token.created', $2)`, [tokenId, JSON.stringify({
                    tokenId,
                    symbol: req.symbol,
                    name: req.name,
                    tokenStandard: req.tokenStandard,
                    treasuryAccountId,
                })]);
            config_1.logger.info({ tokenId, symbol: req.symbol }, 'Token created');
            return tokenId;
        });
    }
    async mint(req) {
        const token = await this.getTokenOrFail(req.tokenId);
        if (token.status !== 'active') {
            throw new Error(`Token ${req.tokenId} is not active (status: ${token.status})`);
        }
        if (token.max_supply) {
            const newMinted = BigInt(token.total_minted) + req.amount;
            if (newMinted > BigInt(token.max_supply)) {
                throw new Error(`Mint would exceed max supply: ${newMinted} > ${token.max_supply}`);
            }
        }
        return (0, connection_1.withSerializableTransaction)(async (client) => {
            const compliance = await this.compliance.validateTransfer(client, req.tokenId, null, req.toAccountId, req.amount);
            if (!compliance.allowed) {
                throw new Error(`Compliance check failed: ${compliance.violations.map(v => v.message).join('; ')}`);
            }
            await this.ensureHolderAccount(client, req.tokenId, req.toAccountId, token.treasury_account_id);
            const journal = await this.postJournalInTx(client, {
                idempotencyKey: req.idempotencyKey,
                description: `Mint ${req.amount} ${token.symbol} to ${req.toAccountId}`,
                externalRef: req.tokenId,
                externalRefType: 'token_mint',
                lines: [
                    {
                        accountId: token.treasury_account_id,
                        amount: req.amount,
                        direction: 'debit',
                    },
                    {
                        accountId: req.toAccountId,
                        amount: req.amount,
                        direction: 'credit',
                    },
                ],
            });
            await client.query(`UPDATE token_definitions
         SET total_minted = total_minted + $1, updated_at = NOW()
         WHERE id = $2`, [req.amount.toString(), req.tokenId]);
            await this.updateHolderBalance(client, req.tokenId, req.toAccountId, req.amount);
            await this.insertOperation(client, {
                tokenId: req.tokenId,
                operationType: 'mint',
                toAccountId: req.toAccountId,
                amount: req.amount,
                journalEntryId: journal.journalEntryId,
                operatorId: req.operatorId,
                reason: req.reason,
            });
            await redis_1.tokenCache.invalidate(req.tokenId);
            await redis_1.tokenSupplyCache.invalidate(req.tokenId);
            config_1.logger.info({ tokenId: req.tokenId, to: req.toAccountId, amount: req.amount.toString() }, 'Tokens minted');
            return journal;
        });
    }
    async burn(req) {
        const token = await this.getTokenOrFail(req.tokenId);
        if (token.status !== 'active') {
            throw new Error(`Token ${req.tokenId} is not active`);
        }
        return (0, connection_1.withSerializableTransaction)(async (client) => {
            const holder = await this.getHolderRow(client, req.tokenId, req.fromAccountId);
            if (!holder) {
                throw new Error(`Account ${req.fromAccountId} is not a holder of token ${req.tokenId}`);
            }
            if (BigInt(holder.balance) < req.amount) {
                throw new Error(`Insufficient balance: ${holder.balance} < ${req.amount}`);
            }
            if (holder.status === 'frozen') {
                throw new Error(`Holder account ${req.fromAccountId} is frozen`);
            }
            const journal = await this.postJournalInTx(client, {
                idempotencyKey: req.idempotencyKey,
                description: `Burn ${req.amount} ${token.symbol} from ${req.fromAccountId}`,
                externalRef: req.tokenId,
                externalRefType: 'token_burn',
                lines: [
                    {
                        accountId: req.fromAccountId,
                        amount: req.amount,
                        direction: 'debit',
                    },
                    {
                        accountId: token.treasury_account_id,
                        amount: req.amount,
                        direction: 'credit',
                    },
                ],
            });
            await client.query(`UPDATE token_definitions
         SET total_burned = total_burned + $1, updated_at = NOW()
         WHERE id = $2`, [req.amount.toString(), req.tokenId]);
            await this.updateHolderBalance(client, req.tokenId, req.fromAccountId, -req.amount);
            await this.insertOperation(client, {
                tokenId: req.tokenId,
                operationType: 'burn',
                fromAccountId: req.fromAccountId,
                amount: req.amount,
                journalEntryId: journal.journalEntryId,
                operatorId: req.operatorId,
                reason: req.reason,
            });
            await redis_1.tokenCache.invalidate(req.tokenId);
            await redis_1.tokenSupplyCache.invalidate(req.tokenId);
            config_1.logger.info({ tokenId: req.tokenId, from: req.fromAccountId, amount: req.amount.toString() }, 'Tokens burned');
            return journal;
        });
    }
    async transfer(req) {
        const token = await this.getTokenOrFail(req.tokenId);
        if (token.status !== 'active') {
            throw new Error(`Token ${req.tokenId} is not active`);
        }
        return (0, connection_1.withSerializableTransaction)(async (client) => {
            const compliance = await this.compliance.validateTransfer(client, req.tokenId, req.fromAccountId, req.toAccountId, req.amount);
            if (!compliance.allowed) {
                throw new Error(`Compliance check failed: ${compliance.violations.map(v => v.message).join('; ')}`);
            }
            const sender = await this.getHolderRow(client, req.tokenId, req.fromAccountId);
            if (!sender) {
                throw new Error(`Sender ${req.fromAccountId} is not a holder`);
            }
            if (BigInt(sender.balance) < req.amount) {
                throw new Error(`Insufficient balance: ${sender.balance} < ${req.amount}`);
            }
            if (sender.status === 'frozen') {
                throw new Error(`Sender account ${req.fromAccountId} is frozen`);
            }
            await this.ensureHolderAccount(client, req.tokenId, req.toAccountId, token.treasury_account_id);
            const journal = await this.postJournalInTx(client, {
                idempotencyKey: req.idempotencyKey,
                description: `Transfer ${req.amount} ${token.symbol}: ${req.fromAccountId} -> ${req.toAccountId}`,
                externalRef: req.tokenId,
                externalRefType: 'token_transfer',
                lines: [
                    {
                        accountId: req.fromAccountId,
                        amount: req.amount,
                        direction: 'debit',
                    },
                    {
                        accountId: req.toAccountId,
                        amount: req.amount,
                        direction: 'credit',
                    },
                ],
            });
            await this.updateHolderBalance(client, req.tokenId, req.fromAccountId, -req.amount);
            await this.updateHolderBalance(client, req.tokenId, req.toAccountId, req.amount);
            await this.insertOperation(client, {
                tokenId: req.tokenId,
                operationType: 'transfer',
                fromAccountId: req.fromAccountId,
                toAccountId: req.toAccountId,
                amount: req.amount,
                journalEntryId: journal.journalEntryId,
                operatorId: req.operatorId,
                reason: req.reason,
            });
            config_1.logger.info({
                tokenId: req.tokenId,
                from: req.fromAccountId,
                to: req.toAccountId,
                amount: req.amount.toString(),
            }, 'Tokens transferred');
            return journal;
        });
    }
    async freezeHolder(req) {
        await this.setHolderStatus(req.tokenId, req.accountId, 'frozen', 'freeze', req.operatorId, req.reason);
    }
    async unfreezeHolder(req) {
        await this.setHolderStatus(req.tokenId, req.accountId, 'active', 'unfreeze', req.operatorId, req.reason);
    }
    async setHolderStatus(tokenId, accountId, newStatus, opType, operatorId, reason) {
        const result = await connection_2.db.query(`UPDATE token_holders
       SET status = $1, updated_at = NOW()
       WHERE token_id = $2 AND account_id = $3
       RETURNING id`, [newStatus, tokenId, accountId]);
        if (result.rows.length === 0) {
            throw new Error(`Holder not found: token=${tokenId}, account=${accountId}`);
        }
        await connection_2.db.query(`INSERT INTO token_operations (
        token_id, operation_type, from_account_id, operator_id, reason
      ) VALUES ($1, $2, $3, $4, $5)`, [tokenId, opType, accountId, operatorId || null, reason || null]);
        await connection_2.db.query(`INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('token', $1, $2, $3)`, [tokenId, `token.holder.${opType}d`, JSON.stringify({
                tokenId, accountId, status: newStatus,
            })]);
        config_1.logger.info({ tokenId, accountId, status: newStatus }, `Holder ${opType}d`);
    }
    async getToken(tokenId) {
        const result = await connection_2.db.query('SELECT * FROM token_definitions WHERE id = $1', [tokenId]);
        return result.rows[0] || null;
    }
    async listTokens(filters = {}) {
        const limit = Math.min(filters.limit || 50, 200);
        const offset = filters.offset || 0;
        let query = 'SELECT * FROM token_definitions WHERE 1=1';
        const params = [];
        if (filters.status) {
            params.push(filters.status);
            query += ` AND status = $${params.length}`;
        }
        if (filters.assetId) {
            params.push(filters.assetId);
            query += ` AND asset_id = $${params.length}`;
        }
        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);
        const result = await connection_2.db.query(query, params);
        return { tokens: result.rows, limit, offset };
    }
    async getHolders(tokenId, limit = 50, offset = 0) {
        const result = await connection_2.db.query(`SELECT * FROM token_holders
       WHERE token_id = $1 AND status != 'removed'
       ORDER BY balance DESC LIMIT $2 OFFSET $3`, [tokenId, Math.min(limit, 200), offset]);
        return { holders: result.rows, limit, offset };
    }
    async getHolderBalance(tokenId, accountId) {
        const result = await connection_2.db.query(`SELECT * FROM token_holders
       WHERE token_id = $1 AND account_id = $2`, [tokenId, accountId]);
        return result.rows[0] || null;
    }
    async getOperationHistory(tokenId, limit = 50, offset = 0) {
        const result = await connection_2.db.query(`SELECT * FROM token_operations
       WHERE token_id = $1
       ORDER BY id DESC LIMIT $2 OFFSET $3`, [tokenId, Math.min(limit, 200), offset]);
        return { operations: result.rows, limit, offset };
    }
    async activateToken(tokenId) {
        const result = await connection_2.db.query(`UPDATE token_definitions SET status = 'active', updated_at = NOW()
       WHERE id = $1 AND status = 'draft' RETURNING id`, [tokenId]);
        if (result.rows.length === 0) {
            throw new Error(`Token ${tokenId} not found or not in draft status`);
        }
        await redis_1.tokenCache.invalidate(tokenId);
    }
    async pauseToken(tokenId) {
        const result = await connection_2.db.query(`UPDATE token_definitions SET status = 'paused', updated_at = NOW()
       WHERE id = $1 AND status = 'active' RETURNING id`, [tokenId]);
        if (result.rows.length === 0) {
            throw new Error(`Token ${tokenId} not found or not active`);
        }
        await redis_1.tokenCache.invalidate(tokenId);
    }
    async getTokenOrFail(tokenId) {
        const result = await connection_2.db.query('SELECT * FROM token_definitions WHERE id = $1', [tokenId]);
        if (result.rows.length === 0) {
            throw new Error(`Token ${tokenId} not found`);
        }
        return result.rows[0];
    }
    async getHolderRow(client, tokenId, accountId) {
        const result = await client.query(`SELECT * FROM token_holders
       WHERE token_id = $1 AND account_id = $2 FOR UPDATE`, [tokenId, accountId]);
        return result.rows[0] || null;
    }
    async ensureHolderAccount(client, tokenId, accountId, _treasuryAccountId) {
        await client.query(`INSERT INTO token_holders (token_id, account_id)
       VALUES ($1, $2)
       ON CONFLICT (token_id, account_id) DO NOTHING`, [tokenId, accountId]);
    }
    async updateHolderBalance(client, tokenId, accountId, delta) {
        await client.query(`UPDATE token_holders
       SET balance = balance + $1, updated_at = NOW()
       WHERE token_id = $2 AND account_id = $3`, [delta.toString(), tokenId, accountId]);
    }
    async insertOperation(client, op) {
        await client.query(`INSERT INTO token_operations (
        token_id, operation_type, from_account_id, to_account_id,
        amount, journal_entry_id, tx_blockchain_id,
        operator_id, reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
            op.tokenId,
            op.operationType,
            op.fromAccountId || null,
            op.toAccountId || null,
            op.amount?.toString() || null,
            op.journalEntryId || null,
            op.txBlockchainId || null,
            op.operatorId || null,
            op.reason || null,
        ]);
    }
    /**
     * Post a journal entry using the existing ledger service's postJournal,
     * but adapted to work within an already-open serializable transaction.
     * We inline the posting logic to share the same client/transaction.
     */
    async postJournalInTx(client, req) {
        const { createHash } = await Promise.resolve().then(() => __importStar(require('crypto')));
        function computeEntryHash(prevHash, accountId, amount, direction, seq) {
            const data = `${prevHash}|${accountId}|${amount}|${direction}|${seq}`;
            return createHash('sha256').update(data).digest('hex');
        }
        await client.query('SET CONSTRAINTS trg_check_balanced DEFERRED');
        const existing = await client.query('SELECT id FROM journal_entries WHERE idempotency_key = $1', [req.idempotencyKey]);
        if (existing.rows.length > 0) {
            const entries = await client.query(`SELECT id, account_id, amount, direction
         FROM ledger_entries WHERE journal_entry_id = $1`, [existing.rows[0].id]);
            return {
                journalEntryId: existing.rows[0].id,
                entries: entries.rows.map(r => ({
                    id: r.id,
                    accountId: r.account_id,
                    amount: BigInt(r.amount),
                    direction: r.direction,
                })),
            };
        }
        const journalResult = await client.query(`INSERT INTO journal_entries (
        idempotency_key, description, external_ref, external_ref_type, metadata
      ) VALUES ($1, $2, $3, $4, '{}') RETURNING id`, [
            req.idempotencyKey,
            req.description,
            req.externalRef,
            req.externalRefType,
        ]);
        const journalId = journalResult.rows[0].id;
        const postedEntries = [];
        for (const line of req.lines) {
            let balanceRow = await client.query('SELECT * FROM balance_cache WHERE account_id = $1 FOR UPDATE', [line.accountId]);
            if (balanceRow.rows.length === 0) {
                await client.query(`INSERT INTO balance_cache (account_id)
           VALUES ($1) ON CONFLICT DO NOTHING`, [line.accountId]);
                balanceRow = await client.query('SELECT * FROM balance_cache WHERE account_id = $1 FOR UPDATE', [line.accountId]);
            }
            const bal = balanceRow.rows[0];
            const prevHash = bal.last_entry_hash
                || '0000000000000000000000000000000000000000000000000000000000000000';
            const seqResult = await client.query(`SELECT COALESCE(MAX(sequence_num), 0) as max_seq
         FROM ledger_entries WHERE account_id = $1`, [line.accountId]);
            const nextSeq = Number(seqResult.rows[0].max_seq) + 1;
            const entryHash = computeEntryHash(prevHash, line.accountId, line.amount, line.direction, nextSeq);
            const entryResult = await client.query(`INSERT INTO ledger_entries (
          journal_entry_id, account_id, amount, direction,
          entry_hash, prev_hash, sequence_num
        ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [
                journalId, line.accountId, line.amount.toString(),
                line.direction, entryHash, prevHash, nextSeq,
            ]);
            const newDebitTotal = BigInt(bal.debit_total)
                + (line.direction === 'debit' ? line.amount : 0n);
            const newCreditTotal = BigInt(bal.credit_total)
                + (line.direction === 'credit' ? line.amount : 0n);
            const newBalance = newDebitTotal - newCreditTotal;
            await client.query(`UPDATE balance_cache
         SET debit_total = $1, credit_total = $2, balance = $3,
             last_entry_id = $4, last_entry_hash = $5, updated_at = NOW()
         WHERE account_id = $6`, [
                newDebitTotal.toString(),
                newCreditTotal.toString(),
                newBalance.toString(),
                entryResult.rows[0].id,
                entryHash,
                line.accountId,
            ]);
            postedEntries.push({
                id: entryResult.rows[0].id,
                accountId: line.accountId,
                amount: line.amount,
                direction: line.direction,
            });
        }
        await client.query(`INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('journal_entry', $1, 'journal.posted', $2)`, [journalId, JSON.stringify({
                journalEntryId: journalId,
                idempotencyKey: req.idempotencyKey,
                lines: postedEntries.map(e => ({
                    accountId: e.accountId,
                    amount: e.amount.toString(),
                    direction: e.direction,
                })),
            })]);
        return { journalEntryId: journalId, entries: postedEntries };
    }
}
exports.TokenService = TokenService;
//# sourceMappingURL=token-service.js.map