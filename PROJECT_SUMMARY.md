# Project status and economics

## Objective

For each active BTC, ETH, or SOL five-minute binary CLOB market, submit one resting post-only YES BUY and one resting post-only NO BUY. If equal quantities settle, merge the pair into USDC. Never treat a provisional match, public market trade, or one-sided balance as secured profit.

## Current requested amount

The full-run template requests 50 shares per outcome. Actual shares are:

```text
max(50, market minimum, order-book minimum)
```

At the `$0.98` combined cap and 50 shares:

```text
paired capital = 50 × 0.98 = $49.00
merge value    = 50 × 1.00 = $50.00
minimum gross  = $1.00
gross ROI      = 1.00 / 49.00 = 2.0408%
```

The observed second live run moved the wallet from about `$51.61` to `$52.51`, approximately `$0.90` net from a `$1.00` gross pair after costs. One successful sample does not establish a stable expected return.

## Trade requirements

1. Exact current timeline slot is open and tradable.
2. Market is a CLOB with YES and NO token IDs and venue data.
3. Book is two-sided and no older than the configured maximum age.
4. Levels satisfy the venue minimum size.
5. Pricing prefers a recent finalized trade from the current market. If none
   appears, a size-filtered WebSocket midpoint is accepted only after three
   distinct updates have a spread no wider than `0.10`. Placeholder-width books
   never qualify.
6. YES and NO prices are centred around fair value and remain post-only.
7. Combined quote is no more than `$0.98`.
8. Entry observation is never shorter than 30 seconds; the supplied default is 180 seconds.
9. Unreserved wallet USDC covers the complete paired cost.
10. Both live placements return order IDs.
11. Both fills reach terminal `MINED` settlement and appear in token balances.
12. Only equal balances are merged. Any remainder is recovered and re-entry stops.

The old `$0.05` full-book spread gate was removed from entry qualification. On a sparse Limitless book such as `0.002 / 0.998`, that width measures missing liquidity—not guaranteed profit. The new quote allocates the `$0.98` cap around fair value. At a fair YES value of `$0.50`, the intended pair is approximately `YES $0.49 + NO $0.49`.

## Execution and reward evidence

Simulation and live accounting are deliberately separate:

- `PAPER FILL-CANDIDATE`: a finalized public trade or displayed ask moved strictly through the hypothetical order price. Equal-price volume is excluded because queue priority is unknown.
- `PAPER RESULT`: shows YES/NO candidate fills, paired shares, one-sided exposure, and gross reward before fees/gas. It is a feasibility estimate, not money earned.
- `SETTLEMENT MINED`: Limitless reports this bot order as terminally settled on Base.
- `MERGE CONFIRMED`: the CTF merge transaction succeeded.
- `LIVE RESULT`: reports balance-confirmed paired shares, terminal fill-event count, merge transaction hash, and paired gross reward before Base gas.
- `SESSION PAPER` and `SESSION LIVE`: cumulative totals printed at shutdown.

For a fully paired 20-share cycle at `$0.98` combined:

```text
settled purchase cost = $19.60
merge proceeds        = $20.00
gross before gas      = $0.40
gross ROI             = 2.0408%
```

Makers have no realized Limitless trading fee. Net profit still requires subtracting Base merge gas and any loss, fee, or slippage from one-sided emergency recovery.

## Confirmed working offline and in public observation

- BTC/ETH five-minute timeline discovery and next-slot warming.
- Public Limitless WebSocket and market subscriptions.
- Public finalized market-trade feed with Base transaction hashes.
- Rate-limit queue and 429 backoff for public REST reads.
- Fresh-book age enforcement with REST fallback.
- Complementary YES/NO order-book calculation.
- Fair-value-centred paired quoting on sparse books.
- Paper execution-candidate and monetary reward accounting.
- Confirmed live settlement/merge reward accounting.
- Distinct market, book, quote, bot, and PnL logs.
- Capital reservations for concurrent asset cycles.
- Six-decimal order-book amount normalization at the ingestion boundary.
- Current-market trade fair value with a three-update, tight-WebSocket-book
  fallback that fixes v0.7's zero-order regression without admitting placeholders.
- BTC/ETH/SOL monitoring with one globally serialized `$50` capital slot.
- A bounded twelve-cycle full-run template with one attempt per market.
- Five-minute backoff for symbols that have no current timeline slot.
- Immediate session stop after a one-sided result.
- Early session-limit checks, so an exhausted session does not keep waiting for quotes.
- Base RPC contract preflight, balance-read retry, and error-triggered recovery.
- Pre-placement fresh-book validation with one bounded quote refresh, preventing
  first-time approval latency from turning a maker quote into a taker order.
- Optional Base RPC fallback rotation for authoritative ERC-1155 balance reads.
- Zero-fill placement rejection is classified as incomplete, not one-sided.
- Atomic `$50` per-cycle/session USDC caps and a Base ETH gas preflight.
- Bounded USDC venue approval for a fresh canary allowance.
- WebSocket authentication exception logging and subscription restoration.
- Full module interface validation and regression tests for trade and tight-book entry.

## Proven with real funds

- Scoped-HMAC authentication and EOA order signing.
- Two-sided post-only placement and terminal `MATCHED → MINED` events.
- A complete 50-share pair at a `$0.98` combined bot price.
- Manual resolved-position claim and an observed wallet increase from about
  `$51.61` to `$52.51` after the second live run.

## Still not proven end to end

- Automatic CTF merge after the new Base RPC retry path.
- Emergency FAK execution, taker fee, depth, and realized unwind loss.
- Multi-market unattended operation across BTC, ETH, and SOL.
- Net PnL consistency across many cycles, including gas, slippage, settlement
  delays, one-sided recoveries, and rebates.

The full runner remains bounded because only two live samples exist and the
automatic merge/recovery path has not yet completed successfully on-chain.
