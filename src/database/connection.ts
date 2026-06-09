import { Pool, PoolClient } from 'pg';
import { config, logger } from '../config';
import { readFileSync, existsSync } from 'fs';

const sslConfig = config.postgres.sslEnabled ? {
  ssl: {
    rejectUnauthorized: config.postgres.sslRejectUnauthorized,
    ...(config.postgres.sslCaPath && existsSync(config.postgres.sslCaPath)
      ? { ca: readFileSync(config.postgres.sslCaPath).toString() }
      : {}),
  },
} : {};

export const db = new Pool({
  host: config.postgres.host,
  port: config.postgres.port,
  database: config.postgres.database,
  user: config.postgres.user,
  password: config.postgres.password,
  max: config.postgres.max,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 60_000,
  ...sslConfig,
});

db.on('error', (err) => {
  logger.error(err, 'Unexpected database pool error');
});

export type TxClient = PoolClient;

/**
 * Execute a callback within a SERIALIZABLE transaction with proper cleanup.
 */
export async function withSerializableTransaction<T>(
  fn: (client: TxClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
