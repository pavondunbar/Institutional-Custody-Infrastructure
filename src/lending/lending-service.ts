import { db, withSerializableTransaction } from '../database/connection';
import { logger } from '../config';
import { v4 as uuidv4 } from 'uuid';

export type LoanStatus = 'pending' | 'active' | 'margin_call' | 'liquidating' | 'repaid' | 'defaulted';

export interface Loan {
  id: string;
  borrowerId: string;
  collateralAccountId: string;
  loanAccountId: string;
  collateralAsset: string;
  loanAsset: string;
  collateralAmount: bigint;
  loanAmount: bigint;
  interestRateBps: number;
  accruedInterest: bigint;
  ltv: number;
  liquidationThreshold: number;
  marginCallThreshold: number;
  status: LoanStatus;
}

export interface LiquidationResult {
  loanId: string;
  collateralSeized: bigint;
  debtRepaid: bigint;
  liquidationPenaltyBps: number;
  surplusReturned: bigint;
}

/**
 * Lending, Margin, and Liquidation Engine: loan origination, interest accrual,
 * LTV monitoring, margin calls, and waterfall liquidation.
 */
export class LendingService {
  private readonly liquidationPenaltyBps = 500; // 5%

  /**
   * Originate a new loan with collateral.
   */
  async originateLoan(params: {
    borrowerId: string;
    collateralAccountId: string;
    loanAccountId: string;
    collateralAsset: string;
    loanAsset: string;
    collateralAmount: bigint;
    loanAmount: bigint;
    interestRateBps: number;
    liquidationThreshold: number;
    marginCallThreshold: number;
    collateralPrice: number;
    loanAssetPrice: number;
  }): Promise<Loan> {
    const collateralValue = Number(params.collateralAmount) * params.collateralPrice;
    const loanValue = Number(params.loanAmount) * params.loanAssetPrice;
    const ltv = loanValue / collateralValue;

    if (ltv >= params.marginCallThreshold) throw new Error(`Initial LTV ${(ltv * 100).toFixed(1)}% exceeds margin call threshold`);

    const result = await db.query(
      `INSERT INTO loans (id, borrower_id, collateral_account_id, loan_account_id, collateral_asset, loan_asset, collateral_amount, loan_amount, interest_rate_bps, ltv, liquidation_threshold, margin_call_threshold, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active') RETURNING *`,
      [uuidv4(), params.borrowerId, params.collateralAccountId, params.loanAccountId, params.collateralAsset, params.loanAsset, params.collateralAmount.toString(), params.loanAmount.toString(), params.interestRateBps, ltv, params.liquidationThreshold, params.marginCallThreshold]
    );

    logger.info({ loanId: result.rows[0].id, ltv: (ltv * 100).toFixed(1) + '%' }, 'Loan originated');
    return this.mapLoan(result.rows[0]);
  }

  /**
   * Accrue interest on all active loans (called periodically).
   */
  async accrueInterest(): Promise<number> {
    const loans = await db.query(`SELECT * FROM loans WHERE status IN ('active','margin_call')`);
    let processed = 0;

    for (const loan of loans.rows) {
      const dailyRate = loan.interest_rate_bps / 10000 / 365;
      const interest = BigInt(Math.floor(Number(BigInt(loan.loan_amount)) * dailyRate));
      await db.query(
        `UPDATE loans SET accrued_interest = accrued_interest + $1, updated_at=NOW() WHERE id=$2`,
        [interest.toString(), loan.id]
      );
      processed++;
    }

    logger.info({ processed }, 'Interest accrued');
    return processed;
  }

  /**
   * Monitor LTV ratios and trigger margin calls / liquidations.
   */
  async monitorPositions(prices: Record<string, number>): Promise<{ marginCalls: string[]; liquidations: string[] }> {
    const loans = await db.query(`SELECT * FROM loans WHERE status IN ('active','margin_call')`);
    const marginCalls: string[] = [];
    const liquidations: string[] = [];

    for (const loan of loans.rows) {
      const collateralPrice = prices[loan.collateral_asset] || 0;
      const loanPrice = prices[loan.loan_asset] || 1;

      const collateralValue = Number(BigInt(loan.collateral_amount)) * collateralPrice;
      const totalDebt = Number(BigInt(loan.loan_amount) + BigInt(loan.accrued_interest || '0')) * loanPrice;
      const currentLtv = totalDebt / collateralValue;

      await db.query(`UPDATE loans SET ltv=$1, updated_at=NOW() WHERE id=$2`, [currentLtv, loan.id]);

      if (currentLtv >= loan.liquidation_threshold) {
        await db.query(`UPDATE loans SET status='liquidating', updated_at=NOW() WHERE id=$1`, [loan.id]);
        liquidations.push(loan.id);
      } else if (currentLtv >= loan.margin_call_threshold && loan.status === 'active') {
        await db.query(`UPDATE loans SET status='margin_call', updated_at=NOW() WHERE id=$1`, [loan.id]);
        marginCalls.push(loan.id);
      } else if (currentLtv < loan.margin_call_threshold && loan.status === 'margin_call') {
        await db.query(`UPDATE loans SET status='active', updated_at=NOW() WHERE id=$1`, [loan.id]);
      }
    }

    if (marginCalls.length > 0) logger.warn({ count: marginCalls.length }, 'Margin calls triggered');
    if (liquidations.length > 0) logger.warn({ count: liquidations.length }, 'Liquidations triggered');
    return { marginCalls, liquidations };
  }

