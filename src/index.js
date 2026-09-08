import config, { validateConfig } from './config.js';
import logger from './logger.js';
import { cancelOrder, initClients } from './limitlessClient.js';
import { assertBaseContracts, getBaseEthBalance, getUsdcBalance } from './ctf.js';
import { fillWatcher } from './fillWatcher.js';
import { MarketDetector } from './detector.js';
import {
  executeCycle,
  getActivePositions,
  isLiveSessionLimitReached,
  requestStrategyShutdown,
  waitForActivePositionsToClose,
} from './strategy.js';
import { performanceTracker } from './performanceTracker.js';

validateConfig();

for (const method of [
  'start',
  'watchMarket',
  'registerMarket',
  'recordBook',
  'getBook',
  'getBookAgeMs',
  'waitForBook',
  'lastMarketTrade',
  'trackOwnedOrders',
  'minedFills',
  'hasPending',
  'stop',
]) {
  if (typeof fillWatcher[method] !== 'function') {
    throw new Error(`Incompatible src/fillWatcher.js: missing ${method}()`);
  }
}

await initClients();
try {
  await fillWatcher.start();
} catch (error) {
  logger.error(`Cannot connect to Limitless WebSocket: ${error.message}`);
  process.exit(1);
}

const running = new Set();
const pending = new Map();
let stopping = false;

async function runMarket(market) {
  const asset = market.asset;
  if (running.has(asset)) {
    pending.set(asset, market);
    logger.info(`${asset}: queued ${market.slug}`);
    return;
  }
  running.add(asset);
  let cycles = 0;
  try {
    while (!stopping) {
      const startMs = new Date(market.startAt).getTime();
      if (Date.now() < startMs) {
        logger.info(`${asset}: ${market.slug} pre-open; waiting ${Math.ceil((startMs - Date.now()) / 1000)}s`);
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, startMs - Date.now())));
      }
      if (cycles === 0 && Date.now() - startMs > config.entryWindowSec * 1000) {
        logger.info(`${asset}: skipped late discovery of ${market.slug}`);
        break;
      }
      const result = await executeCycle(market, { reentry: cycles > 0 });
      cycles += 1;
      if (result.skipped) {
        logger.info(`${asset}: cycle skipped — ${result.reason}`);
        if (!config.dryRun && isLiveSessionLimitReached()) {
          void shutdown('LIVE SESSION LIMIT');
        }
        break;
      }
      if (config.dryRun) break;
      if (result.oneSided) {
        logger.warn(`${asset}: one-sided cycle; stopping re-entry for ${market.slug}`);
        if (config.stopSessionOnOneSided) {
          void shutdown('ONE-SIDED SAFETY STOP');
        }
        break;
      }
      if (isLiveSessionLimitReached()) {
        void shutdown('LIVE SESSION LIMIT');
        break;
      }
      if (!result.safeToReenter) {
        logger.info(`${asset}: no completed pair; re-entry disabled for ${market.slug}`);
        break;
      }
      if (!config.reentry) break;
      if (config.maxCyclesPerMarket > 0 && cycles >= config.maxCyclesPerMarket) break;
      const secsLeft = (new Date(market.endAt).getTime() - Date.now()) / 1000;
      if (secsLeft <= config.cutLossSec + config.fillTimeoutSec) break;
      await new Promise((resolve) => setTimeout(resolve, config.reentryDelayMs));
    }
  } catch (error) {
    logger.error(`${asset} ${market.slug}: ${error.stack || error.message}`);
  } finally {
    running.delete(asset);
    const queued = pending.get(asset);
    if (queued) {
      pending.delete(asset);
      void runMarket(queued);
    }
  }
}

const detector = new MarketDetector(
  runMarket,
  async (market, { current }) => {
    fillWatcher.registerMarket(market);
    await fillWatcher.watchMarket(market.slug, { activity: current });
  },
);

