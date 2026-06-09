import { db, withSerializableTransaction } from '../database/connection';
import { logger } from '../config';
import { v4 as uuidv4 } from 'uuid';

export type UtxoStatus = 'unspent' | 'reserved' | 'spent' | 'pending_confirmation';
export type BasketStatus = 'pending' | 'approved' | 'settling' | 'settled' | 'rejected';

export interface BtcUtxo {
  id: string;
  txid: string;
  vout: number;
  amount: string; // satoshis
  address: string;
  confirmations: number;
  status: UtxoStatus;
  reservedForBasketId: string | null;
}

export interface CreationRedemptionBasket {
  id: string;
  type: 'creation' | 'redemption';
  apId: string;
  btcAmount: string;
  sharesAmount: string;
  navPerShare: string;
  status: BasketStatus;
  utxoIds: string[];
  submittedAt: Date;
  settledAt: Date | null;
}

export interface IntradayNav {
  fundId: string;
  timestamp: Date;
  btcPrice: string;
  totalBtcHeld: string;
  totalShares: string;
  iNavPerShare: string;
  premiumDiscountBps: number;
}

export class BitcoinEtfService {
  private readonly basketSize = '5000000000'; // 50 BTC in satoshis (standard creation unit)

  async registerUtxo(params: { txid: string; vout: number; amount: string; address: string; confirmations: number }): Promise<BtcUtxo> {
    const id = uuidv4();
    await db.query(
      `INSERT INTO btc_utxos (id, txid, vout, amount, address, confirmations, status)
       VALUES ($1,$2,$3,$4,$5,$6,'unspent')
       ON CONFLICT (txid, vout) DO UPDATE SET confirmations=$6`,
      [id, params.txid, params.vout, params.amount, params.address, params.confirmations]
    );
    return { id, ...params, status: 'unspent', reservedForBasketId: null };
  }

  async getUtxoSet(minConfirmations: number = 6): Promise<{ utxos: BtcUtxo[]; totalBalance: string }> {
    const { rows } = await db.query(
      `SELECT * FROM btc_utxos WHERE status='unspent' AND confirmations >= $1 ORDER BY amount DESC`, [minConfirmations]
    );
    const total = rows.reduce((sum, u) => sum + BigInt(u.amount), 0n);
    return { utxos: rows, totalBalance: total.toString() };
  }

  async selectUtxosForAmount(targetSatoshis: string): Promise<{ selected: BtcUtxo[]; totalSelected: string; change: string }> {
    const target = BigInt(targetSatoshis);
    const { rows } = await db.query(`SELECT * FROM btc_utxos WHERE status='unspent' AND confirmations >= 6 ORDER BY amount ASC`);

    // Simple greedy coin selection (largest first for fewer inputs)
    const sorted = rows.sort((a: { amount: string }, b: { amount: string }) => Number(BigInt(b.amount) - BigInt(a.amount)));
    const selected: BtcUtxo[] = [];
    let accumulated = 0n;

    for (const utxo of sorted) {
      if (accumulated >= target) break;
      selected.push(utxo);
      accumulated += BigInt(utxo.amount);
    }
    if (accumulated < target) throw new Error('Insufficient UTXO balance');

    return { selected, totalSelected: accumulated.toString(), change: (accumulated - target).toString() };
  }

  async submitCreationBasket(apId: string, btcAmount: string, navPerShare: string): Promise<CreationRedemptionBasket> {
    const sharesAmount = (BigInt(btcAmount) * 1000000n) / BigInt(navPerShare);
    const { selected } = await this.selectUtxosForAmount(btcAmount);
    const utxoIds = selected.map(u => u.id);

    const id = uuidv4();
    await db.query(
      `INSERT INTO etf_baskets (id, type, ap_id, btc_amount, shares_amount, nav_per_share, status, utxo_ids, submitted_at)
       VALUES ($1,'creation',$2,$3,$4,$5,'pending',$6,NOW())`,
      [id, apId, btcAmount, sharesAmount.toString(), navPerShare, JSON.stringify(utxoIds)]
    );

    // Reserve UTXOs
    for (const uid of utxoIds) {
      await db.query(`UPDATE btc_utxos SET status='reserved', reserved_for_basket_id=$2 WHERE id=$1`, [uid, id]);
    }

    logger.info({ id, apId, btcAmount, shares: sharesAmount.toString() }, 'Creation basket submitted');
    return { id, type: 'creation', apId, btcAmount, sharesAmount: sharesAmount.toString(), navPerShare, status: 'pending', utxoIds, submittedAt: new Date(), settledAt: null };
  }

