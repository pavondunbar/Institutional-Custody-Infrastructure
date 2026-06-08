import { config, logger } from './config';
import { db } from './database/connection';
import { redis } from './cache/redis';
import { OutboxRelay } from './messaging/outbox-relay';
import { BlockIndexer, EventProcessor, IndexedEvent } from './indexer/block-indexer';
import { ReconciliationService } from './reconciliation/reconciliation-service';
import { createApp } from './api/app';
import { id as ethersId } from 'ethers';

// ERC-20 Transfer(address,address,uint256) event signature
const ERC20_TRANSFER_SIG = ethersId('Transfer(address,address,uint256)');

async function main() {
  logger.info('Starting TradFi-Web3 Infrastructure...');

  // Start API server
  const app = createApp();
  app.listen(config.server.port, () => {
    logger.info({ port: config.server.port }, 'API server listening');
  });

  // Start outbox relay (publishes to Kafka)
  const relay = new OutboxRelay();
  await relay.start();

  // Start block indexer
  const indexer = new BlockIndexer();
  await indexer.start();

  // Start event processor with ERC-20 Transfer handler
  const eventProcessor = new EventProcessor();
  eventProcessor.registerHandler(ERC20_TRANSFER_SIG, handleErc20Transfer);
  await eventProcessor.start();

  // Start reconciliation jobs
  const reconciler = new ReconciliationService();
  reconciler.start();

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    await relay.stop();
    await indexer.stop();
    eventProcessor.stop();
    reconciler.stop();
    await redis.quit();
    await db.end();
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
async function handleErc20Transfer(event: IndexedEvent): Promise<void> {
  const contractAddress = event.contractAddress.toLowerCase();

  // Find matching token definition by contract address
  const tokenResult = await db.query(
    `SELECT id, symbol FROM token_definitions
     WHERE LOWER(contract_address) = $1 AND status IN ('active', 'paused')`,
    [contractAddress]
  );

  if (tokenResult.rows.length === 0) {
    return; // Not a tracked token contract
  }

  const token = tokenResult.rows[0];
  const from = event.topics[1] ? '0x' + event.topics[1].slice(26) : null;
  const to = event.topics[2] ? '0x' + event.topics[2].slice(26) : null;

  logger.info(
    {
      tokenId: token.id,
      symbol: token.symbol,
      from,
      to,
      txHash: event.txHash,
      blockNumber: event.blockNumber,
    },
    'ERC-20 Transfer event detected for tracked token'
  );

  // Record the on-chain event for audit trail
  await db.query(
    `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
     VALUES ('token', $1, 'token.onchain_transfer', $2)`,
    [token.id, JSON.stringify({
      tokenId: token.id,
      symbol: token.symbol,
      from,
      to,
      txHash: event.txHash,
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
    })]
  );
}

main().catch((err) => {
  logger.fatal(err, 'Fatal startup error');
  process.exit(1);
});
