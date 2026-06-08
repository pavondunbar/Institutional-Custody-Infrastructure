/**
 * ReconciliationService: Scheduled jobs that verify ledger integrity.
 * - Balance reconciliation: cached balances match ledger reconstruction
 * - Hash chain verification: no broken links in the append-only chain
 * - Cross-system: on-chain balances match internal records
 */
export declare class ReconciliationService {
    private jobs;
    start(): void;
    stop(): void;
    /**
     * Verify that balance_cache matches reconstructed balances from ledger_entries.
     */
    runBalanceReconciliation(): Promise<{
        passed: boolean;
        discrepancies: number;
    }>;
    /**
     * Verify hash chain integrity for all accounts.
     */
    runHashChainVerification(): Promise<{
        passed: boolean;
        brokenChains: number;
    }>;
    /**
     * Verify token holder balances match supply and ledger records.
     * - Sum of holder balances == total_minted - total_burned
     * - Each holder's balance matches ledger-derived balance
     */
    runTokenBalanceReconciliation(): Promise<{
        passed: boolean;
        discrepancies: number;
    }>;
    private startRun;
    private completeRun;
}
//# sourceMappingURL=reconciliation-service.d.ts.map