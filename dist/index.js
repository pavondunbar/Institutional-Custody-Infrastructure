"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const connection_1 = require("./database/connection");
const redis_1 = require("./cache/redis");
const outbox_relay_1 = require("./messaging/outbox-relay");
const block_indexer_1 = require("./indexer/block-indexer");
const reconciliation_service_1 = require("./reconciliation/reconciliation-service");
const app_1 = require("./api/app");
const ethers_1 = require("ethers");
// ERC-20 Transfer(address,address,uint256) event signature
const ERC20_TRANSFER_SIG = (0, ethers_1.id)('Transfer(address,address,uint256)');
async function main() {
    config_1.logger.info('Starting TradFi-Web3 Infrastructure...');
    // Start API server
    const app = (0, app_1.createApp)();
    app.listen(config_1.config.server.port, () => {
        config_1.logger.info({ port: config_1.config.server.port }, 'API server listening');
    });
    // Start outbox relay (publishes to Kafka)
    const relay = new outbox_relay_1.OutboxRelay();
    await relay.start();
    // Start block indexer
    const indexer = new block_indexer_1.BlockIndexer();
    await indexer.start();
    // Start event processor with ERC-20 Transfer handler
    const eventProcessor = new block_indexer_1.EventProcessor();
    eventProcessor.registerHandler(ERC20_TRANSFER_SIG, handleErc20Transfer);
    await eventProcessor.start();
    // Start reconciliation jobs
    const reconciler = new reconciliation_service_1.ReconciliationService();
    reconciler.start();
    // Graceful shutdown
    const shutdown = async () => {
        config_1.logger.info('Shutting down...');
        await relay.stop();
        await indexer.stop();
        eventProcessor.stop();
        reconciler.stop();
        await redis_1.redis.quit();
        await connection_1.db.end();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
/**
 * Handle ERC-20 Transfer events from indexed on-chain data.
 * Reconciles on-chain transfers with internal token state by recording
 * blockchain transaction references against matching token operations.
 */
async function handleErc20Transfer(event) {
    const contractAddress = event.contractAddress.toLowerCase();
    // Find matching token definition by contract address
    const tokenResult = await connection_1.db.query(`SELECT id, symbol FROM token_definitions
     WHERE LOWER(contract_address) = $1 AND status IN ('active', 'paused')`, [contractAddress]);
    if (tokenResult.rows.length === 0) {
        return; // Not a tracked token contract
    }
    const token = tokenResult.rows[0];
    const from = event.topics[1] ? '0x' + event.topics[1].slice(26) : null;
    const to = event.topics[2] ? '0x' + event.topics[2].slice(26) : null;
    config_1.logger.info({
        tokenId: token.id,
        symbol: token.symbol,
        from,
        to,
        txHash: event.txHash,
        blockNumber: event.blockNumber,
    }, 'ERC-20 Transfer event detected for tracked token');
    // Record the on-chain event for audit trail
    await connection_1.db.query(`INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
     VALUES ('token', $1, 'token.onchain_transfer', $2)`, [token.id, JSON.stringify({
            tokenId: token.id,
            symbol: token.symbol,
            from,
            to,
            txHash: event.txHash,
            blockNumber: event.blockNumber,
            logIndex: event.logIndex,
        })]);
}
main().catch((err) => {
    config_1.logger.fatal(err, 'Fatal startup error');
    process.exit(1);
});
//# sourceMappingURL=index.js.map