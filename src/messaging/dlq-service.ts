import { Kafka, Producer, Consumer, EachMessagePayload } from 'kafkajs';
import { db } from '../database/connection';
import { config, logger } from '../config';

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
export class DLQService {
  private producer: Producer;
  private consumer: Consumer | null = null;
  private running = false;
  private retryInterval: NodeJS.Timeout | null = null;
  private readonly maxRetries = 5;
  private readonly baseDelayMs = 1000;

  constructor() {
    const kafka = new Kafka({ clientId: `${config.kafka.clientId}-dlq`, brokers: config.kafka.brokers });
    this.producer = kafka.producer({ idempotent: true });
  }

  async start() {
    await this.producer.connect();
    this.running = true;
    this.scheduleRetries();
    logger.info('DLQ service started');
  }

  async stop() {
    this.running = false;
    if (this.retryInterval) clearTimeout(this.retryInterval);
    if (this.consumer) await this.consumer.disconnect();
    await this.producer.disconnect();
  }

  /**
   * Send a failed message to the dead-letter queue.
   */
  async sendToDLQ(params: { originalTopic: string; key: string | null; payload: string; error: Error | string }): Promise<string> {
    const errorMessage = params.error instanceof Error ? params.error.message : params.error;
    const nextRetryAt = new Date(Date.now() + this.baseDelayMs);

    const result = await db.query(
      `INSERT INTO dead_letter_queue (original_topic, original_key, payload, error_message, retry_count, max_retries, next_retry_at, status)
       VALUES ($1,$2,$3,$4,0,$5,$6,'pending') RETURNING id`,
      [params.originalTopic, params.key, params.payload, errorMessage, this.maxRetries, nextRetryAt]
    );

    const id = result.rows[0].id;

    // Also publish to DLQ Kafka topic for monitoring
    await this.producer.send({
      topic: `${params.originalTopic}.dlq`,
      messages: [{ key: params.key || undefined, value: JSON.stringify({ dlqId: id, originalTopic: params.originalTopic, error: errorMessage, payload: params.payload }) }],
    });

    logger.warn({ dlqId: id, topic: params.originalTopic, error: errorMessage }, 'Message sent to DLQ');
    return id;
  }

  /**
   * Process retries — picks up messages whose retry time has elapsed.
   */
  async processRetries(): Promise<number> {
    const entries = await db.query(
      `SELECT * FROM dead_letter_queue WHERE status='pending' AND next_retry_at <= NOW() ORDER BY next_retry_at ASC LIMIT 50 FOR UPDATE SKIP LOCKED`
    );

    let retried = 0;
    for (const entry of entries.rows) {
      try {
        await db.query(`UPDATE dead_letter_queue SET status='retrying', updated_at=NOW() WHERE id=$1`, [entry.id]);

        // Republish to original topic
        await this.producer.send({
          topic: entry.original_topic,
          messages: [{ key: entry.original_key || undefined, value: entry.payload, headers: { 'x-retry-count': String(entry.retry_count + 1), 'x-dlq-id': entry.id } }],
        });

        // Mark as resolved (consumer will re-fail if still broken)
        await db.query(`UPDATE dead_letter_queue SET status='resolved', resolved_at=NOW(), updated_at=NOW() WHERE id=$1`, [entry.id]);
        retried++;
      } catch (err) {
        const newCount = entry.retry_count + 1;
        if (newCount >= entry.max_retries) {
          await db.query(`UPDATE dead_letter_queue SET status='exhausted', retry_count=$1, updated_at=NOW() WHERE id=$2`, [newCount, entry.id]);
          logger.error({ dlqId: entry.id, topic: entry.original_topic }, 'DLQ message exhausted all retries');
        } else {
          const delay = this.baseDelayMs * Math.pow(2, newCount); // Exponential backoff
          const nextRetry = new Date(Date.now() + delay);
          await db.query(`UPDATE dead_letter_queue SET status='pending', retry_count=$1, next_retry_at=$2, updated_at=NOW() WHERE id=$3`, [newCount, nextRetry, entry.id]);
        }
      }
    }

    if (retried > 0) logger.info({ retried }, 'DLQ retries processed');
    return retried;
  }

  /**
   * Manually reprocess a specific DLQ entry.
   */
  async reprocess(dlqId: string): Promise<void> {
    const result = await db.query(`SELECT * FROM dead_letter_queue WHERE id=$1`, [dlqId]);
    if (!result.rows[0]) throw new Error('DLQ entry not found');
    const entry = result.rows[0];

    await this.producer.send({
      topic: entry.original_topic,
      messages: [{ key: entry.original_key || undefined, value: entry.payload, headers: { 'x-retry-count': String(entry.retry_count + 1), 'x-dlq-id': entry.id, 'x-manual-reprocess': '1' } }],
    });

    await db.query(`UPDATE dead_letter_queue SET status='resolved', resolved_at=NOW(), updated_at=NOW() WHERE id=$1`, [dlqId]);
    logger.info({ dlqId }, 'DLQ entry manually reprocessed');
  }

  async getStats(): Promise<{ pending: number; retrying: number; exhausted: number; resolved: number }> {
    const result = await db.query(`SELECT status, COUNT(*)::int as count FROM dead_letter_queue GROUP BY status`);
    const stats = { pending: 0, retrying: 0, exhausted: 0, resolved: 0 };
    for (const row of result.rows) { stats[row.status as keyof typeof stats] = row.count; }
    return stats;
  }

  async getEntries(status?: string, limit = 50): Promise<DLQEntry[]> {
    const params: unknown[] = [];
    let query = 'SELECT * FROM dead_letter_queue';
    if (status) { params.push(status); query += ` WHERE status=$1`; }
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    const result = await db.query(query, params);
    return result.rows.map((r: Record<string, unknown>) => ({
      id: r.id as string, originalTopic: r.original_topic as string, originalKey: r.original_key as string | null,
      payload: r.payload as string, errorMessage: r.error_message as string, retryCount: r.retry_count as number,
      maxRetries: r.max_retries as number, nextRetryAt: r.next_retry_at ? new Date(r.next_retry_at as string) : null,
      status: r.status as DLQEntry['status'],
    }));
  }

  private scheduleRetries() {
    if (!this.running) return;
    this.processRetries()
      .catch(err => logger.error(err, 'DLQ retry processing error'))
      .finally(() => { if (this.running) this.retryInterval = setTimeout(() => this.scheduleRetries(), 5000); });
  }
}
