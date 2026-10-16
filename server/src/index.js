import bcrypt from 'bcryptjs';
import { openDb } from './db/index.js';
import { buildApp } from './app.js';
import { createBitoClient, BitoNotConfiguredError } from './bito/client.js';
import { pushPendingCollections } from './bito/worker.js';
import { syncReferenceData } from './bito/sync.js';
import { bitoConfig, jwtSecret } from './settings.js';

const {
  PORT = '3000',
  DB_FILE = './data/yaya.db',
  JWT_SECRET,
  ADMIN_LOGIN,
  ADMIN_PASSWORD,
  BITO_PUSH_INTERVAL_SEC = '30',
  BITO_PULL_INTERVAL_SEC = '300',
} = process.env;

const db = openDb(DB_FILE);

// First start: create the admin from env so no shell access is needed on the host.
if (ADMIN_LOGIN && ADMIN_PASSWORD && !db.prepare('SELECT 1 FROM admins LIMIT 1').get()) {
  db.prepare('INSERT INTO admins (login, password_hash) VALUES (?, ?)').run(ADMIN_LOGIN, bcrypt.hashSync(ADMIN_PASSWORD, 10));
  console.log(`Admin "${ADMIN_LOGIN}" yaratildi`);
}

const bito = createBitoClient({ getConfig: () => bitoConfig(db) });
const app = buildApp({ db, bito, jwtSecret: jwtSecret(db, JWT_SECRET), logger: true });

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
