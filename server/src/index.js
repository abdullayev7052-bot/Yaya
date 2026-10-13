import { openDb } from './db/index.js';
import { buildApp } from './app.js';
import { createBitoClient, BitoNotConfiguredError } from './bito/client.js';
import { pushPendingCollections } from './bito/worker.js';
import { syncReferenceData } from './bito/sync.js';

const {
  PORT = '3000',
  DB_FILE = './data/yaya.db',
  JWT_SECRET,
  BITO_BASE_URL,
  BITO_TOKEN,
  BITO_PUSH_INTERVAL_SEC = '30',
  BITO_PULL_INTERVAL_SEC = '300',
} = process.env;

if (!JWT_SECRET) {
  console.error('JWT_SECRET muhit o\'zgaruvchisi kerak');
  process.exit(1);
}

const db = openDb(DB_FILE);
const bito = createBitoClient({ baseUrl: BITO_BASE_URL, token: BITO_TOKEN });
const app = buildApp({ db, bito, jwtSecret: JWT_SECRET, logger: true });

// Runs a job on an interval, never overlapping with itself.
function every(seconds, name, job) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await job();
    } catch (err) {
      if (!(err instanceof BitoNotConfiguredError)) app.log.error(`${name}: ${err.message}`);
    } finally {
      running = false;
    }
  };
  setInterval(tick, Number(seconds) * 1000);
  tick();
}

every(BITO_PUSH_INTERVAL_SEC, 'bito-push', () => pushPendingCollections(db, bito, { log: app.log }));
every(BITO_PULL_INTERVAL_SEC, 'bito-pull', () => syncReferenceData(db, bito));

await app.listen({ port: Number(PORT), host: '0.0.0.0' });
