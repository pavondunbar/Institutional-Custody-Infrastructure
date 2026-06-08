import { CronJob } from 'cron';
import { db } from '../database/connection';
import { reconstructBalance } from '../database/ledger-service';
import { logger } from '../config';

/**
 * ReconciliationService: Scheduled jobs that verify ledger integrity.
 * - Balance reconciliation: cached balances match ledger reconstruction
 * - Hash chain verification: no broken links in the append-only chain
 * - Cross-system: on-chain balances match internal records
 */
export class ReconciliationService {
  private jobs: CronJob[] = [];

  start() {
    // Balance reconciliation every 5 minutes
    this.jobs.push(new CronJob('*/5 * * * *', () => { this.runBalanceReconciliation().catch(e => logger.error(e, 'Balance recon error')); }, null, true));

    // Hash chain verification every 15 minutes
    this.jobs.push(new CronJob('*/15 * * * *', () => { this.runHashChainVerification().catch(e => logger.error(e, 'Hash chain recon error')); }, null, true));

    // Token balance reconciliation every 10 minutes
    this.jobs.push(new CronJob('*/10 * * * *', () => { this.runTokenBalanceReconciliation().catch(e => logger.error(e, 'Token balance recon error')); }, null, true));

    logger.info('Reconciliation service started');
  }

  stop() {
    this.jobs.forEach(j => j.stop());
  }

  /**
   * Verify that balance_cache matches reconstructed balances from ledger_entries.
   */
  async runBalanceReconciliation(): Promise<{ passed: boolean; discrepancies: number }> {
    const runId = await this.startRun('balance');

    const accounts = await db.query('SELECT account_id FROM balance_cache');
    let discrepancies = 0;

    for (const row of accounts.rows) {
      const cached = await db.query('SELECT debit_total, credit_total, balance FROM balance_cache WHERE account_id = $1', [row.account_id]);
      const reconstructed = await reconstructBalance(row.account_id);

      const c = cached.rows[0];
      if (BigInt(c.debit_total) !== reconstructed.debitTotal ||
          BigInt(c.credit_total) !== reconstructed.creditTotal ||
          BigInt(c.balance) !== reconstructed.balance) {
        discrepancies++;
        logger.error({
          accountId: row.account_id,
          cached: { debit: c.debit_total, credit: c.credit_total, balance: c.balance },
          reconstructed: { debit: reconstructed.debitTotal.toString(), credit: reconstructed.creditTotal.toString(), balance: reconstructed.balance.toString() },
        }, 'Balance discrepancy detected');
      }
    }

    await this.completeRun(runId, accounts.rows.length, discrepancies);
    return { passed: discrepancies === 0, discrepancies };
  }

  /**
   * Verify hash chain integrity for all accounts.
   */
  async runHashChainVerification(): Promise<{ passed: boolean; brokenChains: number }> {
    const runId = await this.startRun('hash_chain');

    const accounts = await db.query('SELECT DISTINCT account_id FROM ledger_entries');
    let brokenChains = 0;

    for (const row of accounts.rows) {
      const entries = await db.query(
        'SELECT entry_hash, prev_hash, sequence_num FROM ledger_entries WHERE account_id = $1 ORDER BY sequence_num ASC',
        [row.account_id]
      );

      const ZERO_HASH = '0000000000000000000000000000000000000000000000000000000000000000';
      let expectedPrevHash = ZERO_HASH;

      for (let i = 0; i < entries.rows.length; i++) {
        const entry = entries.rows[i];
        if (entry.prev_hash !== expectedPrevHash) {
          brokenChains++;
          logger.error({ accountId: row.account_id, seq: entry.sequence_num, expectedPrevHash, actualPrevHash: entry.prev_hash }, 'Hash chain broken');
          break;
        }
        if (entry.sequence_num !== i + 1) {
          brokenChains++;
          logger.error({ accountId: row.account_id, expectedSeq: i + 1, actualSeq: entry.sequence_num }, 'Sequence gap');
          break;
        }
        expectedPrevHash = entry.entry_hash;
      }
    }

    await this.completeRun(runId, accounts.rows.length, brokenChains);
    return { passed: brokenChains === 0, brokenChains };
  }

  /**
   * Verify token holder balances match supply and ledger records.
   * - Sum of holder balances == total_minted - total_burned
   * - Each holder's balance matches ledger-derived balance
   */
  async runTokenBalanceReconciliation(): Promise<{ passed: boolean; discrepancies: number }> {
    const runId = await this.startRun('token_balance');

    const tokens = await db.query(
      `SELECT id, symbol, total_minted, total_burned, treasury_account_id
       FROM token_definitions WHERE status IN ('active', 'paused')`
    );

    let discrepancies = 0;
    let tokensChecked = 0;

    for (const token of tokens.rows) {
      tokensChecked++;
      const expectedSupply = BigInt(token.total_minted) - BigInt(token.total_burned);

      const holderSum = await db.query(
        `SELECT COALESCE(SUM(balance), 0) as total
         FROM token_holders
         WHERE token_id = $1 AND status != 'removed'`,
        [token.id]
      );
      const actualHolderTotal = BigInt(holderSum.rows[0].total);

      if (actualHolderTotal !== expectedSupply) {
        discrepancies++;
        logger.error({
          tokenId: token.id,
          symbol: token.symbol,
          expectedSupply: expectedSupply.toString(),
          holderTotal: actualHolderTotal.toString(),
        }, 'Token supply mismatch: holder balances != minted - burned');
      }

      const holders = await db.query(
        `SELECT th.account_id, th.balance as holder_balance
         FROM token_holders th
         WHERE th.token_id = $1 AND th.status != 'removed' AND th.balance > 0`,
        [token.id]
      );

      for (const holder of holders.rows) {
        const ledgerBalance = await reconstructBalance(holder.account_id);
        const holderBal = BigInt(holder.holder_balance);

        if (ledgerBalance.balance !== holderBal) {
          discrepancies++;
          logger.error({
            tokenId: token.id,
            accountId: holder.account_id,
            holderBalance: holderBal.toString(),
            ledgerBalance: ledgerBalance.balance.toString(),
          }, 'Token holder balance does not match ledger');
        }
      }
    }

    await this.completeRun(runId, tokensChecked, discrepancies);
    return { passed: discrepancies === 0, discrepancies };
  }

  private async startRun(type: string): Promise<string> {
    const result = await db.query(
      `INSERT INTO reconciliation_runs (run_type, status) VALUES ($1, 'running') RETURNING id`,
      [type]
    );
    return result.rows[0].id;
  }

  private async completeRun(runId: string, checked: number, discrepancies: number) {
    const status = discrepancies === 0 ? 'passed' : 'failed';
    await db.query(
      `UPDATE reconciliation_runs SET status = $1, accounts_checked = $2, discrepancies_found = $3, completed_at = NOW() WHERE id = $4`,
      [status, checked, discrepancies, runId]
    );

    if (discrepancies > 0) {
      await db.query(
        `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('reconciliation', $1, 'recon.failed', $2)`,
        [runId, JSON.stringify({ runId, discrepancies })]
      );
    }
  }
}
