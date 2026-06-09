"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LendingService = void 0;
const connection_1 = require("../database/connection");
const config_1 = require("../config");
const uuid_1 = require("uuid");
/**
 * Lending, Margin, and Liquidation Engine: loan origination, interest accrual,
 * LTV monitoring, margin calls, and waterfall liquidation.
 */
class LendingService {
    liquidationPenaltyBps = 500; // 5%
    /**
     * Originate a new loan with collateral.
     */
    async originateLoan(params) {
        const collateralValue = Number(params.collateralAmount) * params.collateralPrice;
        const loanValue = Number(params.loanAmount) * params.loanAssetPrice;
        const ltv = loanValue / collateralValue;
        if (ltv >= params.marginCallThreshold)
            throw new Error(`Initial LTV ${(ltv * 100).toFixed(1)}% exceeds margin call threshold`);
        const result = await connection_1.db.query(`INSERT INTO loans (id, borrower_id, collateral_account_id, loan_account_id, collateral_asset, loan_asset, collateral_amount, loan_amount, interest_rate_bps, ltv, liquidation_threshold, margin_call_threshold, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active') RETURNING *`, [(0, uuid_1.v4)(), params.borrowerId, params.collateralAccountId, params.loanAccountId, params.collateralAsset, params.loanAsset, params.collateralAmount.toString(), params.loanAmount.toString(), params.interestRateBps, ltv, params.liquidationThreshold, params.marginCallThreshold]);
        config_1.logger.info({ loanId: result.rows[0].id, ltv: (ltv * 100).toFixed(1) + '%' }, 'Loan originated');
        return this.mapLoan(result.rows[0]);
    }
    /**
     * Accrue interest on all active loans (called periodically).
     */
    async accrueInterest() {
        const loans = await connection_1.db.query(`SELECT * FROM loans WHERE status IN ('active','margin_call')`);
        let processed = 0;
        for (const loan of loans.rows) {
            const dailyRate = loan.interest_rate_bps / 10000 / 365;
            const interest = BigInt(Math.floor(Number(BigInt(loan.loan_amount)) * dailyRate));
            await connection_1.db.query(`UPDATE loans SET accrued_interest = accrued_interest + $1, updated_at=NOW() WHERE id=$2`, [interest.toString(), loan.id]);
            processed++;
        }
        config_1.logger.info({ processed }, 'Interest accrued');
        return processed;
    }
    /**
     * Monitor LTV ratios and trigger margin calls / liquidations.
     */
    async monitorPositions(prices) {
        const loans = await connection_1.db.query(`SELECT * FROM loans WHERE status IN ('active','margin_call')`);
        const marginCalls = [];
        const liquidations = [];
        for (const loan of loans.rows) {
            const collateralPrice = prices[loan.collateral_asset] || 0;
            const loanPrice = prices[loan.loan_asset] || 1;
            const collateralValue = Number(BigInt(loan.collateral_amount)) * collateralPrice;
            const totalDebt = Number(BigInt(loan.loan_amount) + BigInt(loan.accrued_interest || '0')) * loanPrice;
            const currentLtv = totalDebt / collateralValue;
            await connection_1.db.query(`UPDATE loans SET ltv=$1, updated_at=NOW() WHERE id=$2`, [currentLtv, loan.id]);
            if (currentLtv >= loan.liquidation_threshold) {
                await connection_1.db.query(`UPDATE loans SET status='liquidating', updated_at=NOW() WHERE id=$1`, [loan.id]);
                liquidations.push(loan.id);
            }
            else if (currentLtv >= loan.margin_call_threshold && loan.status === 'active') {
                await connection_1.db.query(`UPDATE loans SET status='margin_call', updated_at=NOW() WHERE id=$1`, [loan.id]);
                marginCalls.push(loan.id);
            }
            else if (currentLtv < loan.margin_call_threshold && loan.status === 'margin_call') {
                await connection_1.db.query(`UPDATE loans SET status='active', updated_at=NOW() WHERE id=$1`, [loan.id]);
            }
        }
        if (marginCalls.length > 0)
            config_1.logger.warn({ count: marginCalls.length }, 'Margin calls triggered');
        if (liquidations.length > 0)
            config_1.logger.warn({ count: liquidations.length }, 'Liquidations triggered');
        return { marginCalls, liquidations };
    }
    /**
     * Execute liquidation with waterfall: seize collateral → repay debt → penalty → return surplus.
     */
    async liquidate(loanId, collateralPrice, loanAssetPrice) {
        return (0, connection_1.withSerializableTransaction)(async (client) => {
            const { rows } = await client.query(`SELECT * FROM loans WHERE id=$1 AND status='liquidating' FOR UPDATE`, [loanId]);
            if (!rows[0])
                throw new Error('Loan not found or not in liquidating status');
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
            const journalId = (0, uuid_1.v4)();
            await client.query(`INSERT INTO journal_entries (id, idempotency_key, description, status, external_ref, external_ref_type)
         VALUES ($1,$2,$3,'posted',$4,'liquidation')`, [journalId, `liquidation_${loanId}`, `Loan liquidation: ${loanId}`, loanId]);
            // Debit collateral account
            await client.query(`INSERT INTO ledger_entries (journal_entry_id, account_id, amount, direction, currency)
         VALUES ($1,$2,$3,'debit',$4)`, [journalId, loan.collateral_account_id, collateralAmount.toString(), loan.collateral_asset]);
            // Credit loan account (debt repayment)
            await client.query(`INSERT INTO ledger_entries (journal_entry_id, account_id, amount, direction, currency)
         VALUES ($1,$2,$3,'credit',$4)`, [journalId, loan.loan_account_id, debtRepaid.toString(), loan.loan_asset]);
            // Mark loan as defaulted/repaid
            const finalStatus = collateralInDebtTerms >= totalOwed ? 'repaid' : 'defaulted';
            await client.query(`UPDATE loans SET status=$1, updated_at=NOW() WHERE id=$2`, [finalStatus, loanId]);
            config_1.logger.warn({ loanId, collateralSeized: collateralAmount.toString(), debtRepaid: debtRepaid.toString(), status: finalStatus }, 'Liquidation executed');
            return { loanId, collateralSeized: collateralAmount, debtRepaid, liquidationPenaltyBps: this.liquidationPenaltyBps, surplusReturned };
        });
    }
    /**
     * Repay a loan (partial or full).
     */
    async repay(loanId, amount) {
        await (0, connection_1.withSerializableTransaction)(async (client) => {
            const { rows } = await client.query(`SELECT * FROM loans WHERE id=$1 AND status IN ('active','margin_call') FOR UPDATE`, [loanId]);
            if (!rows[0])
                throw new Error('Loan not found or not repayable');
            const totalDebt = BigInt(rows[0].loan_amount) + BigInt(rows[0].accrued_interest || '0');
            const remaining = totalDebt - amount;
            if (remaining <= BigInt(0)) {
                await client.query(`UPDATE loans SET status='repaid', loan_amount='0', accrued_interest='0', updated_at=NOW() WHERE id=$1`, [loanId]);
            }
            else {
                // Apply to interest first, then principal
                const interest = BigInt(rows[0].accrued_interest || '0');
                if (amount >= interest) {
                    const principalPayment = amount - interest;
                    const newPrincipal = BigInt(rows[0].loan_amount) - principalPayment;
                    await client.query(`UPDATE loans SET accrued_interest='0', loan_amount=$1, updated_at=NOW() WHERE id=$2`, [newPrincipal.toString(), loanId]);
                }
                else {
                    const newInterest = interest - amount;
                    await client.query(`UPDATE loans SET accrued_interest=$1, updated_at=NOW() WHERE id=$2`, [newInterest.toString(), loanId]);
                }
            }
        });
    }
    async getLoan(id) {
        const result = await connection_1.db.query(`SELECT * FROM loans WHERE id=$1`, [id]);
        return result.rows[0] ? this.mapLoan(result.rows[0]) : null;
    }
    async getActiveLoans(borrowerId) {
        const query = borrowerId
            ? `SELECT * FROM loans WHERE borrower_id=$1 AND status IN ('active','margin_call') ORDER BY created_at DESC`
            : `SELECT * FROM loans WHERE status IN ('active','margin_call') ORDER BY created_at DESC`;
        const result = await connection_1.db.query(query, borrowerId ? [borrowerId] : []);
        return result.rows.map(this.mapLoan);
    }
    mapLoan(row) {
        return {
            id: row.id, borrowerId: row.borrower_id,
            collateralAccountId: row.collateral_account_id, loanAccountId: row.loan_account_id,
            collateralAsset: row.collateral_asset, loanAsset: row.loan_asset,
            collateralAmount: BigInt(row.collateral_amount || '0'), loanAmount: BigInt(row.loan_amount || '0'),
            interestRateBps: row.interest_rate_bps, accruedInterest: BigInt(row.accrued_interest || '0'),
            ltv: row.ltv, liquidationThreshold: row.liquidation_threshold,
            marginCallThreshold: row.margin_call_threshold, status: row.status,
        };
    }
}
exports.LendingService = LendingService;
//# sourceMappingURL=lending-service.js.map