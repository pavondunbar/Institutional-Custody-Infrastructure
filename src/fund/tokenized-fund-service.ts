import { db, withSerializableTransaction } from '../database/connection';
import { logger } from '../config';
import { v4 as uuidv4 } from 'uuid';

export type WindowStatus = 'scheduled' | 'open' | 'closed' | 'processing' | 'settled';
export type OrderType = 'subscription' | 'redemption';

export interface SubscriptionRedemptionWindow {
  id: string;
  fundId: string;
  windowType: OrderType;
  status: WindowStatus;
  opensAt: Date;
  closesAt: Date;
  settlementDate: Date;
  navPerShare: string | null;
  totalOrders: number;
}

export interface FundOrder {
  id: string;
  fundId: string;
  investorId: string;
  orderType: OrderType;
  amount: string;
  shares: string | null;
  status: 'pending' | 'accepted' | 'settled' | 'rejected';
  windowId: string;
}

export interface PerformanceFeeResult {
  fundId: string;
  period: string;
  grossReturn: string;
  hurdleRate: number;
  highWaterMark: string;
  performanceFee: string;
  feeRateBps: number;
}

export class TokenizedFundNavService {
  async createWindow(params: {
    fundId: string;
    windowType: OrderType;
    opensAt: Date;
    closesAt: Date;
    settlementDate: Date;
  }): Promise<SubscriptionRedemptionWindow> {
    const id = uuidv4();
    await db.query(
      `INSERT INTO fund_windows (id, fund_id, window_type, status, opens_at, closes_at, settlement_date)
       VALUES ($1,$2,$3,'scheduled',$4,$5,$6)`,
      [id, params.fundId, params.windowType, params.opensAt, params.closesAt, params.settlementDate]
    );
    return { id, fundId: params.fundId, windowType: params.windowType, status: 'scheduled', opensAt: params.opensAt, closesAt: params.closesAt, settlementDate: params.settlementDate, navPerShare: null, totalOrders: 0 };
  }

  async submitOrder(params: { fundId: string; investorId: string; orderType: OrderType; amount: string }): Promise<FundOrder> {
    // Find open window
    const { rows: windows } = await db.query(
      `SELECT * FROM fund_windows WHERE fund_id=$1 AND window_type=$2 AND status='open' AND opens_at <= NOW() AND closes_at >= NOW() LIMIT 1`,
      [params.fundId, params.orderType]
    );
    if (!windows.length) throw new Error(`No open ${params.orderType} window for this fund`);

    const id = uuidv4();
    await db.query(
      `INSERT INTO fund_orders (id, fund_id, investor_id, order_type, amount, status, window_id)
       VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
      [id, params.fundId, params.investorId, params.orderType, params.amount, windows[0].id]
    );
    return { id, fundId: params.fundId, investorId: params.investorId, orderType: params.orderType, amount: params.amount, shares: null, status: 'pending', windowId: windows[0].id };
  }

  async settleWindow(windowId: string, navPerShare: string): Promise<{ settled: number; totalAmount: string }> {
    return await withSerializableTransaction(async (client) => {
      await client.query(`UPDATE fund_windows SET status='processing', nav_per_share=$2 WHERE id=$1`, [windowId, navPerShare]);

      const { rows: orders } = await client.query(
        `SELECT * FROM fund_orders WHERE window_id=$1 AND status='pending' FOR UPDATE`, [windowId]
      );

      let totalAmount = 0n;
      for (const order of orders) {
        const shares = (BigInt(order.amount) * 1000000n) / BigInt(navPerShare); // 6 decimal precision
        await client.query(
          `UPDATE fund_orders SET status='settled', shares=$2 WHERE id=$1`,
          [order.id, shares.toString()]
        );
        totalAmount += BigInt(order.amount);
      }

      await client.query(`UPDATE fund_windows SET status='settled', total_orders=$2 WHERE id=$1`, [windowId, orders.length]);
      logger.info({ windowId, settled: orders.length, nav: navPerShare }, 'Window settled');
      return { settled: orders.length, totalAmount: totalAmount.toString() };
    });
  }

  async calculateEqualization(investorId: string, fundId: string): Promise<{ equalizationCredit: string; equalizationDebit: string }> {
    // Equalization adjusts for performance fee timing differences between investors
    const { rows: orders } = await db.query(
      `SELECT fo.*, fw.nav_per_share FROM fund_orders fo
       JOIN fund_windows fw ON fw.id = fo.window_id
       WHERE fo.investor_id=$1 AND fo.fund_id=$2 AND fo.status='settled'
       ORDER BY fw.settlement_date`, [investorId, fundId]
    );
    if (!orders.length) return { equalizationCredit: '0', equalizationDebit: '0' };

    // Get current NAV
    const { rows: currentNav } = await db.query(
      `SELECT nav_per_share FROM fund_windows WHERE fund_id=$1 AND status='settled' ORDER BY settlement_date DESC LIMIT 1`, [fundId]
    );
    if (!currentNav.length) return { equalizationCredit: '0', equalizationDebit: '0' };

    const currentNavValue = BigInt(currentNav[0].nav_per_share);
    let credit = 0n;
    let debit = 0n;

    for (const order of orders) {
      const entryNav = BigInt(order.nav_per_share);
      const diff = currentNavValue - entryNav;
      const shares = BigInt(order.shares || '0');
      if (diff > 0n) {
        credit += (diff * shares) / 1000000n;
      } else {
        debit += ((-diff) * shares) / 1000000n;
      }
    }
    return { equalizationCredit: credit.toString(), equalizationDebit: debit.toString() };
  }

  async calculatePerformanceFee(fundId: string, periodEnd: Date, hurdleRateBps: number, feeRateBps: number): Promise<PerformanceFeeResult> {
    // Get high water mark
    const { rows: hwm } = await db.query(
      `SELECT high_water_mark FROM fund_performance WHERE fund_id=$1 ORDER BY period_end DESC LIMIT 1`, [fundId]
    );
    const highWaterMark = hwm.length ? BigInt(hwm[0].high_water_mark) : 0n;

    // Get current NAV
    const { rows: navRows } = await db.query(
      `SELECT nav_per_share FROM fund_windows WHERE fund_id=$1 AND status='settled' ORDER BY settlement_date DESC LIMIT 1`, [fundId]
    );
    const currentNav = navRows.length ? BigInt(navRows[0].nav_per_share) : 0n;

    // Performance fee = feeRate * max(0, currentNAV - max(highWaterMark, highWaterMark * (1 + hurdle)))
    const hurdleAdjusted = highWaterMark + (highWaterMark * BigInt(hurdleRateBps)) / 10000n;
    const threshold = hurdleAdjusted > highWaterMark ? hurdleAdjusted : highWaterMark;
    const excess = currentNav > threshold ? currentNav - threshold : 0n;
    const fee = (excess * BigInt(feeRateBps)) / 10000n;

    const newHwm = currentNav > highWaterMark ? currentNav : highWaterMark;
    await db.query(
      `INSERT INTO fund_performance (id, fund_id, period_end, high_water_mark, performance_fee, fee_rate_bps, hurdle_rate_bps)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv4(), fundId, periodEnd, newHwm.toString(), fee.toString(), feeRateBps, hurdleRateBps]
    );

