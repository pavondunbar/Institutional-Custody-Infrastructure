import { db } from '../database/connection';
import { logger } from '../config';
import { v4 as uuidv4 } from 'uuid';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ReportType = 'ctr' | 'sar' | 'str' | 'threshold' | 'periodic';

export interface TransactionGraphNode {
  address: string;
  riskScore: number;
  directExposure: string;
  indirectExposure: string;
  hopDistance: number;
  flags: string[];
}

export interface JurisdictionRule {
  id: string;
  jurisdiction: string;
  ruleType: string;
  threshold: string;
  action: 'block' | 'flag' | 'report' | 'require_approval';
  enabled: boolean;
}

export interface RegulatoryReport {
  id: string;
  reportType: ReportType;
  jurisdiction: string;
  periodStart: Date;
  periodEnd: Date;
  generatedAt: Date;
  recordCount: number;
  format: 'json' | 'xml' | 'csv';
  status: 'generated' | 'submitted' | 'accepted' | 'rejected';
}

export class OnchainComplianceService {
  async analyzeTransactionGraph(address: string, maxHops: number = 3): Promise<TransactionGraphNode[]> {
    // Build local graph from indexed transactions
    const nodes: TransactionGraphNode[] = [];
    const visited = new Set<string>();
    const queue: { addr: string; hop: number }[] = [{ addr: address, hop: 0 }];

    while (queue.length > 0) {
      const { addr, hop } = queue.shift()!;
      if (visited.has(addr) || hop > maxHops) continue;
      visited.add(addr);

      // Check sanctions / risk flags
      const { rows: screenResults } = await db.query(
        `SELECT risk_level, flags FROM screening_results WHERE address=$1 ORDER BY screened_at DESC LIMIT 1`, [addr]
      );
      const flags: string[] = screenResults.length ? JSON.parse(screenResults[0].flags || '[]') : [];
      const riskScore = this.calculateRiskScore(flags, hop);

      // Get transaction volume
      const { rows: txRows } = await db.query(
        `SELECT COALESCE(SUM(CAST(value AS NUMERIC)),0) as volume FROM indexed_events WHERE LOWER(topics[1])=LOWER($1) OR LOWER(topics[2])=LOWER($1)`,
        [addr]
      );

      nodes.push({ address: addr, riskScore, directExposure: txRows[0]?.volume || '0', indirectExposure: '0', hopDistance: hop, flags });

      // Find connected addresses (up to 50)
      if (hop < maxHops) {
        const { rows: connected } = await db.query(
          `SELECT DISTINCT CASE WHEN LOWER(topics[1])=LOWER($1) THEN topics[2] ELSE topics[1] END as counterparty
           FROM indexed_events WHERE (LOWER(topics[1])=LOWER($1) OR LOWER(topics[2])=LOWER($1)) LIMIT 50`, [addr]
        );
        for (const c of connected) {
          if (c.counterparty && !visited.has(c.counterparty)) {
            queue.push({ addr: c.counterparty, hop: hop + 1 });
          }
        }
      }
    }

    // Store analysis result
    await db.query(
      `INSERT INTO graph_analysis_results (id, root_address, nodes_analyzed, max_risk_score, analysis_at)
       VALUES ($1,$2,$3,$4,NOW())`,
      [uuidv4(), address, nodes.length, Math.max(...nodes.map(n => n.riskScore), 0)]
    );
    return nodes;
  }

  private calculateRiskScore(flags: string[], hopDistance: number): number {
    let score = 0;
    if (flags.includes('sanctioned')) score += 100;
    if (flags.includes('mixer')) score += 80;
    if (flags.includes('darknet')) score += 90;
    if (flags.includes('high_risk_exchange')) score += 40;
    if (flags.includes('gambling')) score += 20;
    // Decay by hop distance
    return Math.round(score / (hopDistance + 1));
  }

  async setJurisdictionRule(params: {
    jurisdiction: string;
    ruleType: string;
    threshold: string;
    action: 'block' | 'flag' | 'report' | 'require_approval';
  }): Promise<JurisdictionRule> {
    const id = uuidv4();
    await db.query(
      `INSERT INTO jurisdiction_rules (id, jurisdiction, rule_type, threshold, action, enabled)
       VALUES ($1,$2,$3,$4,$5,true)
       ON CONFLICT (jurisdiction, rule_type) DO UPDATE SET threshold=$4, action=$5`,
      [id, params.jurisdiction, params.ruleType, params.threshold, params.action]
    );
    return { id, ...params, enabled: true };
  }

  async evaluateJurisdictionRules(transaction: { fromJurisdiction: string; toJurisdiction: string; amount: string; asset: string }): Promise<{ allowed: boolean; actions: { rule: string; action: string }[] }> {
    const actions: { rule: string; action: string }[] = [];
    const jurisdictions = [transaction.fromJurisdiction, transaction.toJurisdiction];

    for (const j of jurisdictions) {
      const { rows: rules } = await db.query(
        `SELECT * FROM jurisdiction_rules WHERE jurisdiction=$1 AND enabled=true`, [j]
      );
      for (const rule of rules) {
        if (rule.rule_type === 'max_transfer' && BigInt(transaction.amount) > BigInt(rule.threshold)) {
          actions.push({ rule: `${j}:${rule.rule_type}`, action: rule.action });
        }
        if (rule.rule_type === 'blocked_asset' && rule.threshold === transaction.asset) {
          actions.push({ rule: `${j}:blocked_asset`, action: 'block' });
        }
      }
    }

    const blocked = actions.some(a => a.action === 'block');
    return { allowed: !blocked, actions };
  }

  async generateRegulatoryReport(params: {
    reportType: ReportType;
    jurisdiction: string;
    periodStart: Date;
    periodEnd: Date;
    format?: 'json' | 'xml' | 'csv';
  }): Promise<RegulatoryReport> {
    const format = params.format || 'json';

    // Gather reportable transactions based on type
    let query: string;
    switch (params.reportType) {
      case 'ctr': // Currency Transaction Report - transactions above threshold
        query = `SELECT * FROM screening_results WHERE screened_at BETWEEN $1 AND $2 AND risk_level IN ('high','critical')`;
        break;
      case 'sar': // Suspicious Activity Report
        query = `SELECT * FROM suspicious_activity_reports WHERE created_at BETWEEN $1 AND $2`;
        break;
      default:
        query = `SELECT * FROM screening_results WHERE screened_at BETWEEN $1 AND $2`;
    }
    const { rows } = await db.query(query, [params.periodStart, params.periodEnd]);

    const id = uuidv4();
    await db.query(
      `INSERT INTO regulatory_reports (id, report_type, jurisdiction, period_start, period_end, generated_at, record_count, format, status, data)
       VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,'generated',$8)`,
      [id, params.reportType, params.jurisdiction, params.periodStart, params.periodEnd, rows.length, format, JSON.stringify(rows)]
    );

    logger.info({ id, type: params.reportType, records: rows.length }, 'Regulatory report generated');
    return { id, reportType: params.reportType, jurisdiction: params.jurisdiction, periodStart: params.periodStart, periodEnd: params.periodEnd, generatedAt: new Date(), recordCount: rows.length, format, status: 'generated' };
  }

  async getReports(jurisdiction?: string, status?: string): Promise<RegulatoryReport[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (jurisdiction) { params.push(jurisdiction); conditions.push(`jurisdiction=$${params.length}`); }
    if (status) { params.push(status); conditions.push(`status=$${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await db.query(`SELECT * FROM regulatory_reports ${where} ORDER BY generated_at DESC`, params);
    return rows;
  }
}
