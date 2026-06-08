import Redis from 'ioredis';
export declare const redis: Redis;
/**
 * Balance cache in Redis (read-through cache backed by Postgres balance_cache table)
 */
export declare const balanceCache: {
    get(accountId: string): Promise<string | null>;
    set(accountId: string, balance: bigint, ttlSeconds?: number): Promise<void>;
    invalidate(accountId: string): Promise<void>;
};
/**
 * Nonce management for blockchain transactions.
 * Prevents nonce conflicts across concurrent transaction submissions.
 */
export declare const nonceManager: {
    getAndIncrement(chain: string, address: string): Promise<number>;
    set(chain: string, address: string, nonce: number): Promise<void>;
    get(chain: string, address: string): Promise<number | null>;
};
/**
 * Sliding window rate limiter.
 */
export declare const rateLimiter: {
    check(key: string, maxRequests: number, windowSeconds: number): Promise<boolean>;
};
/**
 * Block height tracking for indexer progress.
 */
export declare const blockTracker: {
    getHeight(chain: string): Promise<number>;
    setHeight(chain: string, height: number): Promise<void>;
};
/**
 * Transaction status cache for quick lookups.
 */
export declare const txStatusCache: {
    get(txHash: string): Promise<string | null>;
    set(txHash: string, status: string, ttlSeconds?: number): Promise<void>;
};
/**
 * Token definition cache (read-through, 5-minute TTL).
 */
export declare const tokenCache: {
    get(tokenId: string): Promise<string | null>;
    set(tokenId: string, data: string, ttlSeconds?: number): Promise<void>;
    invalidate(tokenId: string): Promise<void>;
};
/**
 * Whitelist cache per token (set of allowed addresses).
 */
export declare const whitelistCache: {
    getAll(tokenId: string): Promise<string[]>;
    isMember(tokenId: string, address: string): Promise<boolean>;
    add(tokenId: string, address: string): Promise<void>;
    remove(tokenId: string, address: string): Promise<void>;
    invalidate(tokenId: string): Promise<void>;
};
/**
 * Token supply cache (total_minted - total_burned).
 */
export declare const tokenSupplyCache: {
    get(tokenId: string): Promise<string | null>;
    set(tokenId: string, supply: bigint, ttlSeconds?: number): Promise<void>;
    invalidate(tokenId: string): Promise<void>;
};
//# sourceMappingURL=redis.d.ts.map