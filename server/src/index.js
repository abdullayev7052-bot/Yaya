import bcrypt from 'bcryptjs';
import { openDb } from './db/index.js';
import { buildApp } from './app.js';
import { jwtSecret } from './settings.js';

const {
  PORT = '3000',
  DB_FILE = './data/yaya.db',
  JWT_SECRET,
  ADMIN_LOGIN,
  ADMIN_PASSWORD,
} = process.env;

const db = openDb(DB_FILE);

// First start: create the admin from env so no shell access is needed on the host.
if (ADMIN_LOGIN && ADMIN_PASSWORD && !db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  db.prepare(`INSERT INTO users (login, password_hash, role) VALUES (?, ?, 'admin')`).run(ADMIN_LOGIN, bcrypt.hashSync(ADMIN_PASSWORD, 10));
  console.log(`Admin "${ADMIN_LOGIN}" yaratildi`);
}

const app = buildApp({ db, jwtSecret: jwtSecret(db, JWT_SECRET), logger: true });

// Close the database cleanly so the WAL is checkpointed on redeploys.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}

await app.listen({ port: Number(PORT), host: '0.0.0.0' });
