// Панель управления флотом. Только 127.0.0.1:3777.
// API: status, log, actions, balances, pools (list/select/add), preflight,
//      fund, bots/add, bots/remove, sweep, params, start, stop
import http from 'http';
import fs from 'fs';
import { spawn } from 'child_process';

// ── env из .env → process.env (до загрузки lib) ──
if (fs.existsSync('.env')) {
  const envFile = Object.fromEntries(
    fs.readFileSync('.env', 'utf8').split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; })
  );
  Object.assign(process.env, envFile);
} else {
  console.warn('[fleet] .env not found — copy .env.example and add your Helius key, or add it later in the panel (Helius RPC block)');
}

const { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction, VersionedTransaction, Connection } = await import('@solana/web3.js');
const spl = await import('@solana/spl-token');
const lib = await import('./lib.mjs');
const { loadWallets, saveWallets, keypairFrom, getBots, sleep } = lib;
let conn = lib.conn; // мутабельно: /api/rpc может переключить на лету

// ── миграция wallets.json: у фандеров name/active, активный ровно один ──
const getFunders = (w) => w.filter((x) => x.role === 'funder');
const activeFunderEntry = (w) => getFunders(w).find((x) => x.active) || getFunders(w)[0];
(function migrate() {
  const w = loadWallets();
  let changed = false;
  for (const x of getFunders(w)) {
    if (!x.name) { x.name = 'funder-' + x.publicKey.slice(0, 4); changed = true; }
  }
  if (getFunders(w).length && !getFunders(w).some((x) => x.active)) {
    getFunders(w)[0].active = true; changed = true;
  }
  if (changed) saveWallets(w);
})();

// ── реестр RPC-ключей: rpc_keys.json [{name, key, active}] ──
const readRpcKeys = () => { try { return JSON.parse(fs.readFileSync('rpc_keys.json', 'utf8')); } catch { return null; } };
function writeRpcKeys(keys) { fs.writeFileSync('rpc_keys.json', JSON.stringify(keys, null, 2)); }
(function migrateRpcKeys() {
  if (readRpcKeys()) return;
  const key = (process.env.HELIUS_MAINNET || '').match(/api-key=([a-f0-9-]+)/)?.[1];
  writeRpcKeys(key ? [{ name: 'default', key, active: true, addedAt: Date.now() }] : []);
})();
const activeRpcKey = () => (readRpcKeys() || []).find((k) => k.active)?.key || '';
const maskKey = (k) => (k ? k.slice(0, 8) + '…' : '');

function applyRpcKey(key) {
  const devnet = `https://devnet.helius-rpc.com/?api-key=${key}`;
  const mainnet = `https://mainnet.helius-rpc.com/?api-key=${key}`;
  let env = fs.readFileSync('.env', 'utf8');
  env = env.replace(/RPC_URL="[^"]*"/, `RPC_URL="${devnet}"`).replace(/HELIUS_MAINNET="[^"]*"/, `HELIUS_MAINNET="${mainnet}"`);
  fs.writeFileSync('.env', env);
  fs.chmodSync('.env', 0o600);
  envFile.RPC_URL = devnet; envFile.HELIUS_MAINNET = mainnet;
  process.env.RPC_URL = devnet; process.env.HELIUS_MAINNET = mainnet;
  conn = new Connection(CLUSTER === 'mainnet' ? mainnet : devnet, 'confirmed');
  balCache.t = 0;
}

const PORT = 3777;
const CLUSTER = process.env.CLUSTER || 'mainnet';
let child = null;

const readJson = (f, fb = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));
const POOLFILE = `pool.${CLUSTER}.json`;
const logAction = (msg) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  fs.appendFileSync('actions.log', line + '\n');
  console.log(line);
};

// ── локализация логов (язык присылает панель) ──
let PANEL_LANG = (() => { try { return JSON.parse(fs.readFileSync('panel_lang.json','utf8')).lang || 'en'; } catch { return 'en'; } })();
const LA_DICT = {
  en: {
    jupiter: (s, q, sym) => `Jupiter: ${s} SOL -> ${q} ${sym}`,
    funded: (n, extra) => `Funding: topped up ${n} bots${extra}`,
    distributed: (d, n, sol, qs, q, ts, t) => `Distribution: ${d}/${n} bots (SOL ${sol}, ${qs} ${q}, ${ts} ${t})`,
    poolSelected: (n, s) => `Pool selected: ${n} (${s})`,
    poolAdded: (n) => `Pool added: ${n}`,
    poolRemoved: (n) => `Pool removed: ${n}`,
    poolRefreshed: (n) => `Pool refreshed: ${n}`,
    poolReverse: (n, on) => `Pool ${n}: reverse ${on ? 'ON' : 'OFF'}`,
    funderAdded: (n, s) => `Funder added: ${n} (${s})`,
    funderActive: (n, s) => `Active funder: ${n} (${s})`,
    funderRemoved: (n, d, m) => `Funder ${n} removed -> ${d}: ${m || 'empty'}`,
    rpcAdded: (n, m) => `RPC key added: ${n} (${m})`,
    rpcActive: (n) => `Active RPC key: ${n}`,
    rpcRemoved: (n) => `RPC key removed: ${n}`,
    botAdded: (i, s) => `Bot ${i} added (${s})`,
    botRemoved: (i, m) => `Bot ${i} removed, collected: ${m || 'empty'}`,
    fleetStoppedForSweep: () => `Fleet stopped before sweep`,
    sweepDone: (n) => `Sweep: collected from ${n} wallets to funder`,
    fleetStopped: () => `Fleet stopped from panel`,
    fleetStarted: (p, n) => `Fleet started (pid ${p}, bots ${n})`,
    watchdogRestart: () => `Watchdog: fleet crashed, restarting in 3s`,
    fleetExited: () => `Fleet exited (crash)`,
    lowGasStop: () => `Auto-stop: bots are out of gas`,
    exportKey: (s) => `Key exported: ${s}`,
    sellAll: (n, r) => `Sell all ${n}: ${r}`,
    deploy: (p, b, d) => `Deploy ${p}%: ${b} SOL → ${d} bots`,
  },
  ru: {
    jupiter: (s, q, sym) => `Jupiter: ${s} SOL → ${q} ${sym}`,
    funded: (n, extra) => `Фандинг: долито ${n} ботов${extra}`,
    distributed: (d, n, sol, qs, q, ts, t) => `Распределение: ${d}/${n} ботов (SOL ${sol}, ${qs} ${q}, ${ts} ${t})`,
    poolSelected: (n, s) => `Пул переключён на ${n} (${s})`,
    poolAdded: (n) => `Пул добавлен в реестр: ${n}`,
    poolRemoved: (n) => `Пул удалён из реестра: ${n}`,
    poolRefreshed: (n) => `Пул обновлён: ${n}`,
    poolReverse: (n, on) => `Пул ${n}: reverse ${on ? 'ON' : 'OFF'}`,
    funderAdded: (n, s) => `Добавлен фандер ${n} (${s})`,
    funderActive: (n, s) => `Активный фандер: ${n} (${s})`,
    funderRemoved: (n, d, m) => `Фандер ${n} удалён → ${d}: ${m || 'пусто'}`,
    rpcAdded: (n, m) => `RPC-ключ добавлен: ${n} (${m})`,
    rpcActive: (n) => `Активный RPC-ключ: ${n}`,
    rpcRemoved: (n) => `RPC-ключ удалён: ${n}`,
    botAdded: (i, s) => `Добавлен bot ${i} (${s})`,
    botRemoved: (i, m) => `Bot ${i} удалён, сведено: ${m || 'пусто'}`,
    fleetStoppedForSweep: () => `Флот остановлен перед sweep`,
    sweepDone: (n) => `Sweep: ${n} кошельков сведено на funder`,
    fleetStopped: () => `Флот остановлен из панели`,
    fleetStarted: (p, n) => `Флот запущен (pid ${p}, ботов: ${n})`,
    watchdogRestart: () => `Watchdog: флот упал, перезапуск через 3 сек`,
    fleetExited: () => `Флот завершился (падение/выход)`,
    lowGasStop: () => `Автостоп: у ботов кончился газ`,
    exportKey: (s) => `Экспорт ключа: ${s}`,
    sellAll: (n, r) => `Продажа ${n}: ${r}`,
    deploy: (p, b, d) => `Оборот ${p}%: ${b} SOL → ${d} ботов`,
  },
};
const LA = (key, ...args) => (LA_DICT[PANEL_LANG]?.[key] || LA_DICT.en[key])(...args);

