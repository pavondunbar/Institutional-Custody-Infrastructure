"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
exports.authMiddleware = authMiddleware;
exports.requireAuth = requireAuth;
exports.requirePermission = requirePermission;
exports.requireRole = requireRole;
exports.requireMfa = requireMfa;
const crypto_1 = require("crypto");
const connection_1 = require("../database/connection");
const config_1 = require("../config");
function hashToken(token) {
    return (0, crypto_1.createHash)('sha256').update(token).digest('hex');
}
function hashPassword(password, salt) {
    return (0, crypto_1.createHash)('sha256')
        .update(`${salt}:${password}`)
        .digest('hex');
}
function generateSalt() {
    return (0, crypto_1.randomBytes)(32).toString('hex');
}
class AuthService {
    async createUser(email, password, displayName) {
        const salt = generateSalt();
        const passwordHash = `${salt}:${hashPassword(password, salt)}`;
        const result = await connection_1.db.query(`INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3) RETURNING id`, [email.toLowerCase(), passwordHash, displayName]);
        return result.rows[0].id;
    }
    async authenticate(email, password, ipAddress, userAgent) {
        const userResult = await connection_1.db.query(`SELECT * FROM users WHERE email = $1 AND status = 'active'`, [email.toLowerCase()]);
        if (userResult.rows.length === 0)
            return null;
        const user = userResult.rows[0];
        if (user.failed_login_attempts >= 5) {
            await connection_1.db.query(`UPDATE users SET status = 'locked', updated_at = NOW() WHERE id = $1`, [user.id]);
            return null;
        }
        const [salt, storedHash] = user.password_hash.split(':');
        const attemptHash = hashPassword(password, salt);
        const storedBuf = Buffer.from(storedHash, 'hex');
        const attemptBuf = Buffer.from(attemptHash, 'hex');
        if (storedBuf.length !== attemptBuf.length ||
            !(0, crypto_1.timingSafeEqual)(storedBuf, attemptBuf)) {
            await connection_1.db.query(`UPDATE users SET failed_login_attempts = failed_login_attempts + 1,
         updated_at = NOW() WHERE id = $1`, [user.id]);
            return null;
        }
        await connection_1.db.query(`UPDATE users SET failed_login_attempts = 0,
       last_login_at = NOW(), updated_at = NOW() WHERE id = $1`, [user.id]);
        const token = (0, crypto_1.randomBytes)(48).toString('hex');
        const tokenHash = hashToken(token);
        const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8 hours
        const sessionResult = await connection_1.db.query(`INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`, [user.id, tokenHash, ipAddress, userAgent, expiresAt]);
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
    async validateSession(token) {
        const tokenHash = hashToken(token);
        const result = await connection_1.db.query(`SELECT s.*, u.email, u.display_name, u.mfa_enabled, u.status as user_status
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token_hash = $1
         AND s.revoked = FALSE
         AND s.expires_at > NOW()
         AND u.status = 'active'`, [tokenHash]);
        if (result.rows.length === 0)
            return null;
        const session = result.rows[0];
        const { roles, permissions } = await this.getUserRolesAndPermissions(session.user_id);
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
    async validateApiKey(apiKey) {
        const keyHash = hashToken(apiKey);
        const result = await connection_1.db.query(`SELECT ak.*, u.email, u.display_name, u.mfa_enabled
       FROM api_keys ak
       LEFT JOIN users u ON ak.user_id = u.id
       WHERE ak.key_hash = $1
         AND ak.status = 'active'
         AND (ak.expires_at IS NULL OR ak.expires_at > NOW())`, [keyHash]);
        if (result.rows.length === 0)
            return null;
        const key = result.rows[0];
        await connection_1.db.query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, [key.id]);
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
    async revokeSession(sessionId) {
        await connection_1.db.query(`UPDATE sessions SET revoked = TRUE WHERE id = $1`, [sessionId]);
    }
    async createApiKey(userId, name, scopes, expiresAt) {
        const key = (0, crypto_1.randomBytes)(32).toString('hex');
        const prefix = key.substring(0, 8);
        const keyHash = hashToken(key);
        const result = await connection_1.db.query(`INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [userId, name, keyHash, prefix, JSON.stringify(scopes), expiresAt || null]);
        return { id: result.rows[0].id, key, prefix };
    }
    async assignRole(userId, roleId, grantedBy, justification, expiresAt) {
        await connection_1.db.query(`INSERT INTO user_roles (user_id, role_id, granted_by, justification, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, role_id) DO UPDATE
         SET granted_by = EXCLUDED.granted_by,
             justification = EXCLUDED.justification,
             expires_at = EXCLUDED.expires_at`, [userId, roleId, grantedBy, justification, expiresAt || null]);
    }
    async removeRole(userId, roleId) {
        await connection_1.db.query(`DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2`, [userId, roleId]);
    }
    async enableMfa(userId, secret) {
        const backupCodes = Array.from({ length: 10 }, () => (0, crypto_1.randomBytes)(4).toString('hex'));
        await connection_1.db.query(`UPDATE users SET mfa_enabled = TRUE, mfa_secret = $1,
       mfa_backup_codes = $2, updated_at = NOW() WHERE id = $3`, [secret, JSON.stringify(backupCodes.map(c => hashToken(c))), userId]);
        return backupCodes;
    }
    async getUserRolesAndPermissions(userId) {
        const rolesResult = await connection_1.db.query(`SELECT r.name FROM roles r
       JOIN user_roles ur ON r.id = ur.role_id
       WHERE ur.user_id = $1
         AND (ur.expires_at IS NULL OR ur.expires_at > NOW())`, [userId]);
        const roles = rolesResult.rows.map(r => r.name);
        const permsResult = await connection_1.db.query(`SELECT DISTINCT p.resource || ':' || p.action as perm
       FROM permissions p
       JOIN role_permissions rp ON p.id = rp.permission_id
       JOIN user_roles ur ON rp.role_id = ur.role_id
       WHERE ur.user_id = $1
         AND (ur.expires_at IS NULL OR ur.expires_at > NOW())`, [userId]);
        const permissions = permsResult.rows.map(r => r.perm);
        return { roles, permissions };
    }
}
exports.AuthService = AuthService;
/**
 * Express middleware: extracts auth from Bearer token or X-API-Key header.
 */
function authMiddleware(authService) {
    return async (req, _res, next) => {
        const correlationId = req.headers['x-correlation-id']
            || (0, crypto_1.randomBytes)(16).toString('hex');
        const authHeader = req.headers.authorization;
        const apiKeyHeader = req.headers['x-api-key'];
        let user = null;
        if (authHeader?.startsWith('Bearer ')) {
            const token = authHeader.slice(7);
            user = await authService.validateSession(token);
        }
        else if (apiKeyHeader) {
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
function requireAuth(req, res, next) {
    if (!req.auth) {
        res.status(401).json({ error: 'Authentication required' });
        return;
    }
    next();
}
/**
 * Require specific permission on a route.
 */
function requirePermission(resource, action) {
    return (req, res, next) => {
        if (!req.auth) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        const perm = `${resource}:${action}`;
        if (!req.auth.user.permissions.includes(perm)) {
            config_1.logger.warn({ userId: req.auth.user.id, required: perm }, 'Permission denied');
            return res.status(403).json({ error: `Permission denied: ${perm}` });
        }
        next();
    };
}
/**
 * Require specific role on a route.
 */
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.auth) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        const hasRole = roles.some(r => req.auth.user.roles.includes(r));
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
function requireMfa(req, res, next) {
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
//# sourceMappingURL=auth-service.js.map