  /**
   * Execute liquidation with waterfall: seize collateral → repay debt → penalty → return surplus.
   */
  async liquidate(loanId: string, collateralPrice: number, loanAssetPrice: number): Promise<LiquidationResult> {
    return withSerializableTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM loans WHERE id=$1 AND status='liquidating' FOR UPDATE`, [loanId]);
      if (!rows[0]) throw new Error('Loan not found or not in liquidating status');
      const loan = rows[0];

      const collateralAmount = BigInt(loan.collateral_amount);
      const totalDebt = BigInt(loan.loan_amount) + BigInt(loan.accrued_interest || '0');
      const penalty = (totalDebt * BigInt(this.liquidationPenaltyBps)) / BigInt(10000);
      const totalOwed = totalDebt + penalty;

      // Convert collateral to debt asset terms
      const collateralInDebtTerms = BigInt(Math.floor(Number(collateralAmount) * collateralPrice / loanAssetPrice));
      const debtRepaid = collateralInDebtTerms >= totalOwed ? totalOwed : collateralInDebtTerms;
      const surplusReturned = collateralInDebtTerms > totalOwed ? collateralInDebtTerms - totalOwed : BigInt(0);

      // Create journal entries for liquidation
      const journalId = uuidv4();
      await client.query(
        `INSERT INTO journal_entries (id, idempotency_key, description, status, external_ref, external_ref_type)
         VALUES ($1,$2,$3,'posted',$4,'liquidation')`,
        [journalId, `liquidation_${loanId}`, `Loan liquidation: ${loanId}`, loanId]
      );

      // Debit collateral account
      await client.query(
        `INSERT INTO ledger_entries (journal_entry_id, account_id, amount, direction, currency)
         VALUES ($1,$2,$3,'debit',$4)`,
        [journalId, loan.collateral_account_id, collateralAmount.toString(), loan.collateral_asset]
      );

      // Credit loan account (debt repayment)
      await client.query(
        `INSERT INTO ledger_entries (journal_entry_id, account_id, amount, direction, currency)
         VALUES ($1,$2,$3,'credit',$4)`,
        [journalId, loan.loan_account_id, debtRepaid.toString(), loan.loan_asset]
      );

      // Mark loan as defaulted/repaid
      const finalStatus = collateralInDebtTerms >= totalOwed ? 'repaid' : 'defaulted';
      await client.query(`UPDATE loans SET status=$1, updated_at=NOW() WHERE id=$2`, [finalStatus, loanId]);

      logger.warn({ loanId, collateralSeized: collateralAmount.toString(), debtRepaid: debtRepaid.toString(), status: finalStatus }, 'Liquidation executed');

      return { loanId, collateralSeized: collateralAmount, debtRepaid, liquidationPenaltyBps: this.liquidationPenaltyBps, surplusReturned };
    });
  }

  /**
   * Repay a loan (partial or full).
   */
  async repay(loanId: string, amount: bigint): Promise<void> {
    await withSerializableTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM loans WHERE id=$1 AND status IN ('active','margin_call') FOR UPDATE`, [loanId]);
      if (!rows[0]) throw new Error('Loan not found or not repayable');

      const totalDebt = BigInt(rows[0].loan_amount) + BigInt(rows[0].accrued_interest || '0');
      const remaining = totalDebt - amount;

      if (remaining <= BigInt(0)) {
        await client.query(`UPDATE loans SET status='repaid', loan_amount='0', accrued_interest='0', updated_at=NOW() WHERE id=$1`, [loanId]);
      } else {
        // Apply to interest first, then principal
        const interest = BigInt(rows[0].accrued_interest || '0');
        if (amount >= interest) {
          const principalPayment = amount - interest;
          const newPrincipal = BigInt(rows[0].loan_amount) - principalPayment;
          await client.query(`UPDATE loans SET accrued_interest='0', loan_amount=$1, updated_at=NOW() WHERE id=$2`, [newPrincipal.toString(), loanId]);
        } else {
          const newInterest = interest - amount;
          await client.query(`UPDATE loans SET accrued_interest=$1, updated_at=NOW() WHERE id=$2`, [newInterest.toString(), loanId]);
        }
      }
    });
  }

  async getLoan(id: string): Promise<Loan | null> {
    const result = await db.query(`SELECT * FROM loans WHERE id=$1`, [id]);
    return result.rows[0] ? this.mapLoan(result.rows[0]) : null;
  }

  async getActiveLoans(borrowerId?: string): Promise<Loan[]> {
    const query = borrowerId
      ? `SELECT * FROM loans WHERE borrower_id=$1 AND status IN ('active','margin_call') ORDER BY created_at DESC`
      : `SELECT * FROM loans WHERE status IN ('active','margin_call') ORDER BY created_at DESC`;
    const result = await db.query(query, borrowerId ? [borrowerId] : []);
    return result.rows.map(this.mapLoan);
  }

  private mapLoan(row: Record<string, unknown>): Loan {
    return {
      id: row.id as string, borrowerId: row.borrower_id as string,
      collateralAccountId: row.collateral_account_id as string, loanAccountId: row.loan_account_id as string,
      collateralAsset: row.collateral_asset as string, loanAsset: row.loan_asset as string,
      collateralAmount: BigInt((row.collateral_amount as string) || '0'), loanAmount: BigInt((row.loan_amount as string) || '0'),
      interestRateBps: row.interest_rate_bps as number, accruedInterest: BigInt((row.accrued_interest as string) || '0'),
      ltv: row.ltv as number, liquidationThreshold: row.liquidation_threshold as number,
      marginCallThreshold: row.margin_call_threshold as number, status: row.status as LoanStatus,
    };
  }
}