logger.info(`Limitless maker MM starting in ${config.dryRun ? 'SIMULATION' : 'LIVE'} mode`);
logger.info(`Assets ${config.assets.join('/')} | ${config.subFrequency} | shares ${config.shares} | combined cap ${config.maxCombined}`);
logger.info(`Poll ${config.pollMs}ms | discovery gap ${config.discoveryRequestGapMs}ms | entry ${config.entryWindowSec}s | cycles ${config.maxCyclesPerMarket || 'unlimited'}`);
logger.info(`Book max age ${config.bookMaxAgeMs}ms | quote log ${config.quoteLogIntervalMs}ms | activity poll ${config.marketActivityPollMs}ms`);
logger.info(`Fair trade age ${config.fairTradeMaxAgeMs}ms | paper observe ${config.paperObserveSec}s | entry minimum enforced at 30s`);
logger.info(
  `Fair fallback ${config.allowTightBookFair ? 'enabled' : 'disabled'} | ` +
  `tight WS spread <=${config.tightBookMaxSpread.toFixed(3)} for ` +
  `${config.tightBookConfirmations} distinct updates`,
);
if (config.openingCanaryFair) {
  logger.warn(
    `OPENING FAIR ENABLED fairYES=${config.openingFairYes.toFixed(3)} ` +
    `source=OPENING_50_50_CANARY; a fill is not guaranteed`,
  );
}
if (!config.dryRun) {
  if (
    config.baseRpcUrls.length === 1
    && config.baseRpcUrl === 'https://mainnet.base.org'
  ) {
    logger.warn(
      'PUBLIC BASE RPC ONLY: configure BASE_RPC_FALLBACK_URLS with at least ' +
      'one production Base RPC endpoint for balance reconciliation',
    );
  }
  await assertBaseContracts();
  const [usdc, baseEth] = await Promise.all([
    getUsdcBalance(),
    getBaseEthBalance(),
  ]);
  logger.pnl(`PREFLIGHT USDC=$${usdc.toFixed(2)} BaseETH=${baseEth.toFixed(6)}`);
  logger.warn(
    `LIVE LIMITS assets=${config.assets.join('/')} cycles=${config.maxLiveCyclesSession} ` +
    `cycleCap=$${config.maxCycleUsdc.toFixed(2)} totalCap=$${config.maxTotalUsdc.toFixed(2)} ` +
    `oneSidedStop=${config.stopSessionOnOneSided}`,
  );
  const minimumCycleCost = config.shares * config.maxCombined;
  if (usdc + 1e-9 < minimumCycleCost) {
    logger.error(
      `Insufficient USDC for configured shares: $${usdc.toFixed(2)} ` +
      `< $${minimumCycleCost.toFixed(2)}`,
    );
    await fillWatcher.stop();
    process.exit(1);
  }
  if (baseEth < config.minBaseEth) {
    logger.error(
      `Insufficient Base ETH for canary gas: ${baseEth.toFixed(8)} ` +
      `< ${config.minBaseEth.toFixed(8)}`,
    );
    await fillWatcher.stop();
    process.exit(1);
  }
}
await detector.start();

async function shutdown(signal) {
  if (stopping) {
    logger.warn(`${signal}: shutdown recovery is already running; do not force-quit`);
    return;
  }
  stopping = true;
  logger.warn(`${signal}: stopping discovery and starting active-cycle recovery`);
  detector.stop();
  requestStrategyShutdown();
  if (!config.dryRun) {
    const positions = getActivePositions();
    await Promise.all(positions.flatMap((position) => [
      cancelOrder(position.yesOrderId),
      cancelOrder(position.noOrderId),
    ]));
    logger.bot(`SHUTDOWN cancellation requested for ${positions.length} active cycle(s)`);
    const recovered = await waitForActivePositionsToClose(
      config.shutdownRecoveryTimeoutSec * 1_000,
    );
    if (!recovered) {
      logger.error(
        `SHUTDOWN RECOVERY TIMEOUT active=${getActivePositions().length}; ` +
        'check Limitless open orders and YES/NO balances before closing the terminal',
      );
      return;
    }
    logger.bot('SHUTDOWN RECOVERY COMPLETE: no active bot cycles remain');
  }
  performanceTracker.logSummary();
  await fillWatcher.stop();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
