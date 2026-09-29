# Solana Fleet Panel

Web control panel for a fleet of Solana trading wallets: automated, scheduled buy/sell flow on a chosen liquidity pool, with one-screen management of funders, bots, RPC keys, trading pairs, budget deployment, live candlestick chart and session reports.

> **⚠️ Disclaimer.** This tool executes **real on-chain transactions with real money**. Automated self-directed trading (many of your own wallets trading with each other) is considered **wash trading** and is illegal in most jurisdictions when used to mislead the market. This project is intended for **education, devnet testing, and experimenting on pools you fully own**. You are solely responsible for how you use it and for complying with your local laws.

## Features

- **Fleet engine** — N bot wallets swap randomly within configurable size/interval ranges (buy/sell ratio tunable live)
- **Panel UI** (localhost:3777) — start/stop, live parameters, balances, ledger of income/expenses, session reports
- **Trading pairs registry** — add a pool by address (tickers auto-resolved via Dexscreener), switch, reverse quote, USD candle chart with your own swap markers (Jupiter + Dexscreener data)
- **Multi-funder** — generate/import funders, one active at a time, drain-on-remove
- **Deploy budget** — one slider: % of funder SOL → fixed gas, then 70% quote / 30% base token via Jupiter, split evenly across all bots (idempotent top-up)
- **Sweep** — collect everything back to the active funder (tokens first, SOL last, ATAs closed)
- **Sell all → SOL** — liquidate all tokens on any funder via Jupiter
- **RPC registry** — multiple Helius keys, live switch with reconnect
- **Watchdog** — auto-restart the fleet process if it crashes
- English / Russian UI

## Quick start (Docker, recommended)

```bash
git clone <this-repo> && cd solana-fleet-panel
cp .env.example .env          # paste your Helius API key
docker compose up -d --build
open http://localhost:3777
```

First-run checklist in the panel:

1. **Helius RPC** — add your key (or it is read from `.env`)
2. **Funders** — generate or import a funder wallet, send SOL to it
3. **Trading pair** — paste the pool address (the pair must exist; tickers resolve automatically)
4. **Bots** — add bot wallets (they are generated for you)
5. **Deploy budget** — slide the % and hit *Distribute*: gas + tokens land on every bot
6. **Start** — the fleet begins swapping; **End session & collect** sweeps everything back

## macOS app (no Docker, no Node needed)

Download `Solana.Fleet.Panel_1.0.0_aarch64.dmg` from [Releases](https://github.com/ccubetez/solana-fleet-panel/releases), drag to Applications.

- The app bundles its own Node.js runtime and the full panel — double-click and it works.
- All data (wallets, pools, logs) lives in `~/Library/Application Support/com.solanafleet.panel/`.
- **First launch**: macOS Gatekeeper will warn about an unidentified developer (the app is not notarized). Right-click the app → **Open** → **Open**. Or run once: `xattr -dr com.apple.quarantine "/Applications/Solana Fleet Panel.app"`.
- Apple Silicon only (aarch64). Intel build can be produced the same way (`tauri build --target x86_64-apple-darwin`).

## Without Docker

```bash
npm ci
cp .env.example .env   # fill in
export $(grep -v '^#' .env | xargs)
CLUSTER=mainnet node server.mjs
```

Devnet playground (create your own token + CPMM pool + bots):

```bash
node 1_generate.mjs        # master + funder + bots wallets
BOTS=6 node 2_fund.mjs     # devnet airdrop-style funding
node 3_pool.mjs            # create token + Raydium CPMM pool
node 4_fleet.mjs           # headless fleet
```

## Security notes

- The panel binds to **127.0.0.1 only** — do not expose it.
- `wallets.json` holds private keys (base64). It is gitignored; keep it safe, `chmod 600`.
- RPC keys are shown masked after entry; private keys are revealed only on explicit export (with a confirm dialog).

See [FAQ.md](FAQ.md) for detailed usage.
