import assert from 'node:assert/strict';

import * as client from '../src/limitlessClient.js';
import * as ctf from '../src/ctf.js';
import * as quote from '../src/quote.js';
import * as strategy from '../src/strategy.js';
import { fillWatcher } from '../src/fillWatcher.js';

const requiredExports = new Map([
  [client, [
    'initClients',
    'getClient',
    'getClients',
    'fetchJson',
    'getTimeline',
    'getMarket',
    'getOrderBook',
    'getMarketEvents',
    'buildMakerBuyParams',
    'createMakerBuy',
    'cancelOrder',
    'emergencySell',
  ]],
  [ctf, [
    'assertBaseContracts',
    'getTokenBalance',
    'getUsdcBalance',
    'getBaseEthBalance',
    'ensureVenueApprovals',
    'mergePositions',
  ]],
  [quote, [
    'normaliseOrderbook',
    'buildMakerQuote',
    'buildCenteredMakerQuote',
    'marketMinimumShares',
    'orderbookMinimumShares',
    'selectFairYesReference',
    'validateRestingPair',
    'quoteEconomics',
  ]],
  [strategy, [
    'executeCycle',
    'getActivePositions',
    'isLiveSessionLimitReached',
    'requestStrategyShutdown',
    'waitForActivePositionsToClose',
  ]],
]);

for (const [module, names] of requiredExports) {
  for (const name of names) {
    assert.equal(typeof module[name], 'function', `Missing required export: ${name}`);
  }
}

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
  assert.equal(typeof fillWatcher[method], 'function', `FillWatcher missing ${method}()`);
}

console.log('Interface check passed');
