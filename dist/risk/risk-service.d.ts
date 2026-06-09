export interface RiskCheckResult {
    allowed: boolean;
    riskLevel: string;
    violations: RiskViolation[];
}
export interface RiskViolation {
    policyId: string;
    policyType: string;
    severity: string;
    message: string;
    actionRequired: string;
}
export declare class RiskService {
    /**
     * Evaluate all active risk policies for a transaction.
     */
    evaluateTransaction(params: {
        accountId: string;
        amount: bigint;
        direction: string;
        tokenId?: string;
        counterpartyId?: string;
    }): Promise<RiskCheckResult>;
    private checkPolicy;
    /**
     * Velocity check: max transactions/amount in a time window.
     */
    private checkVelocity;
    /**
     * Concentration check: max % of total supply held by one account.
     */
    private checkConcentration;
    /**
     * Exposure check: max total value at risk for an account.
     */
    private checkExposure;
    private recordRiskEvent;
    createPolicy(params: {
        name: string;
        policyType: string;
        config: Record<string, unknown>;
        severity: string;
        actionOnBreach: string;
    }): Promise<string>;
    getPolicies(): Promise<any[]>;
    getUnresolvedEvents(limit?: number): Promise<any[]>;
    resolveEvent(eventId: string, resolvedBy: string): Promise<void>;
}
//# sourceMappingURL=risk-service.d.ts.map