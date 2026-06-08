import { CreateAssetRequest, AssetStatus } from './types';
export declare class AssetService {
    createAsset(req: CreateAssetRequest): Promise<string>;
    getAsset(assetId: string): Promise<any>;
    listAssets(filters?: {
        assetType?: string;
        status?: string;
        limit?: number;
        offset?: number;
    }): Promise<{
        assets: any[];
        limit: number;
        offset: number;
    }>;
    updateValuation(assetId: string, valuation: bigint, currency: string): Promise<void>;
    updateStatus(assetId: string, newStatus: AssetStatus, eventType: string): Promise<void>;
    activateAsset(assetId: string): Promise<void>;
    suspendAsset(assetId: string): Promise<void>;
}
//# sourceMappingURL=asset-service.d.ts.map