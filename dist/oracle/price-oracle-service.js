"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PriceOracleService = void 0;
const redis_1 = require("../cache/redis");
const connection_1 = require("../database/connection");
/**
 * Price Oracle Service: multi-source VWAP aggregation, median filtering,
 * staleness detection, outlier rejection, and confidence scoring.
 */
class PriceOracleService {
    stalenessThresholdMs = 60_000; // 60s
    outlierThresholdPct = 10; // Reject quotes >10% from median
    minSources = 2;
    /**
     * Submit a price quote from a source.
     */
    async submitQuote(quote) {
        const key = `oracle:quotes:${quote.pair}`;
        const entry = JSON.stringify({ source: quote.source, price: quote.price, volume: quote.volume, ts: quote.timestamp.getTime() });
        await redis_1.redis.lpush(key, entry);
        await redis_1.redis.ltrim(key, 0, 99); // Keep last 100 quotes per pair
        await redis_1.redis.expire(key, 300); // 5min TTL
        await connection_1.db.query(`INSERT INTO price_quotes (source, pair, price, volume, quoted_at) VALUES ($1,$2,$3,$4,$5)`, [quote.source, quote.pair, quote.price, quote.volume, quote.timestamp]);
    }
    /**
     * Get aggregated price using VWAP + median filtering + outlier rejection.
     */
    async getPrice(pair) {
        const key = `oracle:quotes:${pair}`;
        const raw = await redis_1.redis.lrange(key, 0, -1);
        const now = Date.now();
        // Parse and filter stale quotes
        const quotes = raw
            .map(r => JSON.parse(r))
            .filter(q => (now - q.ts) < this.stalenessThresholdMs);
        // Deduplicate by source (keep latest)
        const bySource = new Map();
        for (const q of quotes) {
            const existing = bySource.get(q.source);
            if (!existing || q.ts > existing.ts)
                bySource.set(q.source, q);
        }
        const deduped = Array.from(bySource.values());
        if (deduped.length === 0) {
            return { pair, vwap: 0, median: 0, sources: 0, stale: true, confidence: 0, timestamp: new Date() };
        }
        // Calculate median
        const sorted = [...deduped].sort((a, b) => a.price - b.price);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 === 0 ? (sorted[mid - 1].price + sorted[mid].price) / 2 : sorted[mid].price;
        // Reject outliers (>threshold% from median)
        const filtered = deduped.filter(q => Math.abs(q.price - median) / median * 100 <= this.outlierThresholdPct);
        // Calculate VWAP
        let totalVolumePrice = 0;
        let totalVolume = 0;
        for (const q of filtered) {
            totalVolumePrice += q.price * q.volume;
            totalVolume += q.volume;
        }
        const vwap = totalVolume > 0 ? totalVolumePrice / totalVolume : median;
        const stale = deduped.length < this.minSources;
        const confidence = Math.min(100, (filtered.length / this.minSources) * 50 + (1 - Math.abs(vwap - median) / median) * 50);
        // Cache the aggregated price
        await redis_1.redis.setex(`oracle:price:${pair}`, 30, JSON.stringify({ vwap, median, sources: filtered.length, confidence }));
        return { pair, vwap, median, sources: filtered.length, stale, confidence, timestamp: new Date() };
    }
    /**
     * Get cached price (fast path for frequent lookups).
     */
    async getCachedPrice(pair) {
        const cached = await redis_1.redis.get(`oracle:price:${pair}`);
        if (!cached)
            return null;
        const data = JSON.parse(cached);
        return { vwap: data.vwap, median: data.median };
    }
    /**
     * Get price history for a pair.
     */
    async getPriceHistory(pair, hours = 24) {
        const since = new Date(Date.now() - hours * 3600_000);
        const result = await connection_1.db.query(`SELECT source, price, volume, quoted_at FROM price_quotes WHERE pair=$1 AND quoted_at >= $2 ORDER BY quoted_at DESC LIMIT 1000`, [pair, since]);
        return result.rows.map((r) => ({ price: r.price, volume: r.volume, source: r.source, timestamp: new Date(r.quoted_at) }));
    }
    /**
     * Get all supported pairs with latest prices.
     */
    async getAllPrices() {
        const result = await connection_1.db.query(`SELECT DISTINCT pair FROM price_quotes WHERE quoted_at > NOW() - INTERVAL '5 minutes'`);
        const prices = [];
        for (const row of result.rows) {
            prices.push(await this.getPrice(row.pair));
        }
        return prices;
    }
}
exports.PriceOracleService = PriceOracleService;
//# sourceMappingURL=price-oracle-service.js.map