// ── Журнал расходов/доходов (funder-центричный, дельты; fee всегда расход) ──
const TX_FEE = 0.000005;
const ledger = (e) => {
  fs.appendFileSync('ledger.jsonl', JSON.stringify({ ts: new Date().toISOString().slice(5, 19).replace('T', ' '), ...e }) + '\n');
};

// ── helpers ──
const activePool = () => readJson(POOLFILE);
async function tokenProgramOf(mint) {
  const info = await conn.getAccountInfo(new PublicKey(mint));
  return info.owner;
}
async function tokenBal(ata, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { return BigInt((await conn.getTokenAccountBalance(ata)).value.amount); }
    catch { if (i < tries - 1) await sleep(1500); }
  }
  return 0n;
}
function short(a) { return a.slice(0, 4) + '…' + a.slice(-4); }

// ── балансы (кэш 15 сек) ──
let balCache = { t: 0, data: null };
async function balances() {
  if (Date.now() - balCache.t < 15000 && balCache.data) return balCache.data;
  const pool = activePool();
  const wallets = loadWallets();
  if (!pool) {
    async function solOnly(pkStr) {
      const sol = await conn.getBalance(new PublicKey(pkStr)).catch(() => 0);
      return { address: pkStr, short: short(pkStr), sol: sol / LAMPORTS_PER_SOL, quote: 0, token: 0 };
    }
    const data = {
      funders: await Promise.all(getFunders(wallets).map(async (f) => ({ ...(await solOnly(f.publicKey)), name: f.name, active: !!f.active }))),
      bots: await Promise.all(getBots(wallets).map((b) => solOnly(b.publicKey).then((r) => ({ ...r, index: b.index })))),
      noPool: true,
    };
    balCache = { t: Date.now(), data };
    return data;
  }
  const mint = new PublicKey(pool.mint), quote = new PublicKey(pool.quoteMint);
  const [mintProg, quoteProg] = await Promise.all([tokenProgramOf(pool.mint), tokenProgramOf(pool.quoteMint)]);

  async function one(pkStr) {
    const pk = new PublicKey(pkStr);
    const [sol, q, t] = await Promise.all([
      conn.getBalance(pk),
      tokenBal(spl.getAssociatedTokenAddressSync(quote, pk, false, quoteProg)),
      tokenBal(spl.getAssociatedTokenAddressSync(mint, pk, false, mintProg)),
    ]);
    return { address: pkStr, short: short(pkStr), sol: sol / LAMPORTS_PER_SOL, quote: Number(q) / 10 ** pool.quoteDecimals, token: Number(t) / 10 ** pool.decimals };
  }

  const data = {
    funders: await Promise.all(getFunders(wallets).map(async (f) => ({
      ...(await one(f.publicKey)), name: f.name, active: !!f.active,
    }))),
    bots: await Promise.all(getBots(wallets).map((b) => one(b.publicKey).then((r) => ({ ...r, index: b.index })))),
  };
  balCache = { t: Date.now(), data };
  return data;
}

// ── пре-флайт ──
async function preflight() {
  const checks = [];
  const params = readJson('params.json', {});
  const fundGas = params.fundGas ?? 0.02;
  const minSwap = params.minSwap ?? 1;

  try { await conn.getVersion(); checks.push({ name: 'RPC', ok: true }); }
  catch { checks.push({ name: 'RPC', ok: false, detail: 'нет ответа' }); }

  const pool = activePool();
  try {
    const info = await conn.getAccountInfo(new PublicKey(pool.poolId));
    checks.push({ name: 'Пул', ok: !!info && info.data.length > 100, detail: pool.name || short(pool.poolId) });
  } catch { checks.push({ name: 'Пул', ok: false, detail: 'не читается' }); }

  const bal = await balances();
  const badGas = bal.bots.filter((b) => b.sol < fundGas * 0.8);
  const badQuote = bal.bots.filter((b) => b.quote < minSwap && b.token <= 0);
  checks.push({ name: 'Газ у ботов', ok: badGas.length === 0, detail: badGas.length ? `мало у: ${badGas.map((b) => b.short).join(', ')}` : `${bal.bots.length} ок` });
  checks.push({ name: 'Quote у ботов', ok: badQuote.length === 0, detail: badQuote.length ? `пусто: ${badQuote.map((b) => b.short).join(', ')}` : `${bal.bots.length} ок` });
  const afSol = (bal.funders.find((f) => f.active) || bal.funders[0] || { sol: 0 }).sol;
  checks.push({ name: 'Funder SOL', ok: afSol > 0.05, detail: afSol.toFixed(3) });

  return { ready: checks.every((c) => c.ok), checks, fundGas, fundQuote: params.fundQuote ?? 100 };
}

