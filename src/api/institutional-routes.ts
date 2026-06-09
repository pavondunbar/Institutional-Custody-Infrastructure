import { Router, Request, Response } from 'express';
import { KeyManagementService } from '../key-management/key-service';
import { SettlementService } from '../settlement/settlement-service';
import { TreasuryService } from '../treasury/treasury-service';
import { MonitoringService } from '../monitoring/monitoring-service';
import { TrustDomainService } from '../trust-domains/trust-domain-service';
import { AssetLifecycleService } from '../asset-lifecycle/asset-lifecycle-service';
import { VendorRiskService } from '../vendor/vendor-risk-service';
import { PrivacyService } from '../privacy/privacy-service';
import { InfrastructureService } from '../infrastructure/infrastructure-service';
import { ApprovalService } from '../governance/approval-service';
import { AmlService } from '../compliance/aml-service';
import { RiskService } from '../risk/risk-service';
import { KillSwitchService } from '../risk/circuit-breaker';
import { DLQService } from '../messaging/dlq-service';
import { PriceOracleService } from '../oracle/price-oracle-service';
import { LendingService } from '../lending/lending-service';
import { FXService } from '../fx/fx-service';
import { CryptoCustodyService } from '../custody/crypto-custody-service';
import { RwaTokenizationService } from '../rwa/rwa-tokenization-service';
import { DvpSettlementService } from '../settlement/dvp-settlement-service';
import { CcpClearinghouseService } from '../clearing/ccp-clearinghouse-service';
import { LendingExtensionsService } from '../lending/lending-extensions-service';
import { StablecoinService } from '../stablecoin/stablecoin-service';
import { PermissionedDefiService } from '../defi/permissioned-defi-service';
import { OnchainComplianceService } from '../compliance/onchain-compliance-service';
import { TokenizedFundNavService } from '../fund/tokenized-fund-service';
import { DigitalBondService } from '../bond/digital-bond-service';
import { BitcoinEtfService } from '../etf/bitcoin-etf-service';
import { UnbankedInfraService } from '../unbanked/unbanked-infra-service';
import { logger } from '../config';

function param(req: Request, name: string): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : val;
}

