import { Request, Response, NextFunction } from 'express';
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
    namespace Express {
        interface Request {
            auth?: AuthContext;
        }
    }
}
export declare class AuthService {
    createUser(email: string, password: string, displayName: string): Promise<string>;
    authenticate(email: string, password: string, ipAddress: string, userAgent: string): Promise<{
        token: string;
        user: AuthenticatedUser;
    } | null>;
    validateSession(token: string): Promise<AuthenticatedUser | null>;
    validateApiKey(apiKey: string): Promise<AuthenticatedUser | null>;
    revokeSession(sessionId: string): Promise<void>;
    createApiKey(userId: string, name: string, scopes: string[], expiresAt?: Date): Promise<{
        id: string;
        key: string;
        prefix: string;
    }>;
    assignRole(userId: string, roleId: string, grantedBy: string, justification: string, expiresAt?: Date): Promise<void>;
    removeRole(userId: string, roleId: string): Promise<void>;
    enableMfa(userId: string, secret: string): Promise<string[]>;
    private getUserRolesAndPermissions;
}
/**
 * Express middleware: extracts auth from Bearer token or X-API-Key header.
 */
export declare function authMiddleware(authService: AuthService): (req: Request, _res: Response, next: NextFunction) => Promise<void>;
/**
 * Require authentication on a route.
 */
export declare function requireAuth(req: Request, res: Response, next: NextFunction): void;
/**
 * Require specific permission on a route.
 */
export declare function requirePermission(resource: string, action: string): (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
/**
 * Require specific role on a route.
 */
export declare function requireRole(...roles: string[]): (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
/**
 * Require MFA for sensitive operations.
 */
export declare function requireMfa(req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=auth-service.d.ts.map