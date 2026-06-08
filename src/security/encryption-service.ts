import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;

/**
 * Field-level encryption for sensitive data (PII, addresses, keys).
 * Uses AES-256-GCM for authenticated encryption.
 */
export class EncryptionService {
  private masterKey: Buffer;

  constructor(masterKeyHex?: string) {
    const keySource = masterKeyHex
      || process.env.ENCRYPTION_MASTER_KEY
      || randomBytes(KEY_LENGTH).toString('hex');
    this.masterKey = Buffer.from(keySource, 'hex');
  }

  /**
   * Encrypt a plaintext string. Returns base64-encoded ciphertext
   * with embedded IV and auth tag.
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.masterKey, iv);

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
  decrypt(ciphertext: string): string {
    const combined = Buffer.from(ciphertext, 'base64');

    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, this.masterKey, iv);
    decipher.setAuthTag(authTag);

    return decipher.update(encrypted) + decipher.final('utf8');
  }

  /**
   * Hash a value for lookup (non-reversible).
   * Used for sanctions screening, address matching.
   */
  hashForLookup(value: string): string {
    const salt = scryptSync(this.masterKey, 'lookup-salt', SALT_LENGTH);
    return scryptSync(value, salt, KEY_LENGTH).toString('hex');
  }

  /**
   * Mask PII data for display/logging.
   */
  static maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    const maskedLocal = local.length <= 2
      ? '*'.repeat(local.length)
      : local[0] + '*'.repeat(local.length - 2) + local[local.length - 1];
    return `${maskedLocal}@${domain}`;
  }

  static maskAddress(address: string): string {
    if (address.length <= 10) return '***';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  static maskName(name: string): string {
    const parts = name.split(' ');
    return parts
      .map(p => p[0] + '*'.repeat(Math.max(0, p.length - 1)))
      .join(' ');
  }

  /**
   * Redact sensitive fields from an object for logging.
   */
  static redactForLogging(
    obj: Record<string, unknown>,
    sensitiveFields: string[] = [
      'password', 'secret', 'token', 'key', 'mfa_secret',
      'private_key', 'seed_phrase',
    ],
  ): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (sensitiveFields.some(f => k.toLowerCase().includes(f))) {
        redacted[k] = '[REDACTED]';
      } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        redacted[k] = EncryptionService.redactForLogging(
          v as Record<string, unknown>,
          sensitiveFields,
        );
      } else {
        redacted[k] = v;
      }
    }
    return redacted;
  }
}

/**
 * Data classification labels for governance.
 */
export const DATA_CLASSIFICATIONS = {
  PUBLIC: 'public',
  INTERNAL: 'internal',
  CONFIDENTIAL: 'confidential',
  RESTRICTED: 'restricted',
  PII: 'pii',
  PHI: 'phi',
} as const;

/**
 * Default field classifications for the schema.
 */
export const FIELD_CLASSIFICATIONS: Array<{
  table: string;
  column: string;
  classification: string;
  encryptionRequired: boolean;
  maskingRule?: string;
}> = [
  { table: 'users', column: 'email', classification: 'pii', encryptionRequired: false, maskingRule: 'email' },
  { table: 'users', column: 'password_hash', classification: 'restricted', encryptionRequired: true },
  { table: 'users', column: 'mfa_secret', classification: 'restricted', encryptionRequired: true },
  { table: 'wallets', column: 'address', classification: 'confidential', encryptionRequired: false, maskingRule: 'address' },
  { table: 'token_holders', column: 'holder_address', classification: 'confidential', encryptionRequired: false, maskingRule: 'address' },
  { table: 'travel_rule_messages', column: 'originator_name', classification: 'pii', encryptionRequired: true, maskingRule: 'name' },
  { table: 'travel_rule_messages', column: 'beneficiary_name', classification: 'pii', encryptionRequired: true, maskingRule: 'name' },
  { table: 'key_metadata', column: 'key_id', classification: 'restricted', encryptionRequired: false },
];
