import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCenteredMakerQuote,
  buildMakerQuote,
  marketMinimumShares,
  normaliseOrderbook,
  orderbookMinimumShares,
  selectFairYesReference,
  quoteEconomics,
  validateRestingPair,
} from '../src/quote.js';

test('centres a paired quote around fair value on a sparse book', () => {
  const quote = buildCenteredMakerQuote({
    bids: [{ price: 0.002, size: 100 }],
    asks: [{ price: 0.998, size: 100 }],
  }, {
    fairYes: 0.5,
    tick: 0.001,
    improvementTicks: 1,
    maxCombined: 0.98,
  });

  assert.equal(quote.ok, true);
  assert.equal(quote.yesPrice, 0.49);
  assert.equal(quote.noPrice, 0.49);
  assert.equal(quote.combined, 0.98);
  assert.equal(quote.grossPerPair, 0.02);
});

test('uses a recent fair value while keeping both legs post-only', () => {
  const quote = buildCenteredMakerQuote({
    bids: [{ price: 0.15, size: 100 }],
    asks: [{ price: 0.969, size: 100 }],
  }, {
    fairYes: 0.7,
    tick: 0.001,
    improvementTicks: 1,
    maxCombined: 0.98,
  });

  assert.equal(quote.ok, true);
  assert.equal(quote.yesPrice, 0.69);
  assert.equal(quote.noPrice, 0.29);
  assert.ok(quote.yesPrice < quote.yesAsk);
  assert.ok(quote.noPrice < quote.noAsk);
});

test('rejects a centred pair when the combined cap cannot beat both bids', () => {
  const quote = buildCenteredMakerQuote({
    bids: [{ price: 0.495, size: 100 }],
    asks: [{ price: 0.505, size: 100 }],
  }, {
    fairYes: 0.5,
    tick: 0.001,
    improvementTicks: 1,
    maxCombined: 0.98,
  });

  assert.equal(quote.ok, false);
  assert.match(quote.reason, /no feasible paired/);
});

test('derives the NO book as the complement of the YES book', () => {
  const book = normaliseOrderbook({
    bids: [{ price: 0.47, size: 100 }],
    asks: [{ price: 0.52, size: 100 }],
  });
  assert.deepEqual(book, {
    yesBid: 0.47,
    yesAsk: 0.52,
    yesBidSize: 100,
    yesAskSize: 100,
    noBid: 0.48,
    noAsk: 0.53,
    noBidSize: 100,
    noAskSize: 100,
    minimumSize: 0,
  });
});

test('builds post-only maker prices under the combined cap', () => {
  const quote = buildMakerQuote({
    bids: [{ price: 0.47, size: 100 }],
    asks: [{ price: 0.52, size: 100 }],
  }, { tick: 0.001, improvementTicks: 1, maxCombined: 0.98 });
  assert.equal(quote.ok, true);
  assert.equal(quote.yesPrice, 0.471);
  assert.equal(quote.noPrice, 0.481);
  assert.equal(quote.combined, 0.952);
  assert.equal(quote.grossPerPair, 0.048);
});

test('rejects a quote that breaches the configured cap', () => {
  const quote = buildMakerQuote({
    bids: [{ price: 0.495, size: 100 }],
    asks: [{ price: 0.505, size: 100 }],
  }, { tick: 0.001, improvementTicks: 1, maxCombined: 0.98 });
  assert.equal(quote.ok, false);
  assert.match(quote.reason, /exceeds cap/);
});

test('rejects an empty placeholder-width book', () => {
  const quote = buildMakerQuote({
    bids: [{ price: 0.002, size: 100 }],
    asks: [{ price: 0.998, size: 100 }],
  }, { maxBookSpread: 0.05 });
  assert.equal(quote.ok, false);
  assert.match(quote.reason, /reference spread/);
});

test('ignores displayed levels smaller than venue minSize', () => {
  const book = normaliseOrderbook({
    minSize: 10,
    bids: [{ price: 0.49, size: 1 }, { price: 0.47, size: 20 }],
    asks: [{ price: 0.51, size: 1 }, { price: 0.53, size: 20 }],
  });
  assert.equal(book.yesBid, 0.47);
  assert.equal(book.yesAsk, 0.53);
});

