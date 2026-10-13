import { openDb } from './db/index.js';
import { buildApp } from './app.js';
import { createBitoClient } from './bito/client.js';
import { pushPendingCollections } from './bito/worker.js';

const {
  PORT = '3000',
  DB_FILE = './data/yaya.db',
  JWT_SECRET,
  BITO_BASE_URL,
  BITO_TOKEN,
  BITO_PUSH_INTERVAL_SEC = '30',
} = process.env;

if (!JWT_SECRET) {
  console.error('JWT_SECRET muhit o\'zgaruvchisi kerak');
  process.exit(1);
}

const db = openDb(DB_FILE);
const app = buildApp({ db, jwtSecret: JWT_SECRET, logger: true });
const bito = createBitoClient({ baseUrl: BITO_BASE_URL, token: BITO_TOKEN });

let running = false;
setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await pushPendingCollections(db, bito, { log: app.log });
  } finally {
    running = false;
  }
}, Number(BITO_PUSH_INTERVAL_SEC) * 1000);

await app.listen({ port: Number(PORT), host: '0.0.0.0' });
