import * as SQLite from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';

// The database lives in the app's private files directory, not in the cache
// directory, so Android's "Clear cache" never touches it. Every write below is
// synchronous and committed before the UI moves on, so killing the app at any
// moment cannot lose a saved pickup.
const db = SQLite.openDatabaseSync('yaya.db');

db.execSync(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS shifts (
    uuid TEXT PRIMARY KEY,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    dirty INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS collections (
    uuid TEXT PRIMARY KEY,
    shift_uuid TEXT NOT NULL,
    supplier_id INTEGER NOT NULL,
    supplier_name TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    unit TEXT,
    quantity REAL NOT NULL,
    collected_at TEXT NOT NULL,
    synced_at TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_col_shift ON collections(shift_uuid);
  CREATE INDEX IF NOT EXISTS idx_col_unsynced ON collections(synced_at);
`);

// ---- key/value (session, cached reference data, unfinished input) ----
export function getKv(key, fallback = null) {
  const row = db.getFirstSync('SELECT value FROM kv WHERE key = ?', key);
  return row ? JSON.parse(row.value) : fallback;
}
export function setKv(key, value) {
  if (value === null || value === undefined) db.runSync('DELETE FROM kv WHERE key = ?', key);
  else db.runSync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, JSON.stringify(value));
}

// ---- shifts ----
export function getOpenShift() {
  return db.getFirstSync('SELECT * FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1');
}
export function openShift() {
  const shift = { uuid: randomUUID(), opened_at: new Date().toISOString() };
  db.runSync('INSERT INTO shifts (uuid, opened_at) VALUES (?, ?)', shift.uuid, shift.opened_at);
  return shift;
}
export function closeShift(uuid) {
  db.runSync('UPDATE shifts SET closed_at = ?, dirty = 1 WHERE uuid = ?', new Date().toISOString(), uuid);
}

// ---- collections ----
// Saving the pickup and clearing the unfinished input happen in one transaction,
// so a crash can never leave both (which would invite a double entry).
export function addCollectionAndClearDraft({ shiftUuid, supplier, product, quantity }) {
  db.withTransactionSync(() => {
    db.runSync(`INSERT INTO collections
    (uuid, shift_uuid, supplier_id, supplier_name, product_id, product_name, unit, quantity, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(), shiftUuid, supplier.id, supplier.name, product.id, product.name, product.unit ?? 'kg',
    quantity, new Date().toISOString());
    db.runSync("DELETE FROM kv WHERE key = 'draft'");
  });
}
export function shiftCollections(shiftUuid) {
  return db.getAllSync('SELECT * FROM collections WHERE shift_uuid = ? ORDER BY collected_at DESC', shiftUuid);
}
export function unsyncedCount() {
  return db.getFirstSync('SELECT COUNT(*) AS n FROM collections WHERE synced_at IS NULL AND error IS NULL').n;
}
export function errorCount() {
  return db.getFirstSync('SELECT COUNT(*) AS n FROM collections WHERE error IS NOT NULL').n;
}

// ---- sync helpers ----
export function pendingUpload() {
  return {
    shifts: db.getAllSync('SELECT uuid, opened_at, closed_at FROM shifts WHERE dirty = 1'),
    collections: db.getAllSync('SELECT * FROM collections WHERE synced_at IS NULL AND error IS NULL LIMIT 200'),
  };
}
export function markUploaded(sentShifts, accepted, rejected) {
  const now = new Date().toISOString();
  db.withTransactionSync(() => {
    // Only clear the flag if the shift was not closed while the upload was in flight.
    for (const s of sentShifts) db.runSync('UPDATE shifts SET dirty = 0 WHERE uuid = ? AND closed_at IS ?', s.uuid, s.closed_at);
    for (const u of accepted) db.runSync('UPDATE collections SET synced_at = ? WHERE uuid = ?', now, u);
    for (const r of rejected) db.runSync('UPDATE collections SET error = ? WHERE uuid = ?', r.error, r.uuid);
  });
}
// Rows the server rejected (e.g. supplier reassigned) get another try after the
// admin fixes the settings.
export function retryErrors() {
  db.runSync('UPDATE collections SET error = NULL WHERE error IS NOT NULL');
}
// Keep a month of history on the phone; never delete anything not yet on the server.
export function pruneOld() {
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
  db.runSync('DELETE FROM collections WHERE synced_at IS NOT NULL AND collected_at < ?', cutoff);
  db.runSync(`DELETE FROM shifts WHERE closed_at IS NOT NULL AND dirty = 0 AND closed_at < ?
    AND uuid NOT IN (SELECT shift_uuid FROM collections)`, cutoff);
}
