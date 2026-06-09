"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InfrastructureService = void 0;
const redis_1 = require("../cache/redis");
const config_1 = require("../config");
const connection_1 = require("../database/connection");
/**
 * Infrastructure Engineering: node management, RPC load balancing,
 * health monitoring, capacity planning, geographic failover.
 */
class InfrastructureService {
    nodeIndex = 0;
    /**
     * Register an infrastructure node.
     */
    async registerNode(params) {
        const key = `infra:node:${params.name}`;
        await redis_1.redis.hset(key, { component: params.component, endpoint: params.endpoint, region: params.region, weight: String(params.weight || 1), status: 'healthy', registeredAt: new Date().toISOString() });
        await redis_1.redis.sadd(`infra:nodes:${params.component}`, params.name);
        config_1.logger.info({ name: params.name, component: params.component }, 'Infrastructure node registered');
    }
    /**
     * Health check a node — returns latency and status.
     */
    async checkNodeHealth(nodeName) {
        const key = `infra:node:${nodeName}`;
        const node = await redis_1.redis.hgetall(key);
        if (!node.endpoint)
            throw new Error('Node not found');
        const start = Date.now();
        let status = 'healthy';
        let blockHeight;
        try {
            // For RPC nodes, check block height
            if (node.component === 'rpc_node') {
                const response = await fetch(node.endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
                    signal: AbortSignal.timeout(5000),
                });
                const data = await response.json();
                blockHeight = data.result ? parseInt(data.result, 16) : undefined;
            }
        }
        catch {
            status = 'unhealthy';
        }
        const latencyMs = Date.now() - start;
        if (latencyMs > 2000 && status === 'healthy')
            status = 'degraded';
        await redis_1.redis.hset(key, { status, latencyMs: String(latencyMs), lastCheckedAt: new Date().toISOString(), ...(blockHeight !== undefined ? { blockHeight: String(blockHeight) } : {}) });
        return { id: nodeName, name: nodeName, component: node.component, endpoint: node.endpoint, status, latencyMs, blockHeight, lastCheckedAt: new Date(), region: node.region };
    }
    /**
     * Get next healthy node using load balancing strategy.
     */
    async getHealthyNode(component, strategy = 'round_robin') {
        const nodeNames = await redis_1.redis.smembers(`infra:nodes:${component}`);
        if (nodeNames.length === 0)
            return null;
        const healthyNodes = [];
        for (const name of nodeNames) {
            const node = await redis_1.redis.hgetall(`infra:node:${name}`);
            if (node.status === 'healthy' || node.status === 'degraded') {
                healthyNodes.push({ name, latency: parseInt(node.latencyMs || '0'), weight: parseInt(node.weight || '1') });
            }
        }
        if (healthyNodes.length === 0)
            return null;
        if (strategy === 'failover')
            return healthyNodes[0].name;
        if (strategy === 'least_latency') {
            healthyNodes.sort((a, b) => a.latency - b.latency);
            return healthyNodes[0].name;
        }
        // Round robin
        this.nodeIndex = (this.nodeIndex + 1) % healthyNodes.length;
        return healthyNodes[this.nodeIndex].name;
    }
    /**
     * Get capacity metrics for planning.
     */
    async getCapacityMetrics() {
        const dbResult = await connection_1.db.query(`SELECT count(*) as active FROM pg_stat_activity WHERE state='active'`);
        const poolMax = 20; // From config
        const redisInfo = await redis_1.redis.info('memory');
        const memMatch = redisInfo.match(/used_memory_human:(.+)/);
        const components = ['rpc_node', 'validator', 'database', 'cache', 'message_broker', 'api_gateway'];
        const nodeCount = {};
        for (const c of components) {
            nodeCount[c] = (await redis_1.redis.smembers(`infra:nodes:${c}`)).length;
        }
        return {
            dbConnections: { used: parseInt(dbResult.rows[0].active), max: poolMax },
            redisMemory: memMatch?.[1]?.trim() || 'unknown',
            nodeCount: nodeCount,
        };
    }
    /**
     * Geographic failover — switch traffic to another region.
     */
    async failoverToRegion(component, targetRegion) {
        const nodeNames = await redis_1.redis.smembers(`infra:nodes:${component}`);
        let switchedNodes = 0;
        for (const name of nodeNames) {
            const node = await redis_1.redis.hgetall(`infra:node:${name}`);
            if (node.region === targetRegion) {
                await redis_1.redis.hset(`infra:node:${name}`, 'weight', '10'); // Boost weight
                switchedNodes++;
            }
            else {
                await redis_1.redis.hset(`infra:node:${name}`, 'weight', '0'); // Zero weight = no traffic
            }
        }
        config_1.logger.warn({ component, targetRegion, switchedNodes }, 'Geographic failover executed');
        return { switchedNodes };
    }
}
exports.InfrastructureService = InfrastructureService;
//# sourceMappingURL=infrastructure-service.js.map