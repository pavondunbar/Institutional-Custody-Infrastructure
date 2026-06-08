import { PostedJournal } from '../database/ledger-service';
import { CreateTokenRequest, MintRequest, BurnRequest, TransferRequest, FreezeHolderRequest } from './types';
export declare class TokenService {
    private compliance;
    createToken(req: CreateTokenRequest): Promise<string>;
    mint(req: MintRequest): Promise<PostedJournal>;
    burn(req: BurnRequest): Promise<PostedJournal>;
    transfer(req: TransferRequest): Promise<PostedJournal>;
    freezeHolder(req: FreezeHolderRequest): Promise<void>;
    unfreezeHolder(req: FreezeHolderRequest): Promise<void>;
    private setHolderStatus;
    getToken(tokenId: string): Promise<any>;
    listTokens(filters?: {
        status?: string;
        assetId?: string;
        limit?: number;
        offset?: number;
    }): Promise<{
        tokens: any[];
        limit: number;
        offset: number;
    }>;
    getHolders(tokenId: string, limit?: number, offset?: number): Promise<{
        holders: any[];
        limit: number;
        offset: number;
    }>;
    getHolderBalance(tokenId: string, accountId: string): Promise<any>;
    getOperationHistory(tokenId: string, limit?: number, offset?: number): Promise<{
        operations: any[];
        limit: number;
        offset: number;
    }>;
    activateToken(tokenId: string): Promise<void>;
    pauseToken(tokenId: string): Promise<void>;
    private getTokenOrFail;
    private getHolderRow;
    private ensureHolderAccount;
    private updateHolderBalance;
    private insertOperation;
    /**
     * Post a journal entry using the existing ledger service's postJournal,
     * but adapted to work within an already-open serializable transaction.
     * We inline the posting logic to share the same client/transaction.
     */
    private postJournalInTx;
}
//# sourceMappingURL=token-service.d.ts.map