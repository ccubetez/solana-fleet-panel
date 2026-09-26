import { Connection, Keypair } from '@solana/web3.js';
import fs from 'fs';

// Для своего запуска подставь свой Helius RPC.
// CLUSTER=devnet (по умолчанию) → RPC_URL; CLUSTER=mainnet → HELIUS_MAINNET
export const CLUSTER = process.env.CLUSTER || 'devnet';
export const RPC = CLUSTER === 'mainnet'
  ? (process.env.HELIUS_MAINNET || 'https://api.mainnet-beta.solana.com')
  : (process.env.RPC_URL || 'https://api.devnet.solana.com');
export const conn = new Connection(RPC, 'confirmed');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rand = (min, max) => Math.random() * (max - min) + min;
export const randInt = (min, max) => Math.floor(rand(min, max + 1));

export function loadWallets() {
  if (!fs.existsSync('wallets.json')) return [];
  return JSON.parse(fs.readFileSync('wallets.json', 'utf8'));
}
export function saveWallets(w) {
  fs.writeFileSync('wallets.json', JSON.stringify(w, null, 2));
}
export function keypairFrom(b64) {
  return Keypair.fromSecretKey(Buffer.from(b64, 'base64'));
}
export function loadPool() {
  const file = fs.existsSync(`pool.${CLUSTER}.json`) ? `pool.${CLUSTER}.json` : 'pool.json';
  if (!fs.existsSync(file)) throw new Error(`no pool configured — add a trading pair in the panel (expected ${file})`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export function savePool(p) {
  fs.writeFileSync('pool.json', JSON.stringify(p, null, 2));
}
export const getMaster = (w) => w.find((x) => x.role === 'master');
export const getFunder = (w) => w.find((x) => x.role === 'funder');
export const getBots = (w) => w.filter((x) => x.role === 'bot');
export const solscan = (sig) => CLUSTER === 'mainnet'
  ? `https://solscan.io/tx/${sig}`
  : `https://solscan.io/tx/${sig}?cluster=devnet`;
