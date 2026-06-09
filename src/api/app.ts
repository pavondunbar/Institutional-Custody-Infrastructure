import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { postJournal, reverseJournal, getBalance } from '../database/ledger-service';
import { WalletService } from '../wallet/wallet-service';
import { ChainService } from '../chain/chain-service';
import { AssetService } from '../tokenization/asset-service';
import { TokenService } from '../tokenization/token-service';
import { ComplianceService } from '../tokenization/compliance-service';
import { CorporateActionsService } from '../tokenization/corporate-actions-service';
import { createInstitutionalRoutes } from './institutional-routes';
import { createAuthRoutes } from './auth-routes';
import { MetricsExporter } from '../monitoring/metrics-exporter';
import { db } from '../database/connection';
import { rateLimiter } from '../cache/redis';
import { logger } from '../config';

function param(req: Request, name: string): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : val;
}

export function createApp() {
  const app = express();
  app.use(express.json());

  const walletService = new WalletService();
  const chainService = new ChainService();
  const assetService = new AssetService();
  const tokenService = new TokenService();
  const complianceService = new ComplianceService();
  const corporateActionsService = new CorporateActionsService();

  // Rate limiting middleware
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    const key = (Array.isArray(req.ip) ? req.ip[0] : req.ip) || 'unknown';
    const allowed = await rateLimiter.check(key, 100, 60);
    if (!allowed) return res.status(429).json({ error: 'Rate limit exceeded' });
    next();
  });

  // ======================== HEALTH ========================
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ======================== PROMETHEUS METRICS ========================
  const metricsExporter = new MetricsExporter();
  app.get('/metrics', metricsExporter.handler());

  // ======================== ACCOUNTS ========================
  app.get('/api/v1/accounts', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit) || '50'), 200);
      const offset = parseInt(String(req.query.offset) || '0');
      const result = await db.query(
        'SELECT * FROM accounts ORDER BY created_at DESC LIMIT $1 OFFSET $2',
        [limit, offset]
      );
      res.json({ accounts: result.rows, limit, offset });
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/v1/accounts', async (req: Request, res: Response) => {
    try {
      const { externalId, accountType, currency, metadata } = req.body;
      if (!externalId || !accountType || !currency) {
        return res.status(400).json({ error: 'externalId, accountType, and currency are required' });
      }
      const validTypes = ['asset', 'liability', 'equity', 'revenue', 'expense'];
      if (!validTypes.includes(accountType)) {
        return res.status(400).json({ error: `accountType must be one of: ${validTypes.join(', ')}` });
      }
      const result = await db.query(
        `INSERT INTO accounts (external_id, account_type, currency, metadata)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [externalId, accountType, currency, JSON.stringify(metadata || {})]
      );
      res.status(201).json(result.rows[0]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (msg.includes('duplicate key')) {
        return res.status(409).json({ error: 'Account with this externalId already exists' });
      }
      res.status(400).json({ error: msg });
    }
  });

  // ======================== LEDGER ========================
  app.post('/api/v1/journal', async (req: Request, res: Response) => {
    try {
      const { idempotencyKey, description, externalRef, externalRefType, lines, metadata } = req.body;
      if (!idempotencyKey || !lines || lines.length === 0) {
        return res.status(400).json({ error: 'idempotencyKey and lines are required' });
      }
      const result = await postJournal({
        idempotencyKey,
        description,
        externalRef,
        externalRefType,
        lines: lines.map((l: { accountId: string; amount: string; direction: string }) => ({
          accountId: l.accountId,
          amount: BigInt(l.amount),
          direction: l.direction as 'debit' | 'credit',
        })),
        metadata,
      });
      res.status(201).json({
        journalEntryId: result.journalEntryId,
        entries: result.entries.map(e => ({ ...e, amount: e.amount.toString() })),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      logger.error(err, 'Journal posting failed');
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/v1/journal/:id/reverse', async (req: Request, res: Response) => {
    try {
      const idempotencyKey = req.body.idempotencyKey || uuidv4();
      const result = await reverseJournal(param(req, 'id'), idempotencyKey);
      res.json({ journalEntryId: result.journalEntryId, entries: result.entries.map(e => ({ ...e, amount: e.amount.toString() })) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.get('/api/v1/accounts/:id/balance', async (req: Request, res: Response) => {
    try {
      const balance = await getBalance(param(req, 'id'));
      if (!balance) return res.status(404).json({ error: 'Account not found' });
      res.json({
        accountId: balance.accountId,
        debitTotal: balance.debitTotal.toString(),
        creditTotal: balance.creditTotal.toString(),
        balance: balance.balance.toString(),
        lastEntryHash: balance.lastEntryHash,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/v1/accounts/:id/history', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit) || '50'), 200);
      const offset = parseInt(String(req.query.offset) || '0');
      const result = await db.query(
        `SELECT l.*, j.description, j.external_ref, j.status as journal_status
         FROM ledger_entries l JOIN journal_entries j ON l.journal_entry_id = j.id
         WHERE l.account_id = $1 ORDER BY l.sequence_num DESC LIMIT $2 OFFSET $3`,
        [param(req, 'id'), limit, offset]
      );
      res.json({ entries: result.rows, limit, offset });
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ======================== WALLETS ========================
  app.post('/api/v1/wallets', async (req: Request, res: Response) => {
    try {
      const id = await walletService.createWallet(req.body);
      res.status(201).json({ walletId: id });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.get('/api/v1/wallets/:id', async (req: Request, res: Response) => {
    const wallet = await walletService.getWallet(param(req, 'id'));
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
    res.json(wallet);
  });

  app.post('/api/v1/wallets/:id/transactions', async (req: Request, res: Response) => {
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  // ======================== CHAIN ========================
  app.get('/api/v1/chain/state', async (_req: Request, res: Response) => {
    try {
      const state = await chainService.getChainState();
      res.json(state);
    } catch (err: unknown) {
      res.status(500).json({ error: 'Failed to get chain state' });
    }
  });

  app.get('/api/v1/chain/tx/:hash', async (req: Request, res: Response) => {
    try {
      const status = await chainService.getTransactionStatus(param(req, 'hash'));
      res.json(status);
    } catch (err: unknown) {
      res.status(500).json({ error: 'Failed to get tx status' });
    }
  });

  app.post('/api/v1/chain/estimate-gas', async (req: Request, res: Response) => {
    try {
      const estimate = await chainService.estimateGas(
        req.body.to, BigInt(req.body.value || '0'), req.body.data
      );
      res.json({
        gasLimit: estimate.gasLimit.toString(),
        gasPrice: estimate.gasPrice.toString(),
        maxFeePerGas: estimate.maxFeePerGas.toString(),
        maxPriorityFeePerGas: estimate.maxPriorityFeePerGas.toString(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  // ======================== INDEXER ========================
  app.get('/api/v1/blocks', async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit) || '20'), 100);
    const result = await db.query(
      `SELECT * FROM indexed_blocks WHERE status = 'confirmed' ORDER BY block_number DESC LIMIT $1`,
      [limit]
    );
    res.json({ blocks: result.rows });
  });

  app.get('/api/v1/blocks/:number', async (req: Request, res: Response) => {
    const result = await db.query(
      `SELECT * FROM indexed_blocks WHERE block_number = $1 AND status = 'confirmed'`,
      [param(req, 'number')]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Block not found' });
    res.json(result.rows[0]);
  });

  app.get('/api/v1/events', async (req: Request, res: Response) => {
    const contract = req.query.contract ? String(req.query.contract) : undefined;
    const event = req.query.event ? String(req.query.event) : undefined;
    const limit = Math.min(parseInt(String(req.query.limit) || '50'), 200);
    let query = 'SELECT * FROM indexed_events WHERE 1=1';
    const params: unknown[] = [];
    if (contract) { params.push(contract); query += ` AND contract_address = $${params.length}`; }
    if (event) { params.push(event); query += ` AND event_signature = $${params.length}`; }
    query += ` ORDER BY id DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    const result = await db.query(query, params);
    res.json({ events: result.rows });
  });

  // ======================== RECONCILIATION ========================
  app.get('/api/v1/reconciliation/runs', async (_req: Request, res: Response) => {
    const result = await db.query('SELECT * FROM reconciliation_runs ORDER BY started_at DESC LIMIT 20');
    res.json({ runs: result.rows });
  });

  // ======================== ASSETS ========================
  app.post('/api/v1/assets', async (req: Request, res: Response) => {
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (msg.includes('duplicate key')) {
        return res.status(409).json({ error: 'Asset with this externalId already exists' });
      }
      res.status(400).json({ error: msg });
    }
  });

  app.get('/api/v1/assets', async (req: Request, res: Response) => {
    try {
      const result = await assetService.listAssets({
        assetType: req.query.assetType ? String(req.query.assetType) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        limit: req.query.limit ? parseInt(String(req.query.limit)) : undefined,
        offset: req.query.offset ? parseInt(String(req.query.offset)) : undefined,
      });
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/v1/assets/:id', async (req: Request, res: Response) => {
    const asset = await assetService.getAsset(param(req, 'id'));
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    res.json(asset);
  });

  app.put('/api/v1/assets/:id/valuation', async (req: Request, res: Response) => {
    try {
      const { valuation, currency } = req.body;
      if (!valuation || !currency) {
        return res.status(400).json({ error: 'valuation and currency are required' });
      }
      await assetService.updateValuation(param(req, 'id'), BigInt(valuation), currency);
      res.json({ status: 'updated' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/v1/assets/:id/activate', async (req: Request, res: Response) => {
    try {
      await assetService.activateAsset(param(req, 'id'));
      res.json({ status: 'activated' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/v1/assets/:id/suspend', async (req: Request, res: Response) => {
    try {
      await assetService.suspendAsset(param(req, 'id'));
      res.json({ status: 'suspended' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  // ======================== TOKENS ========================
  app.post('/api/v1/tokens', async (req: Request, res: Response) => {
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.get('/api/v1/tokens', async (req: Request, res: Response) => {
    try {
      const result = await tokenService.listTokens({
        status: req.query.status ? String(req.query.status) : undefined,
        assetId: req.query.assetId ? String(req.query.assetId) : undefined,
        limit: req.query.limit ? parseInt(String(req.query.limit)) : undefined,
        offset: req.query.offset ? parseInt(String(req.query.offset)) : undefined,
      });
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/v1/tokens/:id', async (req: Request, res: Response) => {
    const token = await tokenService.getToken(param(req, 'id'));
    if (!token) return res.status(404).json({ error: 'Token not found' });
    res.json(token);
  });

  app.post('/api/v1/tokens/:id/activate', async (req: Request, res: Response) => {
    try {
      await tokenService.activateToken(param(req, 'id'));
      res.json({ status: 'activated' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/v1/tokens/:id/pause', async (req: Request, res: Response) => {
    try {
      await tokenService.pauseToken(param(req, 'id'));
      res.json({ status: 'paused' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/v1/tokens/:id/mint', async (req: Request, res: Response) => {
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/v1/tokens/:id/burn', async (req: Request, res: Response) => {
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/v1/tokens/:id/transfer', async (req: Request, res: Response) => {
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/v1/tokens/:id/freeze', async (req: Request, res: Response) => {
    try {
      const { accountId, operatorId, reason } = req.body;
      if (!accountId) return res.status(400).json({ error: 'accountId is required' });
      await tokenService.freezeHolder({
        tokenId: param(req, 'id'), accountId, operatorId, reason,
      });
      res.json({ status: 'frozen' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/v1/tokens/:id/unfreeze', async (req: Request, res: Response) => {
    try {
      const { accountId, operatorId, reason } = req.body;
      if (!accountId) return res.status(400).json({ error: 'accountId is required' });
      await tokenService.unfreezeHolder({
        tokenId: param(req, 'id'), accountId, operatorId, reason,
      });
      res.json({ status: 'unfrozen' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  // ======================== CAP TABLE ========================
  app.get('/api/v1/tokens/:id/holders', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(String(req.query.limit) || '50');
      const offset = parseInt(String(req.query.offset) || '0');
      const result = await tokenService.getHolders(param(req, 'id'), limit, offset);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/v1/tokens/:id/holders/:accountId', async (req: Request, res: Response) => {
    const holder = await tokenService.getHolderBalance(param(req, 'id'), param(req, 'accountId'));
    if (!holder) return res.status(404).json({ error: 'Holder not found' });
    res.json(holder);
  });

  app.get('/api/v1/tokens/:id/operations', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(String(req.query.limit) || '50');
      const offset = parseInt(String(req.query.offset) || '0');
      const result = await tokenService.getOperationHistory(param(req, 'id'), limit, offset);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ======================== COMPLIANCE ========================
  app.post('/api/v1/tokens/:id/restrictions', async (req: Request, res: Response) => {
    try {
      const { restrictionType, config } = req.body;
      if (!restrictionType || !config) {
        return res.status(400).json({ error: 'restrictionType and config are required' });
      }
      const id = await complianceService.addRestriction({
        tokenId: param(req, 'id'), restrictionType, config,
      });
      res.status(201).json({ restrictionId: id });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.get('/api/v1/tokens/:id/restrictions', async (req: Request, res: Response) => {
    try {
      const restrictions = await complianceService.getRestrictions(param(req, 'id'));
      res.json({ restrictions });
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.delete('/api/v1/tokens/:tokenId/restrictions/:restrictionId', async (req: Request, res: Response) => {
    try {
      await complianceService.removeRestriction(param(req, 'restrictionId'));
      res.json({ status: 'removed' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/v1/tokens/:id/whitelist', async (req: Request, res: Response) => {
    try {
      const { address, validFrom, validUntil } = req.body;
      if (!address) return res.status(400).json({ error: 'address is required' });
      const id = await complianceService.addWhitelistEntry({
        tokenId: param(req, 'id'), address,
        validFrom: validFrom ? new Date(validFrom) : undefined,
        validUntil: validUntil ? new Date(validUntil) : undefined,
      });
      res.status(201).json({ whitelistEntryId: id });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.delete('/api/v1/tokens/:tokenId/whitelist/:address', async (req: Request, res: Response) => {
    try {
      await complianceService.removeWhitelistEntry(param(req, 'tokenId'), param(req, 'address'));
      res.json({ status: 'removed' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.get('/api/v1/tokens/:id/whitelist', async (req: Request, res: Response) => {
    try {
      const entries = await complianceService.getWhitelistEntries(param(req, 'id'));
      res.json({ entries });
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/v1/tokens/:id/compliance-check', async (req: Request, res: Response) => {
    try {
      const { fromAccountId, toAccountId, amount } = req.body;
      if (!amount) return res.status(400).json({ error: 'amount is required' });
      const result = await complianceService.checkCompliance(
        param(req, 'id'),
        fromAccountId || null,
        toAccountId || null,
        BigInt(amount),
      );
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  // ======================== CORPORATE ACTIONS ========================
  app.post('/api/v1/tokens/:id/actions', async (req: Request, res: Response) => {
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.get('/api/v1/tokens/:id/actions', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(String(req.query.limit) || '50');
      const offset = parseInt(String(req.query.offset) || '0');
      const result = await corporateActionsService.listActions(param(req, 'id'), limit, offset);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/v1/actions/:id', async (req: Request, res: Response) => {
    const action = await corporateActionsService.getAction(param(req, 'id'));
    if (!action) return res.status(404).json({ error: 'Corporate action not found' });
    res.json(action);
  });

  app.post('/api/v1/actions/:id/set-record', async (req: Request, res: Response) => {
    try {
      const holderCount = await corporateActionsService.setRecordDate(param(req, 'id'));
      res.json({ status: 'record_set', holdersSnapshot: holderCount });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/v1/actions/:id/process', async (req: Request, res: Response) => {
    try {
      const processed = await corporateActionsService.processDistributions(param(req, 'id'));
      res.json({ status: 'completed', processed });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/v1/actions/:id/vote', async (req: Request, res: Response) => {
    try {
      const { accountId, voteChoice } = req.body;
      if (!accountId || !voteChoice) {
        return res.status(400).json({ error: 'accountId and voteChoice are required' });
      }
      await corporateActionsService.castVote({
        actionId: param(req, 'id'), accountId, voteChoice,
      });
      res.json({ status: 'voted' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.get('/api/v1/actions/:id/results', async (req: Request, res: Response) => {
    try {
      const results = await corporateActionsService.getActionResults(param(req, 'id'));
      res.json(results);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/v1/actions/:id/cancel', async (req: Request, res: Response) => {
    try {
      await corporateActionsService.cancelAction(param(req, 'id'));
      res.json({ status: 'cancelled' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  // ======================== INSTITUTIONAL CONTROLS ========================
  app.use('/api/v1/institutional', createInstitutionalRoutes());

  // ======================== AUTH / IAM ========================
  app.use('/api/v1/auth', createAuthRoutes());

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error(err, 'Unhandled API error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
