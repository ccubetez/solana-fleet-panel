// Шаг 3: создаём токен и CPMM-пул WSOL/TOKEN на Raydium devnet
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Raydium, DEVNET_PROGRAM_ID, getCpmmPdaAmmConfigId, TxVersion } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import { conn, loadWallets, keypairFrom, savePool } from './lib.mjs';

const DECIMALS = 6;
const TOKEN_SUPPLY = 1_000_000;                 // 1 млн токенов
const POOL_SOL = parseFloat(process.env.POOL_SOL || '2');  // SOL в пул
const POOL_TOKENS = 500_000;                    // токенов в пул → стартовая цена = POOL_SOL/POOL_TOKENS

const wallets = loadWallets();
const master = keypairFrom(wallets[0].secretKey);

// 1. Mint
const mint = await createMint(conn, master, master.publicKey, null, DECIMALS);
console.log(`Токен создан: ${mint.toBase58()}`);

const ata = await getOrCreateAssociatedTokenAccount(conn, master, mint, master.publicKey);
await mintTo(conn, master, mint, ata.address, master, BigInt(TOKEN_SUPPLY) * BigInt(10 ** DECIMALS));
console.log(`Выпущено ${TOKEN_SUPPLY} токенов на master`);

// 2. Пул. CPMM требует mintA < mintB (по байтам pubkey) — сортируем.
const wsol = NATIVE_MINT;
const solFirst = Buffer.from(wsol.toBytes()).compare(Buffer.from(mint.toBytes())) < 0;

const mintAInfo = solFirst
  ? { address: wsol.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), decimals: 9 }
  : { address: mint.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), decimals: DECIMALS };
const mintBInfo = solFirst
  ? { address: mint.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), decimals: DECIMALS }
  : { address: wsol.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), decimals: 9 };

const solAmount = new BN(Math.floor(POOL_SOL * LAMPORTS_PER_SOL));
const tokenAmount = new BN(POOL_TOKENS * 10 ** DECIMALS);

const raydium = await Raydium.load({
  connection: conn,
  owner: master,
  cluster: 'devnet',
  disableFeatureCheck: true,
  disableLoadToken: true,
  blockhashCommitment: 'finalized',
});

const feeConfigs = await raydium.api.getCpmmConfigs();
feeConfigs.forEach((c) => {
  c.id = getCpmmPdaAmmConfigId(DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM, c.index).publicKey.toBase58();
});

const { execute, extInfo } = await raydium.cpmm.createPool({
  programId: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
  poolFeeAccount: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC,
  mintA: mintAInfo,
  mintB: mintBInfo,
  mintAAmount: solFirst ? solAmount : tokenAmount,
  mintBAmount: solFirst ? tokenAmount : solAmount,
  startTime: new BN(0),
  feeConfig: feeConfigs[0],
  associatedOnly: false,
  ownerInfo: { useSOLBalance: true },
  txVersion: TxVersion.LEGACY,
});

const { txId } = await execute({ sendAndConfirm: true });
const poolId = extInfo.address.poolId.toBase58();
console.log(`Пул создан: ${poolId}`);
console.log(`TX: https://solscan.io/tx/${txId}?cluster=devnet`);

savePool({ poolId, mint: mint.toBase58(), decimals: DECIMALS, solFirst });
console.log('Сохранено → pool.json');