  async submitRedemptionBasket(apId: string, sharesAmount: string, navPerShare: string): Promise<CreationRedemptionBasket> {
    const btcAmount = (BigInt(sharesAmount) * BigInt(navPerShare)) / 1000000n;
    const id = uuidv4();
    await db.query(
      `INSERT INTO etf_baskets (id, type, ap_id, btc_amount, shares_amount, nav_per_share, status, utxo_ids, submitted_at)
       VALUES ($1,'redemption',$2,$3,$4,$5,'pending','[]',NOW())`,
      [id, apId, btcAmount.toString(), sharesAmount, navPerShare]
    );
    logger.info({ id, apId, sharesAmount, btc: btcAmount.toString() }, 'Redemption basket submitted');
    return { id, type: 'redemption', apId, btcAmount: btcAmount.toString(), sharesAmount, navPerShare, status: 'pending', utxoIds: [], submittedAt: new Date(), settledAt: null };
  }

  async approveBasket(basketId: string, approvedBy: string): Promise<void> {
    await db.query(`UPDATE etf_baskets SET status='approved', approved_by=$2 WHERE id=$1 AND status='pending'`, [basketId, approvedBy]);
  }

  async settleBasket(basketId: string): Promise<void> {
    await withSerializableTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM etf_baskets WHERE id=$1 AND status='approved' FOR UPDATE`, [basketId]);
      if (!rows.length) throw new Error('Basket not found or not approved');
      const basket = rows[0];

      if (basket.type === 'creation') {
        // Mark UTXOs as spent
        const utxoIds: string[] = JSON.parse(basket.utxo_ids);
        for (const uid of utxoIds) {
          await client.query(`UPDATE btc_utxos SET status='spent' WHERE id=$1`, [uid]);
        }
      }

      await client.query(`UPDATE etf_baskets SET status='settled', settled_at=NOW() WHERE id=$1`, [basketId]);
      await client.query(
        `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ('etf',$1,$2,$3)`,
        [basketId, `etf.basket.${basket.type}.settled`, JSON.stringify({ basketId, type: basket.type, btc: basket.btc_amount, shares: basket.shares_amount })]
      );
    });
  }

  async calculateIntradayNav(fundId: string, btcPrice: string): Promise<IntradayNav> {
    const { totalBalance } = await this.getUtxoSet(1); // include 1-conf for iNAV
    const { rows: shares } = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN type='creation' THEN CAST(shares_amount AS NUMERIC) ELSE -CAST(shares_amount AS NUMERIC) END),0) as total_shares
       FROM etf_baskets WHERE status='settled'`
    );
    const totalShares = BigInt(Math.floor(Number(shares[0].total_shares)));
    const totalBtcValue = (BigInt(totalBalance) * BigInt(btcPrice)) / 100000000n; // convert sats to value
    const iNavPerShare = totalShares > 0n ? (totalBtcValue * 1000000n) / totalShares : 0n;

    // Calculate premium/discount vs last official NAV
    const { rows: lastNav } = await db.query(
      `SELECT nav_per_share FROM etf_baskets WHERE status='settled' ORDER BY settled_at DESC LIMIT 1`
    );
    const officialNav = lastNav.length ? BigInt(lastNav[0].nav_per_share) : iNavPerShare;
    const premDisc = officialNav > 0n ? Number(((iNavPerShare - officialNav) * 10000n) / officialNav) : 0;

    const result: IntradayNav = { fundId, timestamp: new Date(), btcPrice, totalBtcHeld: totalBalance, totalShares: totalShares.toString(), iNavPerShare: iNavPerShare.toString(), premiumDiscountBps: premDisc };

    await db.query(
      `INSERT INTO intraday_nav (id, fund_id, timestamp, btc_price, total_btc_held, total_shares, inav_per_share, premium_discount_bps)
       VALUES ($1,$2,NOW(),$3,$4,$5,$6,$7)`,
      [uuidv4(), fundId, btcPrice, totalBalance, totalShares.toString(), iNavPerShare.toString(), premDisc]
    );
    return result;
  }

  async reconcileFundAccounting(fundId: string): Promise<{ balanced: boolean; discrepancies: string[] }> {
    const discrepancies: string[] = [];

    // Compare UTXO total vs expected holdings
    const { totalBalance } = await this.getUtxoSet(6);
    const { rows: baskets } = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN type='creation' THEN CAST(btc_amount AS NUMERIC) ELSE -CAST(btc_amount AS NUMERIC) END),0) as net_btc
       FROM etf_baskets WHERE status='settled'`
    );
    const expectedBtc = BigInt(Math.floor(Number(baskets[0].net_btc)));
    const actualBtc = BigInt(totalBalance);

    if (actualBtc !== expectedBtc) {
      discrepancies.push(`UTXO balance mismatch: actual=${actualBtc.toString()} expected=${expectedBtc.toString()}`);
    }

    // Verify shares outstanding
    const { rows: sharesRows } = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN type='creation' THEN CAST(shares_amount AS NUMERIC) ELSE -CAST(shares_amount AS NUMERIC) END),0) as net
       FROM etf_baskets WHERE status='settled'`
    );
    if (Number(sharesRows[0].net) < 0) {
      discrepancies.push('Negative shares outstanding detected');
    }

    logger.info({ fundId, balanced: discrepancies.length === 0, issues: discrepancies.length }, 'Fund accounting reconciliation');
    return { balanced: discrepancies.length === 0, discrepancies };
  }
}
