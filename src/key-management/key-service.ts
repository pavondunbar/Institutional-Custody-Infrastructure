import { db } from '../database/connection';
import { logger } from '../config';
import { v4 as uuidv4 } from 'uuid';

export type KeyProvider = 'hsm' | 'mpc' | 'kms' | 'local_dev';
export type KeyType = 'signing' | 'encryption' | 'authentication' | 'master';
export type KeyStatus = 'active' | 'rotating' | 'deprecated' | 'destroyed';
export type CeremonyType = 'generation' | 'rotation' | 'recovery' | 'destruction' | 'shard_recombine';

export interface KeyMetadata {
  id: string;
  keyId: string;
  keyType: KeyType;
  algorithm: string;
  provider: KeyProvider;
  purpose?: string;
  chain?: string;
  status: KeyStatus;
  version: number;
  shardCount?: number;
  shardThreshold?: number;
  geographicLocations: string[];
  rotationDueAt?: Date;
  lastUsedAt?: Date;
}

export interface SignRequest {
  keyId: string;
  payload: Buffer;
  algorithm?: string;
}

export interface SignResponse {
  signature: Buffer;
  keyVersion: number;
  provider: KeyProvider;
}

/**
 * Key Management Service: HSM/MPC integration, rotation, sharding, geographic distribution.
 */
export class KeyManagementService {
  /**
   * Register a new key with metadata. Actual key material lives in HSM/MPC provider.
   */
  async registerKey(params: {
    keyType: KeyType;
    algorithm: string;
    provider: KeyProvider;
    purpose?: string;
    chain?: string;
    shardCount?: number;
    shardThreshold?: number;
    geographicLocations?: string[];
  }): Promise<KeyMetadata> {
    const keyId = `key_${uuidv4().replace(/-/g, '')}`;
    const rotationDueAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 days

    const result = await db.query(
      `INSERT INTO key_metadata (key_id, key_type, algorithm, provider, purpose, chain, status, version, shard_count, shard_threshold, geographic_locations, rotation_due_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active',1,$7,$8,$9,$10)
       RETURNING *`,
      [keyId, params.keyType, params.algorithm, params.provider, params.purpose || null, params.chain || null, params.shardCount || null, params.shardThreshold || null, JSON.stringify(params.geographicLocations || []), rotationDueAt]
    );

    logger.info({ keyId, provider: params.provider }, 'Key registered');
    return this.mapRow(result.rows[0]);
  }

  /**
   * Initiate key rotation — creates a new version, marks old as rotating.
   */
  async rotateKey(keyId: string, initiatedBy: string): Promise<{ newVersion: number; ceremonyId: string }> {
    const key = await this.getKey(keyId);
    if (!key) throw new Error('Key not found');
    if (key.status !== 'active') throw new Error(`Cannot rotate key in status: ${key.status}`);

    const newVersion = key.version + 1;
    await db.query(
      `UPDATE key_metadata SET status='rotating', version=$1, updated_at=NOW() WHERE key_id=$2`,
      [newVersion, keyId]
    );

    const ceremonyId = await this.initiateCeremony({
      type: 'rotation',
      keyId: key.id,
      participants: [initiatedBy],
      minParticipants: key.shardThreshold || 1,
    });

    logger.info({ keyId, newVersion, ceremonyId }, 'Key rotation initiated');
    return { newVersion, ceremonyId };
  }

