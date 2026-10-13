import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  login TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Mirrored from Bito. bito_id is Bito's own identifier.
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY,
  bito_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  bito_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  unit TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY,
  bito_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  pin_hash TEXT NOT NULL,
  warehouse_id INTEGER REFERENCES warehouses(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which supplier gives which product at what price.
CREATE TABLE IF NOT EXISTS supplier_products (
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price REAL NOT NULL,
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
  bito_status TEXT NOT NULL DEFAULT 'pending' CHECK (bito_status IN ('pending','sent','error')),
  bito_doc_id TEXT,
  bito_error TEXT,
  bito_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_collections_bito_status ON collections(bito_status);
CREATE INDEX IF NOT EXISTS idx_collections_employee ON collections(employee_id, collected_at);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
