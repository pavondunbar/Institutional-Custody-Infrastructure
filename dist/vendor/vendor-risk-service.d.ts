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
export declare class VendorRiskService {
    registerVendor(params: {
        name: string;
        vendorType: VendorType;
        riskTier: RiskTier;
        primaryContactName?: string;
        primaryContactEmail?: string;
    }): Promise<Vendor>;
    conductAssessment(params: {
        vendorId: string;
        assessmentType: AssessmentType;
        assessorId: string;
        categories: Record<string, number>;
        findings: string[];
        recommendations: string[];
    }): Promise<VendorAssessment>;
    recordSLAMetric(params: {
        vendorId: string;
        metricName: string;
        targetValue: number;
        actualValue: number;
        periodStart: Date;
        periodEnd: Date;
    }): Promise<SLAMetric>;
    getVendorsNeedingAssessment(): Promise<Vendor[]>;
    getVendor(id: string): Promise<Vendor | null>;
    getSLABreaches(vendorId: string): Promise<SLAMetric[]>;
    private mapVendor;
    private mapAssessment;
    private mapSLA;
}
//# sourceMappingURL=vendor-risk-service.d.ts.map