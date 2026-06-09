"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const uuid_1 = require("uuid");
const ledger_service_1 = require("../database/ledger-service");
const wallet_service_1 = require("../wallet/wallet-service");
const chain_service_1 = require("../chain/chain-service");
const asset_service_1 = require("../tokenization/asset-service");
const token_service_1 = require("../tokenization/token-service");
const compliance_service_1 = require("../tokenization/compliance-service");
const corporate_actions_service_1 = require("../tokenization/corporate-actions-service");
const institutional_routes_1 = require("./institutional-routes");
const auth_routes_1 = require("./auth-routes");
const metrics_exporter_1 = require("../monitoring/metrics-exporter");
const connection_1 = require("../database/connection");
const redis_1 = require("../cache/redis");
const config_1 = require("../config");
function param(req, name) {
    const val = req.params[name];
    return Array.isArray(val) ? val[0] : val;
}
function createApp() {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    const walletService = new wallet_service_1.WalletService();
    const chainService = new chain_service_1.ChainService();
    const assetService = new asset_service_1.AssetService();
    const tokenService = new token_service_1.TokenService();
    const complianceService = new compliance_service_1.ComplianceService();
    const corporateActionsService = new corporate_actions_service_1.CorporateActionsService();
    // Rate limiting middleware
    app.use(async (req, res, next) => {
        const key = (Array.isArray(req.ip) ? req.ip[0] : req.ip) || 'unknown';
        const allowed = await redis_1.rateLimiter.check(key, 100, 60);
        if (!allowed)
            return res.status(429).json({ error: 'Rate limit exceeded' });
        next();
    });
    // ======================== HEALTH ========================
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });
    // ======================== PROMETHEUS METRICS ========================
    const metricsExporter = new metrics_exporter_1.MetricsExporter();
    app.get('/metrics', metricsExporter.handler());
    // ======================== ACCOUNTS ========================
    app.get('/api/v1/accounts', async (req, res) => {
        try {
            const limit = Math.min(parseInt(String(req.query.limit) || '50'), 200);
            const offset = parseInt(String(req.query.offset) || '0');
            const result = await connection_1.db.query('SELECT * FROM accounts ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset]);
            res.json({ accounts: result.rows, limit, offset });
        }
        catch (err) {
            res.status(500).json({ error: 'Internal error' });
        }
    });
    app.post('/api/v1/accounts', async (req, res) => {
        try {
            const { externalId, accountType, currency, metadata } = req.body;
            if (!externalId || !accountType || !currency) {
                return res.status(400).json({ error: 'externalId, accountType, and currency are required' });
            }
            const validTypes = ['asset', 'liability', 'equity', 'revenue', 'expense'];
            if (!validTypes.includes(accountType)) {
                return res.status(400).json({ error: `accountType must be one of: ${validTypes.join(', ')}` });
            }
            const result = await connection_1.db.query(`INSERT INTO accounts (external_id, account_type, currency, metadata)
         VALUES ($1, $2, $3, $4) RETURNING *`, [externalId, accountType, currency, JSON.stringify(metadata || {})]);
            res.status(201).json(result.rows[0]);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            if (msg.includes('duplicate key')) {
                return res.status(409).json({ error: 'Account with this externalId already exists' });
            }
            res.status(400).json({ error: msg });
        }
    });
    // ======================== LEDGER ========================
    app.post('/api/v1/journal', async (req, res) => {
        try {
            const { idempotencyKey, description, externalRef, externalRefType, lines, metadata } = req.body;
            if (!idempotencyKey || !lines || lines.length === 0) {
                return res.status(400).json({ error: 'idempotencyKey and lines are required' });
            }
            const result = await (0, ledger_service_1.postJournal)({
                idempotencyKey,
                description,
                externalRef,
                externalRefType,
                lines: lines.map((l) => ({
                    accountId: l.accountId,
                    amount: BigInt(l.amount),
                    direction: l.direction,
                })),
                metadata,
            });
            res.status(201).json({
                journalEntryId: result.journalEntryId,
                entries: result.entries.map(e => ({ ...e, amount: e.amount.toString() })),
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            config_1.logger.error(err, 'Journal posting failed');
            res.status(400).json({ error: msg });
        }
    });
    app.post('/api/v1/journal/:id/reverse', async (req, res) => {
        try {
            const idempotencyKey = req.body.idempotencyKey || (0, uuid_1.v4)();
            const result = await (0, ledger_service_1.reverseJournal)(param(req, 'id'), idempotencyKey);
            res.json({ journalEntryId: result.journalEntryId, entries: result.entries.map(e => ({ ...e, amount: e.amount.toString() })) });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.get('/api/v1/accounts/:id/balance', async (req, res) => {
        try {
            const balance = await (0, ledger_service_1.getBalance)(param(req, 'id'));
            if (!balance)
                return res.status(404).json({ error: 'Account not found' });
            res.json({
                accountId: balance.accountId,
                debitTotal: balance.debitTotal.toString(),
                creditTotal: balance.creditTotal.toString(),
                balance: balance.balance.toString(),
                lastEntryHash: balance.lastEntryHash,
            });
        }
        catch (err) {
            res.status(500).json({ error: 'Internal error' });
        }
    });
    app.get('/api/v1/accounts/:id/history', async (req, res) => {
        try {
            const limit = Math.min(parseInt(String(req.query.limit) || '50'), 200);
            const offset = parseInt(String(req.query.offset) || '0');
            const result = await connection_1.db.query(`SELECT l.*, j.description, j.external_ref, j.status as journal_status
         FROM ledger_entries l JOIN journal_entries j ON l.journal_entry_id = j.id
         WHERE l.account_id = $1 ORDER BY l.sequence_num DESC LIMIT $2 OFFSET $3`, [param(req, 'id'), limit, offset]);
            res.json({ entries: result.rows, limit, offset });
        }
        catch (err) {
            res.status(500).json({ error: 'Internal error' });
        }
    });
    // ======================== WALLETS ========================
    app.post('/api/v1/wallets', async (req, res) => {
        try {
            const id = await walletService.createWallet(req.body);
            res.status(201).json({ walletId: id });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.get('/api/v1/wallets/:id', async (req, res) => {
        const wallet = await walletService.getWallet(param(req, 'id'));
        if (!wallet)
            return res.status(404).json({ error: 'Wallet not found' });
        res.json(wallet);
    });
    app.post('/api/v1/wallets/:id/transactions', async (req, res) => {
        try {
            const txId = await walletService.createTransaction({
                walletId: param(req, 'id'),
                toAddress: req.body.toAddress,
                amount: BigInt(req.body.amount),
                gasLimit: req.body.gasLimit ? BigInt(req.body.gasLimit) : undefined,
                gasPrice: req.body.gasPrice ? BigInt(req.body.gasPrice) : undefined,
                metadata: req.body.metadata,
            });
            res.status(201).json({ transactionId: txId });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    // ======================== CHAIN ========================
    app.get('/api/v1/chain/state', async (_req, res) => {
        try {
            const state = await chainService.getChainState();
            res.json(state);
        }
        catch (err) {
            res.status(500).json({ error: 'Failed to get chain state' });
        }
    });
    app.get('/api/v1/chain/tx/:hash', async (req, res) => {
        try {
            const status = await chainService.getTransactionStatus(param(req, 'hash'));
            res.json(status);
        }
        catch (err) {
            res.status(500).json({ error: 'Failed to get tx status' });
        }
    });
    app.post('/api/v1/chain/estimate-gas', async (req, res) => {
        try {
            const estimate = await chainService.estimateGas(req.body.to, BigInt(req.body.value || '0'), req.body.data);
            res.json({
                gasLimit: estimate.gasLimit.toString(),
                gasPrice: estimate.gasPrice.toString(),
                maxFeePerGas: estimate.maxFeePerGas.toString(),
                maxPriorityFeePerGas: estimate.maxPriorityFeePerGas.toString(),
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    // ======================== INDEXER ========================
    app.get('/api/v1/blocks', async (req, res) => {
        const limit = Math.min(parseInt(String(req.query.limit) || '20'), 100);
        const result = await connection_1.db.query(`SELECT * FROM indexed_blocks WHERE status = 'confirmed' ORDER BY block_number DESC LIMIT $1`, [limit]);
        res.json({ blocks: result.rows });
    });
    app.get('/api/v1/blocks/:number', async (req, res) => {
        const result = await connection_1.db.query(`SELECT * FROM indexed_blocks WHERE block_number = $1 AND status = 'confirmed'`, [param(req, 'number')]);
        if (result.rows.length === 0)
            return res.status(404).json({ error: 'Block not found' });
        res.json(result.rows[0]);
    });
    app.get('/api/v1/events', async (req, res) => {
        const contract = req.query.contract ? String(req.query.contract) : undefined;
        const event = req.query.event ? String(req.query.event) : undefined;
        const limit = Math.min(parseInt(String(req.query.limit) || '50'), 200);
        let query = 'SELECT * FROM indexed_events WHERE 1=1';
        const params = [];
        if (contract) {
            params.push(contract);
            query += ` AND contract_address = $${params.length}`;
        }
        if (event) {
            params.push(event);
            query += ` AND event_signature = $${params.length}`;
        }
        query += ` ORDER BY id DESC LIMIT $${params.length + 1}`;
        params.push(limit);
        const result = await connection_1.db.query(query, params);
        res.json({ events: result.rows });
    });
    // ======================== RECONCILIATION ========================
    app.get('/api/v1/reconciliation/runs', async (_req, res) => {
        const result = await connection_1.db.query('SELECT * FROM reconciliation_runs ORDER BY started_at DESC LIMIT 20');
        res.json({ runs: result.rows });
    });
    // ======================== ASSETS ========================
    app.post('/api/v1/assets', async (req, res) => {
        try {
            const { externalId, assetType, name, description, issuerId, valuation, valuationCurrency, jurisdiction, legalDocRefs, metadata } = req.body;
            if (!externalId || !assetType || !name || !issuerId) {
                return res.status(400).json({ error: 'externalId, assetType, name, and issuerId are required' });
            }
            const id = await assetService.createAsset({
                externalId, assetType, name, description, issuerId,
                valuation: valuation ? BigInt(valuation) : undefined,
                valuationCurrency, jurisdiction, legalDocRefs, metadata,
            });
            res.status(201).json({ assetId: id });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            if (msg.includes('duplicate key')) {
                return res.status(409).json({ error: 'Asset with this externalId already exists' });
            }
            res.status(400).json({ error: msg });
        }
    });
    app.get('/api/v1/assets', async (req, res) => {
        try {
            const result = await assetService.listAssets({
                assetType: req.query.assetType ? String(req.query.assetType) : undefined,
                status: req.query.status ? String(req.query.status) : undefined,
                limit: req.query.limit ? parseInt(String(req.query.limit)) : undefined,
                offset: req.query.offset ? parseInt(String(req.query.offset)) : undefined,
            });
            res.json(result);
        }
        catch (err) {
            res.status(500).json({ error: 'Internal error' });
        }
    });
    app.get('/api/v1/assets/:id', async (req, res) => {
        const asset = await assetService.getAsset(param(req, 'id'));
        if (!asset)
            return res.status(404).json({ error: 'Asset not found' });
        res.json(asset);
    });
    app.put('/api/v1/assets/:id/valuation', async (req, res) => {
        try {
            const { valuation, currency } = req.body;
            if (!valuation || !currency) {
                return res.status(400).json({ error: 'valuation and currency are required' });
            }
            await assetService.updateValuation(param(req, 'id'), BigInt(valuation), currency);
            res.json({ status: 'updated' });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.post('/api/v1/assets/:id/activate', async (req, res) => {
        try {
            await assetService.activateAsset(param(req, 'id'));
            res.json({ status: 'activated' });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.post('/api/v1/assets/:id/suspend', async (req, res) => {
        try {
            await assetService.suspendAsset(param(req, 'id'));
            res.json({ status: 'suspended' });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    // ======================== TOKENS ========================
    app.post('/api/v1/tokens', async (req, res) => {
        try {
            const { assetId, symbol, name, tokenStandard, decimals, maxSupply, contractAddress, chain, treasuryCurrency, metadata } = req.body;
            if (!symbol || !name || !tokenStandard || !treasuryCurrency) {
                return res.status(400).json({ error: 'symbol, name, tokenStandard, and treasuryCurrency are required' });
            }
            const id = await tokenService.createToken({
                assetId, symbol, name, tokenStandard, decimals,
                maxSupply: maxSupply ? BigInt(maxSupply) : undefined,
                contractAddress, chain, treasuryCurrency, metadata,
            });
            res.status(201).json({ tokenId: id });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.get('/api/v1/tokens', async (req, res) => {
        try {
            const result = await tokenService.listTokens({
                status: req.query.status ? String(req.query.status) : undefined,
                assetId: req.query.assetId ? String(req.query.assetId) : undefined,
                limit: req.query.limit ? parseInt(String(req.query.limit)) : undefined,
                offset: req.query.offset ? parseInt(String(req.query.offset)) : undefined,
            });
            res.json(result);
        }
        catch (err) {
            res.status(500).json({ error: 'Internal error' });
        }
    });
    app.get('/api/v1/tokens/:id', async (req, res) => {
        const token = await tokenService.getToken(param(req, 'id'));
        if (!token)
            return res.status(404).json({ error: 'Token not found' });
        res.json(token);
    });
    app.post('/api/v1/tokens/:id/activate', async (req, res) => {
        try {
            await tokenService.activateToken(param(req, 'id'));
            res.json({ status: 'activated' });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.post('/api/v1/tokens/:id/pause', async (req, res) => {
        try {
            await tokenService.pauseToken(param(req, 'id'));
            res.json({ status: 'paused' });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.post('/api/v1/tokens/:id/mint', async (req, res) => {
        try {
            const { toAccountId, amount, holderAddress, operatorId, reason, idempotencyKey } = req.body;
            if (!toAccountId || !amount || !idempotencyKey) {
                return res.status(400).json({ error: 'toAccountId, amount, and idempotencyKey are required' });
            }
            const result = await tokenService.mint({
                tokenId: param(req, 'id'), toAccountId,
                amount: BigInt(amount), holderAddress, operatorId, reason, idempotencyKey,
            });
            res.status(201).json({
                journalEntryId: result.journalEntryId,
                entries: result.entries.map(e => ({ ...e, amount: e.amount.toString() })),
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.post('/api/v1/tokens/:id/burn', async (req, res) => {
        try {
            const { fromAccountId, amount, operatorId, reason, idempotencyKey } = req.body;
            if (!fromAccountId || !amount || !idempotencyKey) {
                return res.status(400).json({ error: 'fromAccountId, amount, and idempotencyKey are required' });
            }
            const result = await tokenService.burn({
                tokenId: param(req, 'id'), fromAccountId,
                amount: BigInt(amount), operatorId, reason, idempotencyKey,
            });
            res.json({
                journalEntryId: result.journalEntryId,
                entries: result.entries.map(e => ({ ...e, amount: e.amount.toString() })),
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.post('/api/v1/tokens/:id/transfer', async (req, res) => {
        try {
            const { fromAccountId, toAccountId, amount, operatorId, reason, idempotencyKey } = req.body;
            if (!fromAccountId || !toAccountId || !amount || !idempotencyKey) {
                return res.status(400).json({ error: 'fromAccountId, toAccountId, amount, and idempotencyKey are required' });
            }
            const result = await tokenService.transfer({
                tokenId: param(req, 'id'), fromAccountId, toAccountId,
                amount: BigInt(amount), operatorId, reason, idempotencyKey,
            });
            res.json({
                journalEntryId: result.journalEntryId,
                entries: result.entries.map(e => ({ ...e, amount: e.amount.toString() })),
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.post('/api/v1/tokens/:id/freeze', async (req, res) => {
        try {
            const { accountId, operatorId, reason } = req.body;
            if (!accountId)
                return res.status(400).json({ error: 'accountId is required' });
            await tokenService.freezeHolder({
                tokenId: param(req, 'id'), accountId, operatorId, reason,
            });
            res.json({ status: 'frozen' });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.post('/api/v1/tokens/:id/unfreeze', async (req, res) => {
        try {
            const { accountId, operatorId, reason } = req.body;
            if (!accountId)
                return res.status(400).json({ error: 'accountId is required' });
            await tokenService.unfreezeHolder({
                tokenId: param(req, 'id'), accountId, operatorId, reason,
            });
            res.json({ status: 'unfrozen' });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    // ======================== CAP TABLE ========================
    app.get('/api/v1/tokens/:id/holders', async (req, res) => {
        try {
            const limit = parseInt(String(req.query.limit) || '50');
            const offset = parseInt(String(req.query.offset) || '0');
            const result = await tokenService.getHolders(param(req, 'id'), limit, offset);
            res.json(result);
        }
        catch (err) {
            res.status(500).json({ error: 'Internal error' });
        }
    });
    app.get('/api/v1/tokens/:id/holders/:accountId', async (req, res) => {
        const holder = await tokenService.getHolderBalance(param(req, 'id'), param(req, 'accountId'));
        if (!holder)
            return res.status(404).json({ error: 'Holder not found' });
        res.json(holder);
    });
    app.get('/api/v1/tokens/:id/operations', async (req, res) => {
        try {
            const limit = parseInt(String(req.query.limit) || '50');
            const offset = parseInt(String(req.query.offset) || '0');
            const result = await tokenService.getOperationHistory(param(req, 'id'), limit, offset);
            res.json(result);
        }
        catch (err) {
            res.status(500).json({ error: 'Internal error' });
        }
    });
    // ======================== COMPLIANCE ========================
    app.post('/api/v1/tokens/:id/restrictions', async (req, res) => {
        try {
            const { restrictionType, config } = req.body;
            if (!restrictionType || !config) {
                return res.status(400).json({ error: 'restrictionType and config are required' });
            }
            const id = await complianceService.addRestriction({
                tokenId: param(req, 'id'), restrictionType, config,
            });
            res.status(201).json({ restrictionId: id });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.get('/api/v1/tokens/:id/restrictions', async (req, res) => {
        try {
            const restrictions = await complianceService.getRestrictions(param(req, 'id'));
            res.json({ restrictions });
        }
        catch (err) {
            res.status(500).json({ error: 'Internal error' });
        }
    });
    app.delete('/api/v1/tokens/:tokenId/restrictions/:restrictionId', async (req, res) => {
        try {
            await complianceService.removeRestriction(param(req, 'restrictionId'));
            res.json({ status: 'removed' });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.post('/api/v1/tokens/:id/whitelist', async (req, res) => {
        try {
            const { address, validFrom, validUntil } = req.body;
            if (!address)
                return res.status(400).json({ error: 'address is required' });
            const id = await complianceService.addWhitelistEntry({
                tokenId: param(req, 'id'), address,
                validFrom: validFrom ? new Date(validFrom) : undefined,
                validUntil: validUntil ? new Date(validUntil) : undefined,
            });
            res.status(201).json({ whitelistEntryId: id });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.delete('/api/v1/tokens/:tokenId/whitelist/:address', async (req, res) => {
        try {
            await complianceService.removeWhitelistEntry(param(req, 'tokenId'), param(req, 'address'));
            res.json({ status: 'removed' });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.get('/api/v1/tokens/:id/whitelist', async (req, res) => {
        try {
            const entries = await complianceService.getWhitelistEntries(param(req, 'id'));
            res.json({ entries });
        }
        catch (err) {
            res.status(500).json({ error: 'Internal error' });
        }
    });
    app.post('/api/v1/tokens/:id/compliance-check', async (req, res) => {
        try {
            const { fromAccountId, toAccountId, amount } = req.body;
            if (!amount)
                return res.status(400).json({ error: 'amount is required' });
            const result = await complianceService.checkCompliance(param(req, 'id'), fromAccountId || null, toAccountId || null, BigInt(amount));
            res.json(result);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    // ======================== CORPORATE ACTIONS ========================
    app.post('/api/v1/tokens/:id/actions', async (req, res) => {
        try {
            const { actionType, title, description, perTokenAmount, voteOptions, metadata } = req.body;
            if (!actionType || !title) {
                return res.status(400).json({ error: 'actionType and title are required' });
            }
            const id = await corporateActionsService.createAction({
                tokenId: param(req, 'id'), actionType, title, description,
                perTokenAmount: perTokenAmount ? BigInt(perTokenAmount) : undefined,
                voteOptions, metadata,
            });
            res.status(201).json({ actionId: id });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.get('/api/v1/tokens/:id/actions', async (req, res) => {
        try {
            const limit = parseInt(String(req.query.limit) || '50');
            const offset = parseInt(String(req.query.offset) || '0');
            const result = await corporateActionsService.listActions(param(req, 'id'), limit, offset);
            res.json(result);
        }
        catch (err) {
            res.status(500).json({ error: 'Internal error' });
        }
    });
    app.get('/api/v1/actions/:id', async (req, res) => {
        const action = await corporateActionsService.getAction(param(req, 'id'));
        if (!action)
            return res.status(404).json({ error: 'Corporate action not found' });
        res.json(action);
    });
    app.post('/api/v1/actions/:id/set-record', async (req, res) => {
        try {
            const holderCount = await corporateActionsService.setRecordDate(param(req, 'id'));
            res.json({ status: 'record_set', holdersSnapshot: holderCount });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.post('/api/v1/actions/:id/process', async (req, res) => {
        try {
            const processed = await corporateActionsService.processDistributions(param(req, 'id'));
            res.json({ status: 'completed', processed });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.post('/api/v1/actions/:id/vote', async (req, res) => {
        try {
            const { accountId, voteChoice } = req.body;
            if (!accountId || !voteChoice) {
                return res.status(400).json({ error: 'accountId and voteChoice are required' });
            }
            await corporateActionsService.castVote({
                actionId: param(req, 'id'), accountId, voteChoice,
            });
            res.json({ status: 'voted' });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.get('/api/v1/actions/:id/results', async (req, res) => {
        try {
            const results = await corporateActionsService.getActionResults(param(req, 'id'));
            res.json(results);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    app.post('/api/v1/actions/:id/cancel', async (req, res) => {
        try {
            await corporateActionsService.cancelAction(param(req, 'id'));
            res.json({ status: 'cancelled' });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            res.status(400).json({ error: msg });
        }
    });
    // ======================== INSTITUTIONAL CONTROLS ========================
    app.use('/api/v1/institutional', (0, institutional_routes_1.createInstitutionalRoutes)());
    // ======================== AUTH / IAM ========================
    app.use('/api/v1/auth', (0, auth_routes_1.createAuthRoutes)());
    // Error handler
    app.use((err, _req, res, _next) => {
        config_1.logger.error(err, 'Unhandled API error');
        res.status(500).json({ error: 'Internal server error' });
    });
    return app;
}
//# sourceMappingURL=app.js.map