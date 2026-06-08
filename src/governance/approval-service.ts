import { db } from '../database/connection';
import { logger } from '../config';

/**
 * Approval workflow service implementing four-eyes principle,
 * maker-checker, and M-of-N approval patterns.
 */
export class ApprovalService {
  /**
   * Create an approval policy.
   */
  async createPolicy(params: {
    name: string;
    resourceType: string;
    action: string;
    minApprovers: number;
    requiredRoles?: string[];
    amountThreshold?: bigint;
    autoRejectAfterHours?: number;
    requiresDifferentActors?: boolean;
  }): Promise<string> {
    const result = await db.query(
      `INSERT INTO approval_policies (
        name, resource_type, action, min_approvers,
        required_roles, amount_threshold,
        auto_reject_after_hours, requires_different_actors
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id`,
      [
        params.name,
        params.resourceType,
        params.action,
        params.minApprovers,
        JSON.stringify(params.requiredRoles || []),
        params.amountThreshold?.toString() || null,
        params.autoRejectAfterHours || 24,
        params.requiresDifferentActors ?? true,
      ]
    );
    return result.rows[0].id;
  }

  /**
   * Check if an operation requires approval based on active policies.
   */
  async requiresApproval(
    resourceType: string,
    action: string,
    amount?: bigint,
  ): Promise<{ required: boolean; policy: unknown | null }> {
    let query = `SELECT * FROM approval_policies
                 WHERE resource_type = $1 AND action = $2 AND active = TRUE`;
    const params: unknown[] = [resourceType, action];

    if (amount) {
      query += ` AND (amount_threshold IS NULL OR amount_threshold <= $3)`;
      params.push(amount.toString());
    }

    query += ' ORDER BY min_approvers DESC LIMIT 1';

    const result = await db.query(query, params);

    if (result.rows.length === 0) {
      return { required: false, policy: null };
    }

    return { required: true, policy: result.rows[0] };
  }

  /**
   * Submit an operation for approval (maker step).
   */
  async submitForApproval(params: {
    policyId: string;
    requesterId: string;
    resourceType: string;
    resourceId?: string;
    action: string;
    operationParams: Record<string, unknown>;
  }): Promise<string> {
    const policy = await db.query(
      'SELECT * FROM approval_policies WHERE id = $1',
      [params.policyId]
    );

    if (policy.rows.length === 0) {
      throw new Error(`Policy ${params.policyId} not found`);
    }

    const p = policy.rows[0];
    const expiresAt = new Date(
      Date.now() + (p.auto_reject_after_hours || 24) * 3600000
    );

    const result = await db.query(
      `INSERT INTO approval_requests (
        policy_id, requester_id, resource_type, resource_id,
        action, params, required_approvals, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id`,
      [
        params.policyId,
        params.requesterId,
        params.resourceType,
        params.resourceId || null,
        params.action,
        JSON.stringify(params.operationParams),
        p.min_approvers,
        expiresAt,
      ]
    );

    const requestId = result.rows[0].id;

    await db.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('approval', $1, 'approval.requested', $2)`,
      [requestId, JSON.stringify({
        requestId,
        resourceType: params.resourceType,
        action: params.action,
        requiredApprovals: p.min_approvers,
      })]
    );

    logger.info(
      { requestId, resourceType: params.resourceType, action: params.action },
      'Approval request submitted'
    );
    return requestId;
  }

  /**
   * Approve a request (checker step). Enforces separation of duties.
   */
  async approve(
    requestId: string,
    approverId: string,
    reason?: string,
  ): Promise<{ status: string; currentApprovals: number; required: number }> {
    const request = await this.getRequestOrFail(requestId);

    if (request.status !== 'pending') {
      throw new Error(`Request is ${request.status}, cannot approve`);
    }

    if (request.expires_at && new Date(request.expires_at) < new Date()) {
      await this.expireRequest(requestId);
      throw new Error('Approval request has expired');
    }

    const policy = await db.query(
      'SELECT * FROM approval_policies WHERE id = $1',
      [request.policy_id]
    );

    if (policy.rows[0].requires_different_actors && request.requester_id === approverId) {
      throw new Error('Maker and checker must be different people (four-eyes principle)');
    }

    const existingDecision = await db.query(
      `SELECT id FROM approval_decisions
       WHERE request_id = $1 AND approver_id = $2`,
      [requestId, approverId]
    );

    if (existingDecision.rows.length > 0) {
      throw new Error('You have already voted on this request');
    }

    await db.query(
      `INSERT INTO approval_decisions (request_id, approver_id, decision, reason)
       VALUES ($1, $2, 'approved', $3)`,
      [requestId, approverId, reason || null]
    );

    const newCount = request.current_approvals + 1;
    const isFullyApproved = newCount >= request.required_approvals;

    await db.query(
      `UPDATE approval_requests
       SET current_approvals = $1, status = $2, updated_at = NOW()
       WHERE id = $3`,
      [newCount, isFullyApproved ? 'approved' : 'pending', requestId]
    );

    if (isFullyApproved) {
      await db.query(
        `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('approval', $1, 'approval.approved', $2)`,
        [requestId, JSON.stringify({ requestId })]
      );
      logger.info({ requestId }, 'Approval request fully approved');
    }

    return {
      status: isFullyApproved ? 'approved' : 'pending',
      currentApprovals: newCount,
      required: request.required_approvals,
    };
  }

  /**
   * Reject a request.
   */
  async reject(
    requestId: string,
    approverId: string,
    reason: string,
  ): Promise<void> {
    const request = await this.getRequestOrFail(requestId);

    if (request.status !== 'pending') {
      throw new Error(`Request is ${request.status}, cannot reject`);
    }

    await db.query(
      `INSERT INTO approval_decisions (request_id, approver_id, decision, reason)
       VALUES ($1, $2, 'rejected', $3)`,
      [requestId, approverId, reason]
    );

    await db.query(
      `UPDATE approval_requests SET status = 'rejected', updated_at = NOW()
       WHERE id = $1`,
      [requestId]
    );

    await db.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('approval', $1, 'approval.rejected', $2)`,
      [requestId, JSON.stringify({ requestId, reason })]
    );

