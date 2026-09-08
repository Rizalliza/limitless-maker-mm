const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function shareAmount(value, { rawSixDecimals = false } = {}) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return rawSixDecimals || amount >= 1_000_000
    ? amount / 1_000_000
    : amount;
}

export function roundDown(value, tick) {
  const units = Math.floor((value + Number.EPSILON) / tick);
  return Number((units * tick).toFixed(8));
}

export function normaliseOrderbook(orderbook, { minimumSize } = {}) {
  const rawBookMinimum = Number(orderbook?.minSize);
  const rawSixDecimals = Number.isFinite(rawBookMinimum)
    && rawBookMinimum >= 1_000_000;
  const levelMinimum = shareAmount(
    minimumSize ?? orderbook?.minSize,
    { rawSixDecimals: rawSixDecimals && minimumSize == null },
  );

  const validLevels = (levels) => [...(levels || [])]
    .map((level) => ({
      price: Number(level.price),
      size: shareAmount(level.size, { rawSixDecimals }),
    }))
    .filter((level) => (
      Number.isFinite(level.price)
      && Number.isFinite(level.size)
      && level.price > 0
      && level.price < 1
      && level.size >= levelMinimum
    ));

  const bids = validLevels(orderbook?.bids).sort((a, b) => b.price - a.price);
  const asks = validLevels(orderbook?.asks).sort((a, b) => a.price - b.price);
  const yesBid = bids[0]?.price ?? null;
  const yesAsk = asks[0]?.price ?? null;

  if (!(yesBid > 0) || !(yesAsk < 1) || yesBid >= yesAsk) return null;

  return {
    yesBid,
    yesAsk,
    yesBidSize: bids[0].size,
    yesAskSize: asks[0].size,
    noBid: Number((1 - yesAsk).toFixed(8)),
    noAsk: Number((1 - yesBid).toFixed(8)),
    noBidSize: asks[0].size,
    noAskSize: bids[0].size,
    minimumSize: levelMinimum,
  };
}

export function buildMakerQuote(orderbook, {
  tick = 0.001,
  improvementTicks = 1,
  maxCombined = 0.98,
  maxBookSpread = 0.05,
  minimumSize,
} = {}) {
  const book = normaliseOrderbook(orderbook, { minimumSize });
  if (!book) return { ok: false, reason: 'orderbook is not two-sided' };

  const venueMaxSpread = Number(orderbook?.maxSpread);
  const effectiveMaxSpread = Number.isFinite(venueMaxSpread) && venueMaxSpread > 0
    ? Math.min(maxBookSpread, venueMaxSpread)
    : maxBookSpread;
  const bookSpread = Number((book.yesAsk - book.yesBid).toFixed(8));

  if (bookSpread > effectiveMaxSpread + 1e-9) {
    return {
      ok: false,
      reason: `reference spread ${bookSpread.toFixed(4)} exceeds ${effectiveMaxSpread.toFixed(4)}`,
      ...book,
      bookSpread,
      effectiveMaxSpread,
    };
  }

  const improvement = tick * Math.max(0, improvementTicks);
  const yesPrice = roundDown(
    clamp(book.yesBid + improvement, tick, book.yesAsk - tick),
    tick,
  );
  const noPrice = roundDown(
    clamp(book.noBid + improvement, tick, book.noAsk - tick),
    tick,
  );
  const combined = Number((yesPrice + noPrice).toFixed(8));

  if (!(yesPrice > 0 && noPrice > 0 && yesPrice < book.yesAsk && noPrice < book.noAsk)) {
    return {
      ok: false,
      reason: 'no post-only price exists inside the current spread',
      ...book,
      bookSpread,
      effectiveMaxSpread,
      yesPrice,
      noPrice,
      combined,
    };
  }

  if (combined > maxCombined + 1e-9) {
    return {
      ok: false,
      reason: `combined ${combined.toFixed(4)} exceeds cap ${maxCombined.toFixed(4)}`,
      ...book,
      bookSpread,
      effectiveMaxSpread,
      yesPrice,
      noPrice,
      combined,
    };
  }

  return {
    ok: true,
    ...book,
    bookSpread,
    effectiveMaxSpread,
    yesPrice,
    noPrice,
    combined,
    grossPerPair: Number((1 - combined).toFixed(8)),
  };
}

function tickUnits(value, tick, mode = 'floor') {
  const scaled = value / tick;
  return mode === 'ceil'
    ? Math.ceil(scaled - 1e-9)
    : Math.floor(scaled + 1e-9);
}

/**
 * Builds a paired maker quote around an explicit YES fair value.
 *
 * Unlike buildMakerQuote(), this does not confuse a sparse book's full
 * bid/ask width with expected profit. It allocates the configured combined
 * cap around fair value, while remaining at least one tick inside both best
 * bids and strictly below both derived asks.
 */
