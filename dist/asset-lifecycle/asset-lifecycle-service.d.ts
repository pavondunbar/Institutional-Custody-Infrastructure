export type AssetEvent = 'issuance' | 'minting' | 'redemption' | 'burning' | 'corporate_action' | 'dividend' | 'interest_payment' | 'maturity';
export type AssetState = 'draft' | 'active' | 'matured' | 'redeemed' | 'burned' | 'suspended';
export interface LifecycleEvent {
    id: string;
    assetId: string;
    eventType: AssetEvent;
    amount: bigint;
    recipientAccountId?: string;
    executedAt: Date;
    metadata: Record<string, unknown>;
}
/**
 * Asset Lifecycle Management: issuance, minting, redemption, burning,
 * corporate actions, dividend distribution, interest payments, maturity.
 */
export declare class AssetLifecycleService {
    /**
     * Issue new asset units — creates ledger entries and lifecycle record.
     */
    issue(params: {
        assetId: string;
        amount: bigint;
        recipientAccountId: string;
        reason?: string;
    }): Promise<LifecycleEvent>;
    /**
     * Burn/redeem asset units.
     */
    burn(params: {
        assetId: string;
        amount: bigint;
        fromAccountId: string;
        reason?: string;
    }): Promise<LifecycleEvent>;
    /**
     * Distribute dividends to all holders of an asset.
     */
    distributeDividend(params: {
        assetId: string;
        totalAmount: bigint;
        sourceAccountId: string;
        recordDate: Date;
    }): Promise<{
        distributionId: string;
        recipientCount: number;
    }>;
    /**
     * Process maturity — mark asset as matured, settle redemption.
     */
    processMaturity(params: {
        assetId: string;
        maturityDate: Date;
        redemptionAccountId: string;
    }): Promise<void>;
    getLifecycleHistory(assetId: string): Promise<LifecycleEvent[]>;
}
//# sourceMappingURL=asset-lifecycle-service.d.ts.map