// ── фандинг (конверсия + раздача) ──
async function jupiterBuyQuote(funder, pool, lamports, outMint = pool.quoteMint) {
  const q = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${outMint}&amount=${lamports}&slippageBps=150`)).json();
  if (q.error || !q.outAmount) throw new Error('Jupiter: ' + (q.error || 'no route'));
  const s = await (await fetch('https://lite-api.jup.ag/swap/v1/swap', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: funder.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
  })).json();
  const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, 'base64'));
  tx.sign([funder]);
  const sig = await conn.sendTransaction(tx, { maxRetries: 3 });
  await conn.confirmTransaction(sig, 'confirmed');
  return { sig, out: q.outAmount };
}

async function fundBots() {
  const pool = activePool();
  const params = readJson('params.json', {});
  const fundGas = params.fundGas ?? 0.02;
  const fundQuote = params.fundQuote ?? 100;
  const convertSol = params.convertSol ?? 0.5;
  const wallets = loadWallets();
  const funder = keypairFrom(activeFunderEntry(wallets).secretKey);
  const bots = getBots(wallets);
  const quoteMint = new PublicKey(pool.quoteMint);
  const quoteProg = await tokenProgramOf(pool.quoteMint);
  const funderAta = spl.getAssociatedTokenAddressSync(quoteMint, funder.publicKey, false, quoteProg);
  const results = [];

  const funderSol = (await conn.getBalance(funder.publicKey)) / LAMPORTS_PER_SOL;
  if (funderSol < 0.05 + fundGas * bots.length) throw new Error(`Мало SOL на funder (${funderSol.toFixed(3)}) — докинь и повтори`);

  const needQuote = BigInt(Math.ceil(fundQuote * bots.length * 10 ** pool.quoteDecimals));
  let funderQ = await tokenBal(funderAta);
  if (funderQ < needQuote) {
    const r = await jupiterBuyQuote(funder, pool, Math.floor(convertSol * LAMPORTS_PER_SOL));
    logAction(LA('jupiter', convertSol, (r.out / 10 ** pool.quoteDecimals).toFixed(1), pool.quoteSymbol));
    ledger({ type: 'расход: конверсия', sol: -convertSol, quote: Number(r.out) / 10 ** pool.quoteDecimals, fee: TX_FEE, note: `SOL → ${pool.quoteSymbol} (Jupiter)` });
    results.push(`конверсия ${convertSol} SOL`);
    funderQ = await tokenBal(funderAta);
  }

  let funded = 0;
  for (const b of bots) {
    const botPk = new PublicKey(b.publicKey);
    const tx = new Transaction();
    let solSent = 0, quoteSent = 0;
    const bal = (await conn.getBalance(botPk)) / LAMPORTS_PER_SOL;
    if (bal < fundGas - 0.001) {
      solSent = fundGas - bal;
      tx.add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: botPk, lamports: Math.floor(solSent * LAMPORTS_PER_SOL) }));
    }
    const botAta = spl.getAssociatedTokenAddressSync(quoteMint, botPk, false, quoteProg);
    const ataInfo = await conn.getAccountInfo(botAta);
    if (!ataInfo) tx.add(spl.createAssociatedTokenAccountInstruction(funder.publicKey, botAta, botPk, quoteMint, quoteProg));
    const cur = ataInfo ? await tokenBal(botAta) : 0n;
    const target = BigInt(Math.ceil(fundQuote * 10 ** pool.quoteDecimals));
    if (cur < target) {
      quoteSent = Number(target - cur) / 10 ** pool.quoteDecimals;
      tx.add(spl.createTransferCheckedInstruction(funderAta, quoteMint, botAta, funder.publicKey, target - cur, pool.quoteDecimals, [], quoteProg));
    }
    if (tx.instructions.length === 0) continue;
    const sig = await conn.sendTransaction(tx, [funder]);
    await conn.confirmTransaction(sig, 'confirmed');
    ledger({ type: 'расход: фандинг', sol: -solSent || null, quote: -quoteSent || null, fee: TX_FEE, note: `bot ${b.index} ${short(b.publicKey)}` });
    funded++;
    await sleep(400);
  }
  logAction(LA('funded', funded, results.length ? ' + conversion' : ''));
  balCache.t = 0;
  return { funded, converted: results.length > 0 };
}

// ── sweep одного кошелька → funder (токены → close ATA → SOL последним) ──
async function sweepWallet(botKp, botIndex, funder, pool, mintProg, quoteProg) {
  const botPk = botKp.publicKey;
  const mint = new PublicKey(pool.mint), quote = new PublicKey(pool.quoteMint);
  const tx = new Transaction();
  const moved = [];
  const amounts = { sol: 0, quote: 0, token: 0 };

  for (const [m, prog, dec, sym, key] of [[mint, mintProg, pool.decimals, pool.mintSymbol || 'TKN', 'token'], [quote, quoteProg, pool.quoteDecimals, pool.quoteSymbol || 'Q', 'quote']]) {
    const botAta = spl.getAssociatedTokenAddressSync(m, botPk, false, prog);
    const funderAta = spl.getAssociatedTokenAddressSync(m, funder.publicKey, false, prog);
    const bal = await tokenBal(botAta);
    if (bal > 0n) {
      const fAtaInfo = await conn.getAccountInfo(funderAta);
      // ATA funder'а оплачивает funder — бот может быть почти пуст по SOL
      if (!fAtaInfo) tx.add(spl.createAssociatedTokenAccountInstruction(funder.publicKey, funderAta, funder.publicKey, m, prog));
      tx.add(spl.createTransferCheckedInstruction(botAta, m, funderAta, botPk, bal, dec, [], prog));
      const ui = Number(bal) / 10 ** dec;
      amounts[key] += ui;
      moved.push(`${ui.toFixed(4)} ${sym}`);
    }
    const ataInfo = await conn.getAccountInfo(botAta);
    if (ataInfo) tx.add(spl.createCloseAccountInstruction(botAta, funder.publicKey, botPk, [], prog));
  }

  // fee платит funder → SOL бота выводим ПОЛНОСТЬЮ (нулевой аккаунт валиден,
  // а остаток < rent-exempt minimum (~0.00089 SOL) сеть отклонит)
  const sol = await conn.getBalance(botPk);
  if (sol > 0) {
    tx.add(SystemProgram.transfer({ fromPubkey: botPk, toPubkey: funder.publicKey, lamports: sol }));
    amounts.sol += sol / LAMPORTS_PER_SOL;
    moved.push(`${(sol / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  }
  if (tx.instructions.length === 0) return { moved: [], empty: true, amounts };
  tx.feePayer = funder.publicKey;
  const sig = await conn.sendTransaction(tx, [funder, botKp]);
  await conn.confirmTransaction(sig, 'confirmed');
  return { moved, sig, empty: false, amounts };
}

// ── равномерное распределение общих сумм на всех ботов ──
async function distributeTotals({ totalSol, totalQuote, totalToken }) {
  const pool = activePool();
  const wallets = loadWallets();
  const funder = keypairFrom(activeFunderEntry(wallets).secretKey);
  const bots = getBots(wallets);
  const n = bots.length;
  if (!n) throw new Error('нет ботов в ростере');
  const shareSol = totalSol / n, shareQuote = totalQuote / n, shareToken = totalToken / n;
  const quoteMint = new PublicKey(pool.quoteMint), mint = new PublicKey(pool.mint);
  const [quoteProg, mintProg] = await Promise.all([tokenProgramOf(pool.quoteMint), tokenProgramOf(pool.mint)]);
  const funderQAta = spl.getAssociatedTokenAddressSync(quoteMint, funder.publicKey, false, quoteProg);
  const funderTAta = spl.getAssociatedTokenAddressSync(mint, funder.publicKey, false, mintProg);

  // quote: если не хватает — докупаем через Jupiter (ExactIn с буфером 5%)
  const needQ = BigInt(Math.ceil(totalQuote * 10 ** pool.quoteDecimals));
  let funderQ = await tokenBal(funderQAta);
  if (funderQ < needQ) {
    const shortUi = totalQuote - Number(funderQ) / 10 ** pool.quoteDecimals;
    const probe = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${pool.quoteMint}&amount=10000000&slippageBps=150`)).json();
    const perSol = Number(probe.outAmount) / 10 ** pool.quoteDecimals / 0.01;
    const solNeed = shortUi / perSol * 1.05;
    const funderSol = (await conn.getBalance(funder.publicKey)) / LAMPORTS_PER_SOL;
    if (funderSol < solNeed + totalSol + 0.02) throw new Error(`мало SOL: нужно ~${(solNeed + totalSol).toFixed(3)}, есть ${funderSol.toFixed(3)}`);
    const r = await jupiterBuyQuote(funder, pool, Math.floor(solNeed * LAMPORTS_PER_SOL));
    ledger({ type: 'расход: конверсия', sol: -solNeed, quote: Number(r.out) / 10 ** pool.quoteDecimals, fee: TX_FEE, note: `SOL → ${pool.quoteSymbol} (для распределения)` });
    logAction(LA('jupiter', solNeed.toFixed(3), (r.out / 10 ** pool.quoteDecimals).toFixed(1), pool.quoteSymbol));
    funderQ = await tokenBal(funderQAta);
  }

  // торгуемый токен: нехватку докупаем SOL→token через Jupiter
  if (totalToken > 0) {
    let funderT = await tokenBal(funderTAta);
    const needT = BigInt(Math.ceil(totalToken * 10 ** pool.decimals));
    if (funderT < needT) {
      const shortUi = totalToken - Number(funderT) / 10 ** pool.decimals;
      const probe = await (await fetch(
        `https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${pool.mint}&amount=10000000&slippageBps=250`
      )).json();
      if (!probe.outAmount) throw new Error(`нет маршрута для докупки ${pool.mintSymbol}`);
      const perSol = Number(probe.outAmount) / 10 ** pool.decimals / 0.01;
      const solNeed = shortUi / perSol * 1.05;
      const funderSolNow = (await conn.getBalance(funder.publicKey)) / LAMPORTS_PER_SOL;
      if (funderSolNow < solNeed + totalSol + 0.02)
        throw new Error(`мало SOL для докупки ${pool.mintSymbol}: нужно ~${(solNeed + totalSol).toFixed(3)}, есть ${funderSolNow.toFixed(3)}`);
      const r = await jupiterBuyQuote(funder, pool, Math.floor(solNeed * LAMPORTS_PER_SOL), pool.mint);
      ledger({ type: 'расход: конверсия', sol: -solNeed, token: Number(r.out) / 10 ** pool.decimals, fee: TX_FEE, note: `SOL → ${pool.mintSymbol} (для распределения)` });
      logAction(LA('jupiter', solNeed.toFixed(3), (r.out / 10 ** pool.decimals).toFixed(1), pool.mintSymbol));
      funderT = await tokenBal(funderTAta);
      if (funderT < needT) throw new Error(`докупка ${pool.mintSymbol} не закрыла дефицит`);
    }
  }

  const funderSol = (await conn.getBalance(funder.publicKey)) / LAMPORTS_PER_SOL;
  if (funderSol < totalSol + 0.02) throw new Error(`у funder мало SOL: есть ${funderSol.toFixed(3)}, нужно ${totalSol} + запас`);

  let done = 0;
  for (const b of bots) {
    const botPk = new PublicKey(b.publicKey);
    const tx = new Transaction();
    let solSent = 0, qSent = 0, tSent = 0;

    const bal = (await conn.getBalance(botPk)) / LAMPORTS_PER_SOL;
    if (bal < shareSol - 0.0001) {
      solSent = shareSol - bal;
      tx.add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: botPk, lamports: Math.floor(solSent * LAMPORTS_PER_SOL) }));
    }
    for (const [m, prog, dec, fromAta, share] of [
      [quoteMint, quoteProg, pool.quoteDecimals, funderQAta, shareQuote],
      [mint, mintProg, pool.decimals, funderTAta, shareToken],
    ]) {
      if (share <= 0) continue;
      const botAta = spl.getAssociatedTokenAddressSync(m, botPk, false, prog);
      const info = await conn.getAccountInfo(botAta);
      if (!info) tx.add(spl.createAssociatedTokenAccountInstruction(funder.publicKey, botAta, botPk, m, prog));
      const cur = info ? await tokenBal(botAta) : 0n;
      const target = BigInt(Math.ceil(share * 10 ** dec));
      if (cur < target) {
        const amt = target - cur;
        tx.add(spl.createTransferCheckedInstruction(fromAta, m, botAta, funder.publicKey, amt, dec, [], prog));
        if (m.equals(quoteMint)) qSent = Number(amt) / 10 ** dec; else tSent = Number(amt) / 10 ** dec;
      }
    }
    if (tx.instructions.length === 0) continue;
    const sig = await conn.sendTransaction(tx, [funder]);
    await conn.confirmTransaction(sig, 'confirmed');
    ledger({ type: 'расход: распределение', sol: -solSent || null, quote: -qSent || null, token: -tSent || null, fee: TX_FEE, note: `bot ${b.index} ${short(b.publicKey)}` });
    done++;
    await sleep(400);
  }
  logAction(LA('distributed', done, n, totalSol, pool.quoteSymbol, totalQuote, pool.mintSymbol, totalToken));
  balCache.t = 0;
  return { ok: true, done, perBot: { sol: shareSol, quote: shareQuote, token: shareToken } };
}

// ── полный слив кошелька на произвольный адрес (удаление фандера) ──
async function drainWallet(srcKp, destPk) {
  const pool = activePool();
  const mint = new PublicKey(pool.mint), quote = new PublicKey(pool.quoteMint);
  const [mintProg, quoteProg] = await Promise.all([tokenProgramOf(pool.mint), tokenProgramOf(pool.quoteMint)]);
  const src = srcKp.publicKey;
  const tx = new Transaction();
  const moved = [];
  const amounts = { sol: 0, quote: 0, token: 0 };
  let ataCreations = 0;

  for (const [m, prog, dec, sym, key] of [[mint, mintProg, pool.decimals, pool.mintSymbol || 'TKN', 'token'], [quote, quoteProg, pool.quoteDecimals, pool.quoteSymbol || 'Q', 'quote']]) {
    const srcAta = spl.getAssociatedTokenAddressSync(m, src, false, prog);
    const destAta = spl.getAssociatedTokenAddressSync(m, destPk, false, prog);
    const bal = await tokenBal(srcAta);
    if (bal > 0n) {
      if (!(await conn.getAccountInfo(destAta))) {
        tx.add(spl.createAssociatedTokenAccountInstruction(src, destAta, destPk, m, prog));
        ataCreations++;
      }
      tx.add(spl.createTransferCheckedInstruction(srcAta, m, destAta, src, bal, dec, [], prog));
      const ui = Number(bal) / 10 ** dec;
      amounts[key] += ui;
      moved.push(`${ui.toFixed(4)} ${sym}`);
    }
    if (await conn.getAccountInfo(srcAta)) tx.add(spl.createCloseAccountInstruction(srcAta, destPk, src, [], prog));
  }

  const sol = await conn.getBalance(src);
  const ataRent = await conn.getMinimumBalanceForRentExemption(165);
  const reserve = 5000 + ataCreations * ataRent; // fee + рента за новые ATA (платит src)
  if (tx.instructions.length === 0 && sol === 0) return { moved: [], amounts, empty: true };
  if (sol < reserve) throw new Error(`на фандере ${(sol / 1e9).toFixed(4)} SOL — не покрывает fee+ренту (${(reserve / 1e9).toFixed(4)}). Докинь SOL на фандера или удали запись без перевода`);
  // сливаем в ноль: transfer = sol − reserve, после tx остаётся ровно 0
  const send = sol - reserve;
  if (send > 0) {
    tx.add(SystemProgram.transfer({ fromPubkey: src, toPubkey: destPk, lamports: send }));
    amounts.sol += send / 1e9;
    moved.push(`${(send / 1e9).toFixed(4)} SOL`);
  }
  tx.feePayer = src;
  const sig = await conn.sendTransaction(tx, [srcKp]);
  await conn.confirmTransaction(sig, 'confirmed');
  return { moved, sig, amounts, empty: false };
}

// ── USD-курсы (Dexscreener, раз в 60 сек) ──
let usdRates = { quote: null, token: null };
async function refreshUsdRates() {
  try {
    const pool = activePool();
    if (!pool?.quoteMint) return;
    const [q, t] = await Promise.all([
      fetch(`https://api.dexscreener.com/latest/dex/tokens/${pool.quoteMint}`).then((r) => r.json()),
      fetch(`https://api.dexscreener.com/latest/dex/tokens/${pool.mint}`).then((r) => r.json()),
    ]);
    usdRates = {
      quote: parseFloat(q?.pairs?.[0]?.priceUsd) || null,
      token: parseFloat(t?.pairs?.[0]?.priceUsd) || null,
    };
  } catch {}
}
setInterval(refreshUsdRates, 60000);
setTimeout(refreshUsdRates, 2500);

