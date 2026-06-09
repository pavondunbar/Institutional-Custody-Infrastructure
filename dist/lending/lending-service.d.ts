export type LoanStatus = 'pending' | 'active' | 'margin_call' | 'liquidating' | 'repaid' | 'defaulted';
export interface Loan {
    id: string;
    borrowerId: string;
    collateralAccountId: string;
    loanAccountId: string;
    collateralAsset: string;
    loanAsset: string;
    collateralAmount: bigint;
    loanAmount: bigint;
    interestRateBps: number;
    accruedInterest: bigint;
    ltv: number;
    liquidationThreshold: number;
    marginCallThreshold: number;
    status: LoanStatus;
}
export interface LiquidationResult {
    loanId: string;
    collateralSeized: bigint;
    debtRepaid: bigint;
    liquidationPenaltyBps: number;
    surplusReturned: bigint;
}
/**
 * Lending, Margin, and Liquidation Engine: loan origination, interest accrual,
 * LTV monitoring, margin calls, and waterfall liquidation.
 */
export declare class LendingService {
    private readonly liquidationPenaltyBps;
    /**
     * Originate a new loan with collateral.
     */
    originateLoan(params: {
        borrowerId: string;
        collateralAccountId: string;
        loanAccountId: string;
        collateralAsset: string;
        loanAsset: string;
        collateralAmount: bigint;
        loanAmount: bigint;
        interestRateBps: number;
        liquidationThreshold: number;
        marginCallThreshold: number;
        collateralPrice: number;
        loanAssetPrice: number;
    }): Promise<Loan>;
    /**
     * Accrue interest on all active loans (called periodically).
     */
    accrueInterest(): Promise<number>;
    /**
     * Monitor LTV ratios and trigger margin calls / liquidations.
     */
    monitorPositions(prices: Record<string, number>): Promise<{
        marginCalls: string[];
        liquidations: string[];
    }>;
    /**
     * Execute liquidation with waterfall: seize collateral → repay debt → penalty → return surplus.
     */
    liquidate(loanId: string, collateralPrice: number, loanAssetPrice: number): Promise<LiquidationResult>;
    /**
     * Repay a loan (partial or full).
     */
    repay(loanId: string, amount: bigint): Promise<void>;
    getLoan(id: string): Promise<Loan | null>;
    getActiveLoans(borrowerId?: string): Promise<Loan[]>;
    private mapLoan;
}
//# sourceMappingURL=lending-service.d.ts.map