# FAQ — Solana Fleet Panel

## What is this?

An automated trading fleet manager. A **funder** wallet holds the budget, a set of **bot** wallets executes randomized buy/sell swaps on one liquidity pool, and a local web panel controls everything: funding, distribution, start/stop, live parameters, charts and reports.

In one sentence: **scheduled, high-frequency, many-wallet automated buying and selling on a chosen Solana pool.**

## Is it legal / safe?

- The panel runs on **127.0.0.1** — only your machine can reach it.
- Private keys live in `wallets.json` on your disk (gitignored). Export only when you must (Phantom import).
- **Wash trading warning**: generating artificial volume on a real market can be illegal market manipulation. Use devnet or pools you fully own for experiments. You accept all responsibility.

## Setup

### Do I need Helius?
Strongly recommended (free tier works). Public RPCs rate-limit a busy fleet quickly. Get a key at https://helius.dev, put it in `.env` or paste it in the **Helius RPC** block of the panel.

### Docker vs plain Node?
Docker: `docker compose up -d --build`, done — the panel survives restarts, logs via `docker compose logs -f`.
Plain: `npm ci`, export env, `CLUSTER=mainnet node server.mjs`.

### Which files matter?

| File | What |
|---|---|
| `wallets.json` | master/funder/bot keys (**private, never share**) |
| `.env` | RPC endpoints with your API key (**private**) |
| `params.json` | live fleet params — edited from the panel, re-read every cycle |
| `pools.json` | trading pair registry |
| `ledger.jsonl` | every expense/income line |
| `sessions.json` | per-session reports (swaps, volume, price delta, fees) |

## Daily use

### How do I start a session?
1. Add/choose the **trading pair** (pool address, e.g. a Raydium CPMM pool).
2. Make sure the **active funder** has SOL.
3. **Deploy budget**: move the slider — the panel previews "gas for N bots + 70% quote + 30% token via Jupiter, evenly split". Hit *Distribute*.
4. Set swap size (in quote token), delays, buy ratio. **Start**.

### What does Deploy budget do exactly?
- Takes X% of the funder's SOL.
- Reserves fixed gas: `N bots × fundGas` (0.02 SOL default).
- Splits the rest **70% → quote token, 30% → base token** (bought via Jupiter at market).
- Tops each bot up to an equal share. Running it twice never double-sends.

### How do I stop and get money back?
- **Stop** halts new swaps.
- **End session & collect** sweeps every bot: tokens first, SOL last, empty ATAs closed (rent reclaimed).
- **→SOL** on a funder sells all its tokens via Jupiter.

### The chart
USD candles for the base token (8-decimal precision), volume histogram, your own swaps marked ▲/▼. The **⇄ reverse** button flips the chart to the quote token in USD.

### How much does a session cost?
Mostly network fees: ~0.0002 SOL per swap + rent for ATAs (reclaimed on sweep). Plus slippage/price impact of your own trades on thin pools — watch the **impact** % in the Deploy preview; red (>5%) means you are moving the market with your own money.

### Bots disappeared from trading after pool switch
Each bot needs the **new pair's tokens**. Re-run **Deploy budget** after switching pairs — it converts and distributes for the active pair.

### Watchdog
If the fleet process crashes, the panel auto-restarts it (toggleable). Session reports are written on stop/crash.

## Devnet playground

No real money needed:

```bash
node 1_generate.mjs     # create wallets
node 2_fund.mjs         # devnet SOL
node 3_pool.mjs         # your own token + CPMM pool
node 4_fleet.mjs        # run the fleet headless
```

## Troubleshooting

- **"Jupiter: no route"** — the token has no liquid route to SOL; sell/buy through the pool manually or skip it.
- **Simulation failed (first attempt)** — transient Jupiter compute-budget race; just press the button again, nothing was spent.
- **Fleet starts then stops** — check `fleet_console.log` / panel log; usually an RPC rate limit (add another key) or insufficient bot gas (re-run Deploy).
- **Page looks stale after switching pairs** — it auto-reloads after a 10-second blocking overlay; balances are re-fetched fresh.
