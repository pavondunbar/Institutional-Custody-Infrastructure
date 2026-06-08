// --- Mocks ---
const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockClient = { query: jest.fn(), release: jest.fn() };
jest.mock('../database/connection', () => ({
  db: { query: (...args: unknown[]) => mockQuery(...args), connect: () => mockConnect() },
  withSerializableTransaction: async (fn: (client: typeof mockClient) => unknown) => {
    return fn(mockClient);
  },
}));

const mockRedis = { get: jest.fn(), setex: jest.fn(), incr: jest.fn(), expire: jest.fn(), exists: jest.fn(), lpush: jest.fn(), ltrim: jest.fn(), lrange: jest.fn(), lindex: jest.fn(), hset: jest.fn(), hgetall: jest.fn(), sadd: jest.fn(), smembers: jest.fn(), info: jest.fn() };
jest.mock('../cache/redis', () => ({ redis: mockRedis }));
jest.mock('../config', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }, config: {} }));
jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }));

import { KeyManagementService } from '../key-management/key-service';
import { SettlementService } from '../settlement/settlement-service';
import { TreasuryService } from '../treasury/treasury-service';
import { MonitoringService } from '../monitoring/monitoring-service';
import { TrustDomainService } from '../trust-domains/trust-domain-service';
import { AssetLifecycleService } from '../asset-lifecycle/asset-lifecycle-service';
import { VendorRiskService } from '../vendor/vendor-risk-service';
import { PrivacyService } from '../privacy/privacy-service';
import { InfrastructureService } from '../infrastructure/infrastructure-service';

describe('KeyManagementService', () => {
  let service: KeyManagementService;
  beforeEach(() => { jest.clearAllMocks(); service = new KeyManagementService(); });

  it('registers a key with metadata', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'k1', key_id: 'key_abc', key_type: 'signing', algorithm: 'secp256k1', provider: 'hsm', status: 'active', version: 1, geographic_locations: ['us-east-1'] }] });

    const key = await service.registerKey({ keyType: 'signing', algorithm: 'secp256k1', provider: 'hsm', geographicLocations: ['us-east-1'] });
    expect(key.provider).toBe('hsm');
    expect(key.status).toBe('active');
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO key_metadata'), expect.any(Array));
  });

  it('rotates a key and initiates ceremony', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'k1', key_id: 'key_abc', key_type: 'signing', algorithm: 'secp256k1', provider: 'mpc', status: 'active', version: 2, shard_threshold: 3, geographic_locations: [] }] });
    mockQuery.mockResolvedValueOnce({}); // UPDATE status
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'ceremony-1' }] }); // INSERT ceremony

    const result = await service.rotateKey('key_abc', 'user-1');
    expect(result.newVersion).toBe(3);
    expect(result.ceremonyId).toBe('ceremony-1');
  });

  it('signs with a key', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'k1', key_id: 'key_abc', key_type: 'signing', algorithm: 'secp256k1', provider: 'hsm', status: 'active', version: 1, geographic_locations: [] }] });
    mockQuery.mockResolvedValueOnce({}); // UPDATE last_used_at

    const result = await service.sign({ keyId: 'key_abc', payload: Buffer.from('deadbeef', 'hex') });
    expect(result.signature).toBeInstanceOf(Buffer);
    expect(result.provider).toBe('hsm');
  });

  it('rejects signing with inactive key', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'k1', key_id: 'key_abc', key_type: 'signing', algorithm: 'secp256k1', provider: 'hsm', status: 'deprecated', version: 1, geographic_locations: [] }] });
    await expect(service.sign({ keyId: 'key_abc', payload: Buffer.from('aa', 'hex') })).rejects.toThrow('Key not active');
  });
});

