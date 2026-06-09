import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import * as argon2 from 'argon2';
import { Request, Response, NextFunction } from 'express';
import { db } from '../database/connection';
import { logger } from '../config';

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: string[];
  mfaEnabled: boolean;
  sessionId: string;
  ipAddress: string;
}

export interface AuthContext {
  user: AuthenticatedUser;
  correlationId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Argon2id parameters following OWASP recommendations
const ARGON2_OPTIONS: argon2.Options & { raw?: false } = {
  type: argon2.argon2id,
  memoryCost: 65536,    // 64 MiB
  timeCost: 3,          // 3 iterations
  parallelism: 4,       // 4 threads
};

async function hashPasswordArgon2(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

async function verifyPasswordArgon2(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

/** Legacy SHA-256 verification for migration from old hashes */
function verifyLegacySha256(storedHash: string, password: string): boolean {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;
  const attempt = createHash('sha256').update(`${salt}:${password}`).digest('hex');
  const storedBuf = Buffer.from(hash, 'hex');
  const attemptBuf = Buffer.from(attempt, 'hex');
  if (storedBuf.length !== attemptBuf.length) return false;
  return timingSafeEqual(storedBuf, attemptBuf);
}

function isArgon2Hash(hash: string): boolean {
  return hash.startsWith('$argon2');
}

export class AuthService {
  async createUser(
    email: string,
    password: string,
    displayName: string,
  ): Promise<string> {
    const passwordHash = await hashPasswordArgon2(password);

    const result = await db.query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3) RETURNING id`,
      [email.toLowerCase(), passwordHash, displayName]
    );
    return result.rows[0].id;
  }

  async authenticate(
    email: string,
    password: string,
    ipAddress: string,
    userAgent: string,
  ): Promise<{ token: string; user: AuthenticatedUser } | null> {
    const userResult = await db.query(
      `SELECT * FROM users WHERE email = $1 AND status = 'active'`,
      [email.toLowerCase()]
    );

    if (userResult.rows.length === 0) return null;
    const user = userResult.rows[0];

    if (user.failed_login_attempts >= 5) {
      await db.query(
        `UPDATE users SET status = 'locked', updated_at = NOW() WHERE id = $1`,
        [user.id]
      );
      return null;
    }

    // Verify password: supports both argon2id (new) and legacy SHA-256 hashes
    let passwordValid = false;
    if (isArgon2Hash(user.password_hash)) {
      passwordValid = await verifyPasswordArgon2(user.password_hash, password);
    } else {
      // Legacy SHA-256 verification with transparent upgrade to argon2id
      passwordValid = verifyLegacySha256(user.password_hash, password);
      if (passwordValid) {
        const upgradedHash = await hashPasswordArgon2(password);
        await db.query(
          `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
          [upgradedHash, user.id]
        );
        logger.info({ userId: user.id }, 'Password hash upgraded from SHA-256 to Argon2id');
      }
    }

    if (!passwordValid) {
      await db.query(
        `UPDATE users SET failed_login_attempts = failed_login_attempts + 1,
         updated_at = NOW() WHERE id = $1`,
        [user.id]
      );
      return null;
    }

    await db.query(
      `UPDATE users SET failed_login_attempts = 0,
       last_login_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [user.id]
    );

    const token = randomBytes(48).toString('hex');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8 hours

    const sessionResult = await db.query(
      `INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [user.id, tokenHash, ipAddress, userAgent, expiresAt]
    );

