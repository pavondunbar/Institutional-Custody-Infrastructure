export type TreasuryStrategy = 'conservative' | 'balanced' | 'growth' | 'custom';
export type PortfolioStatus = 'active' | 'frozen' | 'liquidating' | 'closed';
export interface TreasuryPortfolio {
    id: string;
    name: string;
    strategy: TreasuryStrategy;
    targetAllocations: Record<string, number>;
    actualAllocations: Record<string, number>;
    totalValue: bigint;
    rebalanceThresholdBps: number;
    status: PortfolioStatus;
}
export interface RebalanceAction {
    asset: string;
    direction: 'buy' | 'sell';
    amount: bigint;
    currentPct: number;
    targetPct: number;
}
/**
 * Treasury Management: diversification, rebalancing, NAV, proof of reserves, yield.
 */
export declare class TreasuryService {
    createPortfolio(params: {
        name: string;
        strategy: TreasuryStrategy;
        targetAllocations: Record<string, number>;
        rebalanceThresholdBps?: number;
    }): Promise<TreasuryPortfolio>;
    /**
     * Calculate NAV (Net Asset Value) for a portfolio.
     */
    calculateNAV(portfolioId: string): Promise<{
        totalValue: bigint;
        positions: Array<{
            asset: string;
            value: bigint;
            pct: number;
        }>;
    }>;
    /**
     * Calculate rebalance actions needed to bring portfolio to target.
     */
    calculateRebalance(portfolioId: string): Promise<RebalanceAction[]>;
    /**
     * Proof of Reserves: verify on-chain balances match recorded positions.
     */
    generateProofOfReserves(portfolioId: string): Promise<{
        verified: boolean;
        totalReserves: bigint;
        totalLiabilities: bigint;
        ratio: number;
        timestamp: Date;
    }>;
    getPortfolio(id: string): Promise<TreasuryPortfolio | null>;
    updatePosition(portfolioId: string, assetId: string, quantity: bigint, currentValue: bigint): Promise<void>;
    private mapPortfolio;
}
//# sourceMappingURL=treasury-service.d.ts.map