    logger.info({ requestId, reason }, 'Approval request rejected');
  }

  /**
   * Mark an approved request as executed.
   */
  async markExecuted(requestId: string): Promise<void> {
    await db.query(
      `UPDATE approval_requests
       SET status = 'executed', executed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'approved'`,
      [requestId]
    );
  }

  async cancelRequest(requestId: string, userId: string): Promise<void> {
    const request = await this.getRequestOrFail(requestId);
    if (request.requester_id !== userId) {
      throw new Error('Only the requester can cancel');
    }
    if (request.status !== 'pending') {
      throw new Error(`Cannot cancel: request is ${request.status}`);
    }

    await db.query(
      `UPDATE approval_requests SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1`,
      [requestId]
    );
  }

  async getPendingRequests(limit = 50) {
    const result = await db.query(
      `SELECT ar.*, ap.name as policy_name
       FROM approval_requests ar
       JOIN approval_policies ap ON ar.policy_id = ap.id
       WHERE ar.status = 'pending' AND (ar.expires_at IS NULL OR ar.expires_at > NOW())
       ORDER BY ar.created_at ASC LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  async getRequestWithDecisions(requestId: string) {
    const request = await this.getRequestOrFail(requestId);
    const decisions = await db.query(
      `SELECT ad.*, u.email as approver_email, u.display_name as approver_name
       FROM approval_decisions ad
       JOIN users u ON ad.approver_id = u.id
       WHERE ad.request_id = $1
       ORDER BY ad.created_at ASC`,
      [requestId]
    );
    return { ...request, decisions: decisions.rows };
  }

  async getPolicies() {
    const result = await db.query(
      'SELECT * FROM approval_policies WHERE active = TRUE ORDER BY resource_type, action'
    );
    return result.rows;
  }

  private async getRequestOrFail(requestId: string) {
    const result = await db.query(
      'SELECT * FROM approval_requests WHERE id = $1',
      [requestId]
    );
    if (result.rows.length === 0) {
      throw new Error(`Approval request ${requestId} not found`);
    }
    return result.rows[0];
  }

  private async expireRequest(requestId: string): Promise<void> {
    await db.query(
      `UPDATE approval_requests SET status = 'expired', updated_at = NOW()
       WHERE id = $1`,
      [requestId]
    );
  }
}
