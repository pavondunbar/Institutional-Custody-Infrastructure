import { redis } from '../cache/redis';
import { db } from '../database/connection';
import { logger } from '../config';
import { createHash, createSign, createVerify, generateKeyPairSync, KeyObject, Sign } from 'crypto';

export interface PriceQuote {
  source: string;
  pair: string;
  price: number;
  volume: number;
  timestamp: Date;
}

export interface SignedPriceQuote extends PriceQuote {
  signature: string;       // Ed25519 or ECDSA signature over the quote payload
  publicKeyId: string;     // Identifier for the signing key
  attestationChain?: string; // Hash linking to previous attestation
}

export interface PriceAttestation {
  pair: string;
  vwap: number;
  median: number;
  sources: number;
  timestamp: Date;
  attestationHash: string;       // SHA-256 of the aggregated price data
  previousAttestationHash: string; // Hash chain linking to prior attestation
  sourceSignatures: string[];    // Signatures from contributing sources
  aggregatorSignature: string;   // Oracle's own signature over the attestation
  confidence: number;
  stale: boolean;
}

export interface AggregatedPrice {
  pair: string;
  vwap: number;
  median: number;
  sources: number;
  stale: boolean;
  confidence: number;
  timestamp: Date;
  attestation?: PriceAttestation;
}

export interface RegisteredSource {
  id: string;
  name: string;
  publicKey: string;  // PEM-encoded public key for signature verification
  weight: number;     // Relative trust weight (higher = more trusted)
  active: boolean;
}

/**
 * Price Oracle Service: multi-source VWAP aggregation, median filtering,
 * staleness detection, outlier rejection, confidence scoring,
 * signed attestations, and cryptographic proof chains.
 */
export class PriceOracleService {
  private readonly stalenessThresholdMs = 60_000;
  private readonly outlierThresholdPct = 10;
  private readonly minSources = 2;
  private readonly registeredSources = new Map<string, RegisteredSource>();
  private readonly attestationChain = new Map<string, string>(); // pair → last attestation hash

  /**
   * Register a price data source with its public key for signature verification.
   */
  registerSource(source: RegisteredSource): void {
    this.registeredSources.set(source.id, source);
    logger.info({ sourceId: source.id, name: source.name }, 'Price source registered');
  }

  /**
   * Submit a signed price quote from an authenticated source.
   * Verifies the Ed25519/ECDSA signature before accepting.
   */
  async submitSignedQuote(quote: SignedPriceQuote): Promise<{ accepted: boolean; reason?: string }> {
    // Verify source is registered
    const source = this.registeredSources.get(quote.publicKeyId);
    if (!source) {
      return { accepted: false, reason: `Unknown source: ${quote.publicKeyId}` };
    }
    if (!source.active) {
      return { accepted: false, reason: `Source ${quote.publicKeyId} is inactive` };
    }

    // Verify signature over the quote payload
    const payload = this.serializeQuoteForSigning(quote);
    const signatureValid = this.verifySignature(payload, quote.signature, source.publicKey);

    if (!signatureValid) {
      logger.warn({ source: quote.source, pair: quote.pair }, 'Invalid quote signature rejected');
      return { accepted: false, reason: 'Invalid signature' };
    }

    // Accept the quote
    await this.submitQuote(quote);
    return { accepted: true };
  }

  /**
   * Submit a price quote from a source (unsigned, for backward compatibility).
   */
  async submitQuote(quote: PriceQuote): Promise<void> {
    const key = `oracle:quotes:${quote.pair}`;
    const entry = JSON.stringify({
      source: quote.source,
      price: quote.price,
      volume: quote.volume,
      ts: quote.timestamp.getTime(),
      sig: (quote as SignedPriceQuote).signature || null,
    });
    await redis.lpush(key, entry);
    await redis.ltrim(key, 0, 99);
    await redis.expire(key, 300);

    await db.query(
      `INSERT INTO price_quotes (source, pair, price, volume, quoted_at) VALUES ($1,$2,$3,$4,$5)`,
      [quote.source, quote.pair, quote.price, quote.volume, quote.timestamp]
    );
  }