  /**
   * Complete rotation — mark key active with new version.
   */
  async completeRotation(keyId: string, ceremonyId: string): Promise<void> {
    await db.query(`UPDATE key_metadata SET status='active', rotation_due_at=$1 WHERE key_id=$2`, [new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), keyId]);
    await db.query(`UPDATE key_ceremonies SET status='completed', completed_at=NOW() WHERE id=$1`, [ceremonyId]);
    logger.info({ keyId, ceremonyId }, 'Key rotation completed');
  }

  /**
   * Sign with key — delegates to provider (HSM/MPC/KMS).
   */
  async sign(request: SignRequest): Promise<SignResponse> {
    const key = await this.getKeyByKeyId(request.keyId);
    if (!key) throw new Error('Key not found');
    if (key.status !== 'active') throw new Error('Key not active');

    await db.query(`UPDATE key_metadata SET last_used_at=NOW() WHERE key_id=$1`, [request.keyId]);

    // Delegate to provider-specific signing
    const signature = await this.providerSign(key, request.payload);
    return { signature, keyVersion: key.version, provider: key.provider };
  }

  /**
   * Destroy key — irreversible.
   */
  async destroyKey(keyId: string, reason: string, destroyedBy: string): Promise<void> {
    await db.query(`UPDATE key_metadata SET status='destroyed', destroyed_at=NOW() WHERE key_id=$1`, [keyId]);
    await this.initiateCeremony({ type: 'destruction', keyId, participants: [destroyedBy], minParticipants: 1 });
    logger.warn({ keyId, reason, destroyedBy }, 'Key destroyed');
  }

  /**
   * Get keys needing rotation.
   */
  async getKeysNeedingRotation(): Promise<KeyMetadata[]> {
    const result = await db.query(
      `SELECT * FROM key_metadata WHERE status='active' AND rotation_due_at <= NOW() ORDER BY rotation_due_at`
    );
    return result.rows.map(this.mapRow);
  }

  /**
   * Initiate a key ceremony (generation, rotation, recovery, etc.)
   */
  async initiateCeremony(params: { type: CeremonyType; keyId: string; participants: string[]; minParticipants: number }): Promise<string> {
    const result = await db.query(
      `INSERT INTO key_ceremonies (ceremony_type, key_id, participants, min_participants, status)
       VALUES ($1,$2,$3,$4,'initiated') RETURNING id`,
      [params.type, params.keyId, JSON.stringify(params.participants), params.minParticipants]
    );
    return result.rows[0].id;
  }

  async getKey(id: string): Promise<KeyMetadata | null> {
    const result = await db.query(`SELECT * FROM key_metadata WHERE id=$1`, [id]);
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async getKeyByKeyId(keyId: string): Promise<KeyMetadata | null> {
    const result = await db.query(`SELECT * FROM key_metadata WHERE key_id=$1`, [keyId]);
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  private async providerSign(key: KeyMetadata, payload: Buffer): Promise<Buffer> {
    // Provider-specific signing — in production this calls HSM/MPC APIs
    switch (key.provider) {
      case 'hsm':
        logger.debug({ keyId: key.keyId }, 'HSM sign request');
        return Buffer.from(`hsm_sig_${key.keyId}_${payload.toString('hex').slice(0, 8)}`, 'utf8');
      case 'mpc':
        logger.debug({ keyId: key.keyId }, 'MPC threshold sign request');
        return Buffer.from(`mpc_sig_${key.keyId}_${payload.toString('hex').slice(0, 8)}`, 'utf8');
      case 'kms':
        logger.debug({ keyId: key.keyId }, 'KMS sign request');
        return Buffer.from(`kms_sig_${key.keyId}_${payload.toString('hex').slice(0, 8)}`, 'utf8');
      default:
        return Buffer.from(`dev_sig_${payload.toString('hex').slice(0, 16)}`, 'utf8');
    }
  }

  private mapRow(row: Record<string, unknown>): KeyMetadata {
    return {
      id: row.id as string,
      keyId: row.key_id as string,
      keyType: row.key_type as KeyType,
      algorithm: row.algorithm as string,
      provider: row.provider as KeyProvider,
      purpose: row.purpose as string | undefined,
      chain: row.chain as string | undefined,
      status: row.status as KeyStatus,
      version: row.version as number,
      shardCount: row.shard_count as number | undefined,
      shardThreshold: row.shard_threshold as number | undefined,
      geographicLocations: (row.geographic_locations as string[]) || [],
      rotationDueAt: row.rotation_due_at ? new Date(row.rotation_due_at as string) : undefined,
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at as string) : undefined,
    };
  }
}
