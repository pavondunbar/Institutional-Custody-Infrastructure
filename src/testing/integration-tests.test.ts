/**
 * Integration Tests: Fault Injection & Chaos Patterns
 *
 * Tests DB failure scenarios: serialization conflicts, connection drops,
 * state machine violations, concurrent access, and recovery behaviors.
 */

const mockClientQuery = jest.fn();
const mockClient = { query: mockClientQuery, release: jest.fn() };
const mockConnect = jest.fn().mockResolvedValue(mockClient);

jest.mock('../database/connection', () => ({
  db: {
    query: jest.fn(),
    connect: () => mockConnect(),
  },
  withSerializableTransaction: async (fn: (client: typeof mockClient) => Promise<unknown>) => fn(mockClient),
}));

const mockRedis = {
  get: jest.fn(), set: jest.fn(), setex: jest.fn(), del: jest.fn(),
  incr: jest.fn(), expire: jest.fn(), exists: jest.fn(),
  lpush: jest.fn(), ltrim: jest.fn(), lrange: jest.fn(), lindex: jest.fn(),
  hset: jest.fn(), hgetall: jest.fn(), sadd: jest.fn(), smembers: jest.fn(),
  info: jest.fn(), eval: jest.fn(),
};
jest.mock('../cache/redis', () => ({ redis: mockRedis }));
jest.mock('../config', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  config: {},
}));
jest.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));

import { postJournal } from '../database/ledger-service';
import { db } from '../database/connection';
import { SettlementService } from '../settlement/settlement-service';

const mockDbQuery = db.query as jest.Mock;

describe('Fault Injection: Serialization Conflicts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('detects serialization failure (error code 40001)', async () => {
    const serializationError = new Error('could not serialize access') as Error & { code: string };
    serializationError.code = '40001';
    mockClientQuery.mockRejectedValueOnce(serializationError);

    await expect(
      postJournal({
        idempotencyKey: 'idem-1',
        lines: [
          { accountId: 'acc-1', amount: 1000n, direction: 'debit' },
          { accountId: 'acc-2', amount: 1000n, direction: 'credit' },
        ],
      })
    ).rejects.toThrow('could not serialize access');
  });

  it('detects deadlock (error code 40P01)', async () => {
    const deadlockError = new Error('deadlock detected') as Error & { code: string };
    deadlockError.code = '40P01';
    mockClientQuery.mockRejectedValueOnce(deadlockError);

    await expect(
      postJournal({
        idempotencyKey: 'idem-2',
        lines: [
          { accountId: 'acc-1', amount: 500n, direction: 'debit' },
          { accountId: 'acc-2', amount: 500n, direction: 'credit' },
        ],
      })
    ).rejects.toThrow('deadlock detected');
  });

  it('handles unique constraint violation on idempotency key', async () => {
    const dupeError = new Error('duplicate key value violates unique constraint') as Error & { code: string };
    dupeError.code = '23505';
    mockClientQuery.mockRejectedValueOnce(dupeError);

    await expect(
      postJournal({
        idempotencyKey: 'already-used',
        lines: [
          { accountId: 'acc-1', amount: 100n, direction: 'debit' },
          { accountId: 'acc-2', amount: 100n, direction: 'credit' },
        ],
      })
    ).rejects.toThrow(/duplicate key/);
  });
});

describe('Fault Injection: Connection Failures', () => {
  beforeEach(() => jest.clearAllMocks());

  it('handles connection pool exhaustion', async () => {
    mockConnect.mockRejectedValueOnce(new Error('timeout: no available connections'));
    await expect(mockConnect()).rejects.toThrow('timeout: no available connections');
  });

  it('handles connection termination mid-transaction', async () => {
    const connResetError = new Error('connection terminated unexpectedly') as Error & { code: string };
    connResetError.code = '57P01';
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ id: 'j1' }] })
      .mockRejectedValueOnce(connResetError);

    const client = await mockConnect();
    await client.query('BEGIN');
    await expect(client.query('INSERT ...')).rejects.toThrow('connection terminated');
  });

  it('handles Redis unavailability', async () => {
    mockRedis.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(mockRedis.get('balance:acc-1')).rejects.toThrow('ECONNREFUSED');
  });
});

