import { CreateCorporateActionRequest, CastVoteRequest } from './types';
export declare class CorporateActionsService {
    createAction(req: CreateCorporateActionRequest): Promise<string>;
    setRecordDate(actionId: string): Promise<number>;
    processDistributions(actionId: string): Promise<number>;
    private processOneDistribution;
    castVote(req: CastVoteRequest): Promise<void>;
    getAction(actionId: string): Promise<any>;
    listActions(tokenId: string, limit?: number, offset?: number): Promise<{
        actions: any[];
        limit: number;
        offset: number;
    }>;
    getActionResults(actionId: string): Promise<{
        action: any;
        type: string;
        totalEligible: number;
        totalVoted: number;
        results: {
            choice: string;
            votes: number;
            weightedVotes: string;
        }[];
        totalProcessed?: undefined;
        totalFailed?: undefined;
        totalDistributed?: undefined;
        distributions?: undefined;
    } | {
        action: any;
        type: any;
        totalEligible: number;
        totalProcessed: number;
        totalFailed: number;
        totalDistributed: any;
        distributions: any[];
        totalVoted?: undefined;
        results?: undefined;
    }>;
    cancelAction(actionId: string): Promise<void>;
    private getActionOrFail;
}
//# sourceMappingURL=corporate-actions-service.d.ts.map