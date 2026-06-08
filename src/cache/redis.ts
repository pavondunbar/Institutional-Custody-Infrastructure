import Redis from 'ioredis';
import { config, logger } from '../config';

export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 100, 3000),
});

redis.on('error', (err) => logger.error(err, 'Redis connection error'));

const KEYS = {
  balance: (accountId: string) => `balance:${accountId}`,
  nonce: (chain: string, address: string) => `nonce:${chain}:${address}`,
  rateLimit: (key: string) => `rl:${key}`,
  blockHeight: (chain: string) => `block:height:${chain}`,
  txStatus: (txHash: string) => `tx:status:${txHash}`,
  tokenDef: (tokenId: string) => `token:def:${tokenId}`,
  holderBalance: (tokenId: string, accountId: string) => `token:holder:${tokenId}:${accountId}`,
  whitelist: (tokenId: string) => `token:whitelist:${tokenId}`,
  tokenSupply: (tokenId: string) => `token:supply:${tokenId}`,
  holderCount: (tokenId: string) => `token:holders:${tokenId}`,
} as const;

/**
 * Balance cache in Redis (read-through cache backed by Postgres balance_cache table)
 */
export const balanceCache = {
  async get(accountId: string): Promise<string | null> {
    return redis.get(KEYS.balance(accountId));
  },

  async set(accountId: string, balance: bigint, ttlSeconds = 60): Promise<void> {
    await redis.setex(KEYS.balance(accountId), ttlSeconds, balance.toString());
  },

  async invalidate(accountId: string): Promise<void> {
    await redis.del(KEYS.balance(accountId));
  },
};

/**
 * Nonce management for blockchain transactions.
 * Prevents nonce conflicts across concurrent transaction submissions.
 */
export const nonceManager = {
  async getAndIncrement(chain: string, address: string): Promise<number> {
    const val = await redis.incr(KEYS.nonce(chain, address));
    return val - 1;
  },

  async set(chain: string, address: string, nonce: number): Promise<void> {
    await redis.set(KEYS.nonce(chain, address), nonce);
  },

  async get(chain: string, address: string): Promise<number | null> {
    const val = await redis.get(KEYS.nonce(chain, address));
    return val ? parseInt(val, 10) : null;
  },
};

/**
 * Sliding window rate limiter.
 */
export const rateLimiter = {
  async check(key: string, maxRequests: number, windowSeconds: number): Promise<boolean> {
    const redisKey = KEYS.rateLimit(key);
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(redisKey, 0, windowStart);
    pipeline.zadd(redisKey, now, `${now}`);
    pipeline.zcard(redisKey);
    pipeline.expire(redisKey, windowSeconds);
    const results = await pipeline.exec();

    const count = results?.[2]?.[1] as number;
    return count <= maxRequests;
  },
};

/**
 * Block height tracking for indexer progress.
 */
export const blockTracker = {
  async getHeight(chain: string): Promise<number> {
    const val = await redis.get(KEYS.blockHeight(chain));
    return val ? parseInt(val, 10) : 0;
  },

  async setHeight(chain: string, height: number): Promise<void> {
    await redis.set(KEYS.blockHeight(chain), height);
  },
};

/**
 * Transaction status cache for quick lookups.
 */
export const txStatusCache = {
  async get(txHash: string): Promise<string | null> {
    return redis.get(KEYS.txStatus(txHash));
  },

  async set(txHash: string, status: string, ttlSeconds = 300): Promise<void> {
    await redis.setex(KEYS.txStatus(txHash), ttlSeconds, status);
  },
};

/**
 * Token definition cache (read-through, 5-minute TTL).
 */
export const tokenCache = {
  async get(tokenId: string): Promise<string | null> {
    return redis.get(KEYS.tokenDef(tokenId));
  },

  async set(tokenId: string, data: string, ttlSeconds = 300): Promise<void> {
    await redis.setex(KEYS.tokenDef(tokenId), ttlSeconds, data);
  },

  async invalidate(tokenId: string): Promise<void> {
    await redis.del(KEYS.tokenDef(tokenId));
  },
};

/**
 * Whitelist cache per token (set of allowed addresses).
 */
export const whitelistCache = {
  async getAll(tokenId: string): Promise<string[]> {
    return redis.smembers(KEYS.whitelist(tokenId));
  },

  async isMember(tokenId: string, address: string): Promise<boolean> {
    const result = await redis.sismember(KEYS.whitelist(tokenId), address);
    return result === 1;
  },

  async add(tokenId: string, address: string): Promise<void> {
    await redis.sadd(KEYS.whitelist(tokenId), address);
  },

  async remove(tokenId: string, address: string): Promise<void> {
    await redis.srem(KEYS.whitelist(tokenId), address);
  },

  async invalidate(tokenId: string): Promise<void> {
    await redis.del(KEYS.whitelist(tokenId));
  },
};

/**
 * Token supply cache (total_minted - total_burned).
 */
export const tokenSupplyCache = {
  async get(tokenId: string): Promise<string | null> {
    return redis.get(KEYS.tokenSupply(tokenId));
  },

  async set(tokenId: string, supply: bigint, ttlSeconds = 60): Promise<void> {
    await redis.setex(KEYS.tokenSupply(tokenId), ttlSeconds, supply.toString());
  },

  async invalidate(tokenId: string): Promise<void> {
    await redis.del(KEYS.tokenSupply(tokenId));
  },
};
