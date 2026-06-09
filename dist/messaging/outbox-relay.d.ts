/**
 * Outbox Relay: Polls the transactional outbox table and publishes events to Kafka.
 * Guarantees at-least-once delivery. Failed messages are sent to DLQ.
 */
export declare class OutboxRelay {
    private producer;
    private dlq;
    private running;
    private pollInterval;
    private readonly batchSize;
    private readonly pollMs;
    constructor();
    start(): Promise<void>;
    stop(): Promise<void>;
    private poll;
    private processBatch;
}
//# sourceMappingURL=outbox-relay.d.ts.map