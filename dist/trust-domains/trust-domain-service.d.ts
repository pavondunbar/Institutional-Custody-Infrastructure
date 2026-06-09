export type TrustLevel = 'full' | 'limited' | 'none';
export interface TrustDomain {
    id: string;
    name: string;
    description?: string;
    parentDomainId?: string;
    isolationLevel: 'full' | 'shared' | 'hybrid';
    signingDomainId?: string;
    status: 'active' | 'suspended' | 'decommissioned';
}
export interface CrossDomainPolicy {
    id: string;
    sourceDomainId: string;
    targetDomainId: string;
    trustLevel: TrustLevel;
    allowedOperations: string[];
    requiresApproval: boolean;
    maxAmount?: bigint;
}
/**
 * Trust Domains: isolation of business units, segregation of custody environments,
 * customer asset segregation, independent signing domains, cross-domain authorization.
 */
export declare class TrustDomainService {
    createDomain(params: {
        name: string;
        description?: string;
        parentDomainId?: string;
        isolationLevel: 'full' | 'shared' | 'hybrid';
        signingDomainId?: string;
    }): Promise<TrustDomain>;
    /**
     * Create cross-domain policy — defines what operations are permitted between domains.
     */
    createCrossDomainPolicy(params: {
        sourceDomainId: string;
        targetDomainId: string;
        trustLevel: TrustLevel;
        allowedOperations: string[];
        requiresApproval: boolean;
        maxAmount?: bigint;
    }): Promise<CrossDomainPolicy>;
    /**
     * Authorize a cross-domain operation — checks policies.
     */
    authorizeCrossDomainOperation(params: {
        sourceDomainId: string;
        targetDomainId: string;
        operation: string;
        amount?: bigint;
    }): Promise<{
        authorized: boolean;
        requiresApproval: boolean;
        reason?: string;
    }>;
    /**
     * Validate asset segregation — ensure customer assets are in correct domain.
     */
    validateAssetSegregation(accountId: string, domainId: string): Promise<boolean>;
    /**
     * Assign account to a trust domain.
     */
    assignAccountToDomain(accountId: string, domainId: string): Promise<void>;
    getDomain(id: string): Promise<TrustDomain | null>;
    listDomains(): Promise<TrustDomain[]>;
    private mapDomain;
    private mapPolicy;
}
//# sourceMappingURL=trust-domain-service.d.ts.map