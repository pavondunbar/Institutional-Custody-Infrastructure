import { TxClient } from '../database/connection';
import { ComplianceCheckResult, AddRestrictionRequest, WhitelistAddressRequest } from './types';
export declare class ComplianceService {
    /**
     * Validate a transfer against all active restrictions for a token.
     * Called within a serializable transaction during mint/burn/transfer.
     */
    validateTransfer(client: TxClient, tokenId: string, fromAccountId: string | null, toAccountId: string | null, amount: bigint): Promise<ComplianceCheckResult>;
    private checkRestriction;
    private checkWhitelist;
    private checkJurisdiction;
    private checkLockup;
    private checkMaxHolders;
    private checkMinHolding;
    private checkMaxHolding;
    addRestriction(req: AddRestrictionRequest): Promise<string>;
    removeRestriction(restrictionId: string): Promise<void>;
    getRestrictions(tokenId: string): Promise<any[]>;
    addWhitelistEntry(req: WhitelistAddressRequest): Promise<string>;
    removeWhitelistEntry(tokenId: string, address: string): Promise<void>;
    getWhitelistEntries(tokenId: string): Promise<any[]>;
    /**
     * Standalone compliance check (not within a transaction).
     * Used by the API for pre-flight validation.
     */
    checkCompliance(tokenId: string, fromAccountId: string | null, toAccountId: string | null, amount: bigint): Promise<ComplianceCheckResult>;
}
//# sourceMappingURL=compliance-service.d.ts.map