describe('SettlementService', () => {
  let service: SettlementService;
  beforeEach(() => { jest.clearAllMocks(); service = new SettlementService(); });

  it('creates a DvP settlement instruction', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 's1', settlement_type: 'dvp', leg_a_account_id: 'a1', leg_a_asset: 'ETH', leg_a_amount: '1000', leg_a_direction: 'deliver', leg_b_account_id: 'a2', leg_b_asset: 'USD', leg_b_amount: '500000', leg_b_direction: 'receive', settlement_date: '2024-01-01', settlement_cycle: 'T+0', status: 'pending' }] });

    const instr = await service.createInstruction({
      settlementType: 'dvp',
      legA: { accountId: 'a1', asset: 'ETH', amount: BigInt(1000), direction: 'deliver' },
      legB: { accountId: 'a2', asset: 'USD', amount: BigInt(500000), direction: 'receive' },
      settlementDate: new Date('2024-01-01'),
    });
    expect(instr.settlementType).toBe('dvp');
    expect(instr.legA.direction).toBe('deliver');
  });

  it('executes atomic settlement', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ id: 's1', settlement_type: 'dvp', leg_a_account_id: 'a1', leg_a_asset: 'ETH', leg_a_amount: '1000', leg_a_direction: 'deliver', leg_b_account_id: 'a2', leg_b_asset: 'USD', leg_b_amount: '500000', leg_b_direction: 'receive' }] })
      .mockResolvedValue({});

    await expect(service.executeSettlement('s1')).resolves.toBeUndefined();
    expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO journal_entries'), expect.any(Array));
  });
});

describe('TreasuryService', () => {
  let service: TreasuryService;
  beforeEach(() => { jest.clearAllMocks(); service = new TreasuryService(); });

  it('creates a portfolio', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'p1', name: 'Main', strategy: 'balanced', target_allocations: { ETH: 60, BTC: 40 }, actual_allocations: {}, total_value: '0', rebalance_threshold_bps: 500, status: 'active' }] });

    const p = await service.createPortfolio({ name: 'Main', strategy: 'balanced', targetAllocations: { ETH: 60, BTC: 40 } });
    expect(p.strategy).toBe('balanced');
  });

  it('generates proof of reserves', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ current_value: '1000000' }] }); // positions
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '900000' }] }); // liabilities

    const proof = await service.generateProofOfReserves('p1');
    expect(proof.verified).toBe(true);
    expect(proof.ratio).toBeGreaterThanOrEqual(1);
  });
});

describe('MonitoringService', () => {
  let service: MonitoringService;
  beforeEach(() => { jest.clearAllMocks(); service = new MonitoringService(); });

  it('detects anomaly using z-score', async () => {
    const normalValues = Array.from({ length: 20 }, (_, i) => JSON.stringify({ value: 100 + (i % 5), ts: Date.now() }));
    mockRedis.lrange.mockResolvedValueOnce(normalValues);

    const isAnomaly = await service.detectAnomaly('test_metric', 500, 3);
    expect(isAnomaly).toBe(true);
  });

  it('does not flag normal values as anomaly', async () => {
    const normalValues = Array.from({ length: 20 }, (_, i) => JSON.stringify({ value: 100 + i, ts: Date.now() }));
    mockRedis.lrange.mockResolvedValueOnce(normalValues);

    const isAnomaly = await service.detectAnomaly('test_metric', 110, 3);
    expect(isAnomaly).toBe(false);
  });

  it('monitors transaction for suspicious patterns', async () => {
    mockRedis.incr.mockResolvedValueOnce(51);
    mockRedis.expire.mockResolvedValueOnce(1);
    mockRedis.exists.mockResolvedValueOnce(0);
    mockRedis.setex.mockResolvedValueOnce('OK');

    const result = await service.monitorTransaction({
      txId: 'tx1', fromAddress: '0xabc', toAddress: '0xdef',
      amount: BigInt('2000000000000000000000'), chain: 'ethereum',
    });
    expect(result.suspicious).toBe(true);
    expect(result.reasons).toContain('high_velocity');
    expect(result.reasons).toContain('large_transaction');
    expect(result.reasons).toContain('new_destination');
  });
});

describe('VendorRiskService', () => {
  let service: VendorRiskService;
  beforeEach(() => { jest.clearAllMocks(); service = new VendorRiskService(); });

  it('registers a vendor with correct assessment schedule', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1', name: 'CloudHSM', vendor_type: 'kms_provider', risk_tier: 'critical', status: 'active' }] });

    const vendor = await service.registerVendor({ name: 'CloudHSM', vendorType: 'kms_provider', riskTier: 'critical' });
    expect(vendor.vendorType).toBe('kms_provider');
    expect(vendor.riskTier).toBe('critical');
  });

  it('detects SLA breach', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'sla1', vendor_id: 'v1', metric_name: 'uptime', target_value: 99.9, actual_value: 98.5, in_compliance: false, breach_count: 1 }] });

    const metric = await service.recordSLAMetric({
      vendorId: 'v1', metricName: 'uptime', targetValue: 99.9, actualValue: 98.5,
      periodStart: new Date(), periodEnd: new Date(),
    });
    expect(metric.inCompliance).toBe(false);
    expect(metric.breachCount).toBe(1);
  });
});