    return { fundId, period: periodEnd.toISOString(), grossReturn: excess.toString(), hurdleRate: hurdleRateBps, highWaterMark: newHwm.toString(), performanceFee: fee.toString(), feeRateBps };
  }

  async generateInvestorStatement(investorId: string, fundId: string): Promise<Record<string, unknown>> {
    const { rows: orders } = await db.query(
      `SELECT fo.*, fw.nav_per_share, fw.settlement_date FROM fund_orders fo
       JOIN fund_windows fw ON fw.id = fo.window_id
       WHERE fo.investor_id=$1 AND fo.fund_id=$2 AND fo.status='settled'
       ORDER BY fw.settlement_date`, [investorId, fundId]
    );

    const totalShares = orders.reduce((sum, o) => {
      const shares = BigInt(o.shares || '0');
      return o.order_type === 'subscription' ? sum + shares : sum - shares;
    }, 0n);

    const totalInvested = orders.filter(o => o.order_type === 'subscription').reduce((sum, o) => sum + BigInt(o.amount), 0n);
    const totalRedeemed = orders.filter(o => o.order_type === 'redemption').reduce((sum, o) => sum + BigInt(o.amount), 0n);

    const { rows: navRows } = await db.query(
      `SELECT nav_per_share FROM fund_windows WHERE fund_id=$1 AND status='settled' ORDER BY settlement_date DESC LIMIT 1`, [fundId]
    );
    const currentNav = navRows.length ? BigInt(navRows[0].nav_per_share) : 0n;
    const currentValue = (totalShares * currentNav) / 1000000n;

    const equalization = await this.calculateEqualization(investorId, fundId);

    return {
      investorId, fundId,
      totalShares: totalShares.toString(),
      totalInvested: totalInvested.toString(),
      totalRedeemed: totalRedeemed.toString(),
      currentValue: currentValue.toString(),
      currentNavPerShare: currentNav.toString(),
      unrealizedGain: (currentValue - totalInvested + totalRedeemed).toString(),
      equalization,
      transactionHistory: orders.map(o => ({ date: o.settlement_date, type: o.order_type, amount: o.amount, shares: o.shares, nav: o.nav_per_share })),
      generatedAt: new Date(),
    };
  }
}
