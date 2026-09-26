// Мейннет-фандинг ботов под STIV/STONK:
// 1) конвертит часть SOL funder'а в STONK через Jupiter
// 2) раздаёт каждому боту газ (SOL) + торговый капитал (STONK)
// Идемпотентный top-up. Ручки: BOTS GAS_PER_BOT STONK_PER_BOT CONVERT_SOL
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { conn, loadWallets, loadPool, keypairFrom, getFunder, getBots, sleep, solscan } from './lib.mjs';

const GAS_PER_BOT = parseFloat(process.env.GAS_PER_BOT || '0.02');
const STONK_PER_BOT = parseFloat(process.env.STONK_PER_BOT || '15');
const CONVERT_SOL = parseFloat(process.env.CONVERT_SOL || '0.35');
const N_BOTS = parseInt(process.env.BOTS || '6');

const pool = loadPool(); // pool.mainnet.json при CLUSTER=mainnet
const quoteMint = new PublicKey(pool.quoteMint);
const wallets = loadWallets();
const funder = keypairFrom(getFunder(wallets).secretKey);
const bots = getBots(wallets).slice(0, N_BOTS);

const solBal = (await conn.getBalance(funder.publicKey)) / LAMPORTS_PER_SOL;
const need = CONVERT_SOL + GAS_PER_BOT * bots.length + 0.05;
console.log(`Funder: ${solBal.toFixed(4)} SOL | нужно ~${need.toFixed(3)} (${CONVERT_SOL} конверсия + ${GAS_PER_BOT}×${bots.length} газ)`);
if (solBal < need) {
  console.error('Не хватает SOL на funder. Докинь и перезапусти.');
  process.exit(1);
}

// Программа quote-минта (Token vs Token-2022) — для ATA и transferChecked
const quoteProgram = (await conn.getAccountInfo(quoteMint)).owner;
const funderAta = getAssociatedTokenAddressSync(quoteMint, funder.publicKey, false, quoteProgram);

// Чтение баланса токена с ретраями (RPC может отставать на 1-2 слота после tx)
async function tokenBal(ata, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try { return BigInt((await conn.getTokenAccountBalance(ata)).value.amount); }
    catch { if (i < tries - 1) await sleep(2000); }
  }
  return 0n;
}

// ── 1. Jupiter: SOL → STONK ──
async function jupiterSwapSolToQuote(lamports) {
  const q = await (await fetch(
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${quoteMint.toBase58()}&amount=${lamports}&slippageBps=150`
  )).json();
  if (q.error || !q.outAmount) throw new Error(`Jupiter quote: ${q.error || 'no route'}`);
  const s = await (await fetch('https://lite-api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: q,
      userPublicKey: funder.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  })).json();
  const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, 'base64'));
  tx.sign([funder]);
  const sig = await conn.sendTransaction(tx, { maxRetries: 3 });
  await conn.confirmTransaction(sig, 'confirmed');
  return { sig, out: q.outAmount };
}

let funderQuote = await tokenBal(funderAta);
const needQuote = BigInt(Math.ceil(STONK_PER_BOT * bots.length * 10 ** pool.quoteDecimals));

if (funderQuote < needQuote) {
  console.log(`Конвертирую ${CONVERT_SOL} SOL → ${pool.quoteSymbol} через Jupiter...`);
  const { sig, out } = await jupiterSwapSolToQuote(Math.floor(CONVERT_SOL * LAMPORTS_PER_SOL));
  console.log(`Куплено ~${Number(out) / 10 ** pool.quoteDecimals} ${pool.quoteSymbol}: ${solscan(sig)}`);
  funderQuote = await tokenBal(funderAta);
} else {
  console.log(`На funder уже есть ${Number(funderQuote) / 10 ** pool.quoteDecimals} ${pool.quoteSymbol} — конверсия не нужна`);
}

// ── 2. Раздача ботам: газ + STONK ──
let funded = 0;
for (const b of bots) {
  const botPk = new PublicKey(b.publicKey);
  const tx = new Transaction();
  const actions = [];

  const bal = (await conn.getBalance(botPk)) / LAMPORTS_PER_SOL;
  if (bal < GAS_PER_BOT - 0.001) {
    tx.add(SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: botPk,
      lamports: Math.floor((GAS_PER_BOT - bal) * LAMPORTS_PER_SOL),
    }));
    actions.push(`+${(GAS_PER_BOT - bal).toFixed(3)} SOL`);
  }

  const botAta = getAssociatedTokenAddressSync(quoteMint, botPk, false, quoteProgram);
  let botQuote = 0n;
  const ataInfo = await conn.getAccountInfo(botAta);
  if (!ataInfo) {
    tx.add(createAssociatedTokenAccountInstruction(funder.publicKey, botAta, botPk, quoteMint, quoteProgram));
    actions.push('ATA');
  } else {
    botQuote = BigInt((await conn.getTokenAccountBalance(botAta)).value.amount);
  }
  const target = BigInt(Math.ceil(STONK_PER_BOT * 10 ** pool.quoteDecimals));
  if (botQuote < target) {
    tx.add(createTransferCheckedInstruction(funderAta, quoteMint, botAta, funder.publicKey, target - botQuote, pool.quoteDecimals, quoteProgram));
    actions.push(`+${Number(target - botQuote) / 10 ** pool.quoteDecimals} ${pool.quoteSymbol}`);
  }

  if (tx.instructions.length === 0) {
    console.log(`[bot ${b.index}] ок, пропуск`);
    continue;
  }
  try {
    const sig = await conn.sendTransaction(tx, [funder]);
    await conn.confirmTransaction(sig, 'confirmed');
    funded++;
    console.log(`[bot ${b.index}] ${actions.join(' ')} → ${solscan(sig)}`);
  } catch (e) {
    console.log(`[bot ${b.index}] ошибка: ${String(e?.message ?? e).slice(0, 120)}`);
  }
  await sleep(500);
}

const restQuote = await tokenBal(funderAta);
console.log(`\nГотово: ${funded} ботов профинансировано. Остаток funder: ${((await conn.getBalance(funder.publicKey)) / LAMPORTS_PER_SOL).toFixed(4)} SOL, ${Number(restQuote) / 10 ** pool.quoteDecimals} ${pool.quoteSymbol}`);
