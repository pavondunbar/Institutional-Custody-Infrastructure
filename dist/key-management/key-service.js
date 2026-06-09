"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KeyManagementService = void 0;
const connection_1 = require("../database/connection");
const config_1 = require("../config");
const uuid_1 = require("uuid");
/**
 * Key Management Service: HSM/MPC integration, rotation, sharding, geographic distribution.
 */
class KeyManagementService {
    /**
     * Register a new key with metadata. Actual key material lives in HSM/MPC provider.
     */
    async registerKey(params) {
        const keyId = `key_${(0, uuid_1.v4)().replace(/-/g, '')}`;
        const rotationDueAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 days
        const result = await connection_1.db.query(`INSERT INTO key_metadata (key_id, key_type, algorithm, provider, purpose, chain, status, version, shard_count, shard_threshold, geographic_locations, rotation_due_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active',1,$7,$8,$9,$10)
       RETURNING *`, [keyId, params.keyType, params.algorithm, params.provider, params.purpose || null, params.chain || null, params.shardCount || null, params.shardThreshold || null, JSON.stringify(params.geographicLocations || []), rotationDueAt]);
        config_1.logger.info({ keyId, provider: params.provider }, 'Key registered');
        return this.mapRow(result.rows[0]);
    }
    /**
     * Initiate key rotation — creates a new version, marks old as rotating.
     */
    async rotateKey(keyId, initiatedBy) {
        const key = await this.getKey(keyId);
        if (!key)
            throw new Error('Key not found');
        if (key.status !== 'active')
            throw new Error(`Cannot rotate key in status: ${key.status}`);
        const newVersion = key.version + 1;
        await connection_1.db.query(`UPDATE key_metadata SET status='rotating', version=$1, updated_at=NOW() WHERE key_id=$2`, [newVersion, keyId]);
        const ceremonyId = await this.initiateCeremony({
            type: 'rotation',
            keyId: key.id,
            participants: [initiatedBy],
            minParticipants: key.shardThreshold || 1,
        });
        config_1.logger.info({ keyId, newVersion, ceremonyId }, 'Key rotation initiated');
        return { newVersion, ceremonyId };
    }
    /**
     * Complete rotation — mark key active with new version.
     */
    async completeRotation(keyId, ceremonyId) {
        await connection_1.db.query(`UPDATE key_metadata SET status='active', rotation_due_at=$1 WHERE key_id=$2`, [new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), keyId]);
        await connection_1.db.query(`UPDATE key_ceremonies SET status='completed', completed_at=NOW() WHERE id=$1`, [ceremonyId]);
        config_1.logger.info({ keyId, ceremonyId }, 'Key rotation completed');
    }
    /**
     * Sign with key — delegates to provider (HSM/MPC/KMS).
     */
    async sign(request) {
        const key = await this.getKeyByKeyId(request.keyId);
        if (!key)
            throw new Error('Key not found');
        if (key.status !== 'active')
            throw new Error('Key not active');
        await connection_1.db.query(`UPDATE key_metadata SET last_used_at=NOW() WHERE key_id=$1`, [request.keyId]);
        // Delegate to provider-specific signing
        const signature = await this.providerSign(key, request.payload);
        return { signature, keyVersion: key.version, provider: key.provider };
    }
    /**
     * Destroy key — irreversible.
     */
    async destroyKey(keyId, reason, destroyedBy) {
        await connection_1.db.query(`UPDATE key_metadata SET status='destroyed', destroyed_at=NOW() WHERE key_id=$1`, [keyId]);
        await this.initiateCeremony({ type: 'destruction', keyId, participants: [destroyedBy], minParticipants: 1 });
        config_1.logger.warn({ keyId, reason, destroyedBy }, 'Key destroyed');
    }
    /**
     * Get keys needing rotation.
     */
    async getKeysNeedingRotation() {
        const result = await connection_1.db.query(`SELECT * FROM key_metadata WHERE status='active' AND rotation_due_at <= NOW() ORDER BY rotation_due_at`);
        return result.rows.map(this.mapRow);
    }
    /**
     * Initiate a key ceremony (generation, rotation, recovery, etc.)
     */
    async initiateCeremony(params) {
        const result = await connection_1.db.query(`INSERT INTO key_ceremonies (ceremony_type, key_id, participants, min_participants, status)
       VALUES ($1,$2,$3,$4,'initiated') RETURNING id`, [params.type, params.keyId, JSON.stringify(params.participants), params.minParticipants]);
        return result.rows[0].id;
    }
    async getKey(id) {
        const result = await connection_1.db.query(`SELECT * FROM key_metadata WHERE id=$1`, [id]);
        return result.rows[0] ? this.mapRow(result.rows[0]) : null;
    }
    async getKeyByKeyId(keyId) {
        const result = await connection_1.db.query(`SELECT * FROM key_metadata WHERE key_id=$1`, [keyId]);
        return result.rows[0] ? this.mapRow(result.rows[0]) : null;
    }
    async providerSign(key, payload) {
        // Provider-specific signing — in production this calls HSM/MPC APIs
        switch (key.provider) {
            case 'hsm':
                config_1.logger.debug({ keyId: key.keyId }, 'HSM sign request');
                return Buffer.from(`hsm_sig_${key.keyId}_${payload.toString('hex').slice(0, 8)}`, 'utf8');
            case 'mpc':
                config_1.logger.debug({ keyId: key.keyId }, 'MPC threshold sign request');
                return Buffer.from(`mpc_sig_${key.keyId}_${payload.toString('hex').slice(0, 8)}`, 'utf8');
            case 'kms':
                config_1.logger.debug({ keyId: key.keyId }, 'KMS sign request');
                return Buffer.from(`kms_sig_${key.keyId}_${payload.toString('hex').slice(0, 8)}`, 'utf8');
            default:
                return Buffer.from(`dev_sig_${payload.toString('hex').slice(0, 16)}`, 'utf8');
        }
    }
    mapRow(row) {
        return {
            id: row.id,
            keyId: row.key_id,
            keyType: row.key_type,
            algorithm: row.algorithm,
            provider: row.provider,
            purpose: row.purpose,
            chain: row.chain,
            status: row.status,
            version: row.version,
            shardCount: row.shard_count,
            shardThreshold: row.shard_threshold,
            geographicLocations: row.geographic_locations || [],
            rotationDueAt: row.rotation_due_at ? new Date(row.rotation_due_at) : undefined,
            lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
        };
    }
}
exports.KeyManagementService = KeyManagementService;
//# sourceMappingURL=key-service.js.map