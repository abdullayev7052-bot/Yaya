// Usage: npm run create-admin -- <login> <password>
import bcrypt from 'bcryptjs';
import { openDb, roleIdByCode } from '../db/index.js';

const [login, password] = process.argv.slice(2);
if (!login || !password) {
  console.error('Foydalanish: npm run create-admin -- <login> <parol>');
  process.exit(1);
}
const db = openDb(process.env.DB_FILE ?? './data/yaya.db');
db.prepare(`INSERT INTO users (login, password_hash, role_id) VALUES (?, ?, ?)
  ON CONFLICT(login) DO UPDATE SET password_hash = excluded.password_hash, role_id = excluded.role_id, active = 1`)
  .run(login, bcrypt.hashSync(password, 10), roleIdByCode(db, 'admin'));
console.log(`Admin "${login}" saqlandi`);
