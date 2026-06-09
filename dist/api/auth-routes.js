"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthRoutes = createAuthRoutes;
const express_1 = require("express");
const auth_service_1 = require("../security/auth-service");
function createAuthRoutes() {
    const router = (0, express_1.Router)();
    const authService = new auth_service_1.AuthService();
    router.use((0, auth_service_1.authMiddleware)(authService));
    // ======================== REGISTRATION ========================
    router.post('/register', async (req, res) => {
        try {
            const { email, password, displayName } = req.body;
            if (!email || !password || !displayName) {
                return res.status(400).json({ error: 'email, password, and displayName are required' });
            }
            const userId = await authService.createUser(email, password, displayName);
            res.status(201).json({ userId });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            if (msg.includes('duplicate key')) {
                return res.status(409).json({ error: 'User with this email already exists' });
            }
            res.status(400).json({ error: msg });
        }
    });
    // ======================== LOGIN ========================
    router.post('/login', async (req, res) => {
        try {
            const { email, password } = req.body;
            if (!email || !password) {
                return res.status(400).json({ error: 'email and password are required' });
            }
            const ip = (Array.isArray(req.ip) ? req.ip[0] : req.ip) || 'unknown';
            const userAgent = req.headers['user-agent'] || 'unknown';
            const result = await authService.authenticate(email, password, ip, userAgent);
            if (!result)
                return res.status(401).json({ error: 'Invalid credentials or account locked' });
            res.json(result);
        }
        catch (err) {
            res.status(500).json({ error: 'Internal error' });
        }
    });
    // ======================== LOGOUT ========================
    router.post('/logout', auth_service_1.requireAuth, async (req, res) => {
        try {
            await authService.revokeSession(req.auth.user.sessionId);
            res.json({ status: 'logged_out' });
        }
        catch (err) {
            res.status(500).json({ error: 'Internal error' });
        }
    });
    // ======================== API KEYS ========================
    router.post('/api-keys', auth_service_1.requireAuth, async (req, res) => {
        try {
            const { name, scopes, expiresAt } = req.body;
            if (!name || !scopes) {
                return res.status(400).json({ error: 'name and scopes are required' });
            }
            const result = await authService.createApiKey(req.auth.user.id, name, scopes, expiresAt ? new Date(expiresAt) : undefined);
            res.status(201).json(result);
        }
        catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
        }
    });
    // ======================== ROLES ========================
    router.post('/roles/assign', auth_service_1.requireAuth, async (req, res) => {
        try {
            const { userId, roleId, justification, expiresAt } = req.body;
            if (!userId || !roleId || !justification) {
                return res.status(400).json({ error: 'userId, roleId, and justification are required' });
            }
            await authService.assignRole(userId, roleId, req.auth.user.id, justification, expiresAt ? new Date(expiresAt) : undefined);
            res.json({ status: 'assigned' });
        }
        catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
        }
    });
    router.post('/roles/remove', auth_service_1.requireAuth, async (req, res) => {
        try {
            const { userId, roleId } = req.body;
            if (!userId || !roleId) {
                return res.status(400).json({ error: 'userId and roleId are required' });
            }
            await authService.removeRole(userId, roleId);
            res.json({ status: 'removed' });
        }
        catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
        }
    });
    // ======================== MFA ========================
    router.post('/mfa/enable', auth_service_1.requireAuth, async (req, res) => {
        try {
            const { secret } = req.body;
            if (!secret)
                return res.status(400).json({ error: 'secret is required' });
            const backupCodes = await authService.enableMfa(req.auth.user.id, secret);
            res.json({ status: 'enabled', backupCodes });
        }
        catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
        }
    });
    return router;
}
//# sourceMappingURL=auth-routes.js.map