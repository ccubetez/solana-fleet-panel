// Шаг 4: флот ботов. Работает на devnet (свой пул) и mainnet (CLUSTER=mainnet).
// Параметры читаются КАЖДЫЙ цикл из params.json — их можно менять на лету
// (через дашборд server.mjs или правкой файла). Env-переменные — дефолты.
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Raydium, CurveCalculator, FeeOn, TxVersion } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import fs from 'fs';
import { conn, loadWallets, loadPool, keypairFrom, sleep, rand, solscan, CLUSTER } from './lib.mjs';

// RPC-подвисания не должны ронять весь флот
process.on('unhandledRejection', (e) => {
  console.log(`[fleet] unhandledRejection: ${String(e?.message ?? e).slice(0, 150)}`);
});
process.on('uncaughtException', (e) => {
  console.log(`[fleet] uncaughtException: ${String(e?.message ?? e).slice(0, 150)}`);
});

// ── Параметры: дефолты из env, горячие значения из params.json ──
const DEFAULTS = {
  bots: parseInt(process.env.BOTS || '6'),
  minDelay: parseFloat(process.env.MIN_DELAY || '30'),   // сек
  maxDelay: parseFloat(process.env.MAX_DELAY || '160'),  // сек
  minSwap: parseFloat(process.env.MIN_SWAP || '1'),      // в quote-единицах
  maxSwap: parseFloat(process.env.MAX_SWAP || '4'),
  slippage: parseFloat(process.env.SLIPPAGE || '0.05'),
  priority: parseInt(process.env.PRIORITY_MICROLAMPORTS || '50000'),
  buyPct: parseFloat(process.env.BUY_PCT || '0.5'),
};
function readParams() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync('params.json', 'utf8')) };
  } catch { return DEFAULTS; }
}

const pool = loadPool();
const LOGFILE = `swaps.${CLUSTER}.log`;
const STATSFILE = `stats.${CLUSTER}.json`;
const QUOTE = pool.quoteMint || 'So11111111111111111111111111111111111111112';
const QUOTE_SYMBOL = pool.quoteSymbol || 'SOL';
const N_BOTS = DEFAULTS.bots; // число ботов меняется только рестартом
const wallets = loadWallets().filter((x) => x.role === 'bot').slice(0, N_BOTS);
const stats = { swaps: 0, buys: 0, sells: 0, volume: 0, errors: 0, startedAt: Date.now(), cluster: CLUSTER, quote: QUOTE_SYMBOL };

function publishStats() {
  try {
    fs.writeFileSync(STATSFILE, JSON.stringify({
      ...stats,
      uptimeMin: (Date.now() - stats.startedAt) / 60000,
      params: readParams(),
    }));
  } catch {}
}

