import config from './config.js';
import logger from './logger.js';
import {
  buildCenteredMakerQuote,
  marketMinimumShares,
  normaliseOrderbook,
  orderbookMinimumShares,
  quoteEconomics,
  roundDown,
  selectFairYesReference,
  validateRestingPair,
} from './quote.js';
import {
  cancelOrder,
  createMakerBuy,
  emergencySell,
  getMaintenanceStatus,
  getMarket,
  getOrderBook,
} from './limitlessClient.js';
import {
  ensureVenueApprovals,
  getTokenBalance,
  getUsdcBalance,
  mergePositions,
} from './ctf.js';
import { reserveUsdc, releaseUsdc, reservedUsdc } from './capital.js';
import { fillWatcher } from './fillWatcher.js';
import { performanceTracker } from './performanceTracker.js';

const active = new Map();
let liveCyclesStarted = 0;
let shutdownRequested = false;
let admissionQueue = Promise.resolve();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function liveSessionLimitReached() {
  return config.maxLiveCyclesSession > 0
    && liveCyclesStarted >= config.maxLiveCyclesSession;
}

function admitLiveCycle(cycleId, economics, walletBalance) {
  const task = admissionQueue.then(async () => {
    if (liveSessionLimitReached()) {
      const error = new Error('live session cycle limit reached');
      error.code = 'LIVE_SESSION_LIMIT';
      throw error;
    }
    if (reservedUsdc() > 0 || active.size > 0) {
      const error = new Error('global capital slot is busy with another asset');
      error.code = 'CAPITAL_SLOT_BUSY';
      throw error;
    }
    const reservation = await reserveUsdc(cycleId, economics.cost, walletBalance, {
      maxCycle: config.maxCycleUsdc,
      maxTotal: config.maxTotalUsdc,
    });
    return reservation;
  });
  admissionQueue = task.catch(() => {});
  return task;
}

function timestampMs(value, fallback) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1e12 ? numeric * 1_000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function extractOrderId(result) {
  return result?.order?.id || result?.id || result?.orderId || null;
}

async function balances(market) {
  const [yes, no] = await Promise.all([
    getTokenBalance(market.tokens.yes),
    getTokenBalance(market.tokens.no),
  ]);
  return { yes, no };
}

async function cancelBoth(position) {
  const [yesCancelled, noCancelled] = await Promise.all([
    cancelOrder(position.yesOrderId),
    cancelOrder(position.noOrderId),
  ]);
  return yesCancelled && noCancelled;
}

async function readFreshBook(market) {
  const streamed = fillWatcher.getBook(market.slug, {
    maxAgeMs: config.bookMaxAgeMs,
  });

  if (streamed) {
    return {
      book: streamed,
      source: 'WS',
      ageMs: fillWatcher.getBookAgeMs(market.slug),
    };
  }

  const restBook = await getOrderBook(market.slug);
  const snapshot = fillWatcher.recordBook(market.slug, restBook, 'REST');
  return { book: snapshot, source: 'REST', ageMs: 0 };
}

async function readPlacementBook(market) {
  const streamed = await fillWatcher.waitForBook(
    market.slug,
    Math.min(1_500, config.bookRetryMs),
  );
  if (streamed) {
    return { book: streamed, source: 'WS' };
  }
  return {
    book: await getOrderBook(market.slug),
    source: 'REST',
  };
}

function quoteDiagnostic(slug, snapshot, quote) {
  const bid = quote.yesBid == null ? '?' : quote.yesBid.toFixed(3);
  const ask = quote.yesAsk == null ? '?' : quote.yesAsk.toFixed(3);
  const spread = quote.bookSpread == null ? '?' : quote.bookSpread.toFixed(4);
  const fair = quote.fairYes == null ? '?' : quote.fairYes.toFixed(3);
  const fairSource = quote.fairSource || 'NONE';
  return `${slug} source=${snapshot.source} age=${Math.round(snapshot.ageMs)}ms ` +
    `bid=${bid} ask=${ask} spread=${spread} fairYES=${fair} fairSource=${fairSource} ` +
    `result=${quote.reason || 'eligible'}`;
}

