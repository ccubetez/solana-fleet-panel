// Шаг 2: аирдроп devnet SOL на master + раздача ботам
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { conn, loadWallets, keypairFrom, sleep } from './lib.mjs';

const SOL_PER_BOT = parseFloat(process.env.SOL_PER_BOT || '0.3');
const TARGET_MASTER = parseFloat(process.env.MASTER_SOL || '6'); // сколько хотим на master

const wallets = loadWallets();
const master = keypairFrom(wallets[0].secretKey);

async function airdropLoop(pubkey, targetSol) {
  let balance = await conn.getBalance(pubkey);
  console.log(`Master balance: ${balance / LAMPORTS_PER_SOL} SOL, цель: ${targetSol}`);
  let attempts = 0;
  while (balance < targetSol * LAMPORTS_PER_SOL && attempts < 12) {
    attempts++;
    try {
      const sig = await conn.requestAirdrop(pubkey, 2 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, 'confirmed');
      console.log(`Airdrop #${attempts}: +2 SOL`);
    } catch (e) {
      console.log(`Airdrop #${attempts} отклонён (лимит крана), жду 20s... (${e.message.slice(0, 80)})`);
    }
    await sleep(20000);
    balance = await conn.getBalance(pubkey);
  }
  return balance;
}

const balance = await airdropLoop(master.publicKey, TARGET_MASTER);
const sol = balance / LAMPORTS_PER_SOL;
console.log(`Итого на master: ${sol} SOL`);

// Раздаём ботам одной транзакцией
const bots = wallets.slice(1);
const reserve = parseFloat(process.env.RESERVE_SOL || '1.5'); // оставляем на пул и комиссии
const perBot = Math.min(SOL_PER_BOT, (sol - reserve) / bots.length);
if (perBot < 0.02) {
  console.error('Не хватает SOL на фандинг ботов. Попроси больше у крана и перезапусти.');
  process.exit(1);
}

const tx = new Transaction();
for (const b of bots) {
  tx.add(SystemProgram.transfer({
    fromPubkey: master.publicKey,
    toPubkey: new PublicKey(b.publicKey),
    lamports: Math.floor(perBot * LAMPORTS_PER_SOL),
  }));
}
const sig = await conn.sendTransaction(tx, [master]);
await conn.confirmTransaction(sig, 'confirmed');
console.log(`Раздали по ${perBot.toFixed(3)} SOL × ${bots.length} ботов. TX: ${sig}`);
