import * as SQLite from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';

// The database lives in the app's private files directory, not in the cache
// directory, so Android's "Clear cache" never touches it. Every write below is
// synchronous and committed before the UI moves on, so killing the app at any
// moment cannot lose a saved pickup, correction or payment.
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
  -- Corrections to pickups that already reached the server.
  CREATE TABLE IF NOT EXISTS ops (
    uuid TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    target TEXT NOT NULL,
    quantity REAL,
    product_id INTEGER,
    reason TEXT,
    created_at TEXT NOT NULL,
    synced_at TEXT,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS payments (
    uuid TEXT PRIMARY KEY,
    supplier_id INTEGER NOT NULL,
    supplier_name TEXT NOT NULL,
    amount REAL NOT NULL,
    method TEXT NOT NULL DEFAULT 'cash',
    note TEXT,
    paid_at TEXT NOT NULL,
    synced_at TEXT,
    error TEXT
  );
`);
// Columns added after the first release; phones that already have the table get them here.
if (!db.getAllSync('PRAGMA table_info(collections)').some((c) => c.name === 'voided_at')) {
  db.execSync('ALTER TABLE collections ADD COLUMN voided_at TEXT; ALTER TABLE collections ADD COLUMN edited_at TEXT;');
}

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

// Correct a pickup. Not yet uploaded: just change it. Already on the server:
// change it here too and queue the correction for upload.
export function editCollection(uuid, { quantity, product }) {
  db.withTransactionSync(() => {
    const c = db.getFirstSync('SELECT * FROM collections WHERE uuid = ?', uuid);
    if (!c) return;
    db.runSync('UPDATE collections SET quantity = ?, product_id = ?, product_name = ?, unit = ?, edited_at = ? WHERE uuid = ?',
      quantity, product.id, product.name, product.unit ?? 'kg', new Date().toISOString(), uuid);
    if (c.synced_at) {
      db.runSync('INSERT INTO ops (uuid, type, target, quantity, product_id, created_at) VALUES (?, \'edit\', ?, ?, ?, ?)',
        randomUUID(), uuid, quantity, product.id, new Date().toISOString());
    }
  });
}
export function voidCollection(uuid, reason) {
  db.withTransactionSync(() => {
    const c = db.getFirstSync('SELECT * FROM collections WHERE uuid = ?', uuid);
    if (!c || c.voided_at) return;
    db.runSync('UPDATE collections SET voided_at = ? WHERE uuid = ?', new Date().toISOString(), uuid);
    if (c.synced_at) {
      db.runSync('INSERT INTO ops (uuid, type, target, reason, created_at) VALUES (?, \'void\', ?, ?, ?)',
        randomUUID(), uuid, reason ?? null, new Date().toISOString());
    }
  });
}

// ---- payments made by the collector in the field ----
export function addPayment({ supplier, amount, method, note }) {
  db.runSync('INSERT INTO payments (uuid, supplier_id, supplier_name, amount, method, note, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    randomUUID(), supplier.id, supplier.name, amount, method ?? 'cash', note ?? null, new Date().toISOString());
}
export function recentPayments() {
  return db.getAllSync('SELECT * FROM payments ORDER BY paid_at DESC LIMIT 50');
}

// ---- sync state ----
const PENDING = {
  collections: 'synced_at IS NULL AND error IS NULL AND voided_at IS NULL',
  ops: 'synced_at IS NULL AND error IS NULL',
  payments: 'synced_at IS NULL AND error IS NULL',
};
export function unsyncedCount() {
  return Object.entries(PENDING).reduce((n, [t, w]) => n + db.getFirstSync(`SELECT COUNT(*) AS n FROM ${t} WHERE ${w}`).n, 0);
}
export function errorCount() {
  return ['collections', 'ops', 'payments'].reduce((n, t) => n + db.getFirstSync(`SELECT COUNT(*) AS n FROM ${t} WHERE error IS NOT NULL`).n, 0);
}
export function errors() {
  return [
    ...db.getAllSync('SELECT \'pickup\' AS kind, supplier_name AS name, error FROM collections WHERE error IS NOT NULL'),
    ...db.getAllSync('SELECT \'fix\' AS kind, target AS name, error FROM ops WHERE error IS NOT NULL'),
    ...db.getAllSync('SELECT \'payment\' AS kind, supplier_name AS name, error FROM payments WHERE error IS NOT NULL'),
  ];
}

export function pendingUpload() {
  return {
    shifts: db.getAllSync('SELECT uuid, opened_at, closed_at FROM shifts WHERE dirty = 1'),
    collections: db.getAllSync(`SELECT * FROM collections WHERE ${PENDING.collections} LIMIT 200`),
    ops: db.getAllSync(`SELECT * FROM ops WHERE ${PENDING.ops} ORDER BY created_at LIMIT 200`),
    payments: db.getAllSync(`SELECT * FROM payments WHERE ${PENDING.payments} LIMIT 200`),
  };
}
export function markUploaded(sentShifts, r) {
  const now = new Date().toISOString();
  db.withTransactionSync(() => {
    // Only clear the flag if the shift was not closed while the upload was in flight.
    for (const s of sentShifts) db.runSync('UPDATE shifts SET dirty = 0 WHERE uuid = ? AND closed_at IS ?', s.uuid, s.closed_at);
    const apply = (table, acc = [], rej = []) => {
      for (const u of acc) db.runSync(`UPDATE ${table} SET synced_at = ? WHERE uuid = ?`, now, u);
      for (const x of rej) db.runSync(`UPDATE ${table} SET error = ? WHERE uuid = ?`, x.error, x.uuid);
    };
    apply('collections', r.accepted, r.rejected);
    apply('ops', r.ops?.accepted, r.ops?.rejected);
    apply('payments', r.payments?.accepted, r.payments?.rejected);
  });
}
// Rejected items get another try after the admin fixes the settings.
export function retryErrors() {
  for (const t of ['collections', 'ops', 'payments']) db.runSync(`UPDATE ${t} SET error = NULL WHERE error IS NOT NULL`);
}
// Keep a month of history on the phone; never delete anything not yet on the server.
export function pruneOld() {
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
  db.runSync('DELETE FROM collections WHERE (synced_at IS NOT NULL OR voided_at IS NOT NULL) AND collected_at < ?', cutoff);
  db.runSync('DELETE FROM ops WHERE synced_at IS NOT NULL AND created_at < ?', cutoff);
  db.runSync('DELETE FROM payments WHERE synced_at IS NOT NULL AND paid_at < ?', cutoff);
  db.runSync(`DELETE FROM shifts WHERE closed_at IS NOT NULL AND dirty = 0 AND closed_at < ?
    AND uuid NOT IN (SELECT shift_uuid FROM collections)`, cutoff);
}