export function createInstitutionalRoutes(): Router {
  const router = Router();

  const keyService = new KeyManagementService();
  const settlementService = new SettlementService();
  const treasuryService = new TreasuryService();
  const monitoringService = new MonitoringService();
  const trustDomainService = new TrustDomainService();
  const assetLifecycleService = new AssetLifecycleService();
  const vendorService = new VendorRiskService();
  const privacyService = new PrivacyService();
  const infraService = new InfrastructureService();
  const approvalService = new ApprovalService();
  const amlService = new AmlService();
  const riskService = new RiskService();
  const killSwitchService = new KillSwitchService();
  const dlqService = new DLQService();
  const oracleService = new PriceOracleService();
  const lendingService = new LendingService();
  const fxService = new FXService();

  // ======================== KEY MANAGEMENT ========================
  router.post('/keys', async (req: Request, res: Response) => {
    try {
      const key = await keyService.registerKey(req.body);
      res.status(201).json(key);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/keys/:keyId/rotate', async (req: Request, res: Response) => {
    try {
      const result = await keyService.rotateKey(param(req, 'keyId'), req.body.initiatedBy);
      res.json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/keys/:keyId/sign', async (req: Request, res: Response) => {
    try {
      const result = await keyService.sign({ keyId: param(req, 'keyId'), payload: Buffer.from(req.body.payload, 'hex') });
      res.json({ signature: result.signature.toString('hex'), keyVersion: result.keyVersion, provider: result.provider });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.get('/keys/rotation-needed', async (_req: Request, res: Response) => {
    try {
      const keys = await keyService.getKeysNeedingRotation();
      res.json({ keys });
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ======================== SETTLEMENT ========================
  router.post('/settlements', async (req: Request, res: Response) => {
    try {
      const { settlementType, legA, legB, settlementDate, settlementCycle, counterpartyRef } = req.body;
      const instruction = await settlementService.createInstruction({
        settlementType,
        legA: { ...legA, amount: BigInt(legA.amount) },
        legB: legB ? { ...legB, amount: BigInt(legB.amount) } : undefined,
        settlementDate: new Date(settlementDate),
        settlementCycle,
        counterpartyRef,
      });
      res.status(201).json({ ...instruction, legA: { ...instruction.legA, amount: instruction.legA.amount.toString() }, legB: instruction.legB ? { ...instruction.legB, amount: instruction.legB.amount.toString() } : undefined });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/settlements/:id/execute', async (req: Request, res: Response) => {
    try {
      await settlementService.executeSettlement(param(req, 'id'));
      res.json({ status: 'settled' });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/settlements/netting', async (req: Request, res: Response) => {
    try {
      const { asset, date } = req.body;
      const result = await settlementService.calculateNetting(asset, new Date(date));
      res.json({ ...result, grossAmount: result.grossAmount.toString(), netAmount: result.netAmount.toString() });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.get('/settlements/pending', async (_req: Request, res: Response) => {
    try {
      const settlements = await settlementService.getPendingSettlements();
      res.json({ settlements: settlements.map(s => ({ ...s, legA: { ...s.legA, amount: s.legA.amount.toString() }, legB: s.legB ? { ...s.legB, amount: s.legB.amount.toString() } : undefined })) });
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ======================== TREASURY ========================
  router.post('/treasury/portfolios', async (req: Request, res: Response) => {
    try {
      const portfolio = await treasuryService.createPortfolio(req.body);
      res.status(201).json({ ...portfolio, totalValue: portfolio.totalValue.toString() });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.get('/treasury/portfolios/:id/nav', async (req: Request, res: Response) => {
    try {
      const nav = await treasuryService.calculateNAV(param(req, 'id'));
      res.json({ totalValue: nav.totalValue.toString(), positions: nav.positions.map(p => ({ ...p, value: p.value.toString() })) });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.get('/treasury/portfolios/:id/rebalance', async (req: Request, res: Response) => {
    try {
      const actions = await treasuryService.calculateRebalance(param(req, 'id'));
      res.json({ actions: actions.map(a => ({ ...a, amount: a.amount.toString() })) });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.get('/treasury/portfolios/:id/proof-of-reserves', async (req: Request, res: Response) => {
    try {
      const proof = await treasuryService.generateProofOfReserves(param(req, 'id'));
      res.json({ ...proof, totalReserves: proof.totalReserves.toString(), totalLiabilities: proof.totalLiabilities.toString() });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  // ======================== MONITORING & ALERTING ========================
  router.post('/monitoring/rules', async (req: Request, res: Response) => {
    try {
      const rule = await monitoringService.createAlertRule(req.body);
      res.status(201).json(rule);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/monitoring/evaluate', async (_req: Request, res: Response) => {
    try {
      const fired = await monitoringService.evaluateRules();
      res.json({ alertsFired: fired.length, alerts: fired });
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/monitoring/alerts', async (req: Request, res: Response) => {
    try {
      const severity = req.query.severity as string | undefined;
      const alerts = await monitoringService.getUnresolvedAlerts(severity as 'low' | 'medium' | 'high' | 'critical' | undefined);
      res.json({ alerts });
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/monitoring/alerts/:id/acknowledge', async (req: Request, res: Response) => {
    try {
      await monitoringService.acknowledgeAlert(param(req, 'id'), req.body.userId);
      res.json({ status: 'acknowledged' });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.get('/monitoring/siem-export', async (req: Request, res: Response) => {
    try {
      const since = req.query.since ? new Date(String(req.query.since)) : new Date(Date.now() - 86400000);
      const events = await monitoringService.exportSIEMEvents(since);
      res.json({ events });
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ======================== TRUST DOMAINS ========================
  router.post('/trust-domains', async (req: Request, res: Response) => {
    try {
      const domain = await trustDomainService.createDomain(req.body);
      res.status(201).json(domain);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.get('/trust-domains', async (_req: Request, res: Response) => {
    try {
      const domains = await trustDomainService.listDomains();
      res.json({ domains });
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/trust-domains/policies', async (req: Request, res: Response) => {
    try {
      const { sourceDomainId, targetDomainId, trustLevel, allowedOperations, requiresApproval, maxAmount } = req.body;
      const policy = await trustDomainService.createCrossDomainPolicy({
        sourceDomainId, targetDomainId, trustLevel, allowedOperations, requiresApproval,
        maxAmount: maxAmount ? BigInt(maxAmount) : undefined,
      });
      res.status(201).json({ ...policy, maxAmount: policy.maxAmount?.toString() });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/trust-domains/authorize', async (req: Request, res: Response) => {
    try {
      const { sourceDomainId, targetDomainId, operation, amount } = req.body;
      const result = await trustDomainService.authorizeCrossDomainOperation({
        sourceDomainId, targetDomainId, operation, amount: amount ? BigInt(amount) : undefined,
      });
      res.json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  // ======================== ASSET LIFECYCLE ========================
  router.post('/asset-lifecycle/issue', async (req: Request, res: Response) => {
    try {
      const { assetId, amount, recipientAccountId, reason } = req.body;
      const event = await assetLifecycleService.issue({ assetId, amount: BigInt(amount), recipientAccountId, reason });
      res.status(201).json({ ...event, amount: event.amount.toString() });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/asset-lifecycle/burn', async (req: Request, res: Response) => {
    try {
      const { assetId, amount, fromAccountId, reason } = req.body;
      const event = await assetLifecycleService.burn({ assetId, amount: BigInt(amount), fromAccountId, reason });
      res.json({ ...event, amount: event.amount.toString() });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/asset-lifecycle/dividend', async (req: Request, res: Response) => {
    try {
      const { assetId, totalAmount, sourceAccountId, recordDate } = req.body;
      const result = await assetLifecycleService.distributeDividend({
        assetId, totalAmount: BigInt(totalAmount), sourceAccountId, recordDate: new Date(recordDate),
      });
      res.json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.get('/asset-lifecycle/:assetId/history', async (req: Request, res: Response) => {
    try {
      const history = await assetLifecycleService.getLifecycleHistory(param(req, 'assetId'));
      res.json({ events: history.map(e => ({ ...e, amount: e.amount.toString() })) });
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ======================== GOVERNANCE ========================
  router.post('/governance/policies', async (req: Request, res: Response) => {
    try {
      const policy = await approvalService.createPolicy(req.body);
      res.status(201).json(policy);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/governance/requests', async (req: Request, res: Response) => {
    try {
      const request = await approvalService.submitForApproval(req.body);
      res.status(201).json(request);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/governance/requests/:id/approve', async (req: Request, res: Response) => {
    try {
      const result = await approvalService.approve(param(req, 'id'), req.body.approverId, req.body.reason);
      res.json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/governance/requests/:id/reject', async (req: Request, res: Response) => {
    try {
      await approvalService.reject(param(req, 'id'), req.body.approverId, req.body.reason);
      res.json({ status: 'rejected' });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  // ======================== COMPLIANCE ========================
  router.post('/compliance/screen', async (req: Request, res: Response) => {
    try {
      const { name, address } = req.body;
      if (address) {
        const result = await amlService.screenAddress(address);
        return res.json(result);
      }
      const result = await amlService.screenEntity(name);
      res.json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/compliance/travel-rule', async (req: Request, res: Response) => {
    try {
      const { direction, transactionId, originatorName, originatorAccount, originatorAddress, originatorInstitution, beneficiaryName, beneficiaryAccount, beneficiaryAddress, beneficiaryInstitution, amount, currency } = req.body;
      const id = await amlService.createTravelRuleMessage({
        direction, transactionId, originatorName, originatorAccount, originatorAddress, originatorInstitution,
        beneficiaryName, beneficiaryAccount, beneficiaryAddress, beneficiaryInstitution,
        amount: BigInt(amount), currency,
      });
      res.status(201).json({ id });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/compliance/sar', async (req: Request, res: Response) => {
    try {
      const { subjectType, subjectId, description, amount, currency, indicators, relatedTransactions, filedBy, jurisdiction } = req.body;
      const id = await amlService.fileSar({
        subjectType, subjectId, description,
        amount: amount ? BigInt(amount) : undefined,
        currency, indicators, relatedTransactions, filedBy, jurisdiction,
      });
      res.status(201).json({ id });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  // ======================== RISK MANAGEMENT ========================
  router.post('/risk/check', async (req: Request, res: Response) => {
    try {
      const { accountId, amount, direction, tokenId, counterpartyId } = req.body;
      const result = await riskService.evaluateTransaction({ accountId, amount: BigInt(amount), direction, tokenId, counterpartyId });
      res.json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/risk/kill-switch', async (req: Request, res: Response) => {
    try {
      const { feature, activate, reason, userId } = req.body;
      if (activate) {
        await killSwitchService.activate(feature, userId, reason);
      } else {
        await killSwitchService.deactivate(feature);
      }
      res.json({ status: activate ? 'activated' : 'deactivated', feature });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  // ======================== VENDOR RISK ========================
  router.post('/vendors', async (req: Request, res: Response) => {
    try {
      const vendor = await vendorService.registerVendor(req.body);
      res.status(201).json(vendor);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/vendors/:id/assessments', async (req: Request, res: Response) => {
    try {
      const assessment = await vendorService.conductAssessment({ vendorId: param(req, 'id'), ...req.body });
      res.status(201).json(assessment);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/vendors/:id/sla-metrics', async (req: Request, res: Response) => {
    try {
      const { metricName, targetValue, actualValue, periodStart, periodEnd } = req.body;
      const metric = await vendorService.recordSLAMetric({
        vendorId: param(req, 'id'), metricName, targetValue, actualValue,
        periodStart: new Date(periodStart), periodEnd: new Date(periodEnd),
      });
      res.status(201).json(metric);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.get('/vendors/needs-assessment', async (_req: Request, res: Response) => {
    try {
      const vendors = await vendorService.getVendorsNeedingAssessment();
      res.json({ vendors });
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ======================== PRIVACY ========================
  router.post('/privacy/zk-proof/balance', async (req: Request, res: Response) => {
    try {
      const { accountId, threshold } = req.body;
      const proof = await privacyService.generateBalanceProof({ accountId, threshold: BigInt(threshold) });
      res.json(proof);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/privacy/selective-disclose', async (req: Request, res: Response) => {
    try {
      const result = await privacyService.selectiveDisclose(req.body);
      res.json({ disclosed: result });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/privacy/data-classification', async (req: Request, res: Response) => {
    try {
      const { tableName, columnName, classification, encryptionRequired, retentionDays } = req.body;
      await privacyService.classifyData(tableName, columnName, classification, encryptionRequired, retentionDays);
      res.json({ status: 'classified' });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/privacy/enforce-retention', async (_req: Request, res: Response) => {
    try {
      const result = await privacyService.enforceRetention();
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ======================== INFRASTRUCTURE ========================
  router.post('/infrastructure/nodes', async (req: Request, res: Response) => {
    try {
      await infraService.registerNode(req.body);
      res.status(201).json({ status: 'registered' });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.get('/infrastructure/nodes/:name/health', async (req: Request, res: Response) => {
    try {
      const health = await infraService.checkNodeHealth(param(req, 'name'));
      res.json(health);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.get('/infrastructure/capacity', async (_req: Request, res: Response) => {
    try {
      const metrics = await infraService.getCapacityMetrics();
      res.json(metrics);
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/infrastructure/failover', async (req: Request, res: Response) => {
    try {
      const { component, targetRegion } = req.body;
      const result = await infraService.failoverToRegion(component, targetRegion);
      res.json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  // ======================== DLQ ========================
  router.get('/dlq/stats', async (_req: Request, res: Response) => {
    try { res.json(await dlqService.getStats()); }
    catch (err: unknown) { res.status(500).json({ error: 'Internal error' }); }
  });

  router.get('/dlq/entries', async (req: Request, res: Response) => {
    try {
      const entries = await dlqService.getEntries(req.query.status as string | undefined, req.query.limit ? parseInt(String(req.query.limit)) : undefined);
      res.json({ entries });
    } catch (err: unknown) { res.status(500).json({ error: 'Internal error' }); }
  });

  router.post('/dlq/:id/reprocess', async (req: Request, res: Response) => {
    try { await dlqService.reprocess(param(req, 'id')); res.json({ status: 'reprocessed' }); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });

  // ======================== PRICE ORACLE ========================
  router.post('/oracle/quotes', async (req: Request, res: Response) => {
    try {
      const { source, pair, price, volume } = req.body;
      await oracleService.submitQuote({ source, pair, price, volume, timestamp: new Date() });
      res.status(201).json({ status: 'accepted' });
    } catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });

  router.get('/oracle/prices/:pair', async (req: Request, res: Response) => {
    try {
      const price = await oracleService.getPrice(param(req, 'pair'));
      res.json(price);
    } catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });

  router.get('/oracle/prices', async (_req: Request, res: Response) => {
    try { res.json({ prices: await oracleService.getAllPrices() }); }
    catch (err: unknown) { res.status(500).json({ error: 'Internal error' }); }
  });

  // ======================== LENDING ========================
  router.post('/lending/loans', async (req: Request, res: Response) => {
    try {
      const loan = await lendingService.originateLoan({ ...req.body, collateralAmount: BigInt(req.body.collateralAmount), loanAmount: BigInt(req.body.loanAmount) });
      res.status(201).json({ ...loan, collateralAmount: loan.collateralAmount.toString(), loanAmount: loan.loanAmount.toString(), accruedInterest: loan.accruedInterest.toString() });
    } catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });

  router.get('/lending/loans', async (req: Request, res: Response) => {
    try {
      const loans = await lendingService.getActiveLoans(req.query.borrowerId as string | undefined);
      res.json({ loans: loans.map(l => ({ ...l, collateralAmount: l.collateralAmount.toString(), loanAmount: l.loanAmount.toString(), accruedInterest: l.accruedInterest.toString() })) });
    } catch (err: unknown) { res.status(500).json({ error: 'Internal error' }); }
  });

  router.post('/lending/loans/:id/repay', async (req: Request, res: Response) => {
    try { await lendingService.repay(param(req, 'id'), BigInt(req.body.amount)); res.json({ status: 'repaid' }); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });

  router.post('/lending/monitor', async (req: Request, res: Response) => {
    try {
      const result = await lendingService.monitorPositions(req.body.prices);
      res.json(result);
    } catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });

  router.post('/lending/loans/:id/liquidate', async (req: Request, res: Response) => {
    try {
      const result = await lendingService.liquidate(param(req, 'id'), req.body.collateralPrice, req.body.loanAssetPrice);
      res.json({ ...result, collateralSeized: result.collateralSeized.toString(), debtRepaid: result.debtRepaid.toString(), surplusReturned: result.surplusReturned.toString() });
    } catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });

  // ======================== FX ========================
  router.post('/fx/rates', async (req: Request, res: Response) => {
    try { await fxService.submitRate(req.body); res.status(201).json({ status: 'accepted' }); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });

  router.get('/fx/rates/:pair', async (req: Request, res: Response) => {
    try {
      const rate = await fxService.getRate(param(req, 'pair'));
      if (!rate) return res.status(404).json({ error: 'Rate not found' });
      res.json(rate);
    } catch (err: unknown) { res.status(500).json({ error: 'Internal error' }); }
  });

  router.post('/fx/quote', async (req: Request, res: Response) => {
    try {
      const quote = await fxService.getQuote({ fromCurrency: req.body.fromCurrency, toCurrency: req.body.toCurrency, fromAmount: BigInt(req.body.fromAmount) });
      res.json({ ...quote, fromAmount: quote.fromAmount.toString(), toAmount: quote.toAmount.toString() });
    } catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });

  router.post('/fx/conversions/:id/execute', async (req: Request, res: Response) => {
    try {
      await fxService.executeConversion(param(req, 'id'), req.body.fromAccountId, req.body.toAccountId);
      res.json({ status: 'settled' });
    } catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });

  router.get('/fx/pairs', async (_req: Request, res: Response) => {
    try { res.json({ pairs: await fxService.getSupportedPairs() }); }
    catch (err: unknown) { res.status(500).json({ error: 'Internal error' }); }
  });

  // === Crypto Custody ===
  const custodyService = new CryptoCustodyService();
  router.post('/custody/multisig-policies', async (req: Request, res: Response) => {
    try { res.json(await custodyService.createMultiSigPolicy(req.body)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/custody/whitelist', async (req: Request, res: Response) => {
    try { res.json(await custodyService.addToWhitelist(req.body)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/custody/whitelist/:id/approve', async (req: Request, res: Response) => {
    try { await custodyService.approveWhitelistEntry(param(req, 'id'), req.body.approvedBy); res.json({ status: 'approved' }); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/custody/cold-storage/transfers', async (req: Request, res: Response) => {
    try { res.json(await custodyService.initiateColdStorageTransfer(req.body)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/custody/cold-storage/transfers/:id/sign', async (req: Request, res: Response) => {
    try { res.json(await custodyService.signColdStorageTransfer(param(req, 'id'), req.body.signerId)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });

  // === RWA Tokenization ===
  const rwaService = new RwaTokenizationService();
  router.post('/rwa/accreditations', async (req: Request, res: Response) => {
    try { res.json(await rwaService.submitAccreditation(req.body)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/rwa/accreditations/:id/verify', async (req: Request, res: Response) => {
    try { await rwaService.verifyAccreditation(param(req, 'id'), req.body.verifiedBy); res.json({ status: 'verified' }); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.get('/rwa/eligibility/:investorId/:assetId', async (req: Request, res: Response) => {
    try { res.json(await rwaService.checkInvestorEligibility(param(req, 'investorId'), param(req, 'assetId'))); }
    catch (err: unknown) { res.status(500).json({ error: 'Internal error' }); }
  });
  router.post('/rwa/verifications', async (req: Request, res: Response) => {
    try { res.json(await rwaService.submitAssetVerification(req.body)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });

  // === DvP Settlement Extensions ===
  const dvpService = new DvpSettlementService();
  router.post('/settlements/:id/partial', async (req: Request, res: Response) => {
    try { res.json(await dvpService.executePartialSettlement(param(req, 'id'), req.body.percentage)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/settlements/:id/buy-in', async (req: Request, res: Response) => {
    try { res.json(await dvpService.initiateFailureHandling(param(req, 'id'))); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/settlements/buy-ins/:id/execute', async (req: Request, res: Response) => {
    try { await dvpService.executeBuyIn(param(req, 'id'), req.body.marketPrice); res.json({ status: 'executed' }); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });

  // === CCP Clearinghouse ===
  const ccpService = new CcpClearinghouseService();
  router.post('/clearing/members', async (req: Request, res: Response) => {
    try { res.json(await ccpService.onboardMember(req.body)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/clearing/members/:id/margin', async (req: Request, res: Response) => {
    try { await ccpService.postMargin(param(req, 'id'), req.body.marginType, req.body.amount); res.json({ status: 'posted' }); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/clearing/members/:id/check-limit', async (req: Request, res: Response) => {
    try { res.json(await ccpService.checkPositionLimit(param(req, 'id'), req.body.additionalExposure)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/clearing/default-waterfall/:id', async (req: Request, res: Response) => {
    try { res.json(await ccpService.executeDefaultWaterfall(param(req, 'id'))); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/clearing/stress-test', async (req: Request, res: Response) => {
    try { res.json(await ccpService.runStressTest(req.body.scenarioName, req.body.shockPct)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });

  // === Lending Extensions ===
  const lendingExt = new LendingExtensionsService();
  router.get('/lending/haircuts', async (req: Request, res: Response) => {
    try { res.json(await lendingExt.getHaircutSchedule(req.query.asset as string)); }
    catch (err: unknown) { res.status(500).json({ error: 'Internal error' }); }
  });
  router.post('/lending/haircuts', async (req: Request, res: Response) => {
    try { await lendingExt.setHaircut(req.body.asset, req.body.haircutPct, req.body.volatilityTier); res.json({ status: 'set' }); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/lending/loans/:id/collateral', async (req: Request, res: Response) => {
    try { res.json(await lendingExt.addCollateralToBasket(param(req, 'id'), req.body.asset, req.body.amount)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/lending/loans/:id/partial-liquidate', async (req: Request, res: Response) => {
    try { res.json(await lendingExt.executePartialLiquidation(param(req, 'id'), req.body.percentage)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/lending/rate-curves', async (req: Request, res: Response) => {
    try { const id = await lendingExt.setInterestRateCurve(req.body); res.json({ id }); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/lending/syndications', async (req: Request, res: Response) => {
    try { res.json(await lendingExt.createSyndicatedLoan(req.body)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });

  // === Stablecoin ===
  const stablecoinService = new StablecoinService();
  router.post('/stablecoin/mint', async (req: Request, res: Response) => {
    try { res.json(await stablecoinService.requestMint(req.body)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/stablecoin/redeem', async (req: Request, res: Response) => {
    try { res.json(await stablecoinService.requestRedemption(req.body)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/stablecoin/operations/:id/process', async (req: Request, res: Response) => {
    try { await stablecoinService.processOperation(param(req, 'id')); res.json({ status: 'completed' }); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.get('/stablecoin/peg', async (_req: Request, res: Response) => {
    try { res.json(await stablecoinService.getPegStatus()); }
    catch (err: unknown) { res.status(500).json({ error: 'Internal error' }); }
  });
  router.post('/stablecoin/peg/update', async (req: Request, res: Response) => {
    try { res.json(await stablecoinService.updatePegPrice(req.body.currentPrice)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/stablecoin/yield/distribute', async (req: Request, res: Response) => {
    try { res.json(await stablecoinService.distributeYield({ ...req.body, periodStart: new Date(req.body.periodStart), periodEnd: new Date(req.body.periodEnd) })); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });

  // === Permissioned DeFi ===
  const defiService = new PermissionedDefiService();
  router.post('/defi/credentials', async (req: Request, res: Response) => {
    try { res.json(await defiService.issueCredential(req.body)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.get('/defi/credentials/:id/verify', async (req: Request, res: Response) => {
    try { res.json(await defiService.verifyCredential(param(req, 'id'))); }
    catch (err: unknown) { res.status(500).json({ error: 'Internal error' }); }
  });
  router.post('/defi/credentials/:id/revoke', async (req: Request, res: Response) => {
    try { await defiService.revokeCredential(param(req, 'id'), req.body.reason); res.json({ status: 'revoked' }); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/defi/pools/policies', async (req: Request, res: Response) => {
    try { res.json(await defiService.createPoolAccessPolicy(req.body)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.get('/defi/pools/:poolId/access/:holderId', async (req: Request, res: Response) => {
    try { res.json(await defiService.checkPoolAccess(param(req, 'holderId'), param(req, 'poolId'))); }
    catch (err: unknown) { res.status(500).json({ error: 'Internal error' }); }
  });

  // === Onchain Compliance ===
  const complianceExt = new OnchainComplianceService();
  router.post('/compliance/graph-analysis', async (req: Request, res: Response) => {
    try { res.json(await complianceExt.analyzeTransactionGraph(req.body.address, req.body.maxHops)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/compliance/jurisdiction-rules', async (req: Request, res: Response) => {
    try { res.json(await complianceExt.setJurisdictionRule(req.body)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/compliance/jurisdiction-check', async (req: Request, res: Response) => {
    try { res.json(await complianceExt.evaluateJurisdictionRules(req.body)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/compliance/reports', async (req: Request, res: Response) => {
    try { res.json(await complianceExt.generateRegulatoryReport({ ...req.body, periodStart: new Date(req.body.periodStart), periodEnd: new Date(req.body.periodEnd) })); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.get('/compliance/reports', async (req: Request, res: Response) => {
    try { res.json(await complianceExt.getReports(req.query.jurisdiction as string, req.query.status as string)); }
    catch (err: unknown) { res.status(500).json({ error: 'Internal error' }); }
  });

  // === Tokenized Fund NAV ===
  const fundService = new TokenizedFundNavService();
  router.post('/funds/windows', async (req: Request, res: Response) => {
    try { res.json(await fundService.createWindow({ ...req.body, opensAt: new Date(req.body.opensAt), closesAt: new Date(req.body.closesAt), settlementDate: new Date(req.body.settlementDate) })); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/funds/orders', async (req: Request, res: Response) => {
    try { res.json(await fundService.submitOrder(req.body)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/funds/windows/:id/settle', async (req: Request, res: Response) => {
    try { res.json(await fundService.settleWindow(param(req, 'id'), req.body.navPerShare)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/funds/performance-fee', async (req: Request, res: Response) => {
    try { res.json(await fundService.calculatePerformanceFee(req.body.fundId, new Date(req.body.periodEnd), req.body.hurdleRateBps, req.body.feeRateBps)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.get('/funds/:fundId/statements/:investorId', async (req: Request, res: Response) => {
    try { res.json(await fundService.generateInvestorStatement(param(req, 'investorId'), param(req, 'fundId'))); }
    catch (err: unknown) { res.status(500).json({ error: 'Internal error' }); }
  });

  // === Digital Bonds ===
  const bondService = new DigitalBondService();
  router.post('/bonds/terms', async (req: Request, res: Response) => {
    try { res.json(await bondService.createBondTerms({ ...req.body, issueDate: new Date(req.body.issueDate), maturityDate: new Date(req.body.maturityDate) })); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/bonds/:bondId/coupons/generate', async (req: Request, res: Response) => {
    try { res.json(await bondService.generateCouponSchedule(param(req, 'bondId'))); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/bonds/accrued-interest', async (req: Request, res: Response) => {
    try { res.json(bondService.calculateAccruedInterest({ ...req.body, lastCouponDate: new Date(req.body.lastCouponDate), settlementDate: new Date(req.body.settlementDate), nextCouponDate: new Date(req.body.nextCouponDate) })); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.get('/bonds/:bondId/call-provision', async (req: Request, res: Response) => {
    try { res.json(await bondService.evaluateCallProvision(param(req, 'bondId'), new Date())); }
    catch (err: unknown) { res.status(500).json({ error: 'Internal error' }); }
  });
  router.post('/bonds/:bondId/credit-event', async (req: Request, res: Response) => {
    try { await bondService.recordCreditEvent(param(req, 'bondId'), req.body.eventType, req.body.details || {}); res.json({ status: 'recorded' }); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });

  // === Bitcoin ETF ===
  const etfService = new BitcoinEtfService();
  router.post('/etf/utxos', async (req: Request, res: Response) => {
    try { res.json(await etfService.registerUtxo(req.body)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.get('/etf/utxos', async (req: Request, res: Response) => {
    try { res.json(await etfService.getUtxoSet(parseInt(req.query.minConfirmations as string) || 6)); }
    catch (err: unknown) { res.status(500).json({ error: 'Internal error' }); }
  });
  router.post('/etf/baskets/creation', async (req: Request, res: Response) => {
    try { res.json(await etfService.submitCreationBasket(req.body.apId, req.body.btcAmount, req.body.navPerShare)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/etf/baskets/redemption', async (req: Request, res: Response) => {
    try { res.json(await etfService.submitRedemptionBasket(req.body.apId, req.body.sharesAmount, req.body.navPerShare)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/etf/baskets/:id/approve', async (req: Request, res: Response) => {
    try { await etfService.approveBasket(param(req, 'id'), req.body.approvedBy); res.json({ status: 'approved' }); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/etf/baskets/:id/settle', async (req: Request, res: Response) => {
    try { await etfService.settleBasket(param(req, 'id')); res.json({ status: 'settled' }); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/etf/inav', async (req: Request, res: Response) => {
    try { res.json(await etfService.calculateIntradayNav(req.body.fundId, req.body.btcPrice)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/etf/reconcile', async (req: Request, res: Response) => {
    try { res.json(await etfService.reconcileFundAccounting(req.body.fundId)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });

  // === Unbanked/Underbanked ===
  const unbankedService = new UnbankedInfraService();
  router.post('/unbanked/profiles', async (req: Request, res: Response) => {
    try { res.json(await unbankedService.createProfile(req.body.userId, req.body.phoneVerified)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/unbanked/verify', async (req: Request, res: Response) => {
    try { res.json(await unbankedService.submitVerification(req.body.userId, req.body.verificationType)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/unbanked/corridors', async (req: Request, res: Response) => {
    try { res.json(await unbankedService.createCorridor(req.body)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.post('/unbanked/remittances', async (req: Request, res: Response) => {
    try { res.json(await unbankedService.initiateRemittance(req.body)); }
    catch (err: unknown) { res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' }); }
  });
  router.get('/unbanked/balance/:userId', async (req: Request, res: Response) => {
    try { res.set('Content-Type', 'text/plain').send(await unbankedService.getBalanceUssd(param(req, 'userId'))); }
    catch (err: unknown) { res.status(500).send('ERR'); }
  });

  return router;
}
