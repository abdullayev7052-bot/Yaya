// Usage: npm run create-admin -- <login> <password>
import bcrypt from 'bcryptjs';
import { openDb } from '../db/index.js';

const [login, password] = process.argv.slice(2);
if (!login || !password) {
  console.error('Foydalanish: npm run create-admin -- <login> <parol>');
  process.exit(1);
}
const db = openDb(process.env.DB_FILE ?? './data/yaya.db');
db.prepare(`INSERT INTO admins (login, password_hash) VALUES (?, ?)
  ON CONFLICT(login) DO UPDATE SET password_hash = excluded.password_hash`)
  .run(login, bcrypt.hashSync(password, 10));
console.log(`Admin "${login}" saqlandi`);
