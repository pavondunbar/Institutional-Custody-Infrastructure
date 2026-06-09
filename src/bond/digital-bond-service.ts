import { db } from '../database/connection';
import { logger } from '../config';
import { v4 as uuidv4 } from 'uuid';

export type CouponFrequency = 'monthly' | 'quarterly' | 'semi_annual' | 'annual' | 'zero_coupon';
export type BondEventType = 'coupon_payment' | 'call' | 'put' | 'sinking_fund' | 'credit_event' | 'maturity';
export type CreditEventType = 'downgrade' | 'default' | 'restructuring' | 'cross_default';

export interface BondTerms {
  id: string;
  bondId: string;
  faceValue: string;
  couponRateBps: number;
  couponFrequency: CouponFrequency;
  issueDate: Date;
  maturityDate: Date;
  dayCountConvention: '30/360' | 'actual/360' | 'actual/365' | 'actual/actual';
  callProvisions: { date: Date; price: string }[];
  putProvisions: { date: Date; price: string }[];
  sinkingFundSchedule: { date: Date; amount: string }[];
}

export interface AccruedInterestCalc {
  bondId: string;
  faceValue: string;
  couponRateBps: number;
  daysSinceLastCoupon: number;
  daysInPeriod: number;
  accruedInterest: string;
  cleanPrice: string;
  dirtyPrice: string;
}