// ── сэмплер цены пула (для графика) ──
let raydiumRO = null;
async function getRaydiumRO() {
  if (!raydiumRO) {
    const { Raydium } = await import('@raydium-io/raydium-sdk-v2');
    raydiumRO = await Raydium.load({ connection: conn, owner: Keypair.generate(), cluster: CLUSTER === 'mainnet' ? 'mainnet' : 'devnet', disableFeatureCheck: true, disableLoadToken: true });
  }
  return raydiumRO;
}
let priceSeries = [];
try {
  priceSeries = fs.readFileSync('price_history.jsonl', 'utf8').trim().split('\n').slice(-1500).map(JSON.parse);
} catch {}
const lastPrice = () => (priceSeries.length ? priceSeries[priceSeries.length - 1].p : null);

async function samplePrice() {
  try {
    const pool = activePool();
    if (!pool?.poolId) return;
    const r = await getRaydiumRO();
    const { rpcData } = await r.cpmm.getPoolInfoFromRpc(pool.poolId);
    const aUi = Number(rpcData.baseReserve) / 10 ** rpcData.mintDecimalA;
    const bUi = Number(rpcData.quoteReserve) / 10 ** rpcData.mintDecimalB;
    const mintIsA = rpcData.mintA.toBase58() === pool.mint;
    const p = mintIsA ? bUi / aUi : aUi / bUi; // quote за 1 токен
    const point = { ts: Date.now(), p, usd: usdRates.quote ? p * usdRates.quote : null };
    priceSeries.push(point);
    if (priceSeries.length > 3000) priceSeries = priceSeries.slice(-2000);
    fs.appendFileSync('price_history.jsonl', JSON.stringify(point) + '\n');
  } catch {}
}
setInterval(samplePrice, 10000);
setTimeout(samplePrice, 1500);

// ── сессии ──
let session = null; // {id, startedAt, priceStart}
let solUsdCache = { t: 0, v: null };
async function solUsd() {
  if (Date.now() - solUsdCache.t < 60000 && solUsdCache.v) return solUsdCache.v;
  try {
    const r = await (await fetch('https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112')).json();
    const v = r?.['So11111111111111111111111111111111111111112']?.usdPrice;
    if (v) { solUsdCache = { t: Date.now(), v: parseFloat(v) }; return solUsdCache.v; }
  } catch {}
  return solUsdCache.v;
}
async function endSession(reason) {
  if (!session) return null;
  const st = readJson(`stats.${CLUSTER}.json`, {});
  const priceEnd = lastPrice();
  const solPrice = await solUsd();
  const estFeesSol = (st.swaps || 0) * 0.000015;
  const estFeesQuote = (st.volume || 0) * 0.0025;
  const s = {
    ...session, endedAt: Date.now(), reason,
    swaps: st.swaps || 0, buys: st.buys || 0, sells: st.sells || 0,
    volume: st.volume || 0, errors: st.errors || 0,
    estFeesQuote, estFeesSol,
    priceStart: session.priceStart, priceEnd,
    priceDeltaPct: session.priceStart && priceEnd ? ((priceEnd - session.priceStart) / session.priceStart) * 100 : null,
    volumeUsd: usdRates.quote ? (st.volume || 0) * usdRates.quote : null,
    solUsd: solPrice,
    estFeesUsd: (solPrice ? estFeesSol * solPrice : 0) + (usdRates.quote ? estFeesQuote * usdRates.quote : 0) || null,
  };
  const arr = readJson('sessions.json', []);
  arr.push(s);
  writeJson('sessions.json', arr.slice(-50));
  ledger({ type: 'сессия', note: `стоп (${reason}): ${s.swaps} свопов, объём ${s.volume.toFixed(1)}` });
  session = null;
  return s;
}

// ── watchdog флота ──
let stoppingIntentional = false;

