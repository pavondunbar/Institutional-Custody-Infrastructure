export type SettlementType = 'dvp' | 'pvp' | 'fop' | 'internal' | 'cross_chain';
export type SettlementStatus = 'pending' | 'matched' | 'settling' | 'settled' | 'failed' | 'cancelled';
export interface SettlementInstruction {
    id: string;
    settlementType: SettlementType;
    legA: {
        accountId: string;
        asset: string;
        amount: bigint;
        direction: 'deliver' | 'receive';
    };
    legB?: {
        accountId: string;
        asset: string;
        amount: bigint;
        direction: 'deliver' | 'receive';
    };
    settlementDate: Date;
    settlementCycle: string;
    status: SettlementStatus;
    counterpartyRef?: string;
    nettingGroupId?: string;
}
/**
 * Settlement & Clearing Service: atomic settlement, DvP, PvP, netting, finality.
 */
export declare class SettlementService {
    /**
     * Create a settlement instruction (DvP, PvP, FoP, internal, cross-chain).
     */
    createInstruction(params: {
        settlementType: SettlementType;
        legA: {
            accountId: string;
            asset: string;
            amount: bigint;
            direction: 'deliver' | 'receive';
        };
        legB?: {
            accountId: string;
            asset: string;
            amount: bigint;
            direction: 'deliver' | 'receive';
        };
        settlementDate: Date;
        settlementCycle?: string;
        counterpartyRef?: string;
    }): Promise<SettlementInstruction>;
    /**
     * Execute atomic settlement — both legs settle or neither does.
     */
    executeSettlement(instructionId: string): Promise<void>;
    /**
     * Calculate netting for a group of instructions — reduces gross to net obligations.
     */
    calculateNetting(asset: string, date: Date): Promise<{
        nettingGroupId: string;
        grossAmount: bigint;
        netAmount: bigint;
        savingsBps: number;
    }>;
    getInstruction(id: string): Promise<SettlementInstruction | null>;
    getPendingSettlements(): Promise<SettlementInstruction[]>;
    private mapRow;
}
//# sourceMappingURL=settlement-service.d.ts.map