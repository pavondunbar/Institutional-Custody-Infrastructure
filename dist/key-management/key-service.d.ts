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
export declare class KeyManagementService {
    /**
     * Register a new key with metadata. Actual key material lives in HSM/MPC provider.
     */
    registerKey(params: {
        keyType: KeyType;
        algorithm: string;
        provider: KeyProvider;
        purpose?: string;
        chain?: string;
        shardCount?: number;
        shardThreshold?: number;
        geographicLocations?: string[];
    }): Promise<KeyMetadata>;
    /**
     * Initiate key rotation — creates a new version, marks old as rotating.
     */
    rotateKey(keyId: string, initiatedBy: string): Promise<{
        newVersion: number;
        ceremonyId: string;
    }>;
    /**
     * Complete rotation — mark key active with new version.
     */
    completeRotation(keyId: string, ceremonyId: string): Promise<void>;
    /**
     * Sign with key — delegates to provider (HSM/MPC/KMS).
     */
    sign(request: SignRequest): Promise<SignResponse>;
    /**
     * Destroy key — irreversible.
     */
    destroyKey(keyId: string, reason: string, destroyedBy: string): Promise<void>;
    /**
     * Get keys needing rotation.
     */
    getKeysNeedingRotation(): Promise<KeyMetadata[]>;
    /**
     * Initiate a key ceremony (generation, rotation, recovery, etc.)
     */
    initiateCeremony(params: {
        type: CeremonyType;
        keyId: string;
        participants: string[];
        minParticipants: number;
    }): Promise<string>;
    getKey(id: string): Promise<KeyMetadata | null>;
    getKeyByKeyId(keyId: string): Promise<KeyMetadata | null>;
    private providerSign;
    private mapRow;
}
//# sourceMappingURL=key-service.d.ts.map