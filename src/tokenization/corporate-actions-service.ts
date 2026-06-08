import { v4 as uuidv4 } from 'uuid';
import { TxClient, withSerializableTransaction } from '../database/connection';
import { db } from '../database/connection';
import { logger } from '../config';
import {
  CreateCorporateActionRequest,
  CastVoteRequest,
  CorporateActionStatus,
} from './types';

export class CorporateActionsService {
  async createAction(req: CreateCorporateActionRequest): Promise<string> {
    const result = await db.query(
      `INSERT INTO corporate_actions (
        token_id, action_type, title, description,
        per_token_amount, vote_options, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        req.tokenId,
        req.actionType,
        req.title,
        req.description || null,
        req.perTokenAmount?.toString() || null,
        req.voteOptions ? JSON.stringify(req.voteOptions) : null,
        JSON.stringify(req.metadata || {}),
      ]
    );

    const actionId = result.rows[0].id;

    await db.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('corporate_action', $1, 'corporate_action.created', $2)`,
      [actionId, JSON.stringify({
        actionId,
        tokenId: req.tokenId,
        actionType: req.actionType,
        title: req.title,
      })]
    );

    logger.info(
      { actionId, tokenId: req.tokenId, type: req.actionType },
      'Corporate action created'
    );
    return actionId;
  }

  async setRecordDate(actionId: string): Promise<number> {
    return withSerializableTransaction(async (client: TxClient) => {
      const action = await client.query(
        `SELECT * FROM corporate_actions WHERE id = $1 FOR UPDATE`,
        [actionId]
      );
      if (action.rows.length === 0) {
        throw new Error(`Corporate action ${actionId} not found`);
      }

      const act = action.rows[0];
      if (act.status !== 'draft' && act.status !== 'announced') {
        throw new Error(
          `Cannot set record date: action is in ${act.status} status`
        );
      }

      await client.query(
        `UPDATE corporate_actions
         SET record_date = NOW(), status = 'record_set', updated_at = NOW()
         WHERE id = $1`,
        [actionId]
      );

      const holders = await client.query(
        `SELECT id, account_id, balance FROM token_holders
         WHERE token_id = $1 AND status = 'active' AND balance > 0`,
        [act.token_id]
      );

      for (const holder of holders.rows) {
        await client.query(
          `INSERT INTO corporate_action_distributions (
            action_id, holder_id, account_id, eligible_balance
          ) VALUES ($1, $2, $3, $4)`,
          [actionId, holder.id, holder.account_id, holder.balance]
        );
      }

      await client.query(
        `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('corporate_action', $1, 'corporate_action.record_set', $2)`,
        [actionId, JSON.stringify({
          actionId,
          holdersSnapshot: holders.rows.length,
        })]
      );

      logger.info(
        { actionId, holders: holders.rows.length },
        'Record date set, holders snapshot taken'
      );
      return holders.rows.length;
    });
  }

  async processDistributions(actionId: string): Promise<number> {
    const action = await this.getActionOrFail(actionId);

    if (action.status !== 'record_set') {
      throw new Error(
        `Cannot process: action is in ${action.status} status`
      );
    }

    if (action.action_type === 'vote') {
      throw new Error('Vote actions do not have distributions to process');
    }

    const perTokenAmount = BigInt(action.per_token_amount);
    if (perTokenAmount <= 0n) {
      throw new Error('per_token_amount must be positive');
    }

    const token = await db.query(
      'SELECT treasury_account_id, symbol FROM token_definitions WHERE id = $1',
      [action.token_id]
    );
    if (token.rows.length === 0) {
      throw new Error(`Token ${action.token_id} not found`);
    }
    const treasuryAccountId = token.rows[0].treasury_account_id;
    const symbol = token.rows[0].symbol;

    await db.query(
      `UPDATE corporate_actions
       SET status = 'processing', updated_at = NOW()
       WHERE id = $1`,
      [actionId]
    );

    const BATCH_SIZE = 100;
    let processed = 0;
    let offset = 0;

    while (true) {
      const batch = await db.query(
        `SELECT id, holder_id, account_id, eligible_balance
         FROM corporate_action_distributions
         WHERE action_id = $1 AND status = 'pending'
         ORDER BY id ASC LIMIT $2 OFFSET $3`,
        [actionId, BATCH_SIZE, offset]
      );

      if (batch.rows.length === 0) break;

      for (const dist of batch.rows) {
        try {
          await this.processOneDistribution(
            actionId, dist, perTokenAmount,
            treasuryAccountId, symbol
          );
          processed++;
        } catch (err) {
          logger.error(
            { actionId, distributionId: dist.id, err },
            'Distribution processing failed'
          );
          await db.query(
            `UPDATE corporate_action_distributions
             SET status = 'failed'
             WHERE id = $1`,
            [dist.id]
          );
        }
      }

      offset += BATCH_SIZE;
    }

    await db.query(
      `UPDATE corporate_actions
       SET status = 'completed', payment_date = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [actionId]
    );

    await db.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('corporate_action', $1, 'corporate_action.completed', $2)`,
      [actionId, JSON.stringify({ actionId, processed })]
    );

    logger.info({ actionId, processed }, 'Distributions processed');
    return processed;
  }