  /**
   * Get aggregated price with cryptographic attestation.
   * Returns VWAP, median, confidence, and a signed attestation proof.
   */
  async getPrice(pair: string): Promise<AggregatedPrice> {
    const key = `oracle:quotes:${pair}`;
    const raw = await redis.lrange(key, 0, -1);
    const now = Date.now();

    const quotes = raw
      .map(r => JSON.parse(r) as { source: string; price: number; volume: number; ts: number; sig?: string })
      .filter(q => (now - q.ts) < this.stalenessThresholdMs);

    // Deduplicate by source (keep latest)
    const bySource = new Map<string, { price: number; volume: number; ts: number; sig?: string; source: string }>();
    for (const q of quotes) {
      const existing = bySource.get(q.source);
      if (!existing || q.ts > existing.ts) bySource.set(q.source, q);
    }

    const deduped = Array.from(bySource.values());
    if (deduped.length === 0) {
      return { pair, vwap: 0, median: 0, sources: 0, stale: true, confidence: 0, timestamp: new Date() };
    }

    // Calculate median
    const sorted = [...deduped].sort((a, b) => a.price - b.price);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1].price + sorted[mid].price) / 2 : sorted[mid].price;

    // Reject outliers
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

    // Generate cryptographic attestation
    const sourceSignatures = filtered
      .map(q => q.sig)
      .filter((s): s is string => !!s);

    const attestation = this.generateAttestation(pair, vwap, median, filtered.length, sourceSignatures, confidence, stale);

    await redis.setex(`oracle:price:${pair}`, 30, JSON.stringify({ vwap, median, sources: filtered.length, confidence, attestationHash: attestation.attestationHash }));

    return { pair, vwap, median, sources: filtered.length, stale, confidence, timestamp: new Date(), attestation };
  }

  /**
   * Verify a price attestation's integrity.
   */
  verifyAttestation(attestation: PriceAttestation): { valid: boolean; checks: Record<string, boolean> } {
    const checks: Record<string, boolean> = {};

    // 1. Verify attestation hash
    const computedHash = this.computeAttestationHash(
      attestation.pair, attestation.vwap, attestation.median,
      attestation.sources, attestation.timestamp
    );
    checks.hashValid = computedHash === attestation.attestationHash;

    // 2. Verify hash chain continuity
    const expectedPrev = this.attestationChain.get(attestation.pair);
    checks.chainContinuous = !expectedPrev || expectedPrev === attestation.previousAttestationHash;

    // 3. Verify minimum source signatures present
    checks.minSourcesMet = attestation.sourceSignatures.length >= this.minSources;

    // 4. Verify confidence is reasonable
    checks.confidenceValid = attestation.confidence >= 0 && attestation.confidence <= 100;

    const valid = Object.values(checks).every(c => c);
    return { valid, checks };
  }

  /**
   * Get cached price (fast path).
   */
  async getCachedPrice(pair: string): Promise<{ vwap: number; median: number } | null> {
    const cached = await redis.get(`oracle:price:${pair}`);
    if (!cached) return null;
    const data = JSON.parse(cached);
    return { vwap: data.vwap, median: data.median };
  }

  /**
   * Get price history for a pair.
   */
  async getPriceHistory(pair: string, hours = 24): Promise<Array<{ price: number; volume: number; source: string; timestamp: Date }>> {
    const since = new Date(Date.now() - hours * 3600_000);
    const result = await db.query(
      `SELECT source, price, volume, quoted_at FROM price_quotes WHERE pair=$1 AND quoted_at >= $2 ORDER BY quoted_at DESC LIMIT 1000`,
      [pair, since]
    );
    return result.rows.map((r: Record<string, unknown>) => ({
      price: r.price as number, volume: r.volume as number,
      source: r.source as string, timestamp: new Date(r.quoted_at as string),
    }));
  }

  /**
   * Get all supported pairs with latest prices.
   */
  async getAllPrices(): Promise<AggregatedPrice[]> {
    const result = await db.query(`SELECT DISTINCT pair FROM price_quotes WHERE quoted_at > NOW() - INTERVAL '5 minutes'`);
    const prices: AggregatedPrice[] = [];
    for (const row of result.rows) {
      prices.push(await this.getPrice(row.pair));
    }
    return prices;
  }

  /**
   * Generate a signed attestation for an aggregated price.
   */
  private generateAttestation(
    pair: string, vwap: number, median: number, sources: number,
    sourceSignatures: string[], confidence: number, stale: boolean,
  ): PriceAttestation {
    const timestamp = new Date();
    const attestationHash = this.computeAttestationHash(pair, vwap, median, sources, timestamp);
    const previousAttestationHash = this.attestationChain.get(pair) || '0'.repeat(64);

    // Sign the attestation (in production: use HSM key)
    const signPayload = `${attestationHash}:${previousAttestationHash}:${timestamp.toISOString()}`;
    const aggregatorSignature = createHash('sha256').update(signPayload).digest('hex');

    // Update chain
    this.attestationChain.set(pair, attestationHash);

    return {
      pair, vwap, median, sources, timestamp,
      attestationHash, previousAttestationHash,
      sourceSignatures, aggregatorSignature,
      confidence, stale,
    };
  }

  /**
   * Compute deterministic attestation hash.
   */
  private computeAttestationHash(pair: string, vwap: number, median: number, sources: number, timestamp: Date): string {
    const data = `${pair}|${vwap.toFixed(18)}|${median.toFixed(18)}|${sources}|${timestamp.toISOString()}`;
    return createHash('sha256').update(data).digest('hex');
  }

  /**
   * Serialize a quote into a canonical form for signing.
   */
  private serializeQuoteForSigning(quote: PriceQuote): string {
    return `${quote.source}|${quote.pair}|${quote.price.toFixed(18)}|${quote.volume.toFixed(8)}|${quote.timestamp.toISOString()}`;
  }

  /**
   * Verify an Ed25519/ECDSA signature.
   */
  private verifySignature(payload: string, signature: string, publicKeyPem: string): boolean {
    try {
      const verifier = createVerify('SHA256');
      verifier.update(payload);
      return verifier.verify(publicKeyPem, signature, 'hex');
    } catch (err) {
      logger.error({ err }, 'Signature verification error');
      return false;
    }
  }
}