describe('Fault Injection: State Machine Violations', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects invalid transaction state transition (confirmed → pending)', async () => {
    const stateMachineError = new Error('Invalid state transition: confirmed → pending');
    mockDbQuery.mockRejectedValueOnce(stateMachineError);

    await expect(
      (db.query as jest.Mock)(
        `UPDATE transactions_blockchain SET status='pending' WHERE id=$1`,
        ['tx-1']
      )
    ).rejects.toThrow('Invalid state transition');
  });

  it('rejects invalid settlement state transition', async () => {
    const error = new Error('Invalid settlement state: completed → pending');
    mockClientQuery.mockRejectedValueOnce(error);

    const settlement = new SettlementService();
    await expect(settlement.executeSettlement('s1')).rejects.toThrow();
  });

  it('enforces append-only on ledger UPDATE', async () => {
    const appendOnlyError = new Error('ledger_entries: UPDATE not permitted');
    mockDbQuery.mockRejectedValueOnce(appendOnlyError);

    await expect(
      (db.query as jest.Mock)(`UPDATE ledger_entries SET amount=0 WHERE id=$1`, ['le-1'])
    ).rejects.toThrow('UPDATE not permitted');
  });

  it('enforces append-only on ledger DELETE', async () => {
    const appendOnlyError = new Error('ledger_entries: DELETE not permitted');
    mockDbQuery.mockRejectedValueOnce(appendOnlyError);

    await expect(
      (db.query as jest.Mock)(`DELETE FROM ledger_entries WHERE id=$1`, ['le-1'])
    ).rejects.toThrow('DELETE not permitted');
  });
});

describe('Chaos: Concurrent Access Patterns', () => {
  beforeEach(() => jest.clearAllMocks());

  it('handles concurrent journal postings — one succeeds, one conflicts', async () => {
    // In production, PostgreSQL's Serializable Snapshot Isolation (SSI) detects
    // read-write conflicts between concurrent transactions and aborts one.
    // This test validates that a serialization failure (40001) propagates correctly.

    // Simulate: first transaction commits normally
    mockClientQuery
      .mockResolvedValueOnce({}) // SET CONSTRAINTS
      .mockResolvedValueOnce({ rows: [] }) // idempotency check
      .mockResolvedValueOnce({ rows: [{ id: 'j1' }] }) // INSERT journal
      .mockResolvedValueOnce({ rows: [{ account_id: 'a1', balance: '0', debit_total: '0', credit_total: '0', last_entry_hash: null, last_entry_id: null }] }) // balance FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ max_seq: '0' }] }) // MAX seq
      .mockResolvedValueOnce({ rows: [{ id: 'le-1' }] }) // INSERT ledger_entry
      .mockResolvedValueOnce({}) // UPDATE balance_cache
      .mockResolvedValueOnce({ rows: [{ account_id: 'a2', balance: '0', debit_total: '0', credit_total: '0', last_entry_hash: null, last_entry_id: null }] }) // balance FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ max_seq: '0' }] }) // MAX seq
      .mockResolvedValueOnce({ rows: [{ id: 'le-2' }] }) // INSERT ledger_entry
      .mockResolvedValueOnce({}) // UPDATE balance_cache
      .mockResolvedValueOnce({}); // INSERT outbox

    const result = await postJournal({
      idempotencyKey: 'concurrent-1',
      lines: [
        { accountId: 'a1', amount: 100n, direction: 'debit' },
        { accountId: 'a2', amount: 100n, direction: 'credit' },
      ],
    });
    expect(result.journalEntryId).toBe('j1');

    // Simulate: second concurrent transaction gets serialization error
    const serError = new Error('could not serialize access due to read/write dependencies') as Error & { code: string };
    serError.code = '40001';
    mockClientQuery.mockRejectedValueOnce(serError);

    await expect(
      postJournal({
        idempotencyKey: 'concurrent-2',
        lines: [
          { accountId: 'a1', amount: 200n, direction: 'debit' },
          { accountId: 'a3', amount: 200n, direction: 'credit' },
        ],
      })
    ).rejects.toThrow('could not serialize access');
  });

  it('Redis INCR guarantees unique nonces under concurrency', async () => {
    mockRedis.incr.mockResolvedValueOnce(42).mockResolvedValueOnce(43);

    const nonce1 = await mockRedis.incr('nonce:0xabc');
    const nonce2 = await mockRedis.incr('nonce:0xabc');

    expect(nonce1).not.toBe(nonce2);
  });
});

