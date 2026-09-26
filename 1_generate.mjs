// Шаг 1: кошельки.
// По умолчанию НЕ перезаписывает существующие — добавляет BOTS новых ботов к файлу.
// Полный сброс (новый master + новые боты): FORCE=1 node 1_generate.mjs
// При сбросе старый wallets.json уходит в wallets.backup.<timestamp>.json
import { Keypair } from '@solana/web3.js';
import fs from 'fs';
import { loadWallets, saveWallets } from './lib.mjs';

const ADD = parseInt(process.env.BOTS || '10');
const FORCE = process.env.FORCE === '1';

let wallets;
if (fs.existsSync('wallets.json') && !FORCE) {
  wallets = loadWallets();
  console.log(`Найден существующий wallets.json (${wallets.filter((x) => x.role === 'bot').length} ботов) — дописываю ${ADD} новых`);
} else {
  if (fs.existsSync('wallets.json')) {
    const bak = `wallets.backup.${Date.now()}.json`;
    fs.copyFileSync('wallets.json', bak);
    console.log(`FORCE=1: старые кошельки сохранены в ${bak}`);
  }
  const master = Keypair.generate();
  const funder = Keypair.generate();
  wallets = [{
    role: 'master',
    publicKey: master.publicKey.toBase58(),
    secretKey: Buffer.from(master.secretKey).toString('base64'),
  }, {
    role: 'funder',
    publicKey: funder.publicKey.toBase58(),
    secretKey: Buffer.from(funder.secretKey).toString('base64'),
  }];
  console.log('Создан новый master + funder');
}

const existingBots = wallets.filter((x) => x.role === 'bot').length;
for (let i = 0; i < ADD; i++) {
  const kp = Keypair.generate();
  wallets.push({
    role: 'bot',
    index: existingBots + i,
    publicKey: kp.publicKey.toBase58(),
    secretKey: Buffer.from(kp.secretKey).toString('base64'),
  });
}

saveWallets(wallets);
fs.chmodSync('wallets.json', 0o600); // приватники — только владельцу
console.log(`Итого: 1 master + ${wallets.length - 1} ботов → wallets.json (права 600)`);
console.log(`Master: ${wallets[0].publicKey}`);
