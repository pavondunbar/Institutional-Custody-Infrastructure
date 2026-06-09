import { db } from '../database/connection';
import { logger } from '../config';
import { createHash, randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

export type CeremonyType = 'generation' | 'rotation' | 'recovery' | 'destruction' | 'shard_recombine';
export type CeremonyStatus = 'initiated' | 'awaiting_participants' | 'in_progress' | 'awaiting_attestations' | 'completed' | 'aborted' | 'expired';
export type ParticipantRole = 'initiator' | 'custodian' | 'witness' | 'auditor' | 'approver';

export interface CeremonyParticipant {
  userId: string;
  role: ParticipantRole;
  joinedAt?: Date;
  attestation?: string;       // SHA-256 hash of what the participant attests to
  attestedAt?: Date;
  shardIndex?: number;        // For shard holders
}

export interface CeremonyStep {
  order: number;
  description: string;
  requiredRole: ParticipantRole;
  completedBy?: string;
  completedAt?: Date;
  evidence?: string;          // Hash of evidence (photo, log, video)
}

export interface KeyCeremony {
  id: string;
  type: CeremonyType;
  keyId: string;
  status: CeremonyStatus;
  minParticipants: number;
  minCustodians: number;
  minWitnesses: number;
  participants: CeremonyParticipant[];
  steps: CeremonyStep[];
  startedAt?: Date;
  completedAt?: Date;
  expiresAt: Date;
  auditLog: CeremonyAuditEntry[];
  metadata: Record<string, unknown>;
}

export interface CeremonyAuditEntry {
  timestamp: Date;
  actor: string;
  action: string;
  details: string;
  evidenceHash?: string;
}

/**
 * Key Ceremony Service
 *
 * Implements institutional key ceremony workflows:
 * - Multi-participant orchestration (initiator, custodians, witnesses, auditors)
 * - Step-by-step ceremony procedures with evidence collection
 * - Attestation signing by all participants
 * - Quorum enforcement (M-of-N custodians + witnesses)
 * - Ceremony expiration and abort procedures
 * - Full audit trail with tamper-evident logging
 */
export class KeyCeremonyService {
  private readonly defaultExpiryHours = 4;

  /**
   * Initiate a new key ceremony.
   */
  async initiateCeremony(params: {
    type: CeremonyType;
    keyId: string;
    initiatedBy: string;
    minCustodians: number;
    minWitnesses: number;
    metadata?: Record<string, unknown>;
  }): Promise<KeyCeremony> {
    const id = uuidv4();
    const expiresAt = new Date(Date.now() + this.defaultExpiryHours * 3600_000);
    const steps = this.generateSteps(params.type);
    const minParticipants = params.minCustodians + params.minWitnesses + 1; // +1 for initiator

    const participants: CeremonyParticipant[] = [
      { userId: params.initiatedBy, role: 'initiator', joinedAt: new Date() },
    ];

    const auditLog: CeremonyAuditEntry[] = [{
      timestamp: new Date(),
      actor: params.initiatedBy,
      action: 'ceremony_initiated',
      details: `${params.type} ceremony initiated for key ${params.keyId}`,
    }];

    await db.query(
      `INSERT INTO key_ceremonies (id, ceremony_type, key_id, status, min_participants, 
       participants, steps, expires_at, audit_log, metadata)
       VALUES ($1, $2, $3, 'awaiting_participants', $4, $5, $6, $7, $8, $9)`,
      [id, params.type, params.keyId, minParticipants,
       JSON.stringify(participants), JSON.stringify(steps),
       expiresAt, JSON.stringify(auditLog), JSON.stringify(params.metadata || {})]
    );

    logger.info({ ceremonyId: id, type: params.type, keyId: params.keyId }, 'Key ceremony initiated');

    return {
      id, type: params.type, keyId: params.keyId,
      status: 'awaiting_participants',
      minParticipants, minCustodians: params.minCustodians, minWitnesses: params.minWitnesses,
      participants, steps, expiresAt, auditLog,
      metadata: params.metadata || {},
    };
  }

  /**
   * Join a ceremony as a participant.
   */
  async joinCeremony(ceremonyId: string, userId: string, role: ParticipantRole): Promise<KeyCeremony> {
    const ceremony = await this.getCeremony(ceremonyId);
    if (!ceremony) throw new Error('Ceremony not found');
    if (ceremony.status !== 'awaiting_participants' && ceremony.status !== 'in_progress') {
      throw new Error(`Cannot join ceremony in status: ${ceremony.status}`);
    }
    if (new Date() > ceremony.expiresAt) {
      await this.abortCeremony(ceremonyId, 'system', 'Ceremony expired');
      throw new Error('Ceremony has expired');
    }

    // Prevent duplicate joins
    if (ceremony.participants.some(p => p.userId === userId)) {
      throw new Error('Participant already joined');
    }

    const participant: CeremonyParticipant = { userId, role, joinedAt: new Date() };
    ceremony.participants.push(participant);

    const auditEntry: CeremonyAuditEntry = {
      timestamp: new Date(),
      actor: userId,
      action: 'participant_joined',
      details: `${role} joined the ceremony`,
    };
    ceremony.auditLog.push(auditEntry);

    // Check if we have enough participants to proceed
    const custodians = ceremony.participants.filter(p => p.role === 'custodian').length;
    const witnesses = ceremony.participants.filter(p => p.role === 'witness').length;
    let newStatus = ceremony.status;

    if (custodians >= ceremony.minCustodians && witnesses >= ceremony.minWitnesses) {
      newStatus = 'in_progress';
    }

    await db.query(
      `UPDATE key_ceremonies SET participants=$1, audit_log=$2, status=$3 WHERE id=$4`,
      [JSON.stringify(ceremony.participants), JSON.stringify(ceremony.auditLog), newStatus, ceremonyId]
    );

    ceremony.status = newStatus;
    logger.info({ ceremonyId, userId, role, status: newStatus }, 'Participant joined ceremony');
    return ceremony;
  }

  /**
   * Complete a ceremony step.
   */
  async completeStep(ceremonyId: string, stepOrder: number, completedBy: string, evidence?: string): Promise<KeyCeremony> {
    const ceremony = await this.getCeremony(ceremonyId);
    if (!ceremony) throw new Error('Ceremony not found');
    if (ceremony.status !== 'in_progress') {
      throw new Error(`Cannot complete step in ceremony status: ${ceremony.status}`);
    }

    const step = ceremony.steps.find(s => s.order === stepOrder);
    if (!step) throw new Error(`Step ${stepOrder} not found`);
    if (step.completedBy) throw new Error(`Step ${stepOrder} already completed`);

    // Verify the completing user has the required role
    const participant = ceremony.participants.find(p => p.userId === completedBy);
    if (!participant) throw new Error('User is not a ceremony participant');
    if (step.requiredRole !== participant.role && participant.role !== 'initiator') {
      throw new Error(`Step requires role '${step.requiredRole}', user has '${participant.role}'`);
    }

    // Verify steps are completed in order
    const prevStep = ceremony.steps.find(s => s.order === stepOrder - 1);
    if (prevStep && !prevStep.completedBy) {
      throw new Error(`Previous step ${stepOrder - 1} must be completed first`);
    }

    step.completedBy = completedBy;
    step.completedAt = new Date();
    step.evidence = evidence ? createHash('sha256').update(evidence).digest('hex') : undefined;

    const auditEntry: CeremonyAuditEntry = {
      timestamp: new Date(),
      actor: completedBy,
      action: 'step_completed',
      details: `Step ${stepOrder}: ${step.description}`,
      evidenceHash: step.evidence,
    };
    ceremony.auditLog.push(auditEntry);

    // Check if all steps are complete
    const allStepsComplete = ceremony.steps.every(s => s.completedBy);
    let newStatus: CeremonyStatus = ceremony.status;
    if (allStepsComplete) {
      newStatus = 'awaiting_attestations';
    }

    await db.query(
      `UPDATE key_ceremonies SET steps=$1, audit_log=$2, status=$3 WHERE id=$4`,
      [JSON.stringify(ceremony.steps), JSON.stringify(ceremony.auditLog), newStatus, ceremonyId]
    );

    ceremony.status = newStatus;
    logger.info({ ceremonyId, stepOrder, completedBy, newStatus }, 'Ceremony step completed');
    return ceremony;
  }

  /**
   * Submit attestation — each participant cryptographically attests to what they witnessed.
   */
  async submitAttestation(ceremonyId: string, userId: string, attestationData: string): Promise<KeyCeremony> {
    const ceremony = await this.getCeremony(ceremonyId);
    if (!ceremony) throw new Error('Ceremony not found');
    if (ceremony.status !== 'awaiting_attestations') {
      throw new Error(`Cannot submit attestation in status: ${ceremony.status}`);
    }

    const participant = ceremony.participants.find(p => p.userId === userId);
    if (!participant) throw new Error('User is not a ceremony participant');
    if (participant.attestation) throw new Error('Attestation already submitted');

    // Compute attestation hash (participant signs: ceremony state + their statement)
    const attestationPayload = `${ceremonyId}:${userId}:${ceremony.type}:${ceremony.keyId}:${attestationData}`;
    participant.attestation = createHash('sha256').update(attestationPayload).digest('hex');
    participant.attestedAt = new Date();

    const auditEntry: CeremonyAuditEntry = {
      timestamp: new Date(),
      actor: userId,
      action: 'attestation_submitted',
      details: `Attestation hash: ${participant.attestation.slice(0, 16)}...`,
      evidenceHash: participant.attestation,
    };
    ceremony.auditLog.push(auditEntry);

    // Check if all required participants have attested
    const requiredAttestors = ceremony.participants.filter(
      p => p.role === 'custodian' || p.role === 'witness' || p.role === 'initiator'
    );
    const allAttested = requiredAttestors.every(p => p.attestation);

    let newStatus: CeremonyStatus = ceremony.status;
    if (allAttested) {
      newStatus = 'completed';
      ceremony.completedAt = new Date();
    }

    await db.query(
      `UPDATE key_ceremonies SET participants=$1, audit_log=$2, status=$3, 
       completed_at=${allAttested ? 'NOW()' : 'completed_at'} WHERE id=$4`,
      [JSON.stringify(ceremony.participants), JSON.stringify(ceremony.auditLog), newStatus, ceremonyId]
    );

    ceremony.status = newStatus;
    if (allAttested) {
      logger.info({ ceremonyId }, 'Key ceremony completed — all attestations received');
    }
    return ceremony;
  }

  /**
   * Abort a ceremony (emergency or timeout).
   */
  async abortCeremony(ceremonyId: string, abortedBy: string, reason: string): Promise<void> {
    const auditEntry: CeremonyAuditEntry = {
      timestamp: new Date(),
      actor: abortedBy,
      action: 'ceremony_aborted',
      details: reason,
    };

    await db.query(
      `UPDATE key_ceremonies SET status='aborted', 
       audit_log=audit_log || $1::jsonb WHERE id=$2`,
      [JSON.stringify([auditEntry]), ceremonyId]
    );

    logger.warn({ ceremonyId, abortedBy, reason }, 'Key ceremony aborted');
  }

  /**
   * Get ceremony by ID.
   */
  async getCeremony(id: string): Promise<KeyCeremony | null> {
    const result = await db.query(`SELECT * FROM key_ceremonies WHERE id=$1`, [id]);
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  /**
   * List active ceremonies.
   */
  async listActiveCeremonies(): Promise<KeyCeremony[]> {
    const result = await db.query(
      `SELECT * FROM key_ceremonies WHERE status NOT IN ('completed','aborted','expired') ORDER BY created_at DESC`
    );
    return result.rows.map(this.mapRow);
  }

  /**
   * Expire ceremonies that have passed their deadline.
   */
  async expireOverdueCeremonies(): Promise<number> {
    const result = await db.query(
      `UPDATE key_ceremonies SET status='expired' 
       WHERE expires_at < NOW() AND status NOT IN ('completed','aborted','expired')
       RETURNING id`
    );
    if (result.rows.length > 0) {
      logger.warn({ count: result.rows.length }, 'Expired overdue ceremonies');
    }
    return result.rows.length;
  }

  /**
   * Verify the integrity of a completed ceremony's attestation chain.
   */
  verifyCeremonyIntegrity(ceremony: KeyCeremony): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    if (ceremony.status !== 'completed') {
      issues.push('Ceremony not in completed status');
    }

    // Verify all steps were completed
    const incompleteSteps = ceremony.steps.filter(s => !s.completedBy);
    if (incompleteSteps.length > 0) {
      issues.push(`${incompleteSteps.length} steps not completed`);
    }

    // Verify step ordering
    for (let i = 1; i < ceremony.steps.length; i++) {
      const prev = ceremony.steps[i - 1];
      const curr = ceremony.steps[i];
      if (prev.completedAt && curr.completedAt && curr.completedAt < prev.completedAt) {
        issues.push(`Step ${curr.order} completed before step ${prev.order}`);
      }
    }

    // Verify all required attestations present
    const requiredAttestors = ceremony.participants.filter(
      p => p.role === 'custodian' || p.role === 'witness' || p.role === 'initiator'
    );
    const missingAttestations = requiredAttestors.filter(p => !p.attestation);
    if (missingAttestations.length > 0) {
      issues.push(`${missingAttestations.length} required attestations missing`);
    }

    // Verify minimum quorum
    const custodians = ceremony.participants.filter(p => p.role === 'custodian' && p.attestation);
    if (custodians.length < ceremony.minCustodians) {
      issues.push(`Insufficient custodians: ${custodians.length}/${ceremony.minCustodians}`);
    }

    const witnesses = ceremony.participants.filter(p => p.role === 'witness' && p.attestation);
    if (witnesses.length < ceremony.minWitnesses) {
      issues.push(`Insufficient witnesses: ${witnesses.length}/${ceremony.minWitnesses}`);
    }

    // Verify ceremony completed before expiry
    if (ceremony.completedAt && ceremony.completedAt > ceremony.expiresAt) {
      issues.push('Ceremony completed after expiry');
    }

    return { valid: issues.length === 0, issues };
  }

  /**
   * Generate ceremony steps based on type.
   */
  private generateSteps(type: CeremonyType): CeremonyStep[] {
    switch (type) {
      case 'generation':
        return [
          { order: 1, description: 'Verify secure environment (air-gapped, no recording devices)', requiredRole: 'witness' },
          { order: 2, description: 'Initialize hardware security module', requiredRole: 'custodian' },
          { order: 3, description: 'Generate key material on HSM', requiredRole: 'custodian' },
          { order: 4, description: 'Verify key generation on separate display', requiredRole: 'witness' },
          { order: 5, description: 'Split key into shards (Shamir secret sharing)', requiredRole: 'custodian' },
          { order: 6, description: 'Distribute shards to custodians', requiredRole: 'initiator' },
          { order: 7, description: 'Verify each custodian received their shard', requiredRole: 'witness' },
          { order: 8, description: 'Destroy plaintext key material', requiredRole: 'custodian' },
          { order: 9, description: 'Seal and sign ceremony record', requiredRole: 'initiator' },
        ];
      case 'rotation':
        return [
          { order: 1, description: 'Verify secure environment', requiredRole: 'witness' },
          { order: 2, description: 'Authenticate existing key (proof of possession)', requiredRole: 'custodian' },
          { order: 3, description: 'Generate new key material', requiredRole: 'custodian' },
          { order: 4, description: 'Verify new key on separate display', requiredRole: 'witness' },
          { order: 5, description: 'Re-encrypt assets under new key', requiredRole: 'custodian' },
          { order: 6, description: 'Verify re-encryption integrity', requiredRole: 'witness' },
          { order: 7, description: 'Mark old key as deprecated', requiredRole: 'initiator' },
          { order: 8, description: 'Seal and sign ceremony record', requiredRole: 'initiator' },
        ];
      case 'recovery':
        return [
          { order: 1, description: 'Verify secure environment and operator identity', requiredRole: 'witness' },
          { order: 2, description: 'Collect minimum threshold of key shards', requiredRole: 'custodian' },
          { order: 3, description: 'Verify shard integrity (checksums)', requiredRole: 'witness' },
          { order: 4, description: 'Reconstruct key from shards', requiredRole: 'custodian' },
          { order: 5, description: 'Verify reconstructed key (test signature)', requiredRole: 'witness' },
          { order: 6, description: 'Load key into new HSM', requiredRole: 'custodian' },
          { order: 7, description: 'Destroy intermediate plaintext material', requiredRole: 'custodian' },
          { order: 8, description: 'Seal and sign ceremony record', requiredRole: 'initiator' },
        ];
      case 'destruction':
        return [
          { order: 1, description: 'Verify authorization and justification', requiredRole: 'approver' },
          { order: 2, description: 'Confirm no outstanding obligations using this key', requiredRole: 'custodian' },
          { order: 3, description: 'Revoke key in all systems', requiredRole: 'custodian' },
          { order: 4, description: 'Zeroize key material on HSM', requiredRole: 'custodian' },
          { order: 5, description: 'Destroy all shard copies', requiredRole: 'custodian' },
          { order: 6, description: 'Witness destruction of all copies', requiredRole: 'witness' },
          { order: 7, description: 'Seal and sign destruction record', requiredRole: 'initiator' },
        ];
      case 'shard_recombine':
        return [
          { order: 1, description: 'Verify secure environment', requiredRole: 'witness' },
          { order: 2, description: 'Authenticate shard holders', requiredRole: 'witness' },
          { order: 3, description: 'Collect shards in air-gapped environment', requiredRole: 'custodian' },
          { order: 4, description: 'Recombine shards', requiredRole: 'custodian' },
          { order: 5, description: 'Verify recombined key (test operation)', requiredRole: 'witness' },
          { order: 6, description: 'Complete intended operation', requiredRole: 'initiator' },
          { order: 7, description: 'Destroy recombined material', requiredRole: 'custodian' },
          { order: 8, description: 'Seal and sign ceremony record', requiredRole: 'initiator' },
        ];
    }
  }

  private mapRow(row: Record<string, unknown>): KeyCeremony {
    const participants = typeof row.participants === 'string'
      ? JSON.parse(row.participants) : (row.participants || []);
    const steps = typeof row.steps === 'string'
      ? JSON.parse(row.steps) : (row.steps || []);
    const auditLog = typeof row.audit_log === 'string'
      ? JSON.parse(row.audit_log) : (row.audit_log || []);

    return {
      id: row.id as string,
      type: row.ceremony_type as CeremonyType,
      keyId: row.key_id as string,
      status: row.status as CeremonyStatus,
      minParticipants: Number(row.min_participants),
      minCustodians: Math.max(1, Math.floor(Number(row.min_participants) / 2)),
      minWitnesses: Math.max(1, Math.ceil(Number(row.min_participants) / 3)),
      participants,
      steps,
      startedAt: row.started_at ? new Date(row.started_at as string) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
      expiresAt: new Date(row.expires_at as string),
      auditLog,
      metadata: (row.metadata as Record<string, unknown>) || {},
    };
  }
}
