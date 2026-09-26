// Отладка одного свопа: поля swapResult + симуляция
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Raydium, CurveCalculator, FeeOn, TxVersion } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import { conn, loadWallets, loadPool, keypairFrom } from './lib.mjs';

const pool = loadPool();
const w = loadWallets()[1];
const kp = keypairFrom(w.secretKey);

const raydium = await Raydium.load({
  connection: conn, owner: kp, cluster: 'devnet',
  disableFeatureCheck: true, disableLoadToken: true, blockhashCommitment: 'finalized',
});

const { poolInfo, poolKeys, rpcData } = await raydium.cpmm.getPoolInfoFromRpc(pool.poolId);
console.log('poolInfo.mintA:', poolInfo.mintA.address, '| mintB:', poolInfo.mintB.address);
console.log('rpcData keys:', Object.keys(rpcData));
console.log('configInfo:', JSON.stringify(rpcData.configInfo, (k, v) => typeof v === 'object' && v?.toString ? v.toString() : v));

const inputAmount = new BN(Math.floor(0.01 * LAMPORTS_PER_SOL));
const solIsA = poolInfo.mintA.address === 'So11111111111111111111111111111111111111112';
const baseIn = solIsA;

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
console.log('swapResult keys:', Object.keys(swapResult));
console.log('swapResult:', Object.fromEntries(Object.entries(swapResult).map(([k, v]) => [k, v?.toString?.() ?? String(v)])));

const { execute, transaction } = await raydium.cpmm.swap({
  poolInfo, poolKeys,
  inputAmount, swapResult,
  slippage: 0.05,
  baseIn,
  txVersion: TxVersion.LEGACY,
});

// Симуляция вместо отправки
const sim = await conn.simulateTransaction(transaction, [kp]);
console.log('simulate err:', JSON.stringify(sim.value.err));
console.log('simulate logs:', sim.value.logs?.slice(-15));

if (!sim.value.err) {
  const { txId } = await execute({ sendAndConfirm: true });
  console.log('SWAP OK:', txId);
}
