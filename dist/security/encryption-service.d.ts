/**
 * Field-level encryption for sensitive data (PII, addresses, keys).
 * Uses AES-256-GCM for authenticated encryption.
 */
export declare class EncryptionService {
    private masterKey;
    constructor(masterKeyHex?: string);
    /**
     * Encrypt a plaintext string. Returns base64-encoded ciphertext
     * with embedded IV and auth tag.
     */
    encrypt(plaintext: string): string;
    /**
     * Decrypt a base64-encoded ciphertext.
     */
    decrypt(ciphertext: string): string;
    /**
     * Hash a value for lookup (non-reversible).
     * Used for sanctions screening, address matching.
     */
    hashForLookup(value: string): string;
    /**
     * Mask PII data for display/logging.
     */
    static maskEmail(email: string): string;
    static maskAddress(address: string): string;
    static maskName(name: string): string;
    /**
     * Redact sensitive fields from an object for logging.
     */
    static redactForLogging(obj: Record<string, unknown>, sensitiveFields?: string[]): Record<string, unknown>;
}
/**
 * Data classification labels for governance.
 */
export declare const DATA_CLASSIFICATIONS: {
    readonly PUBLIC: "public";
    readonly INTERNAL: "internal";
    readonly CONFIDENTIAL: "confidential";
    readonly RESTRICTED: "restricted";
    readonly PII: "pii";
    readonly PHI: "phi";
};
/**
 * Default field classifications for the schema.
 */
export declare const FIELD_CLASSIFICATIONS: Array<{
    table: string;
    column: string;
    classification: string;
    encryptionRequired: boolean;
    maskingRule?: string;
}>;
//# sourceMappingURL=encryption-service.d.ts.map