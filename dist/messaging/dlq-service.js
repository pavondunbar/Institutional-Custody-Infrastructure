"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DLQService = void 0;
const kafkajs_1 = require("kafkajs");
const connection_1 = require("../database/connection");
const config_1 = require("../config");
/**
 * Dead Letter Queue service: captures failed messages, tracks retries with
 * exponential backoff, and enables manual/automatic reprocessing.
 */
class DLQService {
    producer;
    consumer = null;
    running = false;
    retryInterval = null;
    maxRetries = 5;
    baseDelayMs = 1000;
    constructor() {
        const kafka = new kafkajs_1.Kafka({ clientId: `${config_1.config.kafka.clientId}-dlq`, brokers: config_1.config.kafka.brokers });
        this.producer = kafka.producer({ idempotent: true });
    }
    async start() {
        await this.producer.connect();
        this.running = true;
        this.scheduleRetries();
        config_1.logger.info('DLQ service started');
    }
    async stop() {
        this.running = false;
        if (this.retryInterval)
            clearTimeout(this.retryInterval);
        if (this.consumer)
            await this.consumer.disconnect();
        await this.producer.disconnect();
    }
    /**
     * Send a failed message to the dead-letter queue.
     */
    async sendToDLQ(params) {
        const errorMessage = params.error instanceof Error ? params.error.message : params.error;
        const nextRetryAt = new Date(Date.now() + this.baseDelayMs);
        const result = await connection_1.db.query(`INSERT INTO dead_letter_queue (original_topic, original_key, payload, error_message, retry_count, max_retries, next_retry_at, status)
       VALUES ($1,$2,$3,$4,0,$5,$6,'pending') RETURNING id`, [params.originalTopic, params.key, params.payload, errorMessage, this.maxRetries, nextRetryAt]);
        const id = result.rows[0].id;
        // Also publish to DLQ Kafka topic for monitoring
        await this.producer.send({
            topic: `${params.originalTopic}.dlq`,
            messages: [{ key: params.key || undefined, value: JSON.stringify({ dlqId: id, originalTopic: params.originalTopic, error: errorMessage, payload: params.payload }) }],
        });
        config_1.logger.warn({ dlqId: id, topic: params.originalTopic, error: errorMessage }, 'Message sent to DLQ');
        return id;
    }
    /**
     * Process retries — picks up messages whose retry time has elapsed.
     */
    async processRetries() {
        const entries = await connection_1.db.query(`SELECT * FROM dead_letter_queue WHERE status='pending' AND next_retry_at <= NOW() ORDER BY next_retry_at ASC LIMIT 50 FOR UPDATE SKIP LOCKED`);
        let retried = 0;
        for (const entry of entries.rows) {
            try {
                await connection_1.db.query(`UPDATE dead_letter_queue SET status='retrying', updated_at=NOW() WHERE id=$1`, [entry.id]);
                // Republish to original topic
                await this.producer.send({
                    topic: entry.original_topic,
                    messages: [{ key: entry.original_key || undefined, value: entry.payload, headers: { 'x-retry-count': String(entry.retry_count + 1), 'x-dlq-id': entry.id } }],
                });
                // Mark as resolved (consumer will re-fail if still broken)
                await connection_1.db.query(`UPDATE dead_letter_queue SET status='resolved', resolved_at=NOW(), updated_at=NOW() WHERE id=$1`, [entry.id]);
                retried++;
            }
            catch (err) {
                const newCount = entry.retry_count + 1;
                if (newCount >= entry.max_retries) {
                    await connection_1.db.query(`UPDATE dead_letter_queue SET status='exhausted', retry_count=$1, updated_at=NOW() WHERE id=$2`, [newCount, entry.id]);
                    config_1.logger.error({ dlqId: entry.id, topic: entry.original_topic }, 'DLQ message exhausted all retries');
                }
                else {
                    const delay = this.baseDelayMs * Math.pow(2, newCount); // Exponential backoff
                    const nextRetry = new Date(Date.now() + delay);
                    await connection_1.db.query(`UPDATE dead_letter_queue SET status='pending', retry_count=$1, next_retry_at=$2, updated_at=NOW() WHERE id=$3`, [newCount, nextRetry, entry.id]);
                }
            }
        }
        if (retried > 0)
            config_1.logger.info({ retried }, 'DLQ retries processed');
        return retried;
    }
    /**
     * Manually reprocess a specific DLQ entry.
     */
    async reprocess(dlqId) {
        const result = await connection_1.db.query(`SELECT * FROM dead_letter_queue WHERE id=$1`, [dlqId]);
        if (!result.rows[0])
            throw new Error('DLQ entry not found');
        const entry = result.rows[0];
        await this.producer.send({
            topic: entry.original_topic,
            messages: [{ key: entry.original_key || undefined, value: entry.payload, headers: { 'x-retry-count': String(entry.retry_count + 1), 'x-dlq-id': entry.id, 'x-manual-reprocess': '1' } }],
        });
        await connection_1.db.query(`UPDATE dead_letter_queue SET status='resolved', resolved_at=NOW(), updated_at=NOW() WHERE id=$1`, [dlqId]);
        config_1.logger.info({ dlqId }, 'DLQ entry manually reprocessed');
    }
    async getStats() {
        const result = await connection_1.db.query(`SELECT status, COUNT(*)::int as count FROM dead_letter_queue GROUP BY status`);
        const stats = { pending: 0, retrying: 0, exhausted: 0, resolved: 0 };
        for (const row of result.rows) {
            stats[row.status] = row.count;
        }
        return stats;
    }
    async getEntries(status, limit = 50) {
        const params = [];
        let query = 'SELECT * FROM dead_letter_queue';
        if (status) {
            params.push(status);
            query += ` WHERE status=$1`;
        }
        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
        params.push(limit);
        const result = await connection_1.db.query(query, params);
        return result.rows.map((r) => ({
            id: r.id, originalTopic: r.original_topic, originalKey: r.original_key,
            payload: r.payload, errorMessage: r.error_message, retryCount: r.retry_count,
            maxRetries: r.max_retries, nextRetryAt: r.next_retry_at ? new Date(r.next_retry_at) : null,
            status: r.status,
        }));
    }
    scheduleRetries() {
        if (!this.running)
            return;
        this.processRetries()
            .catch(err => config_1.logger.error(err, 'DLQ retry processing error'))
            .finally(() => { if (this.running)
            this.retryInterval = setTimeout(() => this.scheduleRetries(), 5000); });
    }
}
exports.DLQService = DLQService;
//# sourceMappingURL=dlq-service.js.map