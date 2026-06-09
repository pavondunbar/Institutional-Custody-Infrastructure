"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FIELD_CLASSIFICATIONS = exports.DATA_CLASSIFICATIONS = exports.EncryptionService = void 0;
const crypto_1 = require("crypto");
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;
/**
 * Field-level encryption for sensitive data (PII, addresses, keys).
 * Uses AES-256-GCM for authenticated encryption.
 */
class EncryptionService {
    masterKey;
    constructor(masterKeyHex) {
        const keySource = masterKeyHex
            || process.env.ENCRYPTION_MASTER_KEY
            || (0, crypto_1.randomBytes)(KEY_LENGTH).toString('hex');
        this.masterKey = Buffer.from(keySource, 'hex');
    }
    /**
     * Encrypt a plaintext string. Returns base64-encoded ciphertext
     * with embedded IV and auth tag.
     */
    encrypt(plaintext) {
        const iv = (0, crypto_1.randomBytes)(IV_LENGTH);
        const cipher = (0, crypto_1.createCipheriv)(ALGORITHM, this.masterKey, iv);
        const encrypted = Buffer.concat([
            cipher.update(plaintext, 'utf8'),
            cipher.final(),
        ]);
        const authTag = cipher.getAuthTag();
        const combined = Buffer.concat([iv, authTag, encrypted]);
        return combined.toString('base64');
    }
    /**
     * Decrypt a base64-encoded ciphertext.
     */
    decrypt(ciphertext) {
        const combined = Buffer.from(ciphertext, 'base64');
        const iv = combined.subarray(0, IV_LENGTH);
        const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
        const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
        const decipher = (0, crypto_1.createDecipheriv)(ALGORITHM, this.masterKey, iv);
        decipher.setAuthTag(authTag);
        return decipher.update(encrypted) + decipher.final('utf8');
    }
    /**
     * Hash a value for lookup (non-reversible).
     * Used for sanctions screening, address matching.
     */
    hashForLookup(value) {
        const salt = (0, crypto_1.scryptSync)(this.masterKey, 'lookup-salt', SALT_LENGTH);
        return (0, crypto_1.scryptSync)(value, salt, KEY_LENGTH).toString('hex');
    }
    /**
     * Mask PII data for display/logging.
     */
    static maskEmail(email) {
        const [local, domain] = email.split('@');
        if (!domain)
            return '***';
        const maskedLocal = local.length <= 2
            ? '*'.repeat(local.length)
            : local[0] + '*'.repeat(local.length - 2) + local[local.length - 1];
        return `${maskedLocal}@${domain}`;
    }
    static maskAddress(address) {
        if (address.length <= 10)
            return '***';
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }
    static maskName(name) {
        const parts = name.split(' ');
        return parts
            .map(p => p[0] + '*'.repeat(Math.max(0, p.length - 1)))
            .join(' ');
    }
    /**
     * Redact sensitive fields from an object for logging.
     */
    static redactForLogging(obj, sensitiveFields = [
        'password', 'secret', 'token', 'key', 'mfa_secret',
        'private_key', 'seed_phrase',
    ]) {
        const redacted = {};
        for (const [k, v] of Object.entries(obj)) {
            if (sensitiveFields.some(f => k.toLowerCase().includes(f))) {
                redacted[k] = '[REDACTED]';
            }
            else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
                redacted[k] = EncryptionService.redactForLogging(v, sensitiveFields);
            }
            else {
                redacted[k] = v;
            }
        }
        return redacted;
    }
}
exports.EncryptionService = EncryptionService;
/**
 * Data classification labels for governance.
 */
exports.DATA_CLASSIFICATIONS = {
    PUBLIC: 'public',
    INTERNAL: 'internal',
    CONFIDENTIAL: 'confidential',
    RESTRICTED: 'restricted',
    PII: 'pii',
    PHI: 'phi',
};
/**
 * Default field classifications for the schema.
 */
exports.FIELD_CLASSIFICATIONS = [
    { table: 'users', column: 'email', classification: 'pii', encryptionRequired: false, maskingRule: 'email' },
    { table: 'users', column: 'password_hash', classification: 'restricted', encryptionRequired: true },
    { table: 'users', column: 'mfa_secret', classification: 'restricted', encryptionRequired: true },
    { table: 'wallets', column: 'address', classification: 'confidential', encryptionRequired: false, maskingRule: 'address' },
    { table: 'token_holders', column: 'holder_address', classification: 'confidential', encryptionRequired: false, maskingRule: 'address' },
    { table: 'travel_rule_messages', column: 'originator_name', classification: 'pii', encryptionRequired: true, maskingRule: 'name' },
    { table: 'travel_rule_messages', column: 'beneficiary_name', classification: 'pii', encryptionRequired: true, maskingRule: 'name' },
    { table: 'key_metadata', column: 'key_id', classification: 'restricted', encryptionRequired: false },
];
//# sourceMappingURL=encryption-service.js.map