test('converts API raw minSize to shares', () => {
  assert.equal(marketMinimumShares({ metadata: { minSize: 50_000_000 } }), 50);
  assert.equal(marketMinimumShares({ settings: { minSize: '50000000' } }), 50);
  assert.equal(orderbookMinimumShares({ minSize: '50000000' }), 50);
});

test('converts raw six-decimal order-book sizes before filtering', () => {
  const book = normaliseOrderbook({
    minSize: '50000000',
    bids: [
      { price: 0.48, size: '20000000' },
      { price: 0.47, size: '60000000' },
    ],
    asks: [
      { price: 0.52, size: '10000000' },
      { price: 0.53, size: '70000000' },
    ],
  });

  assert.equal(book.minimumSize, 50);
  assert.equal(book.yesBid, 0.47);
  assert.equal(book.yesBidSize, 60);
  assert.equal(book.yesAsk, 0.53);
  assert.equal(book.yesAskSize, 70);
});

test('calculates the configured 20-share minimum economics', () => {
  assert.deepEqual(quoteEconomics(20, 0.98), {
    shares: 20,
    cost: 19.6,
    payout: 20,
    gross: 0.4,
    grossRoiPct: 2.040816,
  });
});

test('requires a current-market trade instead of using a placeholder midpoint', () => {
  const book = normaliseOrderbook({
    bids: [{ price: 0.002, size: 50 }],
    asks: [{ price: 0.998, size: 50 }],
  });
  assert.deepEqual(selectFairYesReference(book, null, { requireTrade: true }), {
    fairYes: null,
    source: 'WAITING_FOR_TRADE_OR_TIGHT_BOOK',
  });
  assert.deepEqual(selectFairYesReference(book, {
    yesEquivalentPrice: 0.6,
  }, { requireTrade: true }), {
    fairYes: 0.6,
    source: 'CURRENT_MARKET_MINED_TRADE',
  });
});

test('uses a tight size-filtered book only after the required confirmations', () => {
  const book = normaliseOrderbook({
    bids: [{ price: 0.168, size: 50 }],
    asks: [{ price: 0.242, size: 50 }],
  }, { minimumSize: 50 });

  assert.deepEqual(selectFairYesReference(book, null, {
    requireTrade: true,
    allowTightBookFallback: true,
    tightBookMaxSpread: 0.10,
    tightBookConfirmations: 2,
    requiredTightBookConfirmations: 3,
  }), {
    fairYes: null,
    source: 'WAITING_FOR_TRADE_OR_TIGHT_BOOK',
  });

  assert.deepEqual(selectFairYesReference(book, null, {
    requireTrade: true,
    allowTightBookFallback: true,
    tightBookMaxSpread: 0.10,
    tightBookConfirmations: 3,
    requiredTightBookConfirmations: 3,
  }), {
    fairYes: 0.205,
    source: 'CONFIRMED_TIGHT_BOOK_MIDPOINT',
  });
});

test('never uses a placeholder-width book as the fair reference', () => {
  const book = normaliseOrderbook({
    bids: [{ price: 0.031, size: 50 }],
    asks: [{ price: 0.969, size: 50 }],
  }, { minimumSize: 50 });

  assert.deepEqual(selectFairYesReference(book, null, {
    requireTrade: true,
    allowTightBookFallback: true,
    tightBookMaxSpread: 0.10,
    tightBookConfirmations: 20,
    requiredTightBookConfirmations: 3,
  }), {
    fairYes: null,
    source: 'WAITING_FOR_TRADE_OR_TIGHT_BOOK',
  });
});

test('rejects a stale pair that would cross either fresh ask', () => {
  const book = {
    bids: [{ price: 0.12, size: 50 }],
    asks: [{ price: 0.14, size: 50 }],
  };

  const staleYes = validateRestingPair(book, {
    yesPrice: 0.145,
    noPrice: 0.835,
  }, { minimumSize: 50 });
  assert.equal(staleYes.ok, false);
  assert.match(staleYes.reason, /YES .* would cross ask/);

  const resting = validateRestingPair(book, {
    yesPrice: 0.13,
    noPrice: 0.85,
  }, { minimumSize: 50 });
  assert.equal(resting.ok, true);
});
