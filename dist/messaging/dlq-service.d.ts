export interface DLQEntry {
    id: string;
    originalTopic: string;
    originalKey: string | null;
    payload: string;
    errorMessage: string;
    retryCount: number;
    maxRetries: number;
    nextRetryAt: Date | null;
    status: 'pending' | 'retrying' | 'exhausted' | 'resolved';
}
/**
 * Dead Letter Queue service: captures failed messages, tracks retries with
 * exponential backoff, and enables manual/automatic reprocessing.
 */
export declare class DLQService {
    private producer;
    private consumer;
    private running;
    private retryInterval;
    private readonly maxRetries;
    private readonly baseDelayMs;
    constructor();
    start(): Promise<void>;
    stop(): Promise<void>;
    /**
     * Send a failed message to the dead-letter queue.
     */
    sendToDLQ(params: {
        originalTopic: string;
        key: string | null;
        payload: string;
        error: Error | string;
    }): Promise<string>;
    /**
     * Process retries — picks up messages whose retry time has elapsed.
     */
    processRetries(): Promise<number>;
    /**
     * Manually reprocess a specific DLQ entry.
     */
    reprocess(dlqId: string): Promise<void>;
    getStats(): Promise<{
        pending: number;
        retrying: number;
        exhausted: number;
        resolved: number;
    }>;
    getEntries(status?: string, limit?: number): Promise<DLQEntry[]>;
    private scheduleRetries;
}
//# sourceMappingURL=dlq-service.d.ts.map