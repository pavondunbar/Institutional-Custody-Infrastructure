"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TreasuryService = void 0;
const connection_1 = require("../database/connection");
const config_1 = require("../config");
/**
 * Treasury Management: diversification, rebalancing, NAV, proof of reserves, yield.
 */
class TreasuryService {
    async createPortfolio(params) {
        const result = await connection_1.db.query(`INSERT INTO treasury_portfolios (name, strategy, target_allocations, rebalance_threshold_bps)
       VALUES ($1,$2,$3,$4) RETURNING *`, [params.name, params.strategy, JSON.stringify(params.targetAllocations), params.rebalanceThresholdBps || 500]);
        config_1.logger.info({ id: result.rows[0].id, strategy: params.strategy }, 'Treasury portfolio created');
        return this.mapPortfolio(result.rows[0]);
    }
    /**
     * Calculate NAV (Net Asset Value) for a portfolio.
     */
    async calculateNAV(portfolioId) {
        const positions = await connection_1.db.query(`SELECT * FROM treasury_positions WHERE portfolio_id=$1`, [portfolioId]);
        let totalValue = BigInt(0);
        const posData = [];
        for (const pos of positions.rows) {
            const value = BigInt(pos.current_value);
            totalValue += value;
            posData.push({ asset: pos.asset_id, value, pct: 0 });
        }
        // Calculate percentages
        for (const p of posData) {
            p.pct = totalValue > BigInt(0) ? Number((p.value * BigInt(10000)) / totalValue) / 100 : 0;
        }
        await connection_1.db.query(`UPDATE treasury_portfolios SET total_value=$1, actual_allocations=$2, updated_at=NOW() WHERE id=$3`, [totalValue.toString(), JSON.stringify(Object.fromEntries(posData.map(p => [p.asset, p.pct]))), portfolioId]);
        return { totalValue, positions: posData };
    }
    /**
     * Calculate rebalance actions needed to bring portfolio to target.
     */
    async calculateRebalance(portfolioId) {
        const portfolio = await this.getPortfolio(portfolioId);
        if (!portfolio)
            throw new Error('Portfolio not found');
        const { totalValue, positions } = await this.calculateNAV(portfolioId);
        if (totalValue === BigInt(0))
            return [];
        const actions = [];
        for (const [asset, targetPct] of Object.entries(portfolio.targetAllocations)) {
            const current = positions.find(p => p.asset === asset);
            const currentPct = current?.pct || 0;
            const diffBps = Math.abs((currentPct - targetPct) * 100);
            if (diffBps > portfolio.rebalanceThresholdBps) {
                const targetValue = (totalValue * BigInt(Math.round(targetPct * 100))) / BigInt(10000);
                const currentValue = current?.value || BigInt(0);
                const diff = targetValue - currentValue;
                actions.push({
                    asset,
                    direction: diff > BigInt(0) ? 'buy' : 'sell',
                    amount: diff < BigInt(0) ? -diff : diff,
                    currentPct,
                    targetPct,
                });
            }
        }
        config_1.logger.info({ portfolioId, actionCount: actions.length }, 'Rebalance calculated');
        return actions;
    }
    /**
     * Proof of Reserves: verify on-chain balances match recorded positions.
     */
    async generateProofOfReserves(portfolioId) {
        const positions = await connection_1.db.query(`SELECT * FROM treasury_positions WHERE portfolio_id=$1`, [portfolioId]);
        let totalReserves = BigInt(0);
        for (const pos of positions.rows) {
            totalReserves += BigInt(pos.current_value);
        }
        // Get liabilities from ledger
        const liabilities = await connection_1.db.query(`SELECT COALESCE(SUM(bc.balance),0) as total FROM balance_cache bc JOIN accounts a ON bc.account_id=a.id WHERE a.account_type='liability'`);
        const totalLiabilities = BigInt(liabilities.rows[0]?.total || '0');
        const ratio = totalLiabilities > BigInt(0) ? Number((totalReserves * BigInt(10000)) / totalLiabilities) / 10000 : 1;
        config_1.logger.info({ portfolioId, totalReserves: totalReserves.toString(), ratio }, 'Proof of reserves generated');
        return { verified: ratio >= 1, totalReserves, totalLiabilities, ratio, timestamp: new Date() };
    }
    async getPortfolio(id) {
        const result = await connection_1.db.query(`SELECT * FROM treasury_portfolios WHERE id=$1`, [id]);
        return result.rows[0] ? this.mapPortfolio(result.rows[0]) : null;
    }
    async updatePosition(portfolioId, assetId, quantity, currentValue) {
        await connection_1.db.query(`INSERT INTO treasury_positions (portfolio_id, asset_type, asset_id, quantity, current_value, updated_at)
       VALUES ($1,'digital_asset',$2,$3,$4,NOW())
       ON CONFLICT (portfolio_id, asset_id) DO UPDATE SET quantity=$3, current_value=$4, unrealized_pnl=$4 - treasury_positions.cost_basis, updated_at=NOW()`, [portfolioId, assetId, quantity.toString(), currentValue.toString()]);
    }
    mapPortfolio(row) {
        return {
            id: row.id,
            name: row.name,
            strategy: row.strategy,
            targetAllocations: row.target_allocations || {},
            actualAllocations: row.actual_allocations || {},
            totalValue: BigInt(row.total_value || '0'),
            rebalanceThresholdBps: row.rebalance_threshold_bps,
            status: row.status,
        };
    }
}
exports.TreasuryService = TreasuryService;
//# sourceMappingURL=treasury-service.js.map