// ── мьютекс длинных операций (deploy/sweep/fund/…) ──
let opBusy = null;
async function withOp(name, fn) {
  if (opBusy) throw new Error(`busy: operation «${opBusy}» in progress — wait for it to finish`);
  opBusy = name;
  try { return await fn(); } finally { opBusy = null; }
}

// ── продажа всех токенов кошелька в SOL (Jupiter) ──
async function jupiterSwapToSol(kp, inputMint, amountRaw, slippageBps = 250) {
  const q = await (await fetch(
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=So11111111111111111111111111111111111111112&amount=${amountRaw}&slippageBps=${slippageBps}`
  )).json();
  if (q.error || !q.outAmount) throw new Error(`Jupiter quote: ${q.error || 'no route'}`);
  const s = await (await fetch('https://lite-api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: kp.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
  })).json();
  const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, 'base64'));
  tx.sign([kp]);
  const sig = await conn.sendTransaction(tx, { maxRetries: 3 });
  await conn.confirmTransaction(sig, 'confirmed');
  return { sig, out: q.outAmount };
}

// ── deploy: % SOL funder'а в оборот (газ фиксом, остаток 70/30 quote/token) ──
async function deployCalc(pct) {
  const pool = activePool();
  const params = readJson('params.json', {});
  const gasPerBot = params.fundGas ?? 0.02;
  const wallets = loadWallets();
  const funder = keypairFrom(activeFunderEntry(wallets).secretKey);
  const bots = getBots(wallets);
  const n = bots.length;
  if (!n) throw new Error('нет ботов в ростере');
  const funderSol = (await conn.getBalance(funder.publicKey)) / LAMPORTS_PER_SOL;
  const budget = funderSol * pct / 100;
  const gasTotal = gasPerBot * n;
  const rest = budget - gasTotal;
  return { pool, funder, bots, n, funderSol, budget, gasPerBot, gasTotal, rest, solForQuote: Math.max(rest * 0.7, 0), solForToken: Math.max(rest * 0.3, 0) };
}

async function jupProbe(outMint, lamports, dec) {
  const q = await (await fetch(
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${outMint}&amount=${Math.max(Math.floor(lamports), 1)}&slippageBps=250`
  )).json();
  if (q.error || !q.outAmount) throw new Error(`Jupiter: ${q.error || 'no route'}`);
  return { out: Number(q.outAmount) / 10 ** dec, impact: parseFloat(q.priceImpactPct || '0') };
}

async function deployBudget(pct) {
  const { pool, funder, bots, n, budget, gasPerBot, gasTotal, rest, solForQuote, solForToken } = await deployCalc(pct);
  if (rest <= 0.005) throw new Error(`бюджет ${budget.toFixed(4)} SOL почти весь уйдёт на газ (${gasTotal.toFixed(3)}) — подними % или докинь SOL`);

  const quoteMint = new PublicKey(pool.quoteMint);
  const quoteProg = await tokenProgramOf(pool.quoteMint);
  const mint = new PublicKey(pool.mint);
  const mintProg = await tokenProgramOf(pool.mint);
  const funderQAta = spl.getAssociatedTokenAddressSync(quoteMint, funder.publicKey, false, quoteProg);
  const funderTAta = spl.getAssociatedTokenAddressSync(mint, funder.publicKey, false, mintProg);

  // конверсии SOL → quote / token
  let quoteUi = 0, tokenUi = 0, quoteImpact = 0, tokenImpact = 0;
  if (solForQuote > 0.001) {
    const r = await jupiterBuyQuote(funder, pool, Math.floor(solForQuote * LAMPORTS_PER_SOL), pool.quoteMint);
    quoteUi = Number(r.out) / 10 ** pool.quoteDecimals;
    const pr = await jupProbe(pool.quoteMint, solForQuote * LAMPORTS_PER_SOL, pool.quoteDecimals).catch(() => null);
    quoteImpact = pr?.impact || 0;
    ledger({ type: 'расход: конверсия', sol: -solForQuote, quote: quoteUi, fee: TX_FEE, note: `deploy → ${pool.quoteSymbol}` });
  }
  if (solForToken > 0.001) {
    const r = await jupiterBuyQuote(funder, pool, Math.floor(solForToken * LAMPORTS_PER_SOL), pool.mint);
    tokenUi = Number(r.out) / 10 ** pool.decimals;
    const pr = await jupProbe(pool.mint, solForToken * LAMPORTS_PER_SOL, pool.decimals).catch(() => null);
    tokenImpact = pr?.impact || 0;
    ledger({ type: 'расход: конверсия', sol: -solForToken, token: tokenUi, fee: TX_FEE, note: `deploy → ${pool.mintSymbol}` });
  }

  // раздача поровну (долив до равных долей)
  const shareQuote = quoteUi / n, shareToken = tokenUi / n;
  let done = 0;
  for (const b of bots) {
    const botPk = new PublicKey(b.publicKey);
    const tx = new Transaction();
    let solSent = 0, qSent = 0, tSent = 0;
    const bal = (await conn.getBalance(botPk)) / LAMPORTS_PER_SOL;
    if (bal < gasPerBot - 0.0001) {
      solSent = gasPerBot - bal;
      tx.add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: botPk, lamports: Math.floor(solSent * LAMPORTS_PER_SOL) }));
    }
    for (const [m, prog, dec, fromAta, share, kind] of [
      [quoteMint, quoteProg, pool.quoteDecimals, funderQAta, shareQuote, 'q'],
      [mint, mintProg, pool.decimals, funderTAta, shareToken, 't'],
    ]) {
      if (share <= 0) continue;
      const botAta = spl.getAssociatedTokenAddressSync(m, botPk, false, prog);
      const info = await conn.getAccountInfo(botAta);
      if (!info) tx.add(spl.createAssociatedTokenAccountInstruction(funder.publicKey, botAta, botPk, m, prog));
      const cur = info ? await tokenBal(botAta) : 0n;
      const target = BigInt(Math.ceil(share * 10 ** dec));
      if (cur < target) {
        const amt = target - cur;
        tx.add(spl.createTransferCheckedInstruction(fromAta, m, botAta, funder.publicKey, amt, dec, [], prog));
        if (kind === 'q') qSent = Number(amt) / 10 ** dec; else tSent = Number(amt) / 10 ** dec;
      }
    }
    if (!tx.instructions.length) continue;
    const sig = await conn.sendTransaction(tx, [funder]);
    await conn.confirmTransaction(sig, 'confirmed');
    ledger({ type: 'расход: распределение', sol: -solSent || null, quote: -qSent || null, token: -tSent || null, fee: TX_FEE, note: `bot ${b.index}` });
    done++;
    await sleep(400);
  }

  logAction(LA('deploy', pct, budget.toFixed(4), done));
  balCache.t = 0;
  return { ok: true, done, budget, perBot: { sol: gasPerBot, quote: shareQuote, token: shareToken }, quoteImpact, tokenImpact };
}

