import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderType, Side, buildMakerBuyParams } from '../src/limitlessClient.js';

test('builds only fields forwarded by SDK 1.1.0 createOrder', () => {
  const params = buildMakerBuyParams({
    market: { slug: 'btc-up-or-down-5-min-123' },
    tokenId: '456',
    price: 0.48,
    size: 20,
  });
  assert.deepEqual(params, {
    marketSlug: 'btc-up-or-down-5-min-123',
    tokenId: '456',
    side: Side.BUY,
    price: 0.48,
    size: 20,
    orderType: OrderType.GTC,
    postOnly: true,
  });
  assert.equal('clientOrderId' in params, false);
  assert.equal('stpPolicy' in params, false);
});
