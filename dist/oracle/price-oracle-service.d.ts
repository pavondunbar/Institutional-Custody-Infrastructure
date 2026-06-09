export interface PriceQuote {
    source: string;
    pair: string;
    price: number;
    volume: number;
    timestamp: Date;
}
export interface AggregatedPrice {
    pair: string;
    vwap: number;
    median: number;
    sources: number;
    stale: boolean;
    confidence: number;
    timestamp: Date;
}
/**
 * Price Oracle Service: multi-source VWAP aggregation, median filtering,
 * staleness detection, outlier rejection, and confidence scoring.
 */
export declare class PriceOracleService {
    private readonly stalenessThresholdMs;
    private readonly outlierThresholdPct;
    private readonly minSources;
    /**
     * Submit a price quote from a source.
     */
    submitQuote(quote: PriceQuote): Promise<void>;
    /**
     * Get aggregated price using VWAP + median filtering + outlier rejection.
     */
    getPrice(pair: string): Promise<AggregatedPrice>;
    /**
     * Get cached price (fast path for frequent lookups).
     */
    getCachedPrice(pair: string): Promise<{
        vwap: number;
        median: number;
    } | null>;
    /**
     * Get price history for a pair.
     */
    getPriceHistory(pair: string, hours?: number): Promise<Array<{
        price: number;
        volume: number;
        source: string;
        timestamp: Date;
    }>>;
    /**
     * Get all supported pairs with latest prices.
     */
    getAllPrices(): Promise<AggregatedPrice[]>;
}
//# sourceMappingURL=price-oracle-service.d.ts.map