  private async processOneDistribution(
    actionId: string,
    dist: {
      id: string;
      holder_id: string;
      account_id: string;
      eligible_balance: string;
    },
    perTokenAmount: bigint,
    treasuryAccountId: string,
    symbol: string,
  ): Promise<void> {
    const distributionAmount = BigInt(dist.eligible_balance) * perTokenAmount;

    await withSerializableTransaction(async (client: TxClient) => {
      const { createHash } = await import('crypto');

      function computeEntryHash(
        prevHash: string, accountId: string,
        amount: bigint, direction: string, seq: number,
      ): string {
        const data = `${prevHash}|${accountId}|${amount}|${direction}|${seq}`;
        return createHash('sha256').update(data).digest('hex');
      }

      await client.query('SET CONSTRAINTS trg_check_balanced DEFERRED');

      const idempotencyKey = `corp-action:${actionId}:dist:${dist.id}`;

      const existing = await client.query(
        'SELECT id FROM journal_entries WHERE idempotency_key = $1',
        [idempotencyKey]
      );

      let journalId: string;

      if (existing.rows.length > 0) {
        journalId = existing.rows[0].id;
      } else {
        const journalResult = await client.query(
          `INSERT INTO journal_entries (
            idempotency_key, description, external_ref,
            external_ref_type, metadata
          ) VALUES ($1, $2, $3, $4, '{}') RETURNING id`,
          [
            idempotencyKey,
            `Distribution: ${symbol} action ${actionId} to ${dist.account_id}`,
            actionId,
            'corporate_action_distribution',
          ]
        );
        journalId = journalResult.rows[0].id;

        const lines = [
          {
            accountId: treasuryAccountId,
            amount: distributionAmount,
            direction: 'debit' as const,
          },
          {
            accountId: dist.account_id,
            amount: distributionAmount,
            direction: 'credit' as const,
          },
        ];

        for (const line of lines) {
          let balanceRow = await client.query(
            'SELECT * FROM balance_cache WHERE account_id = $1 FOR UPDATE',
            [line.accountId]
          );

          if (balanceRow.rows.length === 0) {
            await client.query(
              `INSERT INTO balance_cache (account_id)
               VALUES ($1) ON CONFLICT DO NOTHING`,
              [line.accountId]
            );
            balanceRow = await client.query(
              'SELECT * FROM balance_cache WHERE account_id = $1 FOR UPDATE',
              [line.accountId]
            );
          }

          const bal = balanceRow.rows[0];
          const prevHash = bal.last_entry_hash
            || '0000000000000000000000000000000000000000000000000000000000000000';

          const seqResult = await client.query(
            `SELECT COALESCE(MAX(sequence_num), 0) as max_seq
             FROM ledger_entries WHERE account_id = $1`,
            [line.accountId]
          );
          const nextSeq = Number(seqResult.rows[0].max_seq) + 1;
          const entryHash = computeEntryHash(
            prevHash, line.accountId, line.amount, line.direction, nextSeq
          );

          const entryResult = await client.query(
            `INSERT INTO ledger_entries (
              journal_entry_id, account_id, amount, direction,
              entry_hash, prev_hash, sequence_num
            ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [
              journalId, line.accountId, line.amount.toString(),
              line.direction, entryHash, prevHash, nextSeq,
            ]
          );

          const newDebitTotal = BigInt(bal.debit_total)
            + (line.direction === 'debit' ? line.amount : 0n);
          const newCreditTotal = BigInt(bal.credit_total)
            + (line.direction === 'credit' ? line.amount : 0n);
          const newBalance = newDebitTotal - newCreditTotal;

          await client.query(
            `UPDATE balance_cache
             SET debit_total = $1, credit_total = $2, balance = $3,
                 last_entry_id = $4, last_entry_hash = $5, updated_at = NOW()
             WHERE account_id = $6`,
            [
              newDebitTotal.toString(),
              newCreditTotal.toString(),
              newBalance.toString(),
              entryResult.rows[0].id,
              entryHash,
              line.accountId,
            ]
          );
        }

        await client.query(
          `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
           VALUES ('journal_entry', $1, 'journal.posted', $2)`,
          [journalId, JSON.stringify({
            journalEntryId: journalId,
            idempotencyKey,
            lines: [
              { accountId: treasuryAccountId, amount: distributionAmount.toString(), direction: 'debit' },
              { accountId: dist.account_id, amount: distributionAmount.toString(), direction: 'credit' },
            ],
          })]
        );
      }

      await client.query(
        `UPDATE corporate_action_distributions
         SET distribution_amount = $1, journal_entry_id = $2,
             status = 'processed'
         WHERE id = $3`,
        [distributionAmount.toString(), journalId, dist.id]
      );
    });
  }

  async castVote(req: CastVoteRequest): Promise<void> {
    const action = await this.getActionOrFail(req.actionId);

    if (action.action_type !== 'vote') {
      throw new Error('Can only cast votes on vote-type actions');
    }

    if (action.status !== 'record_set') {
      throw new Error(`Cannot vote: action is in ${action.status} status`);
    }

    const voteOptions = action.vote_options as string[];
    if (!voteOptions || !voteOptions.includes(req.voteChoice)) {
      throw new Error(
        `Invalid vote choice. Options: ${(voteOptions || []).join(', ')}`
      );
    }

    const result = await db.query(
      `UPDATE corporate_action_distributions
       SET vote_choice = $1, status = 'processed'
       WHERE action_id = $2 AND account_id = $3 AND status = 'pending'
       RETURNING id`,
      [req.voteChoice, req.actionId, req.accountId]
    );

    if (result.rows.length === 0) {
      throw new Error(
        `No pending vote found for account ${req.accountId} on action ${req.actionId}`
      );
    }

    logger.info(
      { actionId: req.actionId, accountId: req.accountId, choice: req.voteChoice },
      'Vote cast'
    );
  }

  async getAction(actionId: string) {
    const result = await db.query(
      'SELECT * FROM corporate_actions WHERE id = $1', [actionId]
    );
    return result.rows[0] || null;
  }

  async listActions(tokenId: string, limit = 50, offset = 0) {
    const result = await db.query(
      `SELECT * FROM corporate_actions
       WHERE token_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [tokenId, Math.min(limit, 200), offset]
    );
    return { actions: result.rows, limit, offset };
  }

  async getActionResults(actionId: string) {
    const action = await this.getActionOrFail(actionId);

    const distributions = await db.query(
      `SELECT * FROM corporate_action_distributions
       WHERE action_id = $1
       ORDER BY eligible_balance DESC`,
      [actionId]
    );

    if (action.action_type === 'vote') {
      const voteCounts: Record<string, { count: number; balance: bigint }> = {};
      for (const d of distributions.rows) {
        if (d.vote_choice) {
          if (!voteCounts[d.vote_choice]) {
            voteCounts[d.vote_choice] = { count: 0, balance: 0n };
          }
          voteCounts[d.vote_choice].count++;
          voteCounts[d.vote_choice].balance += BigInt(d.eligible_balance);
        }
      }

      const voteResults = Object.entries(voteCounts).map(([choice, data]) => ({
        choice,
        votes: data.count,
        weightedVotes: data.balance.toString(),
      }));

      return {
        action: action,
        type: 'vote',
        totalEligible: distributions.rows.length,
        totalVoted: distributions.rows.filter(
          (d: { vote_choice: string | null }) => d.vote_choice !== null
        ).length,
        results: voteResults,
      };
    }

    const totalDistributed = distributions.rows
      .filter((d: { status: string }) => d.status === 'processed')
      .reduce(
        (sum: bigint, d: { distribution_amount: string }) =>
          sum + BigInt(d.distribution_amount || 0),
        0n,
      );

    return {
      action: action,
      type: action.action_type,
      totalEligible: distributions.rows.length,
      totalProcessed: distributions.rows.filter(
        (d: { status: string }) => d.status === 'processed'
      ).length,
      totalFailed: distributions.rows.filter(
        (d: { status: string }) => d.status === 'failed'
      ).length,
      totalDistributed: totalDistributed.toString(),
      distributions: distributions.rows,
    };
  }

  async cancelAction(actionId: string): Promise<void> {
    const result = await db.query(
      `UPDATE corporate_actions
       SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND status IN ('draft', 'announced', 'record_set')
       RETURNING id`,
      [actionId]
    );

    if (result.rows.length === 0) {
      throw new Error(
        `Action ${actionId} not found or cannot be cancelled`
      );
    }

    await db.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('corporate_action', $1, 'corporate_action.cancelled', $2)`,
      [actionId, JSON.stringify({ actionId })]
    );

    logger.info({ actionId }, 'Corporate action cancelled');
  }

  private async getActionOrFail(actionId: string) {
    const result = await db.query(
      'SELECT * FROM corporate_actions WHERE id = $1', [actionId]
    );
    if (result.rows.length === 0) {
      throw new Error(`Corporate action ${actionId} not found`);
    }
    return result.rows[0];
  }
}
