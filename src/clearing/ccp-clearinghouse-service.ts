import { db, withSerializableTransaction } from '../database/connection';
import { logger } from '../config';
import { v4 as uuidv4 } from 'uuid';

export type MemberStatus = 'pending' | 'active' | 'suspended' | 'defaulting' | 'terminated';
export type MarginType = 'initial' | 'variation';
export type DefaultWaterfallStep = 'defaulter_margin' | 'defaulter_fund' | 'ccp_skin_in_game' | 'surviving_fund' | 'assessment';

export interface ClearingMember {
  id: string;
  name: string;
  status: MemberStatus;
  defaultFundContribution: string;
  initialMargin: string;
  variationMargin: string;
  positionLimit: string;
  currentExposure: string;
}

export interface StressTestResult {
  id: string;
  scenarioName: string;
  totalExposure: string;
  defaultFundAdequacy: number; // ratio
  membersBreachingLimits: string[];
  runAt: Date;
}

export class CcpClearinghouseService {
  private readonly ccpSkinInGameBps = 500; // 5% of default fund

  async onboardMember(params: {
    name: string;
    initialContribution: string;
    positionLimit: string;
  }): Promise<ClearingMember> {
    const id = uuidv4();
    await db.query(
      `INSERT INTO clearing_members (id, name, status, default_fund_contribution, initial_margin, variation_margin, position_limit, current_exposure)
       VALUES ($1,$2,'active',$3,'0','0',$4,'0')`,
      [id, params.name, params.initialContribution, params.positionLimit]
    );
    logger.info({ id, name: params.name }, 'Clearing member onboarded');
    return { id, name: params.name, status: 'active', defaultFundContribution: params.initialContribution, initialMargin: '0', variationMargin: '0', positionLimit: params.positionLimit, currentExposure: '0' };
  }

  async postMargin(memberId: string, marginType: MarginType, amount: string): Promise<void> {
    const col = marginType === 'initial' ? 'initial_margin' : 'variation_margin';
    await db.query(
      `UPDATE clearing_members SET ${col} = (CAST(${col} AS NUMERIC) + $2)::TEXT WHERE id=$1 AND status='active'`,
      [memberId, amount]
    );
    await db.query(
      `INSERT INTO margin_calls (id, member_id, margin_type, amount, status, posted_at)
       VALUES ($1,$2,$3,$4,'posted',NOW())`,
      [uuidv4(), memberId, marginType, amount]
    );
  }

  async checkPositionLimit(memberId: string, additionalExposure: string): Promise<{ allowed: boolean; currentExposure: string; limit: string }> {
    const { rows } = await db.query(`SELECT position_limit, current_exposure FROM clearing_members WHERE id=$1`, [memberId]);
    if (!rows.length) throw new Error('Member not found');
    const current = BigInt(rows[0].current_exposure);
    const limit = BigInt(rows[0].position_limit);
    const newExposure = current + BigInt(additionalExposure);
    return { allowed: newExposure <= limit, currentExposure: current.toString(), limit: limit.toString() };
  }

  async updateExposure(memberId: string, newExposure: string): Promise<void> {
    await db.query(`UPDATE clearing_members SET current_exposure=$2 WHERE id=$1`, [memberId, newExposure]);
  }

  async executeDefaultWaterfall(defaultingMemberId: string): Promise<{ steps: { step: DefaultWaterfallStep; amount: string }[]; totalRecovered: string }> {
    return await withSerializableTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM clearing_members WHERE id=$1 FOR UPDATE`, [defaultingMemberId]
      );
      if (!rows.length) throw new Error('Member not found');
      const member = rows[0];
      const loss = BigInt(member.current_exposure);
      let remaining = loss;
      const steps: { step: DefaultWaterfallStep; amount: string }[] = [];

      // Step 1: Defaulter's margin
      const margin = BigInt(member.initial_margin) + BigInt(member.variation_margin);
      const step1 = margin < remaining ? margin : remaining;
      steps.push({ step: 'defaulter_margin', amount: step1.toString() });
      remaining -= step1;

      // Step 2: Defaulter's default fund contribution
      if (remaining > 0n) {
        const dfContrib = BigInt(member.default_fund_contribution);
        const step2 = dfContrib < remaining ? dfContrib : remaining;
        steps.push({ step: 'defaulter_fund', amount: step2.toString() });
        remaining -= step2;
      }

      // Step 3: CCP skin-in-the-game
      if (remaining > 0n) {
        const { rows: allMembers } = await client.query(`SELECT SUM(CAST(default_fund_contribution AS NUMERIC)) as total FROM clearing_members WHERE status='active'`);
        const totalFund = BigInt(Math.floor(Number(allMembers[0].total || 0)));
        const ccpSkin = (totalFund * BigInt(this.ccpSkinInGameBps)) / 10000n;
        const step3 = ccpSkin < remaining ? ccpSkin : remaining;
        steps.push({ step: 'ccp_skin_in_game', amount: step3.toString() });
        remaining -= step3;
      }

      // Step 4: Surviving members' default fund (mutualized)
      if (remaining > 0n) {
        const { rows: survivors } = await client.query(
          `SELECT SUM(CAST(default_fund_contribution AS NUMERIC)) as total FROM clearing_members WHERE status='active' AND id != $1`, [defaultingMemberId]
        );
        const survivorFund = BigInt(Math.floor(Number(survivors[0].total || 0)));
        const step4 = survivorFund < remaining ? survivorFund : remaining;
        steps.push({ step: 'surviving_fund', amount: step4.toString() });
        remaining -= step4;
      }

      // Step 5: Assessment (unlimited liability)
      if (remaining > 0n) {
        steps.push({ step: 'assessment', amount: remaining.toString() });
        remaining = 0n;
      }

      // Mark member as defaulting
      await client.query(`UPDATE clearing_members SET status='defaulting' WHERE id=$1`, [defaultingMemberId]);

      await client.query(
        `INSERT INTO default_events (id, member_id, loss_amount, waterfall_steps, executed_at) VALUES ($1,$2,$3,$4,NOW())`,
        [uuidv4(), defaultingMemberId, loss.toString(), JSON.stringify(steps)]
      );

      logger.info({ memberId: defaultingMemberId, loss: loss.toString(), steps: steps.length }, 'Default waterfall executed');
      return { steps, totalRecovered: (loss - remaining).toString() };
    });
  }

  async runStressTest(scenarioName: string, shockPct: number): Promise<StressTestResult> {
    const { rows: members } = await db.query(`SELECT * FROM clearing_members WHERE status='active'`);
    const totalExposure = members.reduce((sum, m) => sum + BigInt(m.current_exposure), 0n);
    const stressedExposure = (totalExposure * BigInt(Math.round(shockPct * 100))) / 10000n;
    const totalFund = members.reduce((sum, m) => sum + BigInt(m.default_fund_contribution), 0n);
    const adequacy = totalFund > 0n ? Number(totalFund) / Number(stressedExposure || 1n) : 0;
    const breaching = members.filter(m => {
      const stressed = (BigInt(m.current_exposure) * BigInt(Math.round(shockPct * 100))) / 10000n;
      return stressed > BigInt(m.position_limit);
    }).map(m => m.id);

    const id = uuidv4();
    await db.query(
      `INSERT INTO stress_test_results (id, scenario_name, total_exposure, default_fund_adequacy, members_breaching, run_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [id, scenarioName, stressedExposure.toString(), adequacy, JSON.stringify(breaching)]
    );
    return { id, scenarioName, totalExposure: stressedExposure.toString(), defaultFundAdequacy: adequacy, membersBreachingLimits: breaching, runAt: new Date() };
  }
}
