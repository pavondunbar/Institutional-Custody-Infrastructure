export type DataClassification = 'public' | 'internal' | 'confidential' | 'restricted' | 'pii' | 'phi';
export interface DisclosurePolicy {
    id: string;
    name: string;
    dataClassification: DataClassification;
    allowedRecipients: string[];
    requiredPurpose: string;
    retentionDays: number;
    minimizationRules: Record<string, string>;
}
export interface ZKProof {
    commitment: string;
    proof: string;
    publicInputs: string[];
    verified: boolean;
}
/**
 * Privacy & Confidentiality: zero-knowledge proofs, selective disclosure,
 * data minimization, confidential transactions, permissioned access.
 */
export declare class PrivacyService {
    /**
     * Generate a zero-knowledge proof of balance (proves balance >= threshold without revealing exact amount).
     */
    generateBalanceProof(params: {
        accountId: string;
        threshold: bigint;
    }): Promise<ZKProof>;
    /**
     * Generate proof of reserves without revealing individual holdings.
     */
    generateAggregateProof(accountIds: string[]): Promise<ZKProof>;
    /**
     * Selective disclosure — returns only fields allowed by policy.
     */
    selectiveDisclose(params: {
        data: Record<string, unknown>;
        policyId: string;
        recipientId: string;
        purpose: string;
    }): Promise<Record<string, unknown>>;
    /**
     * Classify data fields for a table.
     */
    classifyData(tableName: string, columnName: string, classification: DataClassification, encryptionRequired: boolean, retentionDays?: number): Promise<void>;
    /**
     * Get data classification for a field.
     */
    getClassification(tableName: string, columnName: string): Promise<{
        classification: DataClassification;
        encryptionRequired: boolean;
    } | null>;
    /**
     * Apply data retention — purge expired data.
     */
    enforceRetention(): Promise<{
        tablesProcessed: number;
        rowsPurged: number;
    }>;
    private getDisclosurePolicy;
}
//# sourceMappingURL=privacy-service.d.ts.map