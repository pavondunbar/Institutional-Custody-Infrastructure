import { redis } from '../cache/redis';
import { logger } from '../config';
import { db } from '../database/connection';

export type NodeStatus = 'healthy' | 'degraded' | 'unhealthy' | 'offline';
export type InfraComponent = 'rpc_node' | 'validator' | 'database' | 'cache' | 'message_broker' | 'api_gateway';

export interface NodeHealth {
  id: string;
  name: string;
  component: InfraComponent;
  endpoint: string;
  status: NodeStatus;
  latencyMs: number;
  blockHeight?: number;
  lastCheckedAt: Date;
  region: string;
}

export interface LoadBalancerConfig {
  nodes: Array<{ endpoint: string; weight: number; healthy: boolean }>;
  strategy: 'round_robin' | 'least_connections' | 'weighted' | 'failover';
  healthCheckIntervalMs: number;
}

/**
 * Infrastructure Engineering: node management, RPC load balancing,
 * health monitoring, capacity planning, geographic failover.
 */
export class InfrastructureService {
  private nodeIndex = 0;

  /**
   * Register an infrastructure node.
   */
  async registerNode(params: { name: string; component: InfraComponent; endpoint: string; region: string; weight?: number }): Promise<void> {
    const key = `infra:node:${params.name}`;
    await redis.hset(key, { component: params.component, endpoint: params.endpoint, region: params.region, weight: String(params.weight || 1), status: 'healthy', registeredAt: new Date().toISOString() });
    await redis.sadd(`infra:nodes:${params.component}`, params.name);
    logger.info({ name: params.name, component: params.component }, 'Infrastructure node registered');
  }

  /**
   * Health check a node — returns latency and status.
   */
  async checkNodeHealth(nodeName: string): Promise<NodeHealth> {
    const key = `infra:node:${nodeName}`;
    const node = await redis.hgetall(key);
    if (!node.endpoint) throw new Error('Node not found');

    const start = Date.now();
    let status: NodeStatus = 'healthy';
    let blockHeight: number | undefined;

    try {
      // For RPC nodes, check block height
      if (node.component === 'rpc_node') {
        const response = await fetch(node.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
          signal: AbortSignal.timeout(5000),
        });
        const data = await response.json() as { result?: string };
        blockHeight = data.result ? parseInt(data.result, 16) : undefined;
      }
    } catch {
      status = 'unhealthy';
    }

    const latencyMs = Date.now() - start;
    if (latencyMs > 2000 && status === 'healthy') status = 'degraded';

    await redis.hset(key, { status, latencyMs: String(latencyMs), lastCheckedAt: new Date().toISOString(), ...(blockHeight !== undefined ? { blockHeight: String(blockHeight) } : {}) });

    return { id: nodeName, name: nodeName, component: node.component as InfraComponent, endpoint: node.endpoint, status, latencyMs, blockHeight, lastCheckedAt: new Date(), region: node.region };
  }

  /**
   * Get next healthy node using load balancing strategy.
   */
  async getHealthyNode(component: InfraComponent, strategy: 'round_robin' | 'failover' | 'least_latency' = 'round_robin'): Promise<string | null> {
    const nodeNames = await redis.smembers(`infra:nodes:${component}`);
    if (nodeNames.length === 0) return null;

    const healthyNodes: Array<{ name: string; latency: number; weight: number }> = [];
    for (const name of nodeNames) {
      const node = await redis.hgetall(`infra:node:${name}`);
      if (node.status === 'healthy' || node.status === 'degraded') {
        healthyNodes.push({ name, latency: parseInt(node.latencyMs || '0'), weight: parseInt(node.weight || '1') });
      }
    }

    if (healthyNodes.length === 0) return null;

    if (strategy === 'failover') return healthyNodes[0].name;
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
  async getCapacityMetrics(): Promise<{ dbConnections: { used: number; max: number }; redisMemory: string; nodeCount: Record<InfraComponent, number> }> {
    const dbResult = await db.query(`SELECT count(*) as active FROM pg_stat_activity WHERE state='active'`);
    const poolMax = 20; // From config
    const redisInfo = await redis.info('memory');
    const memMatch = redisInfo.match(/used_memory_human:(.+)/);

    const components: InfraComponent[] = ['rpc_node', 'validator', 'database', 'cache', 'message_broker', 'api_gateway'];
    const nodeCount: Record<string, number> = {};
    for (const c of components) {
      nodeCount[c] = (await redis.smembers(`infra:nodes:${c}`)).length;
    }

    return {
      dbConnections: { used: parseInt(dbResult.rows[0].active), max: poolMax },
      redisMemory: memMatch?.[1]?.trim() || 'unknown',
      nodeCount: nodeCount as Record<InfraComponent, number>,
    };
  }

  /**
   * Geographic failover — switch traffic to another region.
   */
  async failoverToRegion(component: InfraComponent, targetRegion: string): Promise<{ switchedNodes: number }> {
    const nodeNames = await redis.smembers(`infra:nodes:${component}`);
    let switchedNodes = 0;

    for (const name of nodeNames) {
      const node = await redis.hgetall(`infra:node:${name}`);
      if (node.region === targetRegion) {
        await redis.hset(`infra:node:${name}`, 'weight', '10'); // Boost weight
        switchedNodes++;
      } else {
        await redis.hset(`infra:node:${name}`, 'weight', '0'); // Zero weight = no traffic
      }
    }

    logger.warn({ component, targetRegion, switchedNodes }, 'Geographic failover executed');
    return { switchedNodes };
  }
}
