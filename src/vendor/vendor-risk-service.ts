import { db } from '../database/connection';
import { logger } from '../config';

export type VendorType = 'custodian' | 'oracle' | 'rpc_provider' | 'kms_provider' | 'audit_firm' | 'legal' | 'insurance' | 'infrastructure' | 'other';
export type RiskTier = 'low' | 'medium' | 'high' | 'critical';
export type AssessmentType = 'initial' | 'periodic' | 'incident' | 'renewal';

export interface Vendor {
  id: string;
  name: string;
  vendorType: VendorType;
  riskTier: RiskTier;
  status: 'active' | 'under_review' | 'suspended' | 'terminated';
  lastAssessmentDate?: Date;
  nextAssessmentDate?: Date;
}

export interface VendorAssessment {
  id: string;
  vendorId: string;
  assessmentType: AssessmentType;
  overallScore: number;
  categories: Record<string, number>;
  findings: string[];
  recommendations: string[];
  riskRating?: string;
  status: 'in_progress' | 'completed' | 'requires_action';
}

export interface SLAMetric {
  id: string;
  vendorId: string;
  metricName: string;
  targetValue: number;
  actualValue?: number;
  inCompliance?: boolean;
  breachCount: number;
}

/**
 * Vendor & Third-Party Risk: assessments, oracle risk, SLA monitoring, security reviews.
 */
export class VendorRiskService {
  async registerVendor(params: { name: string; vendorType: VendorType; riskTier: RiskTier; primaryContactName?: string; primaryContactEmail?: string }): Promise<Vendor> {
    const nextAssessment = new Date(Date.now() + (params.riskTier === 'critical' ? 30 : params.riskTier === 'high' ? 90 : 180) * 24 * 60 * 60 * 1000);
    const result = await db.query(
      `INSERT INTO vendors (name, vendor_type, risk_tier, primary_contact_name, primary_contact_email, next_assessment_date)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [params.name, params.vendorType, params.riskTier, params.primaryContactName || null, params.primaryContactEmail || null, nextAssessment]
    );
    logger.info({ id: result.rows[0].id, name: params.name, riskTier: params.riskTier }, 'Vendor registered');
    return this.mapVendor(result.rows[0]);
  }

  async conductAssessment(params: { vendorId: string; assessmentType: AssessmentType; assessorId: string; categories: Record<string, number>; findings: string[]; recommendations: string[] }): Promise<VendorAssessment> {
    const scores = Object.values(params.categories);
    const overallScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
    const riskRating = overallScore >= 80 ? 'low' : overallScore >= 60 ? 'medium' : overallScore >= 40 ? 'high' : 'critical';

    const result = await db.query(
      `INSERT INTO vendor_assessments (vendor_id, assessment_type, assessor_id, overall_score, categories, findings, recommendations, risk_rating, status, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed',NOW()) RETURNING *`,
      [params.vendorId, params.assessmentType, params.assessorId, overallScore, JSON.stringify(params.categories), JSON.stringify(params.findings), JSON.stringify(params.recommendations), riskRating]
    );

    // Update vendor assessment dates
    const nextDate = new Date(Date.now() + (riskRating === 'critical' ? 30 : riskRating === 'high' ? 90 : 180) * 24 * 60 * 60 * 1000);
    await db.query(
      `UPDATE vendors SET last_assessment_date=NOW(), next_assessment_date=$1, risk_tier=$2, updated_at=NOW() WHERE id=$3`,
      [nextDate, riskRating, params.vendorId]
    );

    logger.info({ vendorId: params.vendorId, overallScore, riskRating }, 'Vendor assessment completed');
    return this.mapAssessment(result.rows[0]);
  }

  async recordSLAMetric(params: { vendorId: string; metricName: string; targetValue: number; actualValue: number; periodStart: Date; periodEnd: Date }): Promise<SLAMetric> {
    const inCompliance = params.actualValue >= params.targetValue;
    const result = await db.query(
      `INSERT INTO vendor_sla_metrics (vendor_id, metric_name, target_value, actual_value, measurement_period_start, measurement_period_end, in_compliance, breach_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [params.vendorId, params.metricName, params.targetValue, params.actualValue, params.periodStart, params.periodEnd, inCompliance, inCompliance ? 0 : 1]
    );

    if (!inCompliance) {
      logger.warn({ vendorId: params.vendorId, metric: params.metricName, actual: params.actualValue, target: params.targetValue }, 'SLA breach detected');
    }
    return this.mapSLA(result.rows[0]);
  }

  async getVendorsNeedingAssessment(): Promise<Vendor[]> {
    const result = await db.query(`SELECT * FROM vendors WHERE status='active' AND next_assessment_date <= NOW() ORDER BY next_assessment_date`);
    return result.rows.map(this.mapVendor);
  }

  async getVendor(id: string): Promise<Vendor | null> {
    const result = await db.query(`SELECT * FROM vendors WHERE id=$1`, [id]);
    return result.rows[0] ? this.mapVendor(result.rows[0]) : null;
  }

  async getSLABreaches(vendorId: string): Promise<SLAMetric[]> {
    const result = await db.query(`SELECT * FROM vendor_sla_metrics WHERE vendor_id=$1 AND in_compliance=FALSE ORDER BY created_at DESC`, [vendorId]);
    return result.rows.map(this.mapSLA);
  }

  private mapVendor(row: Record<string, unknown>): Vendor {
    return { id: row.id as string, name: row.name as string, vendorType: row.vendor_type as VendorType, riskTier: row.risk_tier as RiskTier, status: row.status as Vendor['status'], lastAssessmentDate: row.last_assessment_date ? new Date(row.last_assessment_date as string) : undefined, nextAssessmentDate: row.next_assessment_date ? new Date(row.next_assessment_date as string) : undefined };
  }

  private mapAssessment(row: Record<string, unknown>): VendorAssessment {
    return { id: row.id as string, vendorId: row.vendor_id as string, assessmentType: row.assessment_type as AssessmentType, overallScore: row.overall_score as number, categories: row.categories as Record<string, number>, findings: row.findings as string[], recommendations: row.recommendations as string[], riskRating: row.risk_rating as string | undefined, status: row.status as VendorAssessment['status'] };
  }

  private mapSLA(row: Record<string, unknown>): SLAMetric {
    return { id: row.id as string, vendorId: row.vendor_id as string, metricName: row.metric_name as string, targetValue: row.target_value as number, actualValue: row.actual_value as number | undefined, inCompliance: row.in_compliance as boolean | undefined, breachCount: row.breach_count as number };
  }
}
