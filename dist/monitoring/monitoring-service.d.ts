export type AlertCategory = 'security' | 'compliance' | 'operational' | 'financial' | 'performance' | 'chain';
export type ConditionType = 'threshold' | 'anomaly' | 'pattern' | 'absence' | 'rate_change';
export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';
export interface AlertRule {
    id: string;
    name: string;
    category: AlertCategory;
    conditionType: ConditionType;
    config: Record<string, unknown>;
    severity: AlertSeverity;
    notificationChannels: string[];
    cooldownMinutes: number;
    active: boolean;
}
export interface AlertEvent {
    id: string;
    ruleId: string;
    severity: AlertSeverity;
    title: string;
    description?: string;
    metricValue?: number;
    thresholdValue?: number;
    acknowledged: boolean;
    resolved: boolean;
}
/**
 * Monitoring & Observability: real-time monitoring, SIEM integration,
 * fraud/anomaly detection, chain analytics, alerting.
 */
export declare class MonitoringService {
    createAlertRule(params: {
        name: string;
        category: AlertCategory;
        conditionType: ConditionType;
        config: Record<string, unknown>;
        severity: AlertSeverity;
        notificationChannels?: string[];
        cooldownMinutes?: number;
    }): Promise<AlertRule>;
    /**
     * Evaluate all active alert rules against current metrics.
     */
    evaluateRules(): Promise<AlertEvent[]>;
    /**
     * Record a metric for anomaly detection (sliding window in Redis).
     */
    recordMetric(metricName: string, value: number, tags?: Record<string, string>): Promise<void>;
    /**
     * Detect anomalies using statistical deviation (z-score).
     */
    detectAnomaly(metricName: string, currentValue: number, stdDevThreshold?: number): Promise<boolean>;
    /**
     * Monitor transaction for suspicious patterns (fraud detection).
     */
    monitorTransaction(params: {
        txId: string;
        fromAddress: string;
        toAddress: string;
        amount: bigint;
        chain: string;
    }): Promise<{
        suspicious: boolean;
        reasons: string[];
    }>;
    /**
     * SIEM event export format.
     */
    exportSIEMEvents(since: Date, limit?: number): Promise<Array<Record<string, unknown>>>;
    acknowledgeAlert(alertId: string, userId: string): Promise<void>;
    resolveAlert(alertId: string): Promise<void>;
    getUnresolvedAlerts(severity?: AlertSeverity): Promise<AlertEvent[]>;
    private evaluateCondition;
    private fireAlert;
    private mapRule;
    private mapEvent;
}
//# sourceMappingURL=monitoring-service.d.ts.map