export function buildCenteredMakerQuote(orderbook, {
  fairYes,
  tick = 0.001,
  improvementTicks = 1,
  maxCombined = 0.98,
  minimumSize,
} = {}) {
  const book = normaliseOrderbook(orderbook, { minimumSize });
  if (!book) return { ok: false, reason: 'orderbook is not two-sided' };

  const reference = Number(fairYes);
  if (!(reference > 0 && reference < 1)) {
    return { ok: false, reason: 'fair YES reference is unavailable', ...book };
  }

  const improve = Math.max(0, Math.floor(improvementTicks));
  const yesMin = tickUnits(book.yesBid, tick) + improve;
  const noMin = tickUnits(book.noBid, tick) + improve;
  const yesMax = tickUnits(book.yesAsk, tick, 'ceil') - 1;
  const noMax = tickUnits(book.noAsk, tick, 'ceil') - 1;
  const capUnits = tickUnits(maxCombined, tick);
  const maximumCombinedUnits = yesMax + noMax;
  const combinedUnits = Math.min(capUnits, maximumCombinedUnits);

  if (
    yesMin <= 0
    || noMin <= 0
    || yesMin > yesMax
    || noMin > noMax
    || yesMin + noMin > combinedUnits
  ) {
    return {
      ok: false,
      reason: 'no feasible paired post-only quote under combined cap',
      ...book,
      fairYes: reference,
    };
  }

  const edgePerSide = (1 - maxCombined) / 2;
  const preferredYes = tickUnits(reference - edgePerSide, tick);
  const feasibleYesMin = Math.max(yesMin, combinedUnits - noMax);
  const feasibleYesMax = Math.min(yesMax, combinedUnits - noMin);
  const yesUnits = Math.max(
    feasibleYesMin,
    Math.min(feasibleYesMax, preferredYes),
  );
  const noUnits = combinedUnits - yesUnits;
  const yesPrice = Number((yesUnits * tick).toFixed(8));
  const noPrice = Number((noUnits * tick).toFixed(8));
  const combined = Number((yesPrice + noPrice).toFixed(8));

  return {
    ok: true,
    ...book,
    fairYes: reference,
    fairNo: Number((1 - reference).toFixed(8)),
    yesPrice,
    noPrice,
    combined,
    bookSpread: Number((book.yesAsk - book.yesBid).toFixed(8)),
    grossPerPair: Number((1 - combined).toFixed(8)),
  };
}

export function validateRestingPair(orderbook, quote, { minimumSize } = {}) {
  const book = normaliseOrderbook(orderbook, { minimumSize });
  if (!book) {
    return { ok: false, reason: 'fresh orderbook is not two-sided' };
  }

  const yesPrice = Number(quote?.yesPrice);
  const noPrice = Number(quote?.noPrice);
  if (!(yesPrice > 0) || !(noPrice > 0)) {
    return { ok: false, reason: 'quote prices are unavailable', ...book };
  }
  if (yesPrice >= book.yesAsk - 1e-9) {
    return {
      ok: false,
      reason: `YES ${yesPrice.toFixed(3)} would cross ask ${book.yesAsk.toFixed(3)}`,
      ...book,
    };
  }
  if (noPrice >= book.noAsk - 1e-9) {
    return {
      ok: false,
      reason: `NO ${noPrice.toFixed(3)} would cross ask ${book.noAsk.toFixed(3)}`,
      ...book,
    };
  }
  return { ok: true, ...book };
}

export function marketMinimumShares(market) {
  const raw = market?.metadata?.minSize ?? market?.settings?.minSize ?? 0;
  return shareAmount(raw);
}

export function orderbookMinimumShares(orderbook) {
  return shareAmount(orderbook?.minSize);
}

export function selectFairYesReference(
  book,
  recentTrade,
  {
    requireTrade = true,
    allowTightBookFallback = false,
    tightBookMaxSpread = 0.10,
    tightBookConfirmations = 0,
    requiredTightBookConfirmations = 3,
  } = {},
) {
  const traded = Number(recentTrade?.yesEquivalentPrice);
  if (traded > 0 && traded < 1) {
    return { fairYes: traded, source: 'CURRENT_MARKET_MINED_TRADE' };
  }

  const spread = book
    ? Number((book.yesAsk - book.yesBid).toFixed(8))
    : Infinity;
  const confirmedTightBook = allowTightBookFallback
    && book
    && spread <= tightBookMaxSpread + 1e-9
    && tightBookConfirmations >= requiredTightBookConfirmations;

  if (confirmedTightBook) {
    return {
      fairYes: Number(((book.yesBid + book.yesAsk) / 2).toFixed(8)),
      source: 'CONFIRMED_TIGHT_BOOK_MIDPOINT',
    };
  }
  if (requireTrade || !book) {
    return { fairYes: null, source: 'WAITING_FOR_TRADE_OR_TIGHT_BOOK' };
  }
  return {
    fairYes: (book.yesBid + book.yesAsk) / 2,
    source: 'BOOK_MIDPOINT',
  };
}

export function quoteEconomics(shares, combined) {
  const cost = Number((shares * combined).toFixed(8));
  const payout = Number(shares.toFixed(8));
  const gross = Number((payout - cost).toFixed(8));
  const grossRoiPct = cost > 0 ? Number(((gross / cost) * 100).toFixed(6)) : 0;
  return { shares, cost, payout, gross, grossRoiPct };
}
