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
    nodes: Array<{
        endpoint: string;
        weight: number;
        healthy: boolean;
    }>;
    strategy: 'round_robin' | 'least_connections' | 'weighted' | 'failover';
    healthCheckIntervalMs: number;
}
/**
 * Infrastructure Engineering: node management, RPC load balancing,
 * health monitoring, capacity planning, geographic failover.
 */
export declare class InfrastructureService {
    private nodeIndex;
    /**
     * Register an infrastructure node.
     */
    registerNode(params: {
        name: string;
        component: InfraComponent;
        endpoint: string;
        region: string;
        weight?: number;
    }): Promise<void>;
    /**
     * Health check a node — returns latency and status.
     */
    checkNodeHealth(nodeName: string): Promise<NodeHealth>;
    /**
     * Get next healthy node using load balancing strategy.
     */
    getHealthyNode(component: InfraComponent, strategy?: 'round_robin' | 'failover' | 'least_latency'): Promise<string | null>;
    /**
     * Get capacity metrics for planning.
     */
    getCapacityMetrics(): Promise<{
        dbConnections: {
            used: number;
            max: number;
        };
        redisMemory: string;
        nodeCount: Record<InfraComponent, number>;
    }>;
    /**
     * Geographic failover — switch traffic to another region.
     */
    failoverToRegion(component: InfraComponent, targetRegion: string): Promise<{
        switchedNodes: number;
    }>;
}
//# sourceMappingURL=infrastructure-service.d.ts.map