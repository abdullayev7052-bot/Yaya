import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BUILTIN_ROLES } from '../permissions.js';

const SCHEMA_VERSION = 3;

const SCHEMA = `
-- Named permission sets, built by the admin and assigned to people.
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE,                     -- set for built-in roles only
  name TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]', -- JSON array of permission keys
  locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- People who use the panel or the manager mode of the app.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  login TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  role_id INTEGER REFERENCES roles(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Small binary assets (the company logo).
CREATE TABLE IF NOT EXISTS files (
  key TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- opening_balance: what we owed the supplier when they were entered into Yaya
-- (positive = we owe them, negative = they owe us, e.g. an advance).
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  note TEXT,
  opening_balance REAL NOT NULL DEFAULT 0,
  lat REAL,
  lng REAL,
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
  role_id INTEGER REFERENCES roles(id),
  is_test INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS supplier_products (
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price REAL NOT NULL CHECK (price >= 0),
  is_default INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (supplier_id, product_id)
);

CREATE TABLE IF NOT EXISTS employee_suppliers (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (employee_id, supplier_id)
);

-- status: open -> closed (by the collector) -> approved | rejected (by a reviewer).
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  client_uuid TEXT UNIQUE NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT
);

-- One milk pickup. Price is copied from supplier_products at upload time, so
-- later price changes never rewrite history. Mistakes are voided, never deleted.
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
  edited_at TEXT,
  edited_by TEXT,
  voided_at TEXT,
  void_reason TEXT,
  voided_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_collections_time ON collections(collected_at);
CREATE INDEX IF NOT EXISTS idx_collections_employee ON collections(employee_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_collections_supplier ON collections(supplier_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_collections_shift ON collections(shift_uuid);

-- Money paid to a supplier. client_uuid makes offline uploads from the app idempotent.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  client_uuid TEXT UNIQUE NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  amount REAL NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','card','transfer')),
  note TEXT,
  paid_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  employee_id INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT,
  void_reason TEXT,
  voided_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_supplier ON payments(supplier_id, paid_at);

-- Offline corrections from phones already applied (makes re-sends harmless).
CREATE TABLE IF NOT EXISTS applied_ops (
  uuid TEXT PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
    if (tableExists(db, 'settings')) db.prepare("DELETE FROM settings WHERE key != 'jwt_secret'").run();
  })();
  db.pragma('foreign_keys = ON');
}

// v2 -> v3: columns added to existing tables. Each step runs only if missing.
const ADDED_COLUMNS = [
  ['users', 'role_id', 'INTEGER REFERENCES roles(id)'],
  ['employees', 'role_id', 'INTEGER REFERENCES roles(id)'],
  ['suppliers', 'opening_balance', 'REAL NOT NULL DEFAULT 0'],
  ['suppliers', 'lat', 'REAL'],
  ['suppliers', 'lng', 'REAL'],
  ['shifts', 'status', "TEXT NOT NULL DEFAULT 'open'"],
  ['shifts', 'reviewed_by', 'TEXT'],
  ['shifts', 'reviewed_at', 'TEXT'],
  ['shifts', 'review_note', 'TEXT'],
  ['collections', 'edited_at', 'TEXT'],
  ['collections', 'edited_by', 'TEXT'],
];

function addColumns(db) {
  for (const [table, col, def] of ADDED_COLUMNS) {
    if (!tableExists(db, table) || hasColumn(db, table, col)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    if (table === 'shifts' && col === 'status') {
      db.exec("UPDATE shifts SET status = 'closed' WHERE closed_at IS NOT NULL");
    }
  }
}

function seedRoles(db) {
  const ins = db.prepare('INSERT OR IGNORE INTO roles (code, name, permissions, locked) VALUES (?, ?, ?, ?)');
  for (const r of BUILTIN_ROLES) ins.run(r.code, r.name, JSON.stringify(r.perms), r.locked);
  const roleId = (code) => db.prepare('SELECT id FROM roles WHERE code = ?').get(code).id;
  // Users from v2 carried a fixed role name; map it onto the matching built-in role.
  if (hasColumn(db, 'users', 'role')) {
    for (const code of ['admin', 'manager', 'viewer']) {
      db.prepare('UPDATE users SET role_id = ? WHERE role_id IS NULL AND role = ?').run(roleId(code), code);
    }
  }
  db.prepare('UPDATE users SET role_id = ? WHERE role_id IS NULL').run(roleId('viewer'));
  db.prepare('UPDATE employees SET role_id = ? WHERE role_id IS NULL').run(roleId('collector'));
}

function migrateAdmins(db) {
  if (!tableExists(db, 'admins')) return;
  const admin = db.prepare("SELECT id FROM roles WHERE code = 'admin'").get().id;
  for (const a of db.prepare('SELECT * FROM admins').all()) {
    db.prepare('INSERT OR IGNORE INTO users (login, password_hash, role_id, created_at) VALUES (?, ?, ?, ?)')
      .run(a.login, a.password_hash, admin, a.created_at);
  }
  db.exec('DROP TABLE admins');
}

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const version = db.pragma('user_version', { simple: true });
  if (version < 2) migrateFromV1(db);
  db.transaction(() => {
    addColumns(db);
    db.exec(SCHEMA);
    seedRoles(db);
    migrateAdmins(db);
  })();
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
}

export const roleIdByCode = (db, code) => db.prepare('SELECT id FROM roles WHERE code = ?').get(code)?.id;

export function audit(db, actor, action, details) {
  db.prepare('INSERT INTO audit_log (actor, action, details) VALUES (?, ?, ?)')
    .run(actor, action, details == null ? null : JSON.stringify(details));
}
