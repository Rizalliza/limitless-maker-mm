# Limitless Maker/Merge Bot v0.8.1

Five-minute, observation-first ES-module adaptation of the paired YES/NO maker-and-merge strategy for Limitless Exchange on Base.

## Strategy invariants

- Place one post-only GTC maker BUY on YES and one on NO.
- Never cancel and reprice a resting pair.
- Require `YES + NO <= MAKER_MM_MAX_COMBINED`.
- Treat `MATCHED` as provisional; use terminal settlement and ERC-1155 balances.
- Merge only equal settled YES/NO quantities.
- Cancel orders and FAK-sell any unpaired remainder.
- Stop re-entry after any unsafe or incomplete cycle.
- Re-enter only after a completed safe merge.
- Pre-fetch and subscribe to the next recurring market.

## Platform mapping

- Chain: Base (`8453`), not Polygon.
- Collateral: native Base USDC.
- Wallet: EOA with a scoped Limitless HMAC trading token.
- Discovery: `/markets/timeline` for BTC/ETH recurring five-minute slots.
- Order book: one consolidated YES-side book; derive NO by complement.
- Minimum size: larger of configured shares, market minimum, and book minimum.
- Units: API book sizes and minimums are converted from six-decimal contract units to shares once at ingestion.
- Freshness: stale WebSocket books are rejected and replaced with REST snapshots.
- Pricing: prefer a recent current-market finalized trade. If none appears,
  use the midpoint only after three distinct, size-filtered WebSocket books
  remain at or below the configured `0.10` maximum spread. Wide placeholder
  books never qualify.
- Capital: concurrent BTC/ETH cycles cannot reserve the same USDC.
- Placement safety: the candidate pair is checked against a newly received WS
  book (or a fresh REST book) immediately before submission. A stale pair is
  rebuilt once and otherwise aborted before either order is sent.

## Install and simulate

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env
npm run check
npm test
npm run sim
```

`DRY_RUN=true` never submits orders, approvals, cancellations, emergency sells, or merges. It reports real books, genuine venue activity, and hypothetical bot quotes without inventing order IDs. A paper fill candidate is recorded only when a finalized trade or displayed ask moves strictly through the hypothetical bid; it remains queue-unproven.

## Audit log prefixes

- `[MARKET]`: finalized venue-wide trades from any participant.
- `[BOOK]`: fresh book source, age, best bid, best ask, and spread.
- `[QUOTE]`: proposed bot prices, capital, gross dollars, and gross ROI.
- `[BOT]`: this bot's order, settlement, balance, cancellation, unwind, and merge lifecycle.
- `[INFO] ACCOUNT`: wallet events that are not proven to belong to orders created by this process.
- `[PNL] PAPER RESULT`: queue-unproven feasibility estimate, never a real fill.
- `[PNL] LIVE RESULT`: balance-confirmed pair and merge transaction; gross is before Base gas.
- `[PNL] SESSION`: cumulative paper and live scoreboards, kept separate.

An external `[MARKET] TRADE MINED` line is not a bot fill and is never labeled PnL.

## Live prerequisites

1. Confirm use is permitted for the operator's location and account.
2. Use a dedicated EOA and ensure the Limitless profile is in EOA trading mode.
3. Generate a scoped HMAC token with trading permission.
4. Fund the EOA with Base USDC and Base ETH for wallet transactions.
5. Put `LMTS_TOKEN_ID`, `LMTS_TOKEN_SECRET`, and `PRIVATE_KEY` in `.env`.
6. Keep re-entry disabled and one attempt per market until the results justify changing it.
7. Keep both the per-cycle and global capital USDC caps at `$50`.
8. Keep at least the configured minimum Base ETH available for approval, merge, and recovery gas.
9. Validate one non-marketable minimum-size placement and cancellation before broader execution.

Limitless has no testnet or sandbox. Observation validates public behavior only. Live authentication, placement, private events, settlement, approvals, emergency FAK selling, and merging require an explicitly authorized low-value mainnet canary.

For live operation, copy `.env.live.example` to `.env`, fill the three credential
values, and run `npm run check`, `npm test`, then `npm run live`. This is the one
complete live template: BTC, ETH, and SOL share one `$50` capital slot, with at
most twelve accepted cycles, one attempt per market, no repricing or re-entry,
and a session stop after one-sided exposure. A symbol with no recurring slot
backs off without preventing the other symbols from running.

Press Ctrl+C once for a controlled stop. The bot stops discovery, requests
cancellation, waits for settlement, reconciles token balances, merges equal
pairs, and attempts to FAK-sell any unpaired remainder before disconnecting.
Do not close the terminal while `SHUTDOWN` recovery is running.

Base RPC reads are retried with exponential backoff. Optional comma-separated
`BASE_RPC_FALLBACK_URLS` are rotated between attempts; use production Base RPC
endpoints because the public `mainnet.base.org` endpoint is rate limited. Any
unexpected live-cycle error after order placement triggers cancellation and
balance reconciliation before the position is removed from recovery tracking.

## Safety boundary

`MAKER_MM_MAX_COMBINED` protects gross pair economics only. It does not cover Base gas, emergency taker fees, unwind slippage, settlement failures, API downtime, or capital lockup. Both placements are independent and cannot be atomic; the recovery path cancels any accepted order and reconciles balances if its partner placement fails.

See [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md) for exact capital, profit, trade requirements, completed work, and remaining live-only validation.
