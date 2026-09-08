# Start here — v0.8.1

This release contains one simulation template and one live template. It does
not contain a funded wallet, private key, API token, or an existing `.env`.

## Install on macOS

```bash
cd ~/Desktop
unzip ~/Downloads/limitless-maker-mm-v0.8.1-final.zip
cd limitless-maker-mm
npm install
npm run check
npm test
```

## Simulation

```bash
cp .env.example .env
npm run sim
```

Simulation reads live public market data but submits no transactions.

## Live runner

```bash
cp .env.live.example .env
```

Open `.env` and fill only these secret values:

```dotenv
LMTS_TOKEN_ID=
LMTS_TOKEN_SECRET=
PRIVATE_KEY=
```

For unattended live use, also set a production Base RPC as the primary URL or
add one or more comma-separated alternatives:

```dotenv
BASE_RPC_URL=https://your-primary-base-rpc
BASE_RPC_FALLBACK_URLS=https://your-second-base-rpc
```

`https://mainnet.base.org` can be used for initial access but is a rate-limited
public endpoint. Helius Solana RPC URLs are not Base RPC URLs.

Then run:

```bash
npm run check
npm test
npm run live
```

The supplied live configuration monitors BTC, ETH, and SOL five-minute
markets. It serializes them through one `$50` capital slot, attempts no more
than one pair per market and twelve accepted cycles per process, does not
reprice or re-enter, and stops the session after one-sided exposure.

`SOL` may report that no current timeline slot exists. That asset backs off for
five minutes without blocking BTC or ETH.

## Successful-cycle evidence

A secured paired cycle must show all of the following bot-owned stages:

```text
[BOT] ORDERS ACCEPTED
[BOT] SETTLEMENT MINED
[BOT] BALANCE
[BOT] MERGE CONFIRMED
[PNL] LIVE RESULT ... status=MERGE_CONFIRMED
```

`[MARKET] TRADE MINED` alone is another participant's public trade and is not
proof that this bot filled.

At 50 shares and a `0.98` combined price, maximum purchase cost is `$49`, pair
payout is `$50`, and gross profit is `$1` (`2.0408%`) before gas or recovery
losses. A one-sided fill is not profit.

Press Ctrl+C once and allow shutdown recovery to finish. Do not force-close the
terminal while cancellation, reconciliation, merge, or unwind messages remain.