async function waitForEligibleQuote(market, entryDeadlineMs) {
  const minimumShares = marketMinimumShares(market);
  const needsValidatedFair = config.requireTradeFair && !config.openingCanaryFair;
  let lastQuote = { ok: false, reason: 'orderbook unavailable' };
  let lastSnapshot = { source: 'NONE', ageMs: Infinity };
  let nextLogAt = 0;
  let nextActivityPollAt = 0;
  let tightBookConfirmations = 0;
  let lastConfirmedBookAt = 0;

  while (Date.now() < entryDeadlineMs && !shutdownRequested) {
    try {
      if (needsValidatedFair && Date.now() >= nextActivityPollAt) {
        await fillWatcher.pollMarketActivity(market.slug);
        nextActivityPollAt = Date.now() + config.paperActivityPollMs;
      }
      lastSnapshot = await readFreshBook(market);
      const normalized = normaliseOrderbook(lastSnapshot.book, {
        minimumSize: Math.max(
          minimumShares,
          orderbookMinimumShares(lastSnapshot.book),
        ),
      });
      const recentTrade = fillWatcher.lastMarketTrade(market.slug, {
        maxAgeMs: config.fairTradeMaxAgeMs,
      });

      const bookSpread = normalized
        ? Number((normalized.yesAsk - normalized.yesBid).toFixed(8))
        : null;
      const receivedAt = Number(lastSnapshot.book?.receivedAt);
      const distinctWsBook = lastSnapshot.source === 'WS'
        && Number.isFinite(receivedAt)
        && receivedAt > lastConfirmedBookAt;

      if (distinctWsBook) {
        lastConfirmedBookAt = receivedAt;
        tightBookConfirmations = normalized
          && bookSpread <= config.tightBookMaxSpread + 1e-9
          ? tightBookConfirmations + 1
          : 0;
      }

      const fair = config.openingCanaryFair && !recentTrade
        ? {
            fairYes: config.openingFairYes,
            source: 'OPENING_50_50_CANARY',
          }
        : selectFairYesReference(normalized, recentTrade, {
            requireTrade: config.requireTradeFair,
            allowTightBookFallback: config.allowTightBookFair,
            tightBookMaxSpread: config.tightBookMaxSpread,
            tightBookConfirmations,
            requiredTightBookConfirmations: config.tightBookConfirmations,
          });
      const fairYes = fair.fairYes;
      const fairSource = fair.source;

      lastQuote = needsValidatedFair && !fairYes
        ? {
            ok: false,
            reason: config.allowTightBookFair
              ? `waiting for current-market trade or tight WS book ` +
                `(${tightBookConfirmations}/${config.tightBookConfirmations})`
              : 'waiting for current-market finalized trade',
            ...(normalized || {}),
            bookSpread,
          }
        : buildCenteredMakerQuote(lastSnapshot.book, {
            fairYes,
            tick: config.priceTick,
            improvementTicks: config.improvementTicks,
            maxCombined: config.maxCombined,
            minimumSize: Math.max(
              minimumShares,
              orderbookMinimumShares(lastSnapshot.book),
            ),
          });
      lastQuote.fairSource = fairSource;
    } catch (error) {
      lastQuote = { ok: false, reason: `book read failed: ${error.message}` };
    }

    if (Date.now() >= nextLogAt || lastQuote.ok) {
      const output = quoteDiagnostic(market.slug, lastSnapshot, lastQuote);
      if (lastQuote.ok) logger.book(output);
      else logger.info(`[QUOTE WAIT] ${output}`);
      nextLogAt = Date.now() + config.quoteLogIntervalMs;
    }

    if (lastQuote.ok) return { quote: lastQuote, snapshot: lastSnapshot };

    const remaining = entryDeadlineMs - Date.now();
    if (remaining <= 0) break;
    await fillWatcher.waitForBook(
      market.slug,
      Math.min(config.bookRetryMs, remaining),
    );
  }

  if (shutdownRequested) {
    return {
      quote: { ok: false, reason: 'shutdown requested' },
      snapshot: lastSnapshot,
    };
  }
  return { quote: lastQuote, snapshot: lastSnapshot };
}

