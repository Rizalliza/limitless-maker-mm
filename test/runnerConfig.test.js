import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';

const live = parse(
  readFileSync(new URL('../.env.live.example', import.meta.url)),
);

test('full runner enables three assets with one bounded capital slot', () => {
  assert.equal(live.DRY_RUN, 'false');
  assert.equal(live.LIVE_CANARY_ONLY, 'false');
  assert.equal(live.MAKER_MM_ASSETS, 'BTC,ETH,SOL');
  assert.equal(live.MAKER_MM_SHARES, '50');
  assert.equal(live.MAKER_MM_MAX_CYCLE_USDC, '50');
  assert.equal(live.MAKER_MM_MAX_TOTAL_USDC, '50');
  assert.equal(live.MAKER_MM_MAX_LIVE_CYCLES_SESSION, '12');
  assert.equal(live.MAKER_MM_STOP_SESSION_ON_ONE_SIDED, 'true');
});

test('full runner prefers trades and permits only confirmed tight-book fallback', () => {
  assert.equal(live.MAKER_MM_REQUIRE_TRADE_FAIR, 'true');
  assert.equal(live.MAKER_MM_OPENING_CANARY_FAIR, 'false');
  assert.equal(live.MAKER_MM_ALLOW_TIGHT_BOOK_FAIR, 'true');
  assert.equal(live.MAKER_MM_TIGHT_BOOK_MAX_SPREAD, '0.10');
  assert.equal(live.MAKER_MM_TIGHT_BOOK_CONFIRMATIONS, '3');
  assert.equal(live.MAKER_MM_ENTRY_WINDOW_SEC, '180');
});
