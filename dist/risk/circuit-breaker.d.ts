type CircuitState = 'closed' | 'open' | 'half_open';
/**
 * Circuit breaker pattern for service protection.
 * States: closed (normal) -> open (failing) -> half_open (testing) -> closed
 */
export declare class CircuitBreaker {
    getState(serviceName: string): Promise<{
        state: CircuitState;
        failureCount: number;
    }>;
    /**
     * Check if a service call is allowed.
     */
    isAllowed(serviceName: string): Promise<boolean>;
    /**
     * Record a successful call.
     */
    recordSuccess(serviceName: string): Promise<void>;
    /**
     * Record a failed call. Opens the circuit if threshold exceeded.
     */
    recordFailure(serviceName: string): Promise<void>;
    /**
     * Force the circuit to a specific state.
     */
    forceState(serviceName: string, state: CircuitState): Promise<void>;
    /**
     * Reset the circuit breaker to closed state.
     */
    reset(serviceName: string): Promise<void>;
    getAllStates(): Promise<any[]>;
    private transition;
}
/**
 * Kill switch service for emergency feature shutdown.
 */
export declare class KillSwitchService {
    isActive(feature: string): Promise<boolean>;
    activate(feature: string, userId: string, reason: string, autoReactivateAfterHours?: number): Promise<void>;
    deactivate(feature: string): Promise<void>;
    getAllSwitches(): Promise<any[]>;
}
export {};
//# sourceMappingURL=circuit-breaker.d.ts.map