function maintenanceMode(status) {
  return String(
    status?.tradingMode
      ?? status?.mode
      ?? status?.status
      ?? 'UNKNOWN',
  ).toUpperCase();
}

async function assertPostOnlyTradingAvailable() {
  const status = await getMaintenanceStatus();
  const mode = maintenanceMode(status);
  const blocked = ['DISABLED', 'CANCEL_ONLY', 'HALTED', 'PAUSED'].some(
    (value) => mode.includes(value),
  );
  logger.bot(`MAINTENANCE CHECK tradingMode=${mode}`);
  if (blocked) {
    throw new Error(`Limitless trading mode does not allow new post-only orders: ${mode}`);
  }
}

async function observePaperCycle(market, quote, shares, endMs) {
  const filled = { yes: 0, no: 0 };
  const bookCrossed = { yes: false, no: false };
  const deadline = Math.min(
    Date.now() + config.paperObserveSec * 1_000,
    endMs - config.cutLossSec * 1_000,
  );
  let nextActivityPollAt = 0;

  const record = (side, amount, evidence, price) => {
    const remaining = Math.max(0, shares - filled[side]);
    const accepted = Math.min(remaining, Math.max(0, Number(amount) || 0));
    if (accepted <= 0) return;
    filled[side] += accepted;
    logger.bot(
      `PAPER FILL-CANDIDATE ${market.slug} side=${side.toUpperCase()} ` +
      `added=${accepted.toFixed(3)} total=${filled[side].toFixed(3)}/${shares.toFixed(3)} ` +
      `atOrBetter=${Number(price).toFixed(3)} evidence=${evidence} queue=unproven`,
    );
  };

  const onTrade = (trade) => {
    const side = trade.outcome?.toLowerCase();
    if (!['yes', 'no'].includes(side)) return;
    const quotePrice = side === 'yes' ? quote.yesPrice : quote.noPrice;

    // A finalized public trade strictly through our hypothetical bid is strong
    // paper evidence. Equal-price volume is excluded because queue priority is
    // unknowable without actually resting an order.
    if (trade.price < quotePrice - config.priceTick / 2) {
      record(side, trade.shares, 'MINED_TRADE_THROUGH_QUOTE', trade.price);
    }
  };

  fillWatcher.on(`marketTrade:${market.slug}`, onTrade);
  logger.bot(
    `PAPER ORDERS OPEN ${market.slug} YES=${quote.yesPrice.toFixed(3)} ` +
    `NO=${quote.noPrice.toFixed(3)} combined=${quote.combined.toFixed(3)} ` +
    `shares=${shares.toFixed(3)} observe=${Math.max(0, Math.ceil((deadline - Date.now()) / 1_000))}s`,
  );

  try {
    while (
      Date.now() < deadline
      && !shutdownRequested
      && (filled.yes < shares || filled.no < shares)
    ) {
      if (Date.now() >= nextActivityPollAt) {
        await fillWatcher.pollMarketActivity(market.slug);
        nextActivityPollAt = Date.now() + config.paperActivityPollMs;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const snapshot = await fillWatcher.waitForBook(
        market.slug,
        Math.min(config.bookRetryMs, remainingMs),
      );
      if (!snapshot) continue;
      const book = normaliseOrderbook(snapshot, { minimumSize: 0 });
      if (!book) continue;

      if (!bookCrossed.yes && book.yesAsk < quote.yesPrice) {
        bookCrossed.yes = true;
        record('yes', book.yesAskSize, 'BOOK_ASK_THROUGH_QUOTE', book.yesAsk);
      }
      if (!bookCrossed.no && book.noAsk < quote.noPrice) {
        bookCrossed.no = true;
        record('no', book.noAskSize, 'BOOK_ASK_THROUGH_QUOTE', book.noAsk);
      }
    }
  } finally {
    fillWatcher.off(`marketTrade:${market.slug}`, onTrade);
  }

  const paired = Math.min(filled.yes, filled.no);
  const gross = paired * quote.grossPerPair;
  const oneSided = Math.abs(filled.yes - filled.no) >= 0.001;
  const status = paired >= shares * 0.99
    ? 'PAIRED_EXECUTION_CANDIDATE'
    : oneSided
      ? 'ONE_SIDED_CANDIDATE'
      : paired > 0
        ? 'PARTIAL_PAIR_CANDIDATE'
        : 'NO_EXECUTION_EVIDENCE';

  performanceTracker.recordPaper({ paired, gross, oneSided });
  logger.pnl(
    `PAPER RESULT ${market.slug} status=${status} YES=${filled.yes.toFixed(3)} ` +
    `NO=${filled.no.toFixed(3)} paired=${paired.toFixed(3)} ` +
    `grossBeforeFeesGas=$${gross.toFixed(4)} queuePriority=NOT_PROVEN`,
  );

  return {
    simulation: true,
    merged: false,
    paired,
    oneSided,
    safeToReenter: false,
    quote,
    economics: quoteEconomics(shares, quote.combined),
    paperStatus: status,
  };
}

async function reconcileBalances(market, baseline, previous = { yes: 0, no: 0 }) {
  const current = await balances(market);
  const net = {
    yes: Math.max(previous.yes, current.yes - baseline.yes, 0),
    no: Math.max(previous.no, current.no - baseline.no, 0),
  };

  if (net.yes !== previous.yes || net.no !== previous.no) {
    logger.bot(
      `BALANCE ${market.slug} YES=${net.yes.toFixed(6)} NO=${net.no.toFixed(6)}`,
    );
  }
  return net;
}

async function unwindRemainder(market, side, shares) {
  if (shares < 0.001) return { sold: 0, remaining: 0 };

  const tokenId = market.tokens[side];
  const startingBalance = await getTokenBalance(tokenId);
  let remaining = Math.min(shares, startingBalance);

  for (let attempt = 1; attempt <= 3 && remaining >= 0.001; attempt += 1) {
    const orderbook = await getOrderBook(market.slug);
    const book = normaliseOrderbook(orderbook, { minimumSize: 0 });
    if (!book) throw new Error(`Cannot unwind ${side}: orderbook is not two-sided`);

    const reference = side === 'yes' ? book.yesBid : book.noBid;
    const price = Math.max(
      config.priceTick,
      roundDown(
        reference - config.unwindSlippageTicks * config.priceTick,
        config.priceTick,
      ),
    );
    const sellSize = Math.floor(remaining * 1_000) / 1_000;

    logger.bot(
      `UNWIND SUBMIT ${market.slug} side=${side.toUpperCase()} ` +
      `shares=${sellSize.toFixed(3)} limit=${price.toFixed(3)} attempt=${attempt}/3`,
    );
    const result = await emergencySell({ market, tokenId, price, size: sellSize });
    logger.bot(`UNWIND ORDER orderId=${extractOrderId(result) || '?'} side=${side.toUpperCase()}`);

    await pause(1_500);
    const currentBalance = await getTokenBalance(tokenId);
    const sold = Math.max(0, startingBalance - currentBalance);
    remaining = Math.max(0, shares - sold);
  }

  if (remaining >= 0.001) {
    throw new Error(
      `Emergency unwind incomplete: ${remaining.toFixed(6)} ${side.toUpperCase()} shares remain`,
    );
  }

  return { sold: shares, remaining: 0 };
}

async function mergeAndRecover(market, quote, net, position = null) {
  const paired = Math.min(net.yes, net.no);
  let mergeResult = null;
  const gross = paired * quote.grossPerPair;

  if (paired >= 0.001) {
    mergeResult = await mergePositions(market, paired);
  }

  const yesRemainder = Math.max(0, net.yes - paired);
  const noRemainder = Math.max(0, net.no - paired);

  if (yesRemainder >= 0.001) {
    await unwindRemainder(market, 'yes', yesRemainder);
  }
  if (noRemainder >= 0.001) {
    await unwindRemainder(market, 'no', noRemainder);
  }

  const hadExposure = net.yes >= 0.001 || net.no >= 0.001;
  const oneSided = yesRemainder >= 0.001 || noRemainder >= 0.001
    || (paired < 0.001 && hadExposure);
  const minedFills = position
    ? fillWatcher.minedFills([position.yesOrderId, position.noOrderId])
    : [];

  performanceTracker.recordLive({ paired, gross, oneSided });
  logger.pnl(
    `LIVE RESULT ${market.slug} status=${paired >= 0.001 ? 'MERGE_CONFIRMED' : 'NO_PAIR'} ` +
    `YES=${net.yes.toFixed(6)} NO=${net.no.toFixed(6)} paired=${paired.toFixed(6)} ` +
    `grossBeforeGas=$${gross.toFixed(6)} oneSided=${oneSided} ` +
    `minedFillEvents=${minedFills.length} mergeTx=${mergeResult?.txHash || '-'}`,
  );

  return {
    merged: paired >= 0.001,
    paired,
    oneSided,
    safeToReenter: paired >= 0.001 && !oneSided,
    netYes: net.yes,
    netNo: net.no,
  };
}

export async function executeCycle(inputMarket, { reentry = false } = {}) {
  if (shutdownRequested) return { skipped: true, reason: 'shutdown requested' };
  if (!config.dryRun && liveSessionLimitReached()) {
    return { skipped: true, reason: 'live session cycle limit reached' };
  }
  const market = await getMarket(inputMarket.slug);
  fillWatcher.registerMarket(market);
  await fillWatcher.watchMarket(market.slug, { activity: true });

  const startMs = timestampMs(inputMarket.startAt || market.startAt, Date.now());
  const endMs = timestampMs(
    market.expirationTimestamp,
    new Date(inputMarket.endAt).getTime(),
  );

  if ((endMs - Date.now()) / 1_000 <= config.cutLossSec) {
    return { skipped: true, reason: 'inside cut-loss window' };
  }

  const entryDeadlineMs = Math.min(
    reentry
      ? Date.now() + config.entryWindowSec * 1_000
      : startMs + config.entryWindowSec * 1_000,
    endMs - config.cutLossSec * 1_000,
  );
  const warmUntil = Math.min(
    reentry ? Date.now() : startMs + config.bookWarmupMs,
    entryDeadlineMs,
  );
  if (Date.now() < warmUntil) await pause(warmUntil - Date.now());

  const eligible = await waitForEligibleQuote(market, entryDeadlineMs);
  let quote = eligible.quote;
  let snapshot = eligible.snapshot;
  if (!quote.ok) {
    return {
      skipped: true,
      reason: `${quote.reason} throughout entry window`,
    };
  }

  const minimum = Math.max(
    marketMinimumShares(market),
    orderbookMinimumShares(snapshot.book),
  );
  const shares = Math.ceil(Math.max(config.shares, minimum) * 1_000) / 1_000;
  let economics = quoteEconomics(shares, quote.combined);

  logger.quote(
    `${market.slug} YES=${quote.yesPrice.toFixed(3)} NO=${quote.noPrice.toFixed(3)} ` +
    `combined=${quote.combined.toFixed(3)} shares=${shares.toFixed(3)} ` +
    `cost=$${economics.cost.toFixed(4)} gross=$${economics.gross.toFixed(4)} ` +
    `grossROI=${economics.grossRoiPct.toFixed(3)}%`,
  );

  if (config.dryRun) {
    if (config.dryRunFillMode === 'observe') {
      return observePaperCycle(market, quote, shares, endMs);
    }

    performanceTracker.recordPaper();
    logger.pnl(
      `PAPER RESULT ${market.slug} status=QUOTE_ONLY cost=$${economics.cost.toFixed(4)} ` +
      `grossIfPaired=$${economics.gross.toFixed(4)} execution=NOT_OBSERVED`,
    );
    return {
      simulation: true,
      merged: false,
      oneSided: false,
      safeToReenter: false,
      quote,
      economics,
      paperStatus: 'QUOTE_ONLY',
    };
  }

  if (shutdownRequested) return { skipped: true, reason: 'shutdown requested' };

  await assertPostOnlyTradingAvailable();

  const cycleId = `${market.slug}-${Date.now()}`;
  const walletBalance = await getUsdcBalance();
  try {
    await admitLiveCycle(cycleId, economics, walletBalance);
  } catch (error) {
    if (['LIVE_SESSION_LIMIT', 'CAPITAL_SLOT_BUSY'].includes(error.code)) {
      return { skipped: true, reason: error.message };
    }
    throw error;
  }
  logger.warn(
    `LIVE ATTEMPT ${liveCyclesStarted + 1}/${config.maxLiveCyclesSession || 'unlimited'} ` +
    `${market.slug} maximum paired cost=$${economics.cost.toFixed(4)}`,
  );

  const position = {
    cycleId,
    market,
    shares,
    quote,
    baseline: null,
    yesOrderId: null,
    noOrderId: null,
    recoveryStarted: false,
    counted: false,
  };
  active.set(market.conditionId || cycleId, position);

  try {
    if (shutdownRequested) return { skipped: true, reason: 'shutdown requested' };
    await ensureVenueApprovals(market);
    position.baseline = await balances(market);
    logger.bot(
      `BASELINE ${market.slug} YES=${position.baseline.yes.toFixed(6)} ` +
      `NO=${position.baseline.no.toFixed(6)} USDC=$${walletBalance.toFixed(6)}`,
    );

    let placementSnapshot = await readPlacementBook(market);
    let placementCheck = validateRestingPair(placementSnapshot.book, quote, {
      minimumSize: minimum,
    });

    if (!placementCheck.ok && Date.now() < entryDeadlineMs) {
      logger.warn(
        `PLACEMENT QUOTE STALE ${market.slug}: ${placementCheck.reason}; ` +
        'rebuilding once before submitting either order',
      );
      const refreshed = await waitForEligibleQuote(market, entryDeadlineMs);
      if (refreshed.quote.ok) {
        quote = refreshed.quote;
        snapshot = refreshed.snapshot;
        economics = quoteEconomics(shares, quote.combined);
        position.quote = quote;
        logger.quote(
          `REFRESH ${market.slug} YES=${quote.yesPrice.toFixed(3)} ` +
          `NO=${quote.noPrice.toFixed(3)} combined=${quote.combined.toFixed(3)} ` +
          `shares=${shares.toFixed(3)} cost=$${economics.cost.toFixed(4)}`,
        );
        placementSnapshot = await readPlacementBook(market);
        placementCheck = validateRestingPair(placementSnapshot.book, quote, {
          minimumSize: minimum,
        });
      } else {
        placementCheck = {
          ok: false,
          reason: `refresh failed: ${refreshed.quote.reason}`,
        };
      }
    }

    if (!placementCheck.ok || Date.now() >= entryDeadlineMs) {
      const reason = Date.now() >= entryDeadlineMs
        ? 'entry window closed before placement'
        : placementCheck.reason;
      logger.warn(
        `PLACEMENT ABORTED ${market.slug}: ${reason}; no orders submitted`,
      );
      return {
        skipped: true,
        reason,
        placementAborted: true,
      };
    }

    logger.bot(
      `PLACEMENT CHECK ${market.slug} source=${placementSnapshot.source} ` +
      `YES=${quote.yesPrice.toFixed(3)}<ask=${placementCheck.yesAsk.toFixed(3)} ` +
      `NO=${quote.noPrice.toFixed(3)}<ask=${placementCheck.noAsk.toFixed(3)}`,
    );

    const placements = await Promise.allSettled([
      createMakerBuy({
        market,
        tokenId: market.tokens.yes,
        price: quote.yesPrice,
        size: shares,
      }),
      createMakerBuy({
        market,
        tokenId: market.tokens.no,
        price: quote.noPrice,
        size: shares,
      }),
    ]);

    const [yesPlacement, noPlacement] = placements;
    if (yesPlacement.status === 'fulfilled') {
      position.yesOrderId = extractOrderId(yesPlacement.value);
    }
    if (noPlacement.status === 'fulfilled') {
      position.noOrderId = extractOrderId(noPlacement.value);
    }
    fillWatcher.trackOwnedOrders([
      position.yesOrderId,
      position.noOrderId,
    ]);

    if ((position.yesOrderId || position.noOrderId) && !position.counted) {
      liveCyclesStarted += 1;
      position.counted = true;
      logger.warn(
        `LIVE CYCLE ACCEPTED ${liveCyclesStarted}/` +
        `${config.maxLiveCyclesSession || 'unlimited'} ${market.slug}`,
      );
    }

    const placementIncomplete = placements.some((item) => item.status === 'rejected')
      || !position.yesOrderId
      || !position.noOrderId;

    if (placementIncomplete) {
      await cancelBoth(position);
      const reasons = placements
        .filter((item) => item.status === 'rejected')
        .map((item) => item.reason?.message || String(item.reason));
      logger.error(
        `BOT PLACEMENT INCOMPLETE ${market.slug}: ${reasons.join(' | ') || 'missing order ID'}`,
      );

      let net = { yes: 0, no: 0 };
      const until = Date.now() + config.settlementGraceSec * 1_000;
      while (Date.now() < until) {
        net = await reconcileBalances(market, position.baseline, net);
        await pause(1_000);
      }
      position.recoveryStarted = true;
      const recovered = await mergeAndRecover(market, quote, net, position);
      return { ...recovered, placementIncomplete: true, safeToReenter: false };
    }

    logger.bot(
      `ORDERS ACCEPTED ${market.slug} YES=${position.yesOrderId} NO=${position.noOrderId}`,
    );

    const fillDeadline = Math.min(
      Date.now() + config.fillTimeoutSec * 1_000,
      endMs - config.cutLossSec * 1_000,
    );
    let net = { yes: 0, no: 0 };

    while (Date.now() < fillDeadline && !shutdownRequested) {
      net = await reconcileBalances(market, position.baseline, net);
      if (net.yes >= shares * 0.99 && net.no >= shares * 0.99) break;
      await fillWatcher.wait(config.balancePollMs);
    }

    await cancelBoth(position);
    const reconcileUntil = Date.now() + config.settlementGraceSec * 1_000;

    while (Date.now() < reconcileUntil) {
      net = await reconcileBalances(market, position.baseline, net);
      const fullPair = net.yes >= shares * 0.99 && net.no >= shares * 0.99;
      const pending = fillWatcher.hasPending([
        position.yesOrderId,
        position.noOrderId,
      ]);
      if (fullPair || (!pending && Date.now() + 3_000 >= reconcileUntil)) break;
      await pause(1_000);
    }

    position.recoveryStarted = true;
    return mergeAndRecover(market, quote, net, position);
  } catch (error) {
    logger.error(
      `LIVE CYCLE ERROR ${market.slug}: ${error.shortMessage || error.message}; ` +
      'cancelling and reconciling before exit',
    );
    await cancelBoth(position);

    if (!position.baseline || position.recoveryStarted) throw error;

    let net = { yes: 0, no: 0 };
    const reconcileUntil = Date.now() + config.settlementGraceSec * 1_000;
    while (Date.now() < reconcileUntil) {
      try {
        net = await reconcileBalances(market, position.baseline, net);
      } catch (readError) {
        logger.warn(
          `RECOVERY BALANCE READ ${market.slug}: ` +
          `${readError.shortMessage || readError.message}`,
        );
      }
      const pending = fillWatcher.hasPending([
        position.yesOrderId,
        position.noOrderId,
      ]);
      if (!pending && Date.now() + 3_000 >= reconcileUntil) break;
      await fillWatcher.wait(1_000);
    }

    position.recoveryStarted = true;
    const recovered = await mergeAndRecover(market, quote, net, position);
    return {
      ...recovered,
      cycleError: true,
      safeToReenter: false,
    };
  } finally {
    active.delete(market.conditionId || cycleId);
    await releaseUsdc(cycleId);
  }
}

export function getActivePositions() {
  return [...active.values()];
}

export function isLiveSessionLimitReached() {
  return liveSessionLimitReached();
}

export function requestStrategyShutdown() {
  shutdownRequested = true;
  fillWatcher.emit('wake', { type: 'SHUTDOWN' });
}

export async function waitForActivePositionsToClose(timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (active.size > 0 && Date.now() < deadline) {
    await pause(250);
  }
  return active.size === 0;
}
