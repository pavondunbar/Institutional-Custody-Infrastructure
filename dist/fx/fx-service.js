"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FXService = void 0;
const connection_1 = require("../database/connection");
const redis_1 = require("../cache/redis");
const config_1 = require("../config");
const uuid_1 = require("uuid");
/**
 * FX Conversion Engine: real-time rate management, atomic PvP settlement,
 * spread calculation, corridor routing, and rate locking.
 */
class FXService {
    defaultSpreadBps = 50; // 50bps = 0.5%
    rateLockTtlSeconds = 30;
    /**
     * Submit an FX rate from a provider.
     */
    async submitRate(params) {
        const mid = (params.bid + params.ask) / 2;
        const spread = (params.ask - params.bid) / mid * 10000; // in bps
        const key = `fx:rate:${params.pair}`;
        await redis_1.redis.hset(key, { bid: String(params.bid), ask: String(params.ask), mid: String(mid), spread: String(spread), source: params.source, ts: String(Date.now()) });
        await redis_1.redis.expire(key, 120); // 2min TTL
        await connection_1.db.query(`INSERT INTO fx_rates (pair, bid, ask, mid, spread_bps, source) VALUES ($1,$2,$3,$4,$5,$6)`, [params.pair, params.bid, params.ask, mid, Math.round(spread), params.source]);
    }
    /**
     * Get current rate for a pair.
     */
    async getRate(pair) {
        const key = `fx:rate:${pair}`;
        const data = await redis_1.redis.hgetall(key);
        if (!data.mid)
            return null;
        return { pair, bid: parseFloat(data.bid), ask: parseFloat(data.ask), mid: parseFloat(data.mid), spread: parseFloat(data.spread), source: data.source, timestamp: new Date(parseInt(data.ts)) };
    }
    /**
     * Get a locked quote (rate guaranteed for rateLockTtlSeconds).
     */
    async getQuote(params) {
        const pair = `${params.fromCurrency}/${params.toCurrency}`;
        const rate = await this.getRate(pair);
        // Try inverse pair if direct not found
        let effectiveRate;
        if (rate) {
            effectiveRate = rate.ask; // Client buys at ask
        }
        else {
            const inverse = await this.getRate(`${params.toCurrency}/${params.fromCurrency}`);
            if (!inverse)
                throw new Error(`No rate available for ${pair}`);
            effectiveRate = 1 / inverse.bid;
        }
        // Apply spread
        const spreadMultiplier = 1 - this.defaultSpreadBps / 10000;
        const clientRate = effectiveRate * spreadMultiplier;
        const toAmount = BigInt(Math.floor(Number(params.fromAmount) * clientRate));
        const id = (0, uuid_1.v4)();
        await connection_1.db.query(`INSERT INTO fx_conversions (id, from_currency, to_currency, from_amount, to_amount, rate, spread_bps, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'quoted')`, [id, params.fromCurrency, params.toCurrency, params.fromAmount.toString(), toAmount.toString(), clientRate, this.defaultSpreadBps]);
        // Lock the rate in Redis
        await redis_1.redis.setex(`fx:lock:${id}`, this.rateLockTtlSeconds, JSON.stringify({ rate: clientRate, fromAmount: params.fromAmount.toString(), toAmount: toAmount.toString() }));
        return { id, fromCurrency: params.fromCurrency, toCurrency: params.toCurrency, fromAmount: params.fromAmount, toAmount, rate: clientRate, spreadBps: this.defaultSpreadBps, status: 'quoted' };
    }
    /**
     * Execute a quoted FX conversion atomically (PvP — both legs settle or neither).
     */
    async executeConversion(conversionId, fromAccountId, toAccountId) {
        // Check rate lock
        const lockKey = `fx:lock:${conversionId}`;
        const locked = await redis_1.redis.get(lockKey);
        if (!locked)
            throw new Error('Quote expired — rate lock has elapsed');
        const lockData = JSON.parse(locked);
        await (0, connection_1.withSerializableTransaction)(async (client) => {
            const { rows } = await client.query(`SELECT * FROM fx_conversions WHERE id=$1 AND status='quoted' FOR UPDATE`, [conversionId]);
            if (!rows[0])
                throw new Error('Conversion not found or already executed');
            await client.query(`UPDATE fx_conversions SET status='executing', updated_at=NOW() WHERE id=$1`, [conversionId]);
            // Create PvP journal entry — atomic two-leg settlement
            const journalId = (0, uuid_1.v4)();
            await client.query(`INSERT INTO journal_entries (id, idempotency_key, description, status, external_ref, external_ref_type)
         VALUES ($1,$2,$3,'posted',$4,'fx_conversion')`, [journalId, `fx_${conversionId}`, `FX conversion ${rows[0].from_currency}→${rows[0].to_currency}`, conversionId]);
            // Debit source currency from sender
            await client.query(`INSERT INTO ledger_entries (journal_entry_id, account_id, amount, direction, currency)
         VALUES ($1,$2,$3,'debit',$4)`, [journalId, fromAccountId, lockData.fromAmount, rows[0].from_currency]);
            // Credit target currency to receiver
            await client.query(`INSERT INTO ledger_entries (journal_entry_id, account_id, amount, direction, currency)
         VALUES ($1,$2,$3,'credit',$4)`, [journalId, toAccountId, lockData.toAmount, rows[0].to_currency]);
            await client.query(`UPDATE fx_conversions SET status='settled', updated_at=NOW() WHERE id=$1`, [conversionId]);
        });
        await redis_1.redis.del(lockKey);
        config_1.logger.info({ conversionId }, 'FX conversion settled');
    }
    async getConversion(id) {
        const result = await connection_1.db.query(`SELECT * FROM fx_conversions WHERE id=$1`, [id]);
        if (!result.rows[0])
            return null;
        const r = result.rows[0];
        return { id: r.id, fromCurrency: r.from_currency, toCurrency: r.to_currency, fromAmount: BigInt(r.from_amount), toAmount: BigInt(r.to_amount), rate: r.rate, spreadBps: r.spread_bps, status: r.status };
    }
    async getSupportedPairs() {
        const result = await connection_1.db.query(`SELECT DISTINCT pair FROM fx_rates WHERE created_at > NOW() - INTERVAL '10 minutes'`);
        return result.rows.map((r) => r.pair);
    }
}
exports.FXService = FXService;
//# sourceMappingURL=fx-service.js.map