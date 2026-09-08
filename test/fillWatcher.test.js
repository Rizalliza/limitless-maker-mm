import test from 'node:test';
import assert from 'node:assert/strict';

import { FillWatcher } from '../src/fillWatcher.js';

test('rejects stale cached books', async () => {
  const watcher = new FillWatcher();
  watcher.recordBook('btc-test', {
    bids: [{ price: 0.48, size: 20 }],
    asks: [{ price: 0.52, size: 20 }],
  }, 'WS');

  assert.ok(watcher.getBook('btc-test', { maxAgeMs: 1_000 }));
  watcher.books.get('btc-test').receivedAt = Date.now() - 2_000;
  assert.equal(watcher.getBook('btc-test', { maxAgeMs: 1_000 }), null);
});

test('deduplicates repeated market subscriptions and activity initialization', async () => {
  const watcher = new FillWatcher();
  const subscriptions = [];
  watcher.ws = {
    subscribe: async (...args) => subscriptions.push(args),
  };
  watcher.pollMarketActivity = async () => {};

  await watcher.watchMarket('btc-test', { activity: true });
  await watcher.watchMarket('btc-test', { activity: true });

  assert.equal(subscriptions.length, 1);
  assert.equal(watcher.marketSlugs.size, 1);
  assert.equal(watcher.activitySlugs.size, 1);
});

test('normalizes a mined NO trade into a YES fair-value reference', () => {
  const watcher = new FillWatcher();
  watcher.registerMarket({
    slug: 'eth-test',
    tokens: { yes: 'yes-token', no: 'no-token' },
  });

  const trade = watcher.recordMarketTrade('eth-test', {
    tokenId: 'no-token',
    matchedSize: '3330000',
    price: '0.300',
    txHash: '0xabc',
  }, { log: false });

  assert.equal(trade.outcome, 'NO');
  assert.equal(trade.shares, 3.33);
  assert.equal(trade.yesEquivalentPrice, 0.7);
  assert.equal(watcher.lastMarketTrade('eth-test').txHash, '0xabc');
});

test('returns only terminal mined fills for owned order ids', () => {
  const watcher = new FillWatcher();
  watcher.trackOwnedOrders(['yes-order']);
  watcher.handleOrderEvent({
    source: 'SETTLEMENT',
    type: 'MATCHED',
    tradeEventId: 'trade-1',
    orderId: 'yes-order',
  });
  watcher.handleOrderEvent({
    source: 'SETTLEMENT',
    type: 'MINED',
    tradeEventId: 'trade-1',
    orderId: 'yes-order',
    amountContracts: '20',
    price: '0.49',
    txHash: '0xdef',
  });

  const fills = watcher.minedFills(['yes-order', 'other-order']);
  assert.equal(fills.length, 1);
  assert.equal(fills[0].type, 'MINED');
  assert.equal(fills[0].txHash, '0xdef');
});

test('tracks only order ids created by this bot process', () => {
  const watcher = new FillWatcher();
  watcher.trackOwnedOrders(['bot-order', null, '']);

  assert.equal(watcher.ownedOrderIds.has('bot-order'), true);
  assert.equal(watcher.ownedOrderIds.has('account-order'), false);
});

test('does not downgrade an out-of-order terminal settlement to MATCHED', () => {
  const watcher = new FillWatcher();
  watcher.handleOrderEvent({
    source: 'SETTLEMENT',
    type: 'MINED',
    tradeEventId: 'trade-2',
    orderId: 'no-order',
    txHash: '0xmined',
  });
  watcher.handleOrderEvent({
    source: 'SETTLEMENT',
    type: 'MATCHED',
    tradeEventId: 'trade-2',
    orderId: 'no-order',
  });

  assert.equal(watcher.hasPending(['no-order']), false);
  assert.equal(watcher.minedFills(['no-order']).length, 1);
});
