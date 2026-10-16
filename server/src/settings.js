import { randomBytes } from 'node:crypto';

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(db, key, value) {
  if (value == null || value === '') db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// JWT secret: taken from env if given, otherwise generated once and kept in the
// database so tokens survive restarts and nothing has to be configured by hand.
export function jwtSecret(db, fromEnv) {
  if (fromEnv) return fromEnv;
  let s = getSetting(db, 'jwt_secret');
  if (!s) {
    s = randomBytes(48).toString('hex');
    setSetting(db, 'jwt_secret', s);
  }
  return s;
}

// Admin-panel values win over env, so the connection can be fixed without a redeploy.
export function bitoConfig(db, env = process.env) {
  return {
    baseUrl: getSetting(db, 'bito_base_url') || env.BITO_BASE_URL || '',
    token: getSetting(db, 'bito_token') || env.BITO_TOKEN || '',
  };
}
