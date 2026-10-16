import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 2;

const SCHEMA = `
-- Admin panel users. Roles: admin (everything), manager (day-to-day data, no
-- users/settings), viewer (read-only reports).
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  login TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','manager','viewer')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  note TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'kg',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Each collector's own tank/vehicle.
CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Milk collectors (mobile app users). is_test rows are excluded from reports.
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  pin_hash TEXT NOT NULL,
  warehouse_id INTEGER REFERENCES warehouses(id),
  is_test INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which supplier gives which product at what price (per supplier, per product).
CREATE TABLE IF NOT EXISTS supplier_products (
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price REAL NOT NULL CHECK (price >= 0),
  is_default INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (supplier_id, product_id)
);

-- Which collector is responsible for which suppliers.
CREATE TABLE IF NOT EXISTS employee_suppliers (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (employee_id, supplier_id)
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  client_uuid TEXT UNIQUE NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  opened_at TEXT NOT NULL,
  closed_at TEXT
);

-- One milk pickup. client_uuid is generated on the phone and makes uploads idempotent.
-- Price is copied from supplier_products at upload time, so later price changes
-- never rewrite history. Mistakes are voided, never deleted.
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY,
  client_uuid TEXT UNIQUE NOT NULL,
  shift_uuid TEXT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  warehouse_id INTEGER REFERENCES warehouses(id),
  quantity REAL NOT NULL CHECK (quantity > 0),
  price REAL NOT NULL,
  collected_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT,
  void_reason TEXT,
  voided_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_collections_time ON collections(collected_at);
CREATE INDEX IF NOT EXISTS idx_collections_employee ON collections(employee_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_collections_supplier ON collections(supplier_id, collected_at);

-- Who changed what, for accountability.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT
);
`;

const hasColumn = (db, table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
const tableExists = (db, table) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);

// v1 mirrored its reference tables from an external system (recognisable by the
// synced_at column). Those tables could only be filled through that link, so in
// practice they are empty; any that are not are kept under a legacy_ name.
function migrateFromV1(db) {
  if (!tableExists(db, 'suppliers') || !hasColumn(db, 'suppliers', 'synced_at')) return;
  const tables = ['collections', 'shifts', 'employee_suppliers', 'supplier_products', 'employees', 'warehouses', 'products', 'suppliers'];
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    for (const t of tables) {
      if (!tableExists(db, t)) continue;
      const n = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
      if (n) db.exec(`ALTER TABLE ${t} RENAME TO legacy_${t}`);
      else db.exec(`DROP TABLE ${t}`);
    }
    // Only the JWT secret is still a setting; drop the old connection settings.
    db.prepare("DELETE FROM settings WHERE key != 'jwt_secret'").run();
  })();
  db.pragma('foreign_keys = ON');
}

function migrateAdmins(db) {
  if (!tableExists(db, 'admins')) return;
  db.prepare(`INSERT OR IGNORE INTO users (login, password_hash, role, created_at)
    SELECT login, password_hash, 'admin', created_at FROM admins`).run();
  db.exec('DROP TABLE admins');
}

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  if (db.pragma('user_version', { simple: true }) < SCHEMA_VERSION) {
    if (tableExists(db, 'settings') === false) db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    migrateFromV1(db);
  }
  db.exec(SCHEMA);
  migrateAdmins(db);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
}

export function audit(db, actor, action, details) {
  db.prepare('INSERT INTO audit_log (actor, action, details) VALUES (?, ?, ?)')
    .run(actor, action, details == null ? null : JSON.stringify(details));
}