async function makeBot(w) {
  const kp = keypairFrom(w.secretKey);
  const raydium = await Raydium.load({
    connection: conn, owner: kp,
    cluster: CLUSTER === 'mainnet' ? 'mainnet' : 'devnet',
    disableFeatureCheck: true, disableLoadToken: true, blockhashCommitment: 'finalized',
  });
  const { poolInfo, poolKeys } = await raydium.cpmm.getPoolInfoFromRpc(pool.poolId);

  const quoteIsA = poolInfo.mintA.address === QUOTE;
  const quoteDecimals = quoteIsA ? poolInfo.mintA.decimals : poolInfo.mintB.decimals;
  const quoteInfo = quoteIsA ? poolInfo.mintA : poolInfo.mintB;
  const quoteProgram = new PublicKey(quoteInfo.programId);
  const quoteMintPk = new PublicKey(QUOTE);
  const isWsolQuote = QUOTE === 'So11111111111111111111111111111111111111112';
  const tokenInfo = poolInfo.mintA.address === pool.mint ? poolInfo.mintA : poolInfo.mintB;
  const tokenProgram = new PublicKey(tokenInfo.programId); // важно для Token-2022
  const mintPk = new PublicKey(pool.mint);

  await sleep(rand(0, 60000)); // рассинхрон старта

  while (true) {
    const P = readParams(); // ← горячие параметры каждый цикл
    try {
      const fresh = await raydium.cpmm.getPoolInfoFromRpc(pool.poolId);
      const rpcData = fresh.rpcData;

      // Направление: если токенов нет — покупаем; иначе по BUY_PCT
      const ata = getAssociatedTokenAddressSync(mintPk, kp.publicKey, false, tokenProgram);
      let tokenBal = new BN(0);
      try { tokenBal = new BN((await conn.getTokenAccountBalance(ata)).value.amount); } catch {}
      const buyToken = tokenBal.isZero() ? true : Math.random() < P.buyPct;

      let inputAmount, baseIn;
      if (buyToken) {
        const ui = rand(P.minSwap, P.maxSwap);
        inputAmount = new BN(Math.floor(ui * 10 ** quoteDecimals));
        // кэп по реальному балансу quote (для не-WSOL quote; WSOL платится нативно)
        if (!isWsolQuote) {
          const quoteAta = getAssociatedTokenAddressSync(quoteMintPk, kp.publicKey, false, quoteProgram);
          let quoteBal = new BN(0);
          try { quoteBal = new BN((await conn.getTokenAccountBalance(quoteAta)).value.amount); } catch {}
          const cap = quoteBal.muln(90).divn(100);
          inputAmount = BN.min(inputAmount, cap);
        }
        if (inputAmount.lten(0)) { await sleep(rand(P.minDelay, P.maxDelay) * 1000); continue; }
        baseIn = quoteIsA; // входим quote-стороной
      } else {
        const sellPct = rand(0.2, 0.7);
        inputAmount = tokenBal.muln(Math.floor(sellPct * 1000)).divn(1000);
        if (inputAmount.isZero()) continue;
        baseIn = !quoteIsA;
      }

      const swapResult = CurveCalculator.swapBaseInput(
        inputAmount,
        baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
        baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
        rpcData.configInfo.tradeFeeRate,
        rpcData.configInfo.creatorFeeRate,
        rpcData.configInfo.protocolFeeRate,
        rpcData.configInfo.fundFeeRate,
        rpcData.feeOn === FeeOn.BothToken || rpcData.feeOn === FeeOn.OnlyTokenB,
      );

      const { execute } = await raydium.cpmm.swap({
        poolInfo, poolKeys,
        inputAmount, swapResult,
        slippage: P.slippage,
        baseIn,
        txVersion: TxVersion.LEGACY,
        ...(P.priority ? { computeBudgetConfig: { units: 250000, microLamports: P.priority } } : {}),
      });
      const { txId } = await execute({ sendAndConfirm: true });

      const vol = (buyToken ? inputAmount.toNumber() : swapResult.outputAmount.toNumber()) / 10 ** quoteDecimals;
      stats.swaps++;
      stats[buyToken ? 'buys' : 'sells']++;
      stats.volume += vol;
      const line = `[${new Date().toISOString().slice(0, 19)}] [bot ${w.index}] ${buyToken ? 'BUY ' : 'SELL'} in=${inputAmount.toString()} out=${swapResult.outputAmount.toString()} vol=${vol.toFixed(4)} ${QUOTE_SYMBOL} ${solscan(txId)}`;
      console.log(line);
      fs.appendFileSync(LOGFILE, line + '\n');
      publishStats();
    } catch (e) {
      stats.errors++;
      publishStats();
      console.log(`[bot ${w.index}] ошибка: ${String(e?.message ?? JSON.stringify(e)).slice(0, 150)}`);
      await sleep(5000);
    }
    await sleep(rand(P.minDelay, P.maxDelay) * 1000);
  }
}

setInterval(() => {
  const mins = ((Date.now() - stats.startedAt) / 60000).toFixed(1);
  console.log(`=== ${stats.swaps} свопов за ${mins} мин | объём ${stats.volume.toFixed(2)} ${QUOTE_SYMBOL} | ошибок: ${stats.errors} ===`);
}, 60000);

console.log(`[${CLUSTER}] Запускаю ${wallets.length} ботов на пуле ${pool.poolId} (quote: ${QUOTE_SYMBOL})`);
publishStats();
await Promise.all(wallets.map(makeBot));