describe('PrivacyService', () => {
  let service: PrivacyService;
  beforeEach(() => { jest.clearAllMocks(); service = new PrivacyService(); });

  it('generates ZK balance proof', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '1000000' }] });

    const proof = await service.generateBalanceProof({ accountId: 'a1', threshold: BigInt(500000) });
    expect(proof.verified).toBe(true);
    expect(proof.commitment).toBeDefined();
    expect(proof.proof).toBeDefined();
  });

  it('fails ZK proof when balance below threshold', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '100' }] });

    const proof = await service.generateBalanceProof({ accountId: 'a1', threshold: BigInt(500000) });
    expect(proof.verified).toBe(false);
  });
});

describe('InfrastructureService', () => {
  let service: InfrastructureService;
  beforeEach(() => { jest.clearAllMocks(); service = new InfrastructureService(); });

  it('registers an infrastructure node', async () => {
    mockRedis.hset.mockResolvedValueOnce(1);
    mockRedis.sadd.mockResolvedValueOnce(1);

    await expect(service.registerNode({ name: 'rpc-1', component: 'rpc_node', endpoint: 'http://localhost:8545', region: 'us-east-1' })).resolves.toBeUndefined();
    expect(mockRedis.hset).toHaveBeenCalledWith('infra:node:rpc-1', expect.objectContaining({ component: 'rpc_node' }));
  });

  it('gets healthy node with round robin', async () => {
    mockRedis.smembers.mockResolvedValueOnce(['rpc-1', 'rpc-2']);
    mockRedis.hgetall.mockResolvedValueOnce({ status: 'healthy', latencyMs: '50', weight: '1' });
    mockRedis.hgetall.mockResolvedValueOnce({ status: 'healthy', latencyMs: '100', weight: '1' });

    const node = await service.getHealthyNode('rpc_node', 'round_robin');
    expect(node).toBeDefined();
    expect(['rpc-1', 'rpc-2']).toContain(node);
  });

  it('returns null when no healthy nodes', async () => {
    mockRedis.smembers.mockResolvedValueOnce(['rpc-1']);
    mockRedis.hgetall.mockResolvedValueOnce({ status: 'offline', latencyMs: '0', weight: '1' });

    const node = await service.getHealthyNode('rpc_node');
    expect(node).toBeNull();
  });
});

describe('TrustDomainService', () => {
  let service: TrustDomainService;
  beforeEach(() => { jest.clearAllMocks(); service = new TrustDomainService(); });

  it('creates a trust domain', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'td1', name: 'Custody', isolation_level: 'full', status: 'active' }] });

    const domain = await service.createDomain({ name: 'Custody', isolationLevel: 'full' });
    expect(domain.name).toBe('Custody');
    expect(domain.isolationLevel).toBe('full');
  });
});

describe('AssetLifecycleService', () => {
  let service: AssetLifecycleService;
  beforeEach(() => { jest.clearAllMocks(); service = new AssetLifecycleService(); });

  it('issues new asset units', async () => {
    mockClient.query.mockResolvedValue({});

    const event = await service.issue({ assetId: 'asset-1', amount: BigInt(1000000), recipientAccountId: 'acc-1', reason: 'Initial issuance' });
    expect(event.eventType).toBe('issuance');
    expect(event.amount).toBe(BigInt(1000000));
    expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO asset_lifecycle_events'), expect.any(Array));
  });

  it('burns asset units', async () => {
    mockClient.query.mockResolvedValue({});

    const event = await service.burn({ assetId: 'asset-1', amount: BigInt(500), fromAccountId: 'acc-1', reason: 'Redemption' });
    expect(event.eventType).toBe('burning');
    expect(event.amount).toBe(BigInt(500));
  });
});