export class DigitalBondService {
  async createBondTerms(params: {
    bondId: string;
    faceValue: string;
    couponRateBps: number;
    couponFrequency: CouponFrequency;
    issueDate: Date;
    maturityDate: Date;
    dayCountConvention?: '30/360' | 'actual/360' | 'actual/365' | 'actual/actual';
    callProvisions?: { date: Date; price: string }[];
    putProvisions?: { date: Date; price: string }[];
    sinkingFundSchedule?: { date: Date; amount: string }[];
  }): Promise<BondTerms> {
    const id = uuidv4();
    const dcc = params.dayCountConvention || '30/360';
    await db.query(
      `INSERT INTO bond_terms (id, bond_id, face_value, coupon_rate_bps, coupon_frequency, issue_date, maturity_date, day_count_convention, call_provisions, put_provisions, sinking_fund_schedule)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, params.bondId, params.faceValue, params.couponRateBps, params.couponFrequency, params.issueDate, params.maturityDate, dcc, JSON.stringify(params.callProvisions || []), JSON.stringify(params.putProvisions || []), JSON.stringify(params.sinkingFundSchedule || [])]
    );
    return { id, bondId: params.bondId, faceValue: params.faceValue, couponRateBps: params.couponRateBps, couponFrequency: params.couponFrequency, issueDate: params.issueDate, maturityDate: params.maturityDate, dayCountConvention: dcc, callProvisions: params.callProvisions || [], putProvisions: params.putProvisions || [], sinkingFundSchedule: params.sinkingFundSchedule || [] };
  }

  async generateCouponSchedule(bondId: string): Promise<{ date: Date; amount: string }[]> {
    const { rows } = await db.query(`SELECT * FROM bond_terms WHERE bond_id=$1`, [bondId]);
    if (!rows.length) throw new Error('Bond terms not found');
    const terms = rows[0];

    const schedule: { date: Date; amount: string }[] = [];
    const monthsPerPeriod: Record<CouponFrequency, number> = { monthly: 1, quarterly: 3, semi_annual: 6, annual: 12, zero_coupon: 0 };
    const interval = monthsPerPeriod[terms.coupon_frequency as CouponFrequency];
    if (interval === 0) return schedule;

    const couponPerPeriod = (BigInt(terms.face_value) * BigInt(terms.coupon_rate_bps)) / (10000n * BigInt(12 / interval));
    let couponDate = new Date(terms.issue_date);

    while (true) {
      couponDate = new Date(couponDate.getTime());
      couponDate.setMonth(couponDate.getMonth() + interval);
      if (couponDate > new Date(terms.maturity_date)) break;
      schedule.push({ date: new Date(couponDate), amount: couponPerPeriod.toString() });
    }

    // Persist schedule
    for (const s of schedule) {
      await db.query(
        `INSERT INTO coupon_schedule (id, bond_id, payment_date, amount, status) VALUES ($1,$2,$3,$4,'scheduled')
         ON CONFLICT (bond_id, payment_date) DO NOTHING`,
        [uuidv4(), bondId, s.date, s.amount]
      );
    }
    return schedule;
  }

  calculateAccruedInterest(params: {
    faceValue: string;
    couponRateBps: number;
    lastCouponDate: Date;
    settlementDate: Date;
    nextCouponDate: Date;
    cleanPrice: string;
    dayCountConvention: '30/360' | 'actual/360' | 'actual/365' | 'actual/actual';
  }): AccruedInterestCalc {
    let daysSince: number;
    let daysInPeriod: number;

    if (params.dayCountConvention === '30/360') {
      daysSince = this.days30_360(params.lastCouponDate, params.settlementDate);
      daysInPeriod = this.days30_360(params.lastCouponDate, params.nextCouponDate);
    } else {
      daysSince = Math.round((params.settlementDate.getTime() - params.lastCouponDate.getTime()) / 86400_000);
      daysInPeriod = Math.round((params.nextCouponDate.getTime() - params.lastCouponDate.getTime()) / 86400_000);
    }

    const annualCoupon = (BigInt(params.faceValue) * BigInt(params.couponRateBps)) / 10000n;
    const accrued = (annualCoupon * BigInt(daysSince)) / BigInt(params.dayCountConvention === 'actual/360' ? 360 : 365);
    const dirtyPrice = BigInt(params.cleanPrice) + accrued;

    return {
      bondId: '', faceValue: params.faceValue, couponRateBps: params.couponRateBps,
      daysSinceLastCoupon: daysSince, daysInPeriod,
      accruedInterest: accrued.toString(), cleanPrice: params.cleanPrice, dirtyPrice: dirtyPrice.toString()
    };
  }

  private days30_360(start: Date, end: Date): number {
    const d1 = Math.min(start.getDate(), 30);
    const d2 = d1 === 30 ? Math.min(end.getDate(), 30) : end.getDate();
    return (end.getFullYear() - start.getFullYear()) * 360 + (end.getMonth() - start.getMonth()) * 30 + (d2 - d1);
  }

  async evaluateCallProvision(bondId: string, currentDate: Date): Promise<{ callable: boolean; callPrice: string | null; nextCallDate: Date | null }> {
    const { rows } = await db.query(`SELECT call_provisions FROM bond_terms WHERE bond_id=$1`, [bondId]);
    if (!rows.length) throw new Error('Bond not found');
    const provisions: { date: string; price: string }[] = JSON.parse(rows[0].call_provisions);
    const eligible = provisions.filter(p => new Date(p.date) <= currentDate);
    if (!eligible.length) {
      const next = provisions.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())[0];
      return { callable: false, callPrice: null, nextCallDate: next ? new Date(next.date) : null };
    }
    const latest = eligible.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
    return { callable: true, callPrice: latest.price, nextCallDate: null };
  }

  async evaluatePutProvision(bondId: string, currentDate: Date): Promise<{ puttable: boolean; putPrice: string | null }> {
    const { rows } = await db.query(`SELECT put_provisions FROM bond_terms WHERE bond_id=$1`, [bondId]);
    if (!rows.length) throw new Error('Bond not found');
    const provisions: { date: string; price: string }[] = JSON.parse(rows[0].put_provisions);
    const eligible = provisions.filter(p => new Date(p.date) <= currentDate);
    if (!eligible.length) return { puttable: false, putPrice: null };
    const latest = eligible.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
    return { puttable: true, putPrice: latest.price };
  }

  async executeSinkingFundPayment(bondId: string): Promise<{ amount: string; remainingSchedule: number }> {
    const { rows } = await db.query(`SELECT sinking_fund_schedule FROM bond_terms WHERE bond_id=$1`, [bondId]);
    if (!rows.length) throw new Error('Bond not found');
    const schedule: { date: string; amount: string }[] = JSON.parse(rows[0].sinking_fund_schedule);
    const due = schedule.filter(s => new Date(s.date) <= new Date());
    if (!due.length) throw new Error('No sinking fund payment due');

    const payment = due[0];
    await db.query(
      `INSERT INTO bond_events (id, bond_id, event_type, event_date, amount, details) VALUES ($1,$2,'sinking_fund',NOW(),$3,$4)`,
      [uuidv4(), bondId, payment.amount, JSON.stringify(payment)]
    );
    return { amount: payment.amount, remainingSchedule: schedule.length - due.length };
  }

  async recordCreditEvent(bondId: string, eventType: CreditEventType, details: Record<string, unknown>): Promise<void> {
    await db.query(
      `INSERT INTO bond_events (id, bond_id, event_type, event_date, details) VALUES ($1,$2,'credit_event',NOW(),$3)`,
      [uuidv4(), bondId, JSON.stringify({ creditEventType: eventType, ...details })]
    );
    logger.warn({ bondId, eventType }, 'Credit event recorded');
    // Emit outbox for downstream processing
    await db.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ('bond',$1,'bond.credit_event',$2)`,
      [bondId, JSON.stringify({ bondId, eventType, details })]
    );
  }
}
