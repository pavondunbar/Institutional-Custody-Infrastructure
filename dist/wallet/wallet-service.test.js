"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// --- Mocks ---
const mockQuery = jest.fn();
jest.mock('../database/connection', () => ({
    db: { query: (...args) => mockQuery(...args) },
}));
const mockGetAndIncrement = jest.fn();
jest.mock('../cache/redis', () => ({
    nonceManager: { getAndIncrement: (...args) => mockGetAndIncrement(...args) },
}));
jest.mock('../config', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    config: {},
}));
jest.mock('uuid', () => ({ v4: () => 'mock-uuid-1234' }));
const wallet_service_1 = require("./wallet-service");
describe('WalletService', () => {
    let service;
    beforeEach(() => {
        jest.clearAllMocks();
        service = new wallet_service_1.WalletService();
    });
    describe('createWallet', () => {
        it('inserts wallet and returns id', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [{ id: 'mock-uuid-1234' }] });
            const id = await service.createWallet({
                accountId: 'acc-1', chain: 'ethereum', address: '0xABC', walletType: 'hot', keyId: 'kms-1',
            });
            expect(id).toBe('mock-uuid-1234');
            expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO wallets'), expect.arrayContaining(['acc-1', 'ethereum', '0xABC', 'hot', 'kms-1']));
        });
    });
    describe('createTransaction', () => {
        it('allocates nonce atomically and writes tx + outbox', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [{ id: 'w1', address: '0xABC', chain: 'ethereum', status: 'active', key_id: 'kms-1' }] });
            mockGetAndIncrement.mockResolvedValueOnce(7);
            mockQuery.mockResolvedValueOnce({ rows: [{ id: 'mock-uuid-1234' }] });
            mockQuery.mockResolvedValueOnce({});
            const txId = await service.createTransaction({ walletId: 'w1', toAddress: '0xDEF', amount: 1000000000000000000n });
            expect(txId).toBe('mock-uuid-1234');
            expect(mockGetAndIncrement).toHaveBeenCalledWith('ethereum', '0xABC');
            // Verify nonce in INSERT params
            const insertCall = mockQuery.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO transactions_blockchain'));
            expect(insertCall[1]).toContain(7);
        });
        it('rejects for non-existent wallet', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [] });
            await expect(service.createTransaction({ walletId: 'bad', toAddress: '0x1', amount: 1n })).rejects.toThrow('Wallet not found');
        });
        it('rejects for inactive wallet', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [{ id: 'w1', status: 'frozen' }] });
            await expect(service.createTransaction({ walletId: 'w1', toAddress: '0x1', amount: 1n })).rejects.toThrow('not active');
        });
    });
    describe('handleReorg', () => {
        it('marks confirmed txs at or above fork block as reorged', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [{ id: 'tx-1' }, { id: 'tx-2' }] });
            const affected = await service.handleReorg(100, 'ethereum');
            expect(affected).toEqual(['tx-1', 'tx-2']);
            expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'reorged'"), [100, 'ethereum']);
        });
    });
    describe('nonce management under concurrency', () => {
        it('each concurrent tx gets a unique nonce via Redis INCR', async () => {
            // Use mockImplementation to handle interleaved calls
            mockQuery.mockImplementation((sql) => {
                if (sql.includes('SELECT * FROM wallets')) {
                    return Promise.resolve({ rows: [{ id: 'w1', address: '0xABC', chain: 'ethereum', status: 'active', key_id: 'k' }] });
                }
                if (sql.includes('INSERT INTO transactions_blockchain')) {
                    return Promise.resolve({ rows: [{ id: 'mock-uuid-1234' }] });
                }
                return Promise.resolve({});
            });
            mockGetAndIncrement.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
            await Promise.all([
                service.createTransaction({ walletId: 'w1', toAddress: '0x1', amount: 1n }),
                service.createTransaction({ walletId: 'w1', toAddress: '0x2', amount: 2n }),
            ]);
            expect(mockGetAndIncrement).toHaveBeenCalledTimes(2);
        });
    });
});
//# sourceMappingURL=wallet-service.test.js.map