// ── HTTP ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (obj, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const body = async () => { let b = ''; for await (const c of req) b += c; try { return JSON.parse(b || '{}'); } catch { return {}; } };

  // CSRF-защита: POST только с localhost-оригинов (запросы без Origin — curl/скрипты — пропускаем)
  if (req.method === 'POST' && req.headers.origin) {
    let bad = true;
    try { bad = !['localhost', '127.0.0.1', '::1'].includes(new URL(req.headers.origin).hostname); } catch {}
    if (bad) return json({ ok: false, error: 'forbidden origin' }, 403);
  }

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync('dashboard.html', 'utf8'));
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return json({
        running: child !== null && !child.killed, pid: child?.pid ?? null, cluster: CLUSTER,
        stats: readJson(`stats.${CLUSTER}.json`, {}), params: readJson('params.json', {}),
        pool: activePool(), quoteUsd: usdRates.quote,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/lang') {
      const b = await body();
      PANEL_LANG = b.lang === 'ru' ? 'ru' : 'en';
      fs.writeFileSync('panel_lang.json', JSON.stringify({ lang: PANEL_LANG }));
      return json({ ok: true, lang: PANEL_LANG });
    }

    if (req.method === 'GET' && url.pathname === '/api/log') {
      const n = parseInt(url.searchParams.get('n') || '15');
      let lines = [];
      try { lines = fs.readFileSync(`swaps.${CLUSTER}.log`, 'utf8').trim().split('\n').slice(-n); } catch {}
      return json({ lines });
    }
    if (req.method === 'GET' && url.pathname === '/api/actions') {
      let lines = [];
      try { lines = fs.readFileSync('actions.log', 'utf8').trim().split('\n').slice(-10); } catch {}
      return json({ lines });
    }
    if (req.method === 'GET' && url.pathname === '/api/balances') return json(await balances());
    if (req.method === 'GET' && url.pathname === '/api/pools') {
      return json({ pools: readJson('pools.json', []), active: activePool() });
    }
    if (req.method === 'GET' && url.pathname === '/api/preflight') return json(await preflight());

    if (req.method === 'GET' && url.pathname === '/api/price') {
      // маркеры свопов из лога (строки с ISO-таймстампом)
      let swaps = [];
      try {
        swaps = fs.readFileSync(`swaps.${CLUSTER}.log`, 'utf8').trim().split('\n').slice(-400)
          .map((l) => {
            const m = l.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+)Z?\].*(BUY|SELL).*vol=([\d.]+)/);
            return m ? { ts: new Date(m[1] + 'Z').getTime(), side: m[2], vol: parseFloat(m[3]) } : null;
          }).filter(Boolean);
      } catch {}
      return json({ points: priceSeries.slice(-1500), swaps, price: lastPrice(), quoteSymbol: activePool()?.quoteSymbol, quoteUsd: usdRates.quote, tokenUsd: usdRates.token });
    }

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      return json({ sessions: readJson('sessions.json', []).slice(-10).reverse(), current: session });
    }

    // ── свечи для графика: Jupiter datapi (как у cypherdog) + фолбэк на локальную серию ──
    if (req.method === 'GET' && url.pathname === '/api/candles') {
      const IV = { '1m': '1_MINUTE', '5m': '5_MINUTE', '15m': '15_MINUTE', '1h': '1_HOUR', '4h': '4_HOUR', '1d': '1_DAY' };
      const iv = IV[url.searchParams.get('tf')] || '5_MINUTE';
      const pool = activePool();
      // reverse: график quote-токена в USD (CDOG/USD), иначе базовый токен (CYPH/USD)
      const chartMint = pool.reversed ? pool.quoteMint : pool.mint;
      const chartSymbol = pool.reversed ? pool.quoteSymbol : pool.mintSymbol;
      let candles = [], source = 'jup';
      try {
        const r = await fetch(`https://datapi.jup.ag/v2/charts/${chartMint}?interval=${iv}&type=price&candles=300&to=${Date.now()}`);
        const j = await r.json();
        candles = j.candles || [];
      } catch {}
      if (!candles.length) source = 'local';
      let swaps = [];
      try {
        swaps = fs.readFileSync(`swaps.${CLUSTER}.log`, 'utf8').trim().split('\n').slice(-400)
          .map((l) => {
            const m = l.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+)Z?\].*(BUY|SELL).*vol=([\d.]+)/);
            return m ? { ts: new Date(m[1] + 'Z').getTime(), side: m[2], vol: parseFloat(m[3]) } : null;
          }).filter(Boolean);
      } catch {}
      return json({
        source, candles, swaps,
        priceUsd: usdRates.token, quoteUsd: usdRates.quote,
        mintSymbol: pool.mintSymbol, quoteSymbol: pool.quoteSymbol,
        chartSymbol,
        reversed: !!pool.reversed,
        local: priceSeries.slice(-1500),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/ledger') {
      let entries = [];
      try { entries = fs.readFileSync('ledger.jsonl', 'utf8').trim().split('\n').map(JSON.parse); } catch {}
      const totals = { solIn: 0, solOut: 0, quoteIn: 0, quoteOut: 0, fees: 0 };
      for (const e of entries) {
        if (e.sol) e.sol > 0 ? totals.solIn += e.sol : totals.solOut += -e.sol;
        if (e.quote) e.quote > 0 ? totals.quoteIn += e.quote : totals.quoteOut += -e.quote;
        if (e.fee) totals.fees += Math.abs(e.fee);
      }
      return json({ entries: entries.slice(-30).reverse(), totals });
    }

    if (req.method === 'POST' && url.pathname === '/api/params') {
      const next = { ...readJson('params.json', {}), ...(await body()) };
      writeJson('params.json', next);
      return json({ ok: true, params: next });
    }

    if (req.method === 'POST' && url.pathname === '/api/pools/select') {
      const { poolId } = await body();
      const p = readJson('pools.json', []).find((x) => x.poolId === poolId);
      if (!p) return json({ ok: false, error: 'пул не найден в реестре' }, 404);
      writeJson(POOLFILE, p);
      logAction(LA('poolSelected', p.name, short(poolId)));
      balCache.t = 0; // балансы перечитать немедленно под новый пул
      let restarted = false;
      if (child && !child.killed) {
        stoppingIntentional = true;
        await endSession('смена пула');
        child.kill('SIGTERM'); await sleep(1500);
        restarted = true;
        await startFleet();
      }
      return json({ ok: true, restarted });
    }

    if (req.method === 'POST' && url.pathname === '/api/pools/add') {
      const { poolId } = await body();
      const { Raydium } = await import('@raydium-io/raydium-sdk-v2');
      const r = await Raydium.load({ connection: conn, owner: Keypair.generate(), cluster: CLUSTER === 'mainnet' ? 'mainnet' : 'devnet', disableFeatureCheck: true, disableLoadToken: true });
      const { poolInfo } = await r.cpmm.getPoolInfoFromRpc(poolId);
      const isWsolA = poolInfo.mintA.address === 'So11111111111111111111111111111111111111112';
      const quoteI = isWsolA ? poolInfo.mintA : poolInfo.mintA; // эвристика: mintA = quote
      const tokenI = isWsolA ? poolInfo.mintB : poolInfo.mintB;

      // резолв тикеров: Dexscreener pairs API по адресу пула (base/quote символы)
      let mintSym = short(tokenI.address), quoteSym = short(quoteI.address), pairName = null;
      try {
        const dj = await (await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${poolId}`)).json();
        const pair = dj?.pairs?.[0] || dj?.pair;
        if (pair) {
          const byAddr = {};
          for (const t of [pair.baseToken, pair.quoteToken]) if (t?.address) byAddr[t.address] = t.symbol;
          mintSym = byAddr[tokenI.address] || mintSym;
          quoteSym = byAddr[quoteI.address] || quoteSym;
          pairName = `${mintSym}/${quoteSym}`;
        }
      } catch {}

      const entry = {
        name: pairName || `${mintSym}/${quoteSym}`,
        poolId,
        mint: tokenI.address, mintSymbol: mintSym,
        quoteMint: quoteI.address, quoteSymbol: quoteSym,
        decimals: tokenI.decimals, quoteDecimals: quoteI.decimals,
      };
      const pools = readJson('pools.json', []);
      if (!pools.find((x) => x.poolId === poolId)) { pools.push(entry); writeJson('pools.json', pools); }
      logAction(LA('poolAdded', entry.name));
      return json({ ok: true, pool: entry });
    }

    if (req.method === 'POST' && url.pathname === '/api/pools/remove') {
      const { poolId } = await body();
      const pools = readJson('pools.json', []);
      const p = pools.find((x) => x.poolId === poolId);
      if (!p) return json({ ok: false, error: 'не найден' }, 404);
      if (activePool()?.poolId === poolId)
        return json({ ok: false, error: 'активную пару удалить нельзя — переключи на другую' }, 409);
      writeJson('pools.json', pools.filter((x) => x.poolId !== poolId));
      logAction(LA('poolRemoved', p.name));
      return json({ ok: true });
    }

    // обновить метаданные пары (тикеры/имя) с Dexscreener
    if (req.method === 'POST' && url.pathname === '/api/pools/refresh') {
      const { poolId } = await body();
      const pools = readJson('pools.json', []);
      const i = pools.findIndex((x) => x.poolId === poolId);
      if (i === -1) return json({ ok: false, error: 'не найден' }, 404);
      const entry = pools[i];
      try {
        const dj = await (await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${poolId}`)).json();
        const pair = dj?.pairs?.[0] || dj?.pair;
        if (!pair) return json({ ok: false, error: 'Dexscreener не знает пару' }, 404);
        const byAddr = {};
        for (const t of [pair.baseToken, pair.quoteToken]) if (t?.address) byAddr[t.address] = t.symbol;
        entry.mintSymbol = byAddr[entry.mint] || entry.mintSymbol;
        entry.quoteSymbol = byAddr[entry.quoteMint] || entry.quoteSymbol;
        entry.name = `${entry.mintSymbol}/${entry.quoteSymbol}`;
      } catch (e) { return json({ ok: false, error: String(e?.message ?? e).slice(0, 100) }, 500); }
      pools[i] = entry;
      writeJson('pools.json', pools);
      if (activePool()?.poolId === poolId) writeJson(POOLFILE, entry);
      logAction(LA('poolRefreshed', entry.name));
      balCache.t = 0;
      return json({ ok: true, pool: entry });
    }

    // reverse: инверсия отображения пары (STIV/$ ⇄ обратная котировка)
    if (req.method === 'POST' && url.pathname === '/api/pools/reverse') {
      const { poolId } = await body();
      const pools = readJson('pools.json', []);
      const i = pools.findIndex((x) => x.poolId === poolId);
      if (i === -1) return json({ ok: false, error: 'не найден' }, 404);
      pools[i].reversed = !pools[i].reversed;
      writeJson('pools.json', pools);
      if (activePool()?.poolId === poolId) writeJson(POOLFILE, pools[i]);
      logAction(LA('poolReverse', pools[i].name, pools[i].reversed));
      return json({ ok: true, reversed: pools[i].reversed, pool: pools[i] });
    }

    if (req.method === 'POST' && url.pathname === '/api/fund') return json(await withOp('fund', fundBots));

    // ── мульти-фандеры ──
    if (req.method === 'POST' && url.pathname === '/api/funders/add') {
      const b = await body();
      const w = loadWallets();
      let kp;
      if (b.secretKey) {
        try {
          const bs58 = (await import('bs58')).default;
          const raw = bs58.decode(b.secretKey.trim());
          if (raw.length !== 64) throw new Error('нужно 64 байта, получено ' + raw.length);
          kp = Keypair.fromSecretKey(raw);
        } catch (e) { return json({ ok: false, error: 'ключ не читается: ' + String(e?.message ?? e).slice(0, 80) }, 400); }
        if (getFunders(w).find((x) => x.publicKey === kp.publicKey.toBase58()))
          return json({ ok: false, error: 'такой фандер уже есть' }, 409);
      } else kp = Keypair.generate();
      const entry = {
        role: 'funder',
        name: (b.name || '').trim() || 'funder-' + kp.publicKey.toBase58().slice(0, 4),
        publicKey: kp.publicKey.toBase58(),
        secretKey: Buffer.from(kp.secretKey).toString('base64'),
        active: false,
      };
      w.push(entry);
      saveWallets(w);
      logAction(LA('funderAdded', entry.name, short(entry.publicKey)));
      balCache.t = 0;
      return json({
        ok: true, name: entry.name, publicKey: entry.publicKey,
        generatedSecret: b.secretKey ? undefined : (await import('bs58')).default.encode(Buffer.from(kp.secretKey)),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/funders/activate') {
      const { publicKey } = await body();
      const w = loadWallets();
      const f = getFunders(w).find((x) => x.publicKey === publicKey);
      if (!f) return json({ ok: false, error: 'не найден' }, 404);
      for (const x of w) if (x.role === 'funder') x.active = x.publicKey === publicKey;
      saveWallets(w);
      logAction(LA('funderActive', f.name, short(publicKey)));
      balCache.t = 0;
      return json({ ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/funders/remove') return json(await withOp('funder-remove', async () => {
      const { publicKey, destination } = await body();
      const w = loadWallets();
      const i = w.findIndex((x) => x.role === 'funder' && x.publicKey === publicKey);
      if (i === -1) return json({ ok: false, error: 'не найден' }, 404);
      if (w[i].active) return json({ ok: false, error: 'активного фандера удалить нельзя — переключи активного' }, 409);
      let dest;
      try { dest = new PublicKey(destination); } catch { return json({ ok: false, error: 'кривой адрес получателя' }, 400); }
      const name = w[i].name;
      const r = await drainWallet(keypairFrom(w[i].secretKey), dest);
      w.splice(i, 1);
      saveWallets(w);
      logAction(LA('funderRemoved', name, short(destination), r.moved.join(', ')));
      if (!r.empty) ledger({ type: 'доход: вывод фандера', sol: r.amounts.sol || null, quote: r.amounts.quote || null, token: r.amounts.token || null, fee: TX_FEE, note: `${name} → ${short(destination)}` });
      balCache.t = 0;
      return json({ ok: true, ...r });
    }));

    // ── Helius RPC: реестр ключей ──
    if (req.method === 'GET' && url.pathname === '/api/rpc') {
      return json({
        keys: (readRpcKeys() || []).map((k) => ({ name: k.name, masked: maskKey(k.key), active: !!k.active })),
        cluster: CLUSTER,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/rpc/test') {
      const key = ((await body()).key || '').trim();
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(key))
        return json({ ok: false, error: 'не похоже на UUID-ключ Helius' }, 400);
      const t0 = Date.now();
      try {
        await new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, 'confirmed').getVersion();
      } catch (e) { return json({ ok: false, error: 'ключ не работает: ' + String(e?.message ?? e).slice(0, 120) }, 400); }
      return json({ ok: true, latency: Date.now() - t0 });
    }

    if (req.method === 'POST' && url.pathname === '/api/rpc/add') {
      const b = await body();
      const key = (b.key || '').trim();
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(key))
        return json({ ok: false, error: 'не похоже на UUID-ключ Helius' }, 400);
      const keys = readRpcKeys() || [];
      if (keys.find((k) => k.key === key)) return json({ ok: false, error: 'такой ключ уже есть' }, 409);
      const entry = { name: (b.name || '').trim() || 'key-' + key.slice(0, 4), key, active: keys.length === 0, addedAt: Date.now() };
      keys.push(entry);
      writeRpcKeys(keys);
      logAction(LA('rpcAdded', entry.name, maskKey(key)));
      if (entry.active) applyRpcKey(key);
      return json({ ok: true, name: entry.name });
    }

    if (req.method === 'POST' && url.pathname === '/api/rpc/activate') {
      const { name } = await body();
      const keys = readRpcKeys() || [];
      const f = keys.find((k) => k.name === name);
      if (!f) return json({ ok: false, error: 'не найден' }, 404);
      for (const k of keys) k.active = k.name === name;
      writeRpcKeys(keys);
      applyRpcKey(f.key);
      logAction(LA('rpcActive', name));
      return json({ ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/rpc/remove') {
      const { name } = await body();
      let keys = readRpcKeys() || [];
      const f = keys.find((k) => k.name === name);
      if (!f) return json({ ok: false, error: 'не найден' }, 404);
      if (f.active) return json({ ok: false, error: 'активный ключ удалить нельзя' }, 409);
      keys = keys.filter((k) => k.name !== name);
      writeRpcKeys(keys);
      logAction(LA('rpcRemoved', name));
      return json({ ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/funders/sellall') return json(await withOp('sellall', async () => {
      const { publicKey } = await body();
      const w = loadWallets();
      const entry = getFunders(w).find((x) => x.publicKey === publicKey);
      if (!entry) return json({ ok: false, error: 'не найден' }, 404);
      const kp = keypairFrom(entry.secretKey);
      const pool = activePool();

      // все токен-аккаунты кошелька (legacy + Token-2022), parsed — сразу mint/amount/decimals
      const accs = [];
      for (const prog of [spl.TOKEN_PROGRAM_ID, spl.TOKEN_2022_PROGRAM_ID]) {
        try {
          const r = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { programId: prog });
          for (const a of r.value) {
            const info = a.account.data.parsed.info;
            const amount = BigInt(info.tokenAmount.amount);
            if (amount > 0n) accs.push({ ata: a.pubkey, mint: info.mint, amount, dec: info.tokenAmount.decimals, prog });
          }
        } catch {}
      }

      const results = [], skipped = [];
      let solTotal = 0;
      for (const a of accs) {
        const ui = Number(a.amount) / 10 ** a.dec;
        let sym = a.mint === pool.mint ? pool.mintSymbol : a.mint === pool.quoteMint ? pool.quoteSymbol : short(a.mint);
        try {
          const r = await jupiterSwapToSol(kp, a.mint, a.amount.toString());
          const solOut = Number(r.out) / LAMPORTS_PER_SOL;
          solTotal += solOut;
          results.push(`${ui.toFixed(2)} ${sym} → ${solOut.toFixed(4)} SOL`);
          ledger({ type: 'расход: продажа в SOL', sol: solOut, fee: TX_FEE, note: `sell all ${entry.name}: ${ui.toFixed(2)} ${sym}` });
        } catch (e) {
          skipped.push(`${sym} (${String(e?.message ?? e).slice(0, 40)})`);
        }
        // закрыть пустой ATA → рента в SOL
        try {
          const nowBal = await tokenBal(a.ata);
          if (nowBal === 0n) {
            const closeTx = new Transaction().add(spl.createCloseAccountInstruction(a.ata, kp.publicKey, kp.publicKey, [], a.prog));
            closeTx.feePayer = kp.publicKey;
            const csig = await conn.sendTransaction(closeTx, [kp]);
            await conn.confirmTransaction(csig, 'confirmed');
          }
        } catch {}
      }
      if (!results.length && !skipped.length) return json({ ok: false, error: 'нечего продавать — токенов нет' }, 400);
      logAction(LA('sellAll', entry.name, results.join(' + ') || '—'));
      balCache.t = 0;
      return json({ ok: true, results, skipped, solTotal });
    }));

    if (req.method === 'GET' && url.pathname === '/api/deploy/preview') {
      const pct = parseFloat(url.searchParams.get('pct')) || 50;
      const c = await deployCalc(pct);
      const out = { budget: c.budget, gasPerBot: c.gasPerBot, gasTotal: c.gasTotal, rest: c.rest, n: c.n, ok: c.rest > 0.005 };
      if (out.ok) {
        const [pq, pt] = await Promise.all([
          jupProbe(c.pool.quoteMint, c.solForQuote * LAMPORTS_PER_SOL, c.pool.quoteDecimals).catch((e) => ({ error: String(e?.message ?? e).slice(0, 60) })),
          jupProbe(c.pool.mint, c.solForToken * LAMPORTS_PER_SOL, c.pool.decimals).catch((e) => ({ error: String(e?.message ?? e).slice(0, 60) })),
        ]);
        out.quote = pq; out.token = pt;
        out.perBot = { sol: c.gasPerBot, quote: (pq.out || 0) / c.n, token: (pt.out || 0) / c.n };
      }
      return json(out);
    }

    if (req.method === 'POST' && url.pathname === '/api/deploy') return json(await withOp('deploy', async () => {
      const b = await body();
      return json(await deployBudget(parseFloat(b.pct) || 0));
    }));

    if (req.method === 'POST' && url.pathname === '/api/exportkey') {
      const { address } = await body();
      const w = loadWallets();
      const entry = w.find((x) => x.publicKey === address);
      if (!entry) return json({ ok: false, error: 'не найден' }, 404);
      const bs58 = (await import('bs58')).default;
      logAction(LA('exportKey', `${entry.role} ${short(address)}`));
      return json({ ok: true, secret: bs58.encode(Buffer.from(entry.secretKey, 'base64')) });
    }

    if (req.method === 'POST' && url.pathname === '/api/distribute') return json(await withOp('distribute', async () => {
      const b = await body();
      return json(await distributeTotals({
        totalSol: parseFloat(b.totalSol) || 0,
        totalQuote: parseFloat(b.totalQuote) || 0,
        totalToken: parseFloat(b.totalToken) || 0,
      }));
    }));

    if (req.method === 'POST' && url.pathname === '/api/bots/add') {
      const wallets = loadWallets();
      const kp = Keypair.generate();
      const maxIdx = Math.max(-1, ...getBots(wallets).map((b) => b.index));
      wallets.push({ role: 'bot', index: maxIdx + 1, publicKey: kp.publicKey.toBase58(), secretKey: Buffer.from(kp.secretKey).toString('base64') });
      saveWallets(wallets);
      logAction(LA('botAdded', maxIdx + 1, short(kp.publicKey.toBase58())));
      balCache.t = 0;
      return json({ ok: true, index: maxIdx + 1, publicKey: kp.publicKey.toBase58() });
    }

    if (req.method === 'POST' && url.pathname === '/api/bots/remove') return json(await withOp('bot-remove', async () => {
      const { index } = await body();
      const wallets = loadWallets();
      const i = wallets.findIndex((x) => x.role === 'bot' && x.index === index);
      if (i === -1) return json({ ok: false, error: 'не найден' }, 404);
      const pool = activePool();
      const [mintProg, quoteProg] = await Promise.all([tokenProgramOf(pool.mint), tokenProgramOf(pool.quoteMint)]);
      const funder = keypairFrom(activeFunderEntry(wallets).secretKey);
      const botKp = keypairFrom(wallets[i].secretKey);
      const r = await sweepWallet(botKp, index, funder, pool, mintProg, quoteProg);
      wallets.splice(i, 1);
      saveWallets(wallets);
      logAction(LA('botRemoved', index, r.moved.join(', ')));
      if (!r.empty) ledger({ type: 'доход: сбор (удаление)', sol: r.amounts.sol || null, quote: r.amounts.quote || null, token: r.amounts.token || null, fee: TX_FEE, note: `bot ${index}` });
      balCache.t = 0;
      return json({ ok: true, ...r });
    }));

    if (req.method === 'POST' && url.pathname === '/api/sweep') return json(await withOp('sweep', async () => {
      if (child && !child.killed) {
        stoppingIntentional = true;
        await endSession('sweep');
        child.kill('SIGTERM');
        await sleep(2000);
        logAction(LA('fleetStoppedForSweep'));
      }
      const pool = activePool();
      const [mintProg, quoteProg] = await Promise.all([tokenProgramOf(pool.mint), tokenProgramOf(pool.quoteMint)]);
      const wallets = loadWallets();
      const funder = keypairFrom(activeFunderEntry(wallets).secretKey);
      const results = [];
      for (const b of getBots(wallets)) {
        try {
          const r = await sweepWallet(keypairFrom(b.secretKey), b.index, funder, pool, mintProg, quoteProg);
          if (!r.empty) {
            results.push(`bot ${b.index}: ${r.moved.join(', ')}`);
            ledger({ type: 'доход: сбор', sol: r.amounts.sol || null, quote: r.amounts.quote || null, token: r.amounts.token || null, fee: TX_FEE, note: `bot ${b.index}` });
          }
          await sleep(400);
        } catch (e) { results.push(`bot ${b.index}: ошибка ${String(e?.message ?? e).slice(0, 60)}`); }
      }
      logAction(LA('sweepDone', results.length));
      balCache.t = 0;
      return json({ ok: true, results });
    }));

    if (req.method === 'POST' && url.pathname === '/api/start') {
      if (child && !child.killed) return json({ ok: false, error: 'уже запущен' }, 409);
      const b = await body();
      if (!b.force) {
        const pf = await preflight();
        if (!pf.ready) return json({ ok: false, error: 'preflight не пройден', checks: pf.checks }, 409);
      }
      return json(await startFleet());
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
      if (!child || child.killed) return json({ ok: false, error: 'не запущен' }, 409);
      stoppingIntentional = true;
      const s = await endSession('кнопка');
      child.kill('SIGTERM');
      setTimeout(() => { try { child?.kill('SIGKILL'); } catch {} }, 3000);
      logAction(LA('fleetStopped'));
      ledger({ type: 'сессия', note: 'стоп из панели' });
      return json({ ok: true, session: s });
    }

    json({ error: 'not found' }, 404);
  } catch (e) {
    json({ ok: false, error: String(e?.message ?? e).slice(0, 300) }, 500);
  }
});