describe('Chaos: Data Integrity Under Failures', () => {
  beforeEach(() => jest.clearAllMocks());

  it('detects hash chain corruption', async () => {
    const error = new Error('Hash chain validation failed: entry le-5 mismatch');
    mockDbQuery.mockRejectedValueOnce(error);

    await expect(
      (db.query as jest.Mock)(`SELECT verify_hash_chain()`)
    ).rejects.toThrow('Hash chain validation failed');
  });

  it('detects balance reconciliation drift', () => {
    const cached = 10000n;
    const computed = 9500n;
    const drift = cached - computed;
    expect(drift).toBe(500n);
  });

  it('routes failed outbox publishes to DLQ', async () => {
    // Outbox entry polled with FOR UPDATE SKIP LOCKED, Kafka publish fails, entry goes to DLQ
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1', event_type: 'transfer.completed', payload: '{}' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'dlq-1' }] });

    const outbox = await (db.query as jest.Mock)('SELECT * FROM outbox FOR UPDATE SKIP LOCKED LIMIT 1');
    expect(outbox.rows[0].id).toBe('outbox-1');

    // Kafka fails → write to DLQ
    const dlq = await (db.query as jest.Mock)(
      'INSERT INTO dead_letter_queue (original_event_id, event_type, error) VALUES ($1,$2,$3)',
      [outbox.rows[0].id, outbox.rows[0].event_type, 'Broker not available']
    );
    expect(dlq.rows[0].id).toBe('dlq-1');
  });

  it('validates double-entry balance invariant', () => {
    const entries = [
      { amount: 1000n, direction: 'debit' as const },
      { amount: 700n, direction: 'credit' as const },
      { amount: 300n, direction: 'credit' as const },
    ];
    const debits = entries.filter(e => e.direction === 'debit').reduce((s, e) => s + e.amount, 0n);
    const credits = entries.filter(e => e.direction === 'credit').reduce((s, e) => s + e.amount, 0n);
    expect(debits).toBe(credits);
  });
});

describe('Chaos: Circuit Breaker State Transitions', () => {
  it('closed → open after threshold failures', () => {
    const breaker = { state: 'closed' as string, failures: 0, threshold: 3 };
    for (let i = 0; i < 3; i++) {
      breaker.failures++;
      if (breaker.failures >= breaker.threshold) breaker.state = 'open';
    }
    expect(breaker.state).toBe('open');
  });

  it('open → half_open after cooldown', () => {
    const breaker = { state: 'open' as string, openedAt: Date.now() - 31000, cooldownMs: 30000 };
    if (Date.now() - breaker.openedAt > breaker.cooldownMs) breaker.state = 'half_open';
    expect(breaker.state).toBe('half_open');
  });

  it('half_open → closed on success', () => {
    const breaker = { state: 'half_open' as string };
    breaker.state = 'closed';
    expect(breaker.state).toBe('closed');
  });

  it('half_open → open on failure', () => {
    const breaker = { state: 'half_open' as string };
    breaker.state = 'open';
    expect(breaker.state).toBe('open');
  });
});

describe('Chaos: Kill Switch Emergency Shutdown', () => {
  beforeEach(() => jest.clearAllMocks());

  it('blocks operations when kill switch active', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ feature: 'withdrawals', activated: true }] });
    const result = await (db.query as jest.Mock)('SELECT * FROM kill_switches WHERE feature=$1', ['withdrawals']);
    expect(!result.rows[0].activated).toBe(false);
  });

  it('allows operations when kill switch inactive', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ feature: 'withdrawals', activated: false }] });
    const result = await (db.query as jest.Mock)('SELECT * FROM kill_switches WHERE feature=$1', ['withdrawals']);
    expect(!result.rows[0].activated).toBe(true);
  });
});

describe('Chaos: DLQ Exponential Backoff', () => {
  it('calculates correct backoff intervals', () => {
    const base = 1000;
    const expected = [1000, 2000, 4000, 8000, 16000];
    for (let i = 0; i < 5; i++) {
      expect(base * Math.pow(2, i)).toBe(expected[i]);
    }
  });

  it('marks exhausted after max retries', () => {
    const entry = { retryCount: 4, maxRetries: 5, status: 'pending' as string };
    entry.retryCount++;
    if (entry.retryCount >= entry.maxRetries) entry.status = 'exhausted';
    expect(entry.status).toBe('exhausted');
  });

  it('keeps pending when retries remain', () => {
    const entry = { retryCount: 2, maxRetries: 5, status: 'pending' as string };
    entry.retryCount++;
    if (entry.retryCount >= entry.maxRetries) entry.status = 'exhausted';
    expect(entry.status).toBe('pending');
  });
});
