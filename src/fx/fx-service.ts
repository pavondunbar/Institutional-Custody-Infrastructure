import { db, withSerializableTransaction } from '../database/connection';
import { redis } from '../cache/redis';
import { logger } from '../config';
import { v4 as uuidv4 } from 'uuid';

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
export class FXService {
  private readonly defaultSpreadBps = 50; // 50bps = 0.5%
  private readonly rateLockTtlSeconds = 30;

  /**
   * Submit an FX rate from a provider.
   */
  async submitRate(params: { pair: string; bid: number; ask: number; source: string }): Promise<void> {
    const mid = (params.bid + params.ask) / 2;
    const spread = (params.ask - params.bid) / mid * 10000; // in bps
    const key = `fx:rate:${params.pair}`;
    await redis.hset(key, { bid: String(params.bid), ask: String(params.ask), mid: String(mid), spread: String(spread), source: params.source, ts: String(Date.now()) });
    await redis.expire(key, 120); // 2min TTL

    await db.query(
      `INSERT INTO fx_rates (pair, bid, ask, mid, spread_bps, source) VALUES ($1,$2,$3,$4,$5,$6)`,
      [params.pair, params.bid, params.ask, mid, Math.round(spread), params.source]
    );
  }

  /**
   * Get current rate for a pair.
   */
  async getRate(pair: string): Promise<FXRate | null> {
    const key = `fx:rate:${pair}`;
    const data = await redis.hgetall(key);
    if (!data.mid) return null;
    return { pair, bid: parseFloat(data.bid), ask: parseFloat(data.ask), mid: parseFloat(data.mid), spread: parseFloat(data.spread), source: data.source, timestamp: new Date(parseInt(data.ts)) };
  }

  /**
   * Get a locked quote (rate guaranteed for rateLockTtlSeconds).
   */
  async getQuote(params: { fromCurrency: string; toCurrency: string; fromAmount: bigint }): Promise<FXConversion> {
    const pair = `${params.fromCurrency}/${params.toCurrency}`;
    const rate = await this.getRate(pair);

    // Try inverse pair if direct not found
    let effectiveRate: number;
    if (rate) {
      effectiveRate = rate.ask; // Client buys at ask
    } else {
      const inverse = await this.getRate(`${params.toCurrency}/${params.fromCurrency}`);
      if (!inverse) throw new Error(`No rate available for ${pair}`);
      effectiveRate = 1 / inverse.bid;
    }

    // Apply spread
    const spreadMultiplier = 1 - this.defaultSpreadBps / 10000;
    const clientRate = effectiveRate * spreadMultiplier;
    const toAmount = BigInt(Math.floor(Number(params.fromAmount) * clientRate));

    const id = uuidv4();
    await db.query(
      `INSERT INTO fx_conversions (id, from_currency, to_currency, from_amount, to_amount, rate, spread_bps, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'quoted')`,
      [id, params.fromCurrency, params.toCurrency, params.fromAmount.toString(), toAmount.toString(), clientRate, this.defaultSpreadBps]
    );

    // Lock the rate in Redis
    await redis.setex(`fx:lock:${id}`, this.rateLockTtlSeconds, JSON.stringify({ rate: clientRate, fromAmount: params.fromAmount.toString(), toAmount: toAmount.toString() }));

    return { id, fromCurrency: params.fromCurrency, toCurrency: params.toCurrency, fromAmount: params.fromAmount, toAmount, rate: clientRate, spreadBps: this.defaultSpreadBps, status: 'quoted' };
  }

  /**
   * Execute a quoted FX conversion atomically (PvP — both legs settle or neither).
   */
  async executeConversion(conversionId: string, fromAccountId: string, toAccountId: string): Promise<void> {
    // Check rate lock
    const lockKey = `fx:lock:${conversionId}`;
    const locked = await redis.get(lockKey);
    if (!locked) throw new Error('Quote expired — rate lock has elapsed');

    const lockData = JSON.parse(locked);

    await withSerializableTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM fx_conversions WHERE id=$1 AND status='quoted' FOR UPDATE`, [conversionId]);
      if (!rows[0]) throw new Error('Conversion not found or already executed');

      await client.query(`UPDATE fx_conversions SET status='executing', updated_at=NOW() WHERE id=$1`, [conversionId]);

      // Create PvP journal entry — atomic two-leg settlement
      const journalId = uuidv4();
      await client.query(
        `INSERT INTO journal_entries (id, idempotency_key, description, status, external_ref, external_ref_type)
         VALUES ($1,$2,$3,'posted',$4,'fx_conversion')`,
        [journalId, `fx_${conversionId}`, `FX conversion ${rows[0].from_currency}→${rows[0].to_currency}`, conversionId]
      );

      // Debit source currency from sender
      await client.query(
        `INSERT INTO ledger_entries (journal_entry_id, account_id, amount, direction, currency)
         VALUES ($1,$2,$3,'debit',$4)`,
        [journalId, fromAccountId, lockData.fromAmount, rows[0].from_currency]
      );

      // Credit target currency to receiver
      await client.query(
        `INSERT INTO ledger_entries (journal_entry_id, account_id, amount, direction, currency)
         VALUES ($1,$2,$3,'credit',$4)`,
        [journalId, toAccountId, lockData.toAmount, rows[0].to_currency]
      );

      await client.query(`UPDATE fx_conversions SET status='settled', updated_at=NOW() WHERE id=$1`, [conversionId]);
    });

    await redis.del(lockKey);
    logger.info({ conversionId }, 'FX conversion settled');
  }

  async getConversion(id: string): Promise<FXConversion | null> {
    const result = await db.query(`SELECT * FROM fx_conversions WHERE id=$1`, [id]);
    if (!result.rows[0]) return null;
    const r = result.rows[0];
    return { id: r.id, fromCurrency: r.from_currency, toCurrency: r.to_currency, fromAmount: BigInt(r.from_amount), toAmount: BigInt(r.to_amount), rate: r.rate, spreadBps: r.spread_bps, status: r.status };
  }

  async getSupportedPairs(): Promise<string[]> {
    const result = await db.query(`SELECT DISTINCT pair FROM fx_rates WHERE created_at > NOW() - INTERVAL '10 minutes'`);
    return result.rows.map((r: Record<string, unknown>) => r.pair as string);
  }
}
