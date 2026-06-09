"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VendorRiskService = void 0;
const connection_1 = require("../database/connection");
const config_1 = require("../config");
/**
 * Vendor & Third-Party Risk: assessments, oracle risk, SLA monitoring, security reviews.
 */
class VendorRiskService {
    async registerVendor(params) {
        const nextAssessment = new Date(Date.now() + (params.riskTier === 'critical' ? 30 : params.riskTier === 'high' ? 90 : 180) * 24 * 60 * 60 * 1000);
        const result = await connection_1.db.query(`INSERT INTO vendors (name, vendor_type, risk_tier, primary_contact_name, primary_contact_email, next_assessment_date)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [params.name, params.vendorType, params.riskTier, params.primaryContactName || null, params.primaryContactEmail || null, nextAssessment]);
        config_1.logger.info({ id: result.rows[0].id, name: params.name, riskTier: params.riskTier }, 'Vendor registered');
        return this.mapVendor(result.rows[0]);
    }
    async conductAssessment(params) {
        const scores = Object.values(params.categories);
        const overallScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
        const riskRating = overallScore >= 80 ? 'low' : overallScore >= 60 ? 'medium' : overallScore >= 40 ? 'high' : 'critical';
        const result = await connection_1.db.query(`INSERT INTO vendor_assessments (vendor_id, assessment_type, assessor_id, overall_score, categories, findings, recommendations, risk_rating, status, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed',NOW()) RETURNING *`, [params.vendorId, params.assessmentType, params.assessorId, overallScore, JSON.stringify(params.categories), JSON.stringify(params.findings), JSON.stringify(params.recommendations), riskRating]);
        // Update vendor assessment dates
        const nextDate = new Date(Date.now() + (riskRating === 'critical' ? 30 : riskRating === 'high' ? 90 : 180) * 24 * 60 * 60 * 1000);
        await connection_1.db.query(`UPDATE vendors SET last_assessment_date=NOW(), next_assessment_date=$1, risk_tier=$2, updated_at=NOW() WHERE id=$3`, [nextDate, riskRating, params.vendorId]);
        config_1.logger.info({ vendorId: params.vendorId, overallScore, riskRating }, 'Vendor assessment completed');
        return this.mapAssessment(result.rows[0]);
    }
    async recordSLAMetric(params) {
        const inCompliance = params.actualValue >= params.targetValue;
        const result = await connection_1.db.query(`INSERT INTO vendor_sla_metrics (vendor_id, metric_name, target_value, actual_value, measurement_period_start, measurement_period_end, in_compliance, breach_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [params.vendorId, params.metricName, params.targetValue, params.actualValue, params.periodStart, params.periodEnd, inCompliance, inCompliance ? 0 : 1]);
        if (!inCompliance) {
            config_1.logger.warn({ vendorId: params.vendorId, metric: params.metricName, actual: params.actualValue, target: params.targetValue }, 'SLA breach detected');
        }
        return this.mapSLA(result.rows[0]);
    }
    async getVendorsNeedingAssessment() {
        const result = await connection_1.db.query(`SELECT * FROM vendors WHERE status='active' AND next_assessment_date <= NOW() ORDER BY next_assessment_date`);
        return result.rows.map(this.mapVendor);
    }
    async getVendor(id) {
        const result = await connection_1.db.query(`SELECT * FROM vendors WHERE id=$1`, [id]);
        return result.rows[0] ? this.mapVendor(result.rows[0]) : null;
    }
    async getSLABreaches(vendorId) {
        const result = await connection_1.db.query(`SELECT * FROM vendor_sla_metrics WHERE vendor_id=$1 AND in_compliance=FALSE ORDER BY created_at DESC`, [vendorId]);
        return result.rows.map(this.mapSLA);
    }
    mapVendor(row) {
        return { id: row.id, name: row.name, vendorType: row.vendor_type, riskTier: row.risk_tier, status: row.status, lastAssessmentDate: row.last_assessment_date ? new Date(row.last_assessment_date) : undefined, nextAssessmentDate: row.next_assessment_date ? new Date(row.next_assessment_date) : undefined };
    }
    mapAssessment(row) {
        return { id: row.id, vendorId: row.vendor_id, assessmentType: row.assessment_type, overallScore: row.overall_score, categories: row.categories, findings: row.findings, recommendations: row.recommendations, riskRating: row.risk_rating, status: row.status };
    }
    mapSLA(row) {
        return { id: row.id, vendorId: row.vendor_id, metricName: row.metric_name, targetValue: row.target_value, actualValue: row.actual_value, inCompliance: row.in_compliance, breachCount: row.breach_count };
    }
}
exports.VendorRiskService = VendorRiskService;
//# sourceMappingURL=vendor-risk-service.js.map