    const { roles, permissions } = await this.getUserRolesAndPermissions(user.id);

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        roles,
        permissions,
        mfaEnabled: user.mfa_enabled,
        sessionId: sessionResult.rows[0].id,
        ipAddress,
      },
    };
  }

  async validateSession(token: string): Promise<AuthenticatedUser | null> {
    const tokenHash = hashToken(token);

    const result = await db.query(
      `SELECT s.*, u.email, u.display_name, u.mfa_enabled, u.status as user_status
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token_hash = $1
         AND s.revoked = FALSE
         AND s.expires_at > NOW()
         AND u.status = 'active'`,
      [tokenHash]
    );

    if (result.rows.length === 0) return null;
    const session = result.rows[0];

    const { roles, permissions } = await this.getUserRolesAndPermissions(
      session.user_id
    );

    return {
      id: session.user_id,
      email: session.email,
      displayName: session.display_name,
      roles,
      permissions,
      mfaEnabled: session.mfa_enabled,
      sessionId: session.id,
      ipAddress: session.ip_address,
    };
  }

  async validateApiKey(apiKey: string): Promise<AuthenticatedUser | null> {
    const keyHash = hashToken(apiKey);

    const result = await db.query(
      `SELECT ak.*, u.email, u.display_name, u.mfa_enabled
       FROM api_keys ak
       LEFT JOIN users u ON ak.user_id = u.id
       WHERE ak.key_hash = $1
         AND ak.status = 'active'
         AND (ak.expires_at IS NULL OR ak.expires_at > NOW())`,
      [keyHash]
    );

    if (result.rows.length === 0) return null;
    const key = result.rows[0];

    await db.query(
      `UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`,
      [key.id]
    );

    const { roles, permissions } = key.user_id
      ? await this.getUserRolesAndPermissions(key.user_id)
      : { roles: [], permissions: key.scopes || [] };

    return {
      id: key.user_id || key.id,
      email: key.email || `apikey:${key.key_prefix}`,
      displayName: key.name,
      roles,
      permissions,
      mfaEnabled: false,
      sessionId: key.id,
      ipAddress: '',
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await db.query(
      `UPDATE sessions SET revoked = TRUE WHERE id = $1`,
      [sessionId]
    );
  }

  async createApiKey(
    userId: string,
    name: string,
    scopes: string[],
    expiresAt?: Date,
  ): Promise<{ id: string; key: string; prefix: string }> {
    const key = randomBytes(32).toString('hex');
    const prefix = key.substring(0, 8);
    const keyHash = hashToken(key);

    const result = await db.query(
      `INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [userId, name, keyHash, prefix, JSON.stringify(scopes), expiresAt || null]
    );

    return { id: result.rows[0].id, key, prefix };
  }

  async assignRole(
    userId: string,
    roleId: string,
    grantedBy: string,
    justification: string,
    expiresAt?: Date,
  ): Promise<void> {
    await db.query(
      `INSERT INTO user_roles (user_id, role_id, granted_by, justification, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, role_id) DO UPDATE
         SET granted_by = EXCLUDED.granted_by,
             justification = EXCLUDED.justification,
             expires_at = EXCLUDED.expires_at`,
      [userId, roleId, grantedBy, justification, expiresAt || null]
    );
  }

  async removeRole(userId: string, roleId: string): Promise<void> {
    await db.query(
      `DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2`,
      [userId, roleId]
    );
  }

  async enableMfa(userId: string, secret: string): Promise<string[]> {
    const backupCodes = Array.from(
      { length: 10 },
      () => randomBytes(4).toString('hex'),
    );

    await db.query(
      `UPDATE users SET mfa_enabled = TRUE, mfa_secret = $1,
       mfa_backup_codes = $2, updated_at = NOW() WHERE id = $3`,
      [secret, JSON.stringify(backupCodes.map(c => hashToken(c))), userId]
    );

    return backupCodes;
  }

  private async getUserRolesAndPermissions(userId: string): Promise<{
    roles: string[];
    permissions: string[];
  }> {
    const rolesResult = await db.query(
      `SELECT r.name FROM roles r
       JOIN user_roles ur ON r.id = ur.role_id
       WHERE ur.user_id = $1
         AND (ur.expires_at IS NULL OR ur.expires_at > NOW())`,
      [userId]
    );

    const roles = rolesResult.rows.map(r => r.name);

    const permsResult = await db.query(
      `SELECT DISTINCT p.resource || ':' || p.action as perm
       FROM permissions p
       JOIN role_permissions rp ON p.id = rp.permission_id
       JOIN user_roles ur ON rp.role_id = ur.role_id
       WHERE ur.user_id = $1
         AND (ur.expires_at IS NULL OR ur.expires_at > NOW())`,
      [userId]
    );

    const permissions = permsResult.rows.map(r => r.perm);
    return { roles, permissions };
  }
}

/**
 * Express middleware: extracts auth from Bearer token or X-API-Key header.
 */
export function authMiddleware(authService: AuthService) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const correlationId = req.headers['x-correlation-id'] as string
      || randomBytes(16).toString('hex');

    const authHeader = req.headers.authorization;
    const apiKeyHeader = req.headers['x-api-key'] as string;

    let user: AuthenticatedUser | null = null;

    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      user = await authService.validateSession(token);
    } else if (apiKeyHeader) {
      user = await authService.validateApiKey(apiKeyHeader);
    }

    if (user) {
      user.ipAddress = (Array.isArray(req.ip) ? req.ip[0] : req.ip) || 'unknown';
      req.auth = { user, correlationId };
    }

    next();
  };
}

/**
 * Require authentication on a route.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

/**
 * Require specific permission on a route.
 */
export function requirePermission(resource: string, action: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const perm = `${resource}:${action}`;
    if (!req.auth.user.permissions.includes(perm)) {
      logger.warn(
        { userId: req.auth.user.id, required: perm },
        'Permission denied'
      );
      return res.status(403).json({ error: `Permission denied: ${perm}` });
    }
    next();
  };
}

/**
 * Require specific role on a route.
 */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const hasRole = roles.some(r => req.auth!.user.roles.includes(r));
    if (!hasRole) {
      return res.status(403).json({
        error: `Required role: ${roles.join(' or ')}`,
      });
    }
    next();
  };
}

/**
 * Require MFA for sensitive operations.
 */
export function requireMfa(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (!req.auth.user.mfaEnabled) {
    res.status(403).json({ error: 'MFA must be enabled for this operation' });
    return;
  }
  next();
}
