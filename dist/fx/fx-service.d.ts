export interface FXRate {
    pair: string;
    bid: number;
    ask: number;
    mid: number;
    spread: number;
    source: string;
    timestamp: Date;
}
export interface FXConversion {
    id: string;
    fromCurrency: string;
    toCurrency: string;
    fromAmount: bigint;
    toAmount: bigint;
    rate: number;
    spreadBps: number;
    status: 'quoted' | 'executing' | 'settled' | 'failed';
}
/**
 * FX Conversion Engine: real-time rate management, atomic PvP settlement,
 * spread calculation, corridor routing, and rate locking.
 */
export declare class FXService {
    private readonly defaultSpreadBps;
    private readonly rateLockTtlSeconds;
    /**
     * Submit an FX rate from a provider.
     */
    submitRate(params: {
        pair: string;
        bid: number;
        ask: number;
        source: string;
    }): Promise<void>;
    /**
     * Get current rate for a pair.
     */
    getRate(pair: string): Promise<FXRate | null>;
    /**
     * Get a locked quote (rate guaranteed for rateLockTtlSeconds).
     */
    getQuote(params: {
        fromCurrency: string;
        toCurrency: string;
        fromAmount: bigint;
    }): Promise<FXConversion>;
    /**
     * Execute a quoted FX conversion atomically (PvP — both legs settle or neither).
     */
    executeConversion(conversionId: string, fromAccountId: string, toAccountId: string): Promise<void>;
    getConversion(id: string): Promise<FXConversion | null>;
    getSupportedPairs(): Promise<string[]>;
}
//# sourceMappingURL=fx-service.d.ts.map