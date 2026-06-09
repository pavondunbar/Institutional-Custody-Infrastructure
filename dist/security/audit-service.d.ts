import { AuthContext } from './auth-service';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type AuditOutcome = 'success' | 'failure' | 'denied' | 'error';
export interface AuditEntry {
    eventType: string;
    resourceType: string;
    resourceId?: string;
    action: string;
    details?: Record<string, unknown>;
    riskLevel?: RiskLevel;
    outcome?: AuditOutcome;
}
export declare class AuditService {
    /**
     * Record an audit event with full actor context.
     * All state-changing operations should call this.
     */
    record(auth: AuthContext | null, entry: AuditEntry): Promise<void>;
    /**
     * Record a failed authentication attempt.
     */
    recordAuthFailure(email: string, ipAddress: string, reason: string): Promise<void>;
    /**
     * Record a permission denial.
     */
    recordDenied(auth: AuthContext, resource: string, action: string, requiredPermission: string): Promise<void>;
    /**
     * Query audit trail with filters.
     */
    query(filters: {
        actorId?: string;
        resourceType?: string;
        resourceId?: string;
        eventType?: string;
        riskLevel?: string;
        outcome?: string;
        fromDate?: Date;
        toDate?: Date;
        correlationId?: string;
        limit?: number;
        offset?: number;
    }): Promise<{
        events: unknown[];
        total: number;
    }>;
    /**
     * Generate compliance evidence report for a time period.
     */
    generateComplianceReport(fromDate: Date, toDate: Date): Promise<{
        period: {
            from: string;
            to: string;
        };
        summary: Record<string, number>;
        highRiskEvents: unknown[];
        authFailures: number;
        deniedAccess: number;
    }>;
}
//# sourceMappingURL=audit-service.d.ts.map