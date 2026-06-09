export interface ScreeningResult {
    matched: boolean;
    matchScore: number;
    matchType: string | null;
    sanctionsListId: string | null;
    details: Record<string, unknown>;
}
/**
 * AML/Sanctions screening and suspicious activity reporting.
 * Integrates with sanctions lists (OFAC SDN, UN, EU, UK HMT).
 */
export declare class AmlService {
    /**
     * Screen an address against all sanctions lists.
     */
    screenAddress(address: string): Promise<ScreeningResult>;
    /**
     * Screen an entity name against sanctions lists (fuzzy matching).
     */
    screenEntity(name: string): Promise<ScreeningResult>;
    /**
     * Screen a transaction for suspicious patterns.
     */
    screenTransaction(params: {
        accountId: string;
        amount: bigint;
        toAddress?: string;
        fromAddress?: string;
    }): Promise<{
        flagged: boolean;
        indicators: string[];
    }>;
    /**
     * File a Suspicious Activity Report (SAR).
     */
    fileSar(params: {
        subjectType: string;
        subjectId: string;
        description: string;
        amount?: bigint;
        currency?: string;
        indicators: string[];
        relatedTransactions?: string[];
        filedBy: string;
        jurisdiction?: string;
    }): Promise<string>;
    /**
     * Create a Travel Rule message for cross-institution transfers.
     */
    createTravelRuleMessage(params: {
        direction: 'outgoing' | 'incoming';
        transactionId?: string;
        originatorName: string;
        originatorAccount: string;
        originatorAddress?: string;
        originatorInstitution: string;
        beneficiaryName: string;
        beneficiaryAccount: string;
        beneficiaryAddress?: string;
        beneficiaryInstitution: string;
        amount: bigint;
        currency: string;
    }): Promise<string>;
    getSars(status?: string, limit?: number): Promise<any[]>;
    getScreeningResults(subjectId: string): Promise<any[]>;
    /**
     * Add an entry to a sanctions list.
     */
    addSanctionsEntry(params: {
        listType: string;
        entityName?: string;
        entityType?: string;
        addresses?: string[];
        identifiers?: Record<string, unknown>;
        sourceUrl?: string;
    }): Promise<string>;
    private recordScreening;
}
//# sourceMappingURL=aml-service.d.ts.map