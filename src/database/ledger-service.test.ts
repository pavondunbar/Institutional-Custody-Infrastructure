import { createHash } from 'crypto';

// --- Mocks ---
const mockClientQuery = jest.fn();
const mockClient = { query: mockClientQuery, release: jest.fn() };

jest.mock('./connection', () => ({
  db: { query: jest.fn() },
  withSerializableTransaction: async (fn: (client: typeof mockClient) => Promise<unknown>) => fn(mockClient),
}));

jest.mock('../config', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  config: {},
}));

import { postJournal, reverseJournal, getBalance, reconstructBalance, PostJournalRequest } from './ledger-service';
import { db } from './connection';

const mockDbQuery = db.query as jest.Mock;

describe('Ledger Service', () => {
  beforeEach(() => jest.clearAllMocks());

  const accountA = '11111111-1111-1111-1111-111111111111';
  const accountB = '22222222-2222-2222-2222-222222222222';

  const balancedRequest: PostJournalRequest = {
    idempotencyKey: 'txn-001',
    description: 'Test transfer',
    lines: [
      { accountId: accountA, amount: 1000n, direction: 'debit' },
      { accountId: accountB, amount: 1000n, direction: 'credit' },
    ],
  };

  describe('postJournal', () => {
    it('rejects unbalanced journals before hitting the database', async () => {
      await expect(
        postJournal({ idempotencyKey: 'bad', lines: [{ accountId: accountA, amount: 500n, direction: 'debit' }, { accountId: accountB, amount: 300n, direction: 'credit' }] }),
      ).rejects.toThrow('Unbalanced journal');
      expect(mockClientQuery).not.toHaveBeenCalled();
    });

    it('rejects empty journal lines', async () => {
      await expect(postJournal({ idempotencyKey: 'empty', lines: [] })).rejects.toThrow('at least one line');
    });

    it('posts a balanced double-entry journal with hash chain', async () => {
      mockClientQuery
        .mockResolvedValueOnce({}) // SET CONSTRAINTS
        .mockResolvedValueOnce({ rows: [] }) // idempotency check
        .mockResolvedValueOnce({ rows: [{ id: 'journal-1' }] }) // INSERT journal
        // Line 1
        .mockResolvedValueOnce({ rows: [{ account_id: accountA, debit_total: '0', credit_total: '0', balance: '0', last_entry_hash: null, last_entry_id: null }] })
        .mockResolvedValueOnce({ rows: [{ max_seq: '0' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'entry-1' }] })
        .mockResolvedValueOnce({})
        // Line 2
        .mockResolvedValueOnce({ rows: [{ account_id: accountB, debit_total: '0', credit_total: '0', balance: '0', last_entry_hash: null, last_entry_id: null }] })
        .mockResolvedValueOnce({ rows: [{ max_seq: '0' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'entry-2' }] })
        .mockResolvedValueOnce({})
        // Outbox
        .mockResolvedValueOnce({});

      const result = await postJournal(balancedRequest);

      expect(result.journalEntryId).toBe('journal-1');
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]).toMatchObject({ accountId: accountA, amount: 1000n, direction: 'debit' });
      expect(result.entries[1]).toMatchObject({ accountId: accountB, amount: 1000n, direction: 'credit' });

      // Verify entry_hash is a valid SHA-256 hex
      const ledgerInsert = mockClientQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO ledger_entries'),
      );
      expect(ledgerInsert![1][4]).toMatch(/^[a-f0-9]{64}$/);
    });

    it('returns existing journal on duplicate idempotency key', async () => {
      mockClientQuery
        .mockResolvedValueOnce({}) // SET CONSTRAINTS
        .mockResolvedValueOnce({ rows: [{ id: 'journal-existing' }] }) // idempotency hit
        .mockResolvedValueOnce({ rows: [
          { id: 'e1', account_id: accountA, amount: '1000', direction: 'debit' },
          { id: 'e2', account_id: accountB, amount: '1000', direction: 'credit' },
        ] });

      const result = await postJournal(balancedRequest);

      expect(result.journalEntryId).toBe('journal-existing');
      expect(result.entries).toHaveLength(2);
      // No journal INSERT was called
      const journalInserts = mockClientQuery.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO journal_entries'),
      );
      expect(journalInserts).toHaveLength(0);
    });

    it('validates hash chain continuity (prev_hash links to previous entry)', async () => {
      const prevHash = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

      mockClientQuery
        .mockResolvedValueOnce({}) // SET CONSTRAINTS
        .mockResolvedValueOnce({ rows: [] }) // idempotency
        .mockResolvedValueOnce({ rows: [{ id: 'j2' }] }) // INSERT journal
        // Line 1 — has existing hash
        .mockResolvedValueOnce({ rows: [{ account_id: accountA, debit_total: '500', credit_total: '0', balance: '500', last_entry_hash: prevHash, last_entry_id: '5' }] })
        .mockResolvedValueOnce({ rows: [{ max_seq: '3' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'entry-new' }] })
        .mockResolvedValueOnce({})
        // Line 2
        .mockResolvedValueOnce({ rows: [{ account_id: accountB, debit_total: '0', credit_total: '500', balance: '-500', last_entry_hash: null, last_entry_id: null }] })
        .mockResolvedValueOnce({ rows: [{ max_seq: '2' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'entry-new-2' }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}); // outbox

      await postJournal(balancedRequest);

      // Find first ledger INSERT call
      const ledgerInserts = mockClientQuery.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO ledger_entries'),
      );
      const params = ledgerInserts[0][1];
      expect(params[5]).toBe(prevHash); // prev_hash param

      // Verify computed hash matches expected
      const expectedHash = createHash('sha256').update(`${prevHash}|${accountA}|1000|debit|4`).digest('hex');
      expect(params[4]).toBe(expectedHash);
    });
  });

  describe('reverseJournal', () => {
    it('rejects reversal of non-existent journal', async () => {
      mockClientQuery.mockResolvedValueOnce({ rows: [] });
      await expect(reverseJournal('nonexistent', 'rev-key')).rejects.toThrow('Journal entry not found');
    });

    it('rejects reversal of already-reversed journal', async () => {
      mockClientQuery.mockResolvedValueOnce({ rows: [{ id: 'j1', status: 'reversed' }] });
      await expect(reverseJournal('j1', 'rev-key')).rejects.toThrow('already reversed');
    });

    it('posts mirror entries (debit↔credit swap)', async () => {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [{ id: 'j1', status: 'posted' }] }) // SELECT original
        .mockResolvedValueOnce({ rows: [
          { account_id: accountA, amount: '1000', direction: 'debit' },
          { account_id: accountB, amount: '1000', direction: 'credit' },
        ] }) // SELECT lines
        .mockResolvedValueOnce({}) // UPDATE status
        .mockResolvedValueOnce({}) // SET CONSTRAINTS
        .mockResolvedValueOnce({ rows: [{ id: 'j1-rev' }] }) // INSERT reversal journal
        .mockResolvedValueOnce({}) // UPDATE reversed_by
        // Line 1 (credit — mirror of original debit)
        .mockResolvedValueOnce({ rows: [{ account_id: accountA, debit_total: '1000', credit_total: '0', balance: '1000', last_entry_hash: 'aaa', last_entry_id: '1' }] })
        .mockResolvedValueOnce({ rows: [{ max_seq: '1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'rev-e1' }] })
        .mockResolvedValueOnce({})
        // Line 2 (debit — mirror of original credit)
        .mockResolvedValueOnce({ rows: [{ account_id: accountB, debit_total: '0', credit_total: '1000', balance: '-1000', last_entry_hash: 'bbb', last_entry_id: '2' }] })
        .mockResolvedValueOnce({ rows: [{ max_seq: '1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'rev-e2' }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}); // outbox

      const result = await reverseJournal('j1', 'rev-key-001');

      expect(result.journalEntryId).toBe('j1-rev');
      expect(result.entries[0].direction).toBe('credit'); // swapped
      expect(result.entries[1].direction).toBe('debit');  // swapped
    });
  });

  describe('getBalance', () => {
    it('returns null for unknown account', async () => {
      mockDbQuery.mockResolvedValueOnce({ rows: [] });
      expect(await getBalance('unknown')).toBeNull();
    });

    it('returns balance with BigInt values', async () => {
      mockDbQuery.mockResolvedValueOnce({
        rows: [{ account_id: accountA, debit_total: '5000', credit_total: '2000', balance: '3000', last_entry_hash: 'abc' }],
      });
      const result = await getBalance(accountA);
      expect(result).toEqual({ accountId: accountA, debitTotal: 5000n, creditTotal: 2000n, balance: 3000n, lastEntryHash: 'abc' });
    });
  });

  describe('reconstructBalance', () => {
    it('independently derives balance from raw entries', async () => {
      mockDbQuery.mockResolvedValueOnce({ rows: [{ debit_total: '7000', credit_total: '3000' }] });
      const result = await reconstructBalance(accountA);
      expect(result).toEqual({ debitTotal: 7000n, creditTotal: 3000n, balance: 4000n });
    });
  });

  describe('double-spend prevention', () => {
    it('serialization failure rejects concurrent conflicting transactions', async () => {
      mockClientQuery
        .mockResolvedValueOnce({}) // SET CONSTRAINTS
        .mockResolvedValueOnce({ rows: [] }) // idempotency
        .mockResolvedValueOnce({ rows: [{ id: 'j1' }] }) // INSERT journal
        .mockRejectedValueOnce(new Error('could not serialize access due to concurrent update'));

      await expect(postJournal(balancedRequest)).rejects.toThrow('could not serialize access');
    });
  });
});
