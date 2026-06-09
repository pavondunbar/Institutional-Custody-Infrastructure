import { Router, Request, Response } from 'express';
import { AuthService, authMiddleware, requireAuth } from '../security/auth-service';
import { logger } from '../config';

export function createAuthRoutes(): Router {
  const router = Router();
  const authService = new AuthService();

  router.use(authMiddleware(authService));

  // ======================== REGISTRATION ========================
  router.post('/register', async (req: Request, res: Response) => {
    try {
      const { email, password, displayName } = req.body;
      if (!email || !password || !displayName) {
        return res.status(400).json({ error: 'email, password, and displayName are required' });
      }
      const userId = await authService.createUser(email, password, displayName);
      res.status(201).json({ userId });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (msg.includes('duplicate key')) {
        return res.status(409).json({ error: 'User with this email already exists' });
      }
      res.status(400).json({ error: msg });
    }
  });

  // ======================== LOGIN ========================
  router.post('/login', async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'email and password are required' });
      }
      const ip = (Array.isArray(req.ip) ? req.ip[0] : req.ip) || 'unknown';
      const userAgent = req.headers['user-agent'] || 'unknown';
      const result = await authService.authenticate(email, password, ip, userAgent);
      if (!result) return res.status(401).json({ error: 'Invalid credentials or account locked' });
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ======================== LOGOUT ========================
  router.post('/logout', requireAuth, async (req: Request, res: Response) => {
    try {
      await authService.revokeSession(req.auth!.user.sessionId);
      res.json({ status: 'logged_out' });
    } catch (err: unknown) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ======================== API KEYS ========================
  router.post('/api-keys', requireAuth, async (req: Request, res: Response) => {
    try {
      const { name, scopes, expiresAt } = req.body;
      if (!name || !scopes) {
        return res.status(400).json({ error: 'name and scopes are required' });
      }
      const result = await authService.createApiKey(
        req.auth!.user.id, name, scopes,
        expiresAt ? new Date(expiresAt) : undefined,
      );
      res.status(201).json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  // ======================== ROLES ========================
  router.post('/roles/assign', requireAuth, async (req: Request, res: Response) => {
    try {
      const { userId, roleId, justification, expiresAt } = req.body;
      if (!userId || !roleId || !justification) {
        return res.status(400).json({ error: 'userId, roleId, and justification are required' });
      }
      await authService.assignRole(
        userId, roleId, req.auth!.user.id, justification,
        expiresAt ? new Date(expiresAt) : undefined,
      );
      res.json({ status: 'assigned' });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.post('/roles/remove', requireAuth, async (req: Request, res: Response) => {
    try {
      const { userId, roleId } = req.body;
      if (!userId || !roleId) {
        return res.status(400).json({ error: 'userId and roleId are required' });
      }
      await authService.removeRole(userId, roleId);
      res.json({ status: 'removed' });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  // ======================== MFA ========================
  router.post('/mfa/enable', requireAuth, async (req: Request, res: Response) => {
    try {
      const { secret } = req.body;
      if (!secret) return res.status(400).json({ error: 'secret is required' });
      const backupCodes = await authService.enableMfa(req.auth!.user.id, secret);
      res.json({ status: 'enabled', backupCodes });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  return router;
}
