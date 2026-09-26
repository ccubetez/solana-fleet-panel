// Рассылка SOL + токенов ботам с фанд-кошелька перед торговлей.
// Идемпотентный: досылает только недостающее (top-up), можно запускать повторно.
// Ручки: SOL_PER_BOT=0.03 TOKENS_PER_BOT=2000 node fund_bots.mjs
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  conn, loadWallets, saveWallets, loadPool, keypairFrom,
  getMaster, getFunder, getBots, sleep, solscan,
} from './lib.mjs';

const SOL_PER_BOT = parseFloat(process.env.SOL_PER_BOT || '0.03');
const TOKENS_PER_BOT = parseFloat(process.env.TOKENS_PER_BOT || '2000');

// ── 0. Funder существует? Если нет — создаём и вставляем после master ──
let wallets = loadWallets();
if (!getFunder(wallets)) {
  const kp = Keypair.generate();
  wallets.splice(1, 0, {
    role: 'funder',
    publicKey: kp.publicKey.toBase58(),
    secretKey: Buffer.from(kp.secretKey).toString('base64'),
  });
  saveWallets(wallets);
  console.log(`Создан funder: ${kp.publicKey.toBase58()}`);
}

const master = keypairFrom(getMaster(wallets).secretKey);
const funder = keypairFrom(getFunder(wallets).secretKey);
const bots = getBots(wallets);
const pool = loadPool();
const mintPk = new PublicKey(pool.mint);
const DECIMALS = pool.decimals;

const needSol = bots.length * SOL_PER_BOT + 0.02;          // +запас на комиссии рассылок
const needTokens = BigInt(bots.length) * BigInt(Math.floor(TOKENS_PER_BOT)) * BigInt(10 ** DECIMALS);

// ── 1. SOL на funder: если не хватает — аирдроп (devnet) ──
let funderSol = (await conn.getBalance(funder.publicKey)) / LAMPORTS_PER_SOL;
console.log(`Funder: ${funderSol.toFixed(3)} SOL, нужно ~${needSol.toFixed(3)}`);
let attempts = 0;
while (funderSol < needSol && attempts < 5) {
  attempts++;
  try {
    const sig = await conn.requestAirdrop(funder.publicKey, 1 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
    console.log(`Airdrop +1 SOL на funder`);
  } catch (e) {
    console.log(`Airdrop отклонён (кулдаун крана), жду 30s...`);
    await sleep(30000);
  }
  funderSol = (await conn.getBalance(funder.publicKey)) / LAMPORTS_PER_SOL;
}
if (funderSol < needSol) {
  console.log(`⚠️  SOL хватит не на всех: есть ${funderSol.toFixed(3)}, разошлю что есть пропорционально`);
}

// ── 2. Токены на funder: если не хватает — тянем с master ──
const funderAta = getAssociatedTokenAddressSync(mintPk, funder.publicKey);
const masterAta = getAssociatedTokenAddressSync(mintPk, master.publicKey);

let funderTokens = 0n;
try { funderTokens = BigInt((await conn.getTokenAccountBalance(funderAta)).value.amount); } catch {}
console.log(`Funder tokens: ${funderTokens}, нужно ${needTokens}`);

if (funderTokens < needTokens) {
  const deficit = needTokens - funderTokens;
  const masterTokens = BigInt((await conn.getTokenAccountBalance(masterAta)).value.amount);
  const pull = deficit > masterTokens ? masterTokens : deficit;
  if (pull === 0n) throw new Error('У master нет токенов для пополнения funder');

  const tx = new Transaction();
  const funderAtaInfo = await conn.getAccountInfo(funderAta);
  if (!funderAtaInfo) {
    tx.add(createAssociatedTokenAccountInstruction(master.publicKey, funderAta, funder.publicKey, mintPk));
  }
  tx.add(createTransferCheckedInstruction(masterAta, mintPk, funderAta, master.publicKey, pull, DECIMALS));
  const sig = await conn.sendTransaction(tx, [master]);
  await conn.confirmTransaction(sig, 'confirmed');
  console.log(`Переведено с master → funder: ${Number(pull) / 10 ** DECIMALS} токенов (${solscan(sig)})`);
}

// ── 3. Рассылка ботам: SOL-дефицит + токен-дефицит, по одной tx на бота ──
const perBotSol = Math.min(SOL_PER_BOT, (funderSol - 0.01) / bots.length);
let funded = 0;

for (const b of bots) {
  const botPk = new PublicKey(b.publicKey);
  const tx = new Transaction();
  let actions = [];

  // SOL top-up
  const bal = (await conn.getBalance(botPk)) / LAMPORTS_PER_SOL;
  const solDeficit = perBotSol - bal;
  if (solDeficit > 0.001) {
    tx.add(SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: botPk,
      lamports: Math.floor(solDeficit * LAMPORTS_PER_SOL),
    }));
    actions.push(`+${solDeficit.toFixed(3)} SOL`);
  }

  // Token top-up (создаём ATA если нет — платит funder)
  const botAta = getAssociatedTokenAddressSync(mintPk, botPk);
  let tokenBal = 0n;
  const ataInfo = await conn.getAccountInfo(botAta);
  if (!ataInfo) {
    tx.add(createAssociatedTokenAccountInstruction(funder.publicKey, botAta, botPk, mintPk));
    actions.push('ATA');
  } else {
    tokenBal = BigInt((await conn.getTokenAccountBalance(botAta)).value.amount);
  }
  const targetRaw = BigInt(Math.floor(TOKENS_PER_BOT)) * BigInt(10 ** DECIMALS);
  if (tokenBal < targetRaw) {
    tx.add(createTransferCheckedInstruction(funderAta, mintPk, botAta, funder.publicKey, targetRaw - tokenBal, DECIMALS));
    actions.push(`+${Number(targetRaw - tokenBal) / 10 ** DECIMALS} TKN`);
  }

  if (tx.instructions.length === 0) {
    console.log(`[bot ${b.index}] ок, пропуск (${bal.toFixed(3)} SOL, ${Number(tokenBal) / 10 ** DECIMALS} TKN)`);
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
  await sleep(400); // не душим RPC
}

console.log(`\nГотово: профинансировано ${funded} ботов из ${bots.length}`);
console.log(`Funder остаток: ${((await conn.getBalance(funder.publicKey)) / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
