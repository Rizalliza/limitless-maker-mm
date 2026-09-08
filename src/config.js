import 'dotenv/config';

const bool = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
};

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

const list = (name, fallback) => (process.env[name] || fallback)
  .split(',')
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean);

const urls = (name) => (process.env[name] || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const primaryBaseRpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const baseRpcUrls = [...new Set([
  primaryBaseRpcUrl,
  ...urls('BASE_RPC_FALLBACK_URLS'),
])];

const config = {
  dryRun: bool('DRY_RUN', true),
  dryRunFillMode: process.env.DRY_RUN_FILL_MODE || 'observe',
  liveAck: process.env.LIVE_TRADING_ACK || '',
  liveCanaryOnly: bool('LIVE_CANARY_ONLY', true),
  apiUrl: process.env.LMTS_API_URL || 'https://api.limitless.exchange',
  wsUrl: process.env.LMTS_WS_URL || 'wss://ws.limitless.exchange',
  baseRpcUrl: primaryBaseRpcUrl,
  baseRpcUrls,
  baseRpcReadAttempts: num('BASE_RPC_READ_ATTEMPTS', 5),
  baseRpcRetryMs: num('BASE_RPC_RETRY_MS', 500),
  tokenId: process.env.LMTS_TOKEN_ID || '',
  tokenSecret: process.env.LMTS_TOKEN_SECRET || '',
  privateKey: process.env.PRIVATE_KEY || '',
  assets: list('MAKER_MM_ASSETS', 'BTC,ETH'),
  subFrequency: process.env.MAKER_MM_SUB_FREQUENCY || 'minutes_5',
  pollMs: num('MAKER_MM_POLL_MS', 5_000),
  discoveryRequestGapMs: num('LMTS_DISCOVERY_REQUEST_GAP_MS', 1_000),
  timelineNoSlotBackoffMs: num('LMTS_TIMELINE_NO_SLOT_BACKOFF_MS', 300_000),
  marketWsMaxSlugs: num('LMTS_MARKET_WS_MAX_SLUGS', 12),
  entryWindowSec: num('MAKER_MM_ENTRY_WINDOW_SEC', 30),
  bookWarmupMs: num('MAKER_MM_BOOK_WARMUP_MS', 1_500),
  bookRetryMs: num('MAKER_MM_BOOK_RETRY_MS', 2_000),
  bookMaxAgeMs: num('MAKER_MM_BOOK_MAX_AGE_MS', 5_000),
  quoteLogIntervalMs: num('MAKER_MM_QUOTE_LOG_INTERVAL_MS', 10_000),
  marketActivityPollMs: num('LMTS_MARKET_ACTIVITY_POLL_MS', 30_000),
  fairTradeMaxAgeMs: num('MAKER_MM_FAIR_TRADE_MAX_AGE_MS', 60_000),
  requireTradeFair: bool('MAKER_MM_REQUIRE_TRADE_FAIR', true),
  allowTightBookFair: bool('MAKER_MM_ALLOW_TIGHT_BOOK_FAIR', true),
  tightBookMaxSpread: num('MAKER_MM_TIGHT_BOOK_MAX_SPREAD', 0.10),
  tightBookConfirmations: num('MAKER_MM_TIGHT_BOOK_CONFIRMATIONS', 3),
  openingCanaryFair: bool('MAKER_MM_OPENING_CANARY_FAIR', false),
  openingFairYes: num('MAKER_MM_OPENING_FAIR_YES', 0.5),
  paperObserveSec: num('MAKER_MM_PAPER_OBSERVE_SEC', 120),
  paperActivityPollMs: num('MAKER_MM_PAPER_ACTIVITY_POLL_MS', 10_000),
  cutLossSec: num('MAKER_MM_CUT_LOSS_SEC', 30),
  shares: num('MAKER_MM_SHARES', 20),
  maxCombined: num('MAKER_MM_MAX_COMBINED', 0.98),
  maxBookSpread: num('MAKER_MM_MAX_BOOK_SPREAD', 0.05),
  priceTick: num('MAKER_MM_PRICE_TICK', 0.001),
  improvementTicks: num('MAKER_MM_JOIN_IMPROVEMENT_TICKS', 1),
  fillTimeoutSec: num('MAKER_MM_FILL_TIMEOUT_SEC', 30),
  settlementGraceSec: num('MAKER_MM_SETTLEMENT_GRACE_SEC', 30),
  shutdownRecoveryTimeoutSec: num('MAKER_MM_SHUTDOWN_RECOVERY_TIMEOUT_SEC', 180),
  balancePollMs: num('MAKER_MM_BALANCE_POLL_MS', 1_500),
  reentry: bool('MAKER_MM_REENTRY', true),
  reentryDelayMs: num('MAKER_MM_REENTRY_DELAY_MS', 1_000),
  maxCyclesPerMarket: num('MAKER_MM_MAX_CYCLES_PER_MARKET', 1),
  maxLiveCyclesSession: num('MAKER_MM_MAX_LIVE_CYCLES_SESSION', 1),
  stopSessionOnOneSided: bool('MAKER_MM_STOP_SESSION_ON_ONE_SIDED', true),
  maxCycleUsdc: num('MAKER_MM_MAX_CYCLE_USDC', 50),
  maxTotalUsdc: num('MAKER_MM_MAX_TOTAL_USDC', 50),
  minBaseEth: num('MAKER_MM_MIN_BASE_ETH', 0.00005),
  unwindSlippageTicks: num('MAKER_MM_UNWIND_SLIPPAGE_TICKS', 3),
  mergeGasLimit: num('MERGE_GAS_LIMIT', 0),
};

export function validateConfig() {
  if (!['observe', 'none'].includes(config.dryRunFillMode)) {
    throw new Error('DRY_RUN_FILL_MODE must be observe or none');
  }
  if (!['minutes_5', 'minutes_15'].includes(config.subFrequency)) {
    throw new Error('MAKER_MM_SUB_FREQUENCY must be minutes_5 or minutes_15');
  }
  if (!(config.maxCombined > 0 && config.maxCombined < 1)) {
    throw new Error('MAKER_MM_MAX_COMBINED must be between 0 and 1');
  }
  if (!(config.maxBookSpread > 0 && config.maxBookSpread < 1)) {
    throw new Error('MAKER_MM_MAX_BOOK_SPREAD must be between 0 and 1');
  }
  if (!(config.priceTick > 0 && config.priceTick < 1)) {
    throw new Error('MAKER_MM_PRICE_TICK must be between 0 and 1');
  }
  if (config.shares <= 0) throw new Error('MAKER_MM_SHARES must be positive');
  if (config.pollMs < 1_000) throw new Error('MAKER_MM_POLL_MS must be at least 1000');
  if (config.entryWindowSec < 30) {
    throw new Error('MAKER_MM_ENTRY_WINDOW_SEC must be at least 30');
  }
  if (config.discoveryRequestGapMs < 250) {
    throw new Error('LMTS_DISCOVERY_REQUEST_GAP_MS must be at least 250');
  }
  if (config.timelineNoSlotBackoffMs < 30_000) {
    throw new Error('LMTS_TIMELINE_NO_SLOT_BACKOFF_MS must be at least 30000');
  }
  if (config.bookMaxAgeMs < 250) {
    throw new Error('MAKER_MM_BOOK_MAX_AGE_MS must be at least 250');
  }
  if (config.baseRpcReadAttempts < 1 || config.baseRpcReadAttempts > 10) {
    throw new Error('BASE_RPC_READ_ATTEMPTS must be between 1 and 10');
  }
  if (config.baseRpcRetryMs < 100) {
    throw new Error('BASE_RPC_RETRY_MS must be at least 100');
  }
  if (config.quoteLogIntervalMs < 1_000) {
    throw new Error('MAKER_MM_QUOTE_LOG_INTERVAL_MS must be at least 1000');
  }
  if (config.marketActivityPollMs < 10_000) {
    throw new Error('LMTS_MARKET_ACTIVITY_POLL_MS must be at least 10000');
  }
  if (config.fairTradeMaxAgeMs < 5_000) {
    throw new Error('MAKER_MM_FAIR_TRADE_MAX_AGE_MS must be at least 5000');
  }
  if (!(config.tightBookMaxSpread > 0 && config.tightBookMaxSpread < 1)) {
    throw new Error('MAKER_MM_TIGHT_BOOK_MAX_SPREAD must be between 0 and 1');
  }
  if (
    !Number.isInteger(config.tightBookConfirmations)
    || config.tightBookConfirmations < 2
    || config.tightBookConfirmations > 20
  ) {
    throw new Error('MAKER_MM_TIGHT_BOOK_CONFIRMATIONS must be an integer between 2 and 20');
  }
  if (!(config.openingFairYes > 0 && config.openingFairYes < 1)) {
    throw new Error('MAKER_MM_OPENING_FAIR_YES must be between 0 and 1');
  }
  if (config.paperObserveSec < 30) {
    throw new Error('MAKER_MM_PAPER_OBSERVE_SEC must be at least 30');
  }
  if (config.paperActivityPollMs < 5_000) {
    throw new Error('MAKER_MM_PAPER_ACTIVITY_POLL_MS must be at least 5000');
  }
  if (config.maxLiveCyclesSession < 1) {
    throw new Error('MAKER_MM_MAX_LIVE_CYCLES_SESSION must be at least 1');
  }
  if (!(config.maxCycleUsdc > 0 && config.maxTotalUsdc >= config.maxCycleUsdc)) {
    throw new Error('USDC caps require MAX_TOTAL >= MAX_CYCLE > 0');
  }
  if (config.minBaseEth < 0) {
    throw new Error('MAKER_MM_MIN_BASE_ETH cannot be negative');
  }
  if (config.shutdownRecoveryTimeoutSec < 60) {
    throw new Error('MAKER_MM_SHUTDOWN_RECOVERY_TIMEOUT_SEC must be at least 60');
  }
  if (!config.dryRun) {
    const missing = [
      ['LMTS_TOKEN_ID', config.tokenId],
      ['LMTS_TOKEN_SECRET', config.tokenSecret],
      ['PRIVATE_KEY', config.privateKey],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`Live mode missing: ${missing.join(', ')}`);
    if (config.liveAck !== 'I_UNDERSTAND') {
      throw new Error('Live mode requires LIVE_TRADING_ACK=I_UNDERSTAND');
    }
    if (config.liveCanaryOnly) {
      if (config.assets.length !== 1) {
        throw new Error('LIVE_CANARY_ONLY requires exactly one asset');
      }
      if (config.reentry || config.maxCyclesPerMarket !== 1 || config.maxLiveCyclesSession !== 1) {
        throw new Error('LIVE_CANARY_ONLY requires re-entry off and both cycle limits set to 1');
      }
      if (config.maxTotalUsdc > 50) {
        throw new Error('LIVE_CANARY_ONLY caps total USDC exposure at 50');
      }
      if (!config.requireTradeFair) {
        if (!config.openingCanaryFair) {
          throw new Error(
            'LIVE_CANARY_ONLY requires a current-market trade or MAKER_MM_OPENING_CANARY_FAIR=true',
          );
        }
      }
      if (config.openingCanaryFair && config.entryWindowSec > 30) {
        throw new Error('Opening-fair live canary requires MAKER_MM_ENTRY_WINDOW_SEC=30');
      }
    }
  }
}

export default config;