async function startFleet() {
  const nBots = getBots(loadWallets()).length;
  stoppingIntentional = false;
  child = spawn('node', ['4_fleet.mjs'], {
    env: { ...process.env, CLUSTER, BOTS: String(nBots) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = fs.createWriteStream('fleet_console.log', { flags: 'a' });
  child.stdout.pipe(out); child.stderr.pipe(out);
  session = { id: Date.now(), startedAt: Date.now(), priceStart: lastPrice() };
  child.on('exit', () => {
    const wasIntentional = stoppingIntentional;
    child = null;
    if (!wasIntentional) {
      const stopReason = readJson(`stats.${CLUSTER}.json`, {}).stopReason;
      if (stopReason === 'low_gas') {
        logAction(LA('lowGasStop'));
        endSession('low_gas');
      } else if (readJson('params.json', {}).watchdog) {
        logAction(LA('watchdogRestart'));
        setTimeout(() => startFleet(), 3000);
      } else {
        logAction(LA('fleetExited'));
        endSession('crash');
      }
    }
  });
  logAction(LA('fleetStarted', child.pid, nBots));
  ledger({ type: 'сессия', note: `старт, pid ${child.pid}, ботов ${nBots}` });
  return { ok: true, pid: child.pid, bots: nBots };
}

server.listen(PORT, process.env.BIND_HOST || '127.0.0.1', () => console.log(`Панель: http://localhost:${PORT}`));
