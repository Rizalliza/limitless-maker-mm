import test from 'node:test';
import assert from 'node:assert/strict';

import {
  releaseUsdc,
  reserveUsdc,
  reservedUsdc,
  resetCapitalReservationsForTests,
} from '../src/capital.js';

test('prevents concurrent cycles from reserving the same USDC', async () => {
  resetCapitalReservationsForTests();
  await reserveUsdc('btc', 19.6, 30);
  assert.equal(reservedUsdc(), 19.6);

  await assert.rejects(
    reserveUsdc('eth', 19.6, 30),
    /Insufficient unreserved USDC/,
  );

  await releaseUsdc('btc');
  await reserveUsdc('eth', 19.6, 30);
  assert.equal(reservedUsdc(), 19.6);
  await releaseUsdc('eth');
});

test('enforces hard per-cycle and total USDC caps atomically', async () => {
  resetCapitalReservationsForTests();

  await assert.rejects(
    reserveUsdc('too-large', 51, 100, { maxCycle: 50, maxTotal: 50 }),
    /Cycle USDC cap exceeded/,
  );

  await reserveUsdc('first', 30, 100, { maxCycle: 50, maxTotal: 50 });
  await assert.rejects(
    reserveUsdc('second', 21, 100, { maxCycle: 50, maxTotal: 50 }),
    /Session USDC cap exceeded/,
  );
  await releaseUsdc('first');
});
