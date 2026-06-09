/**
 * Approval workflow service implementing four-eyes principle,
 * maker-checker, and M-of-N approval patterns.
 */
export declare class ApprovalService {
    /**
     * Create an approval policy.
     */
    createPolicy(params: {
        name: string;
        resourceType: string;
        action: string;
        minApprovers: number;
        requiredRoles?: string[];
        amountThreshold?: bigint;
        autoRejectAfterHours?: number;
        requiresDifferentActors?: boolean;
    }): Promise<string>;
    /**
     * Check if an operation requires approval based on active policies.
     */
    requiresApproval(resourceType: string, action: string, amount?: bigint): Promise<{
        required: boolean;
        policy: unknown | null;
    }>;
    /**
     * Submit an operation for approval (maker step).
     */
    submitForApproval(params: {
        policyId: string;
        requesterId: string;
        resourceType: string;
        resourceId?: string;
        action: string;
        operationParams: Record<string, unknown>;
    }): Promise<string>;
    /**
     * Approve a request (checker step). Enforces separation of duties.
     */
    approve(requestId: string, approverId: string, reason?: string): Promise<{
        status: string;
        currentApprovals: number;
        required: number;
    }>;
    /**
     * Reject a request.
     */
    reject(requestId: string, approverId: string, reason: string): Promise<void>;
    /**
     * Mark an approved request as executed.
     */
    markExecuted(requestId: string): Promise<void>;
    cancelRequest(requestId: string, userId: string): Promise<void>;
    getPendingRequests(limit?: number): Promise<any[]>;
    getRequestWithDecisions(requestId: string): Promise<any>;
    getPolicies(): Promise<any[]>;
    private getRequestOrFail;
    private expireRequest;
}
//# sourceMappingURL=approval-service.d.ts.map