"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tokenSupplyCache = exports.whitelistCache = exports.tokenCache = exports.txStatusCache = exports.blockTracker = exports.rateLimiter = exports.nonceManager = exports.balanceCache = exports.redis = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
const config_1 = require("../config");
exports.redis = new ioredis_1.default({
    host: config_1.config.redis.host,
    port: config_1.config.redis.port,
    password: config_1.config.redis.password,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 100, 3000),
});
exports.redis.on('error', (err) => config_1.logger.error(err, 'Redis connection error'));
const KEYS = {
    balance: (accountId) => `balance:${accountId}`,
    nonce: (chain, address) => `nonce:${chain}:${address}`,
    rateLimit: (key) => `rl:${key}`,
    blockHeight: (chain) => `block:height:${chain}`,
    txStatus: (txHash) => `tx:status:${txHash}`,
    tokenDef: (tokenId) => `token:def:${tokenId}`,
    holderBalance: (tokenId, accountId) => `token:holder:${tokenId}:${accountId}`,
    whitelist: (tokenId) => `token:whitelist:${tokenId}`,
    tokenSupply: (tokenId) => `token:supply:${tokenId}`,
    holderCount: (tokenId) => `token:holders:${tokenId}`,
};
/**
 * Balance cache in Redis (read-through cache backed by Postgres balance_cache table)
 */
exports.balanceCache = {
    async get(accountId) {
        return exports.redis.get(KEYS.balance(accountId));
    },
    async set(accountId, balance, ttlSeconds = 60) {
        await exports.redis.setex(KEYS.balance(accountId), ttlSeconds, balance.toString());
    },
    async invalidate(accountId) {
        await exports.redis.del(KEYS.balance(accountId));
    },
};
/**
 * Nonce management for blockchain transactions.
 * Prevents nonce conflicts across concurrent transaction submissions.
 */
exports.nonceManager = {
    async getAndIncrement(chain, address) {
        const val = await exports.redis.incr(KEYS.nonce(chain, address));
        return val - 1;
    },
    async set(chain, address, nonce) {
        await exports.redis.set(KEYS.nonce(chain, address), nonce);
    },
    async get(chain, address) {
        const val = await exports.redis.get(KEYS.nonce(chain, address));
        return val ? parseInt(val, 10) : null;
    },
};
/**
 * Sliding window rate limiter.
 */
exports.rateLimiter = {
    async check(key, maxRequests, windowSeconds) {
        const redisKey = KEYS.rateLimit(key);
        const now = Date.now();
        const windowStart = now - windowSeconds * 1000;
        const pipeline = exports.redis.pipeline();
        pipeline.zremrangebyscore(redisKey, 0, windowStart);
        pipeline.zadd(redisKey, now, `${now}`);
        pipeline.zcard(redisKey);
        pipeline.expire(redisKey, windowSeconds);
        const results = await pipeline.exec();
        const count = results?.[2]?.[1];
        return count <= maxRequests;
    },
};
/**
 * Block height tracking for indexer progress.
 */
exports.blockTracker = {
    async getHeight(chain) {
        const val = await exports.redis.get(KEYS.blockHeight(chain));
        return val ? parseInt(val, 10) : 0;
    },
    async setHeight(chain, height) {
        await exports.redis.set(KEYS.blockHeight(chain), height);
    },
};
/**
 * Transaction status cache for quick lookups.
 */
exports.txStatusCache = {
    async get(txHash) {
        return exports.redis.get(KEYS.txStatus(txHash));
    },
    async set(txHash, status, ttlSeconds = 300) {
        await exports.redis.setex(KEYS.txStatus(txHash), ttlSeconds, status);
    },
};
/**
 * Token definition cache (read-through, 5-minute TTL).
 */
exports.tokenCache = {
    async get(tokenId) {
        return exports.redis.get(KEYS.tokenDef(tokenId));
    },
    async set(tokenId, data, ttlSeconds = 300) {
        await exports.redis.setex(KEYS.tokenDef(tokenId), ttlSeconds, data);
    },
    async invalidate(tokenId) {
        await exports.redis.del(KEYS.tokenDef(tokenId));
    },
};
/**
 * Whitelist cache per token (set of allowed addresses).
 */
exports.whitelistCache = {
    async getAll(tokenId) {
        return exports.redis.smembers(KEYS.whitelist(tokenId));
    },
    async isMember(tokenId, address) {
        const result = await exports.redis.sismember(KEYS.whitelist(tokenId), address);
        return result === 1;
    },
    async add(tokenId, address) {
        await exports.redis.sadd(KEYS.whitelist(tokenId), address);
    },
    async remove(tokenId, address) {
        await exports.redis.srem(KEYS.whitelist(tokenId), address);
    },
    async invalidate(tokenId) {
        await exports.redis.del(KEYS.whitelist(tokenId));
    },
};
/**
 * Token supply cache (total_minted - total_burned).
 */
exports.tokenSupplyCache = {
    async get(tokenId) {
        return exports.redis.get(KEYS.tokenSupply(tokenId));
    },
    async set(tokenId, supply, ttlSeconds = 60) {
        await exports.redis.setex(KEYS.tokenSupply(tokenId), ttlSeconds, supply.toString());
    },
    async invalidate(tokenId) {
        await exports.redis.del(KEYS.tokenSupply(tokenId));
    },
};
//# sourceMappingURL=redis.js.map