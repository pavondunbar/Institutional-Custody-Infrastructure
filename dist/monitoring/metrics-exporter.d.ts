import { Request, Response } from 'express';
/**
 * Prometheus-compatible metrics exporter.
 * Exposes /metrics endpoint in OpenMetrics/Prometheus text format.
 */
export declare class MetricsExporter {
    /**
     * Collect all metrics and return Prometheus text format.
     */
    collect(): Promise<string>;
    /**
     * Express handler for /metrics endpoint.
     */
    handler(): (_req: Request, res: Response) => Promise<void>;
    private format;
}
//# sourceMappingURL=metrics-exporter.d.ts.map