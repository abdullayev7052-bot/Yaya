import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, roleIdByCode } from '../src/db/index.js';
import { buildApp } from '../src/app.js';
import { toCsv } from '../src/reports.js';

function setup() {
  const db = openDb(':memory:');
  db.exec(`
    INSERT INTO suppliers (id, name) VALUES (1, 'Karimova Oydin'), (2, 'Begmatov');
    INSERT INTO products (id, name, unit) VALUES (1, 'Yog''li sut', 'kg'), (2, 'Yog''siz sut', 'kg');
    INSERT INTO warehouses (id, name) VALUES (1, 'Mashina 01');
    INSERT INTO supplier_products (supplier_id, product_id, price, is_default) VALUES (1, 1, 5500, 1), (1, 2, 3333.33, 0);
  `);
  const hash = bcrypt.hashSync('1234', 4);
  db.prepare(`INSERT INTO employees (id, name, phone, pin_hash, warehouse_id, is_test) VALUES
    (1, 'Ali', '901112233', ?, 1, 0), (2, 'Test', '900000000', ?, 1, 1)`).run(hash, hash);
  db.exec('INSERT INTO employee_suppliers (employee_id, supplier_id) VALUES (1, 1), (2, 1)');
  const pw = bcrypt.hashSync('secret123', 4);
  const addUser = db.prepare('INSERT INTO users (login, password_hash, role_id) VALUES (?, ?, ?)');
  for (const [login, code] of [['boss', 'admin'], ['mgr', 'manager'], ['view', 'viewer'], ['store', 'storekeeper']]) addUser.run(login, pw, roleIdByCode(db, code));
  const app = buildApp({ db, jwtSecret: 'test-secret' });
  return { db, app };
}

async function phone(app, number = '901112233') {
  const res = await app.inject({ method: 'POST', url: '/api/mobile/login', payload: { phone: number, pin: '1234' } });
  return { authorization: `Bearer ${res.json().token}` };
}
async function panel(app, login) {
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login, password: 'secret123' } });
  return { authorization: `Bearer ${res.json().token}` };
}
const upload = (app, h, collections) => app.inject({ method: 'POST', url: '/api/mobile/sync', headers: h, payload: { collections } }).then((r) => r.json());
const pick = (uuid, extra = {}) => ({ uuid, supplierId: 1, productId: 1, quantity: 10, collectedAt: '2026-10-13T06:00:00Z', ...extra });

test('collector sees only assigned suppliers, without prices', async () => {
  const { app } = setup();
  const res = await app.inject({ url: '/api/mobile/bootstrap', headers: await phone(app) });
  const { suppliers } = res.json();
  assert.equal(suppliers.length, 1);
  assert.equal(suppliers[0].products.length, 2);
  assert.equal(suppliers[0].products[0].isDefault, true);
  assert.ok(!/5500|3333/.test(res.body), 'price must never reach the phone');
});

test('sync is idempotent, rejects unassigned suppliers and uses the server price', async () => {
  const { app, db } = setup();
  const h = await phone(app);
  const batch = [pick('u-1', { quantity: 42.5 }), pick('u-2', { supplierId: 2 })];
  const first = await upload(app, h, batch);
  assert.deepEqual(first.accepted, ['u-1']);
  assert.equal(first.rejected[0].uuid, 'u-2');
  const second = await upload(app, h, batch);
  assert.deepEqual(second.accepted, ['u-1']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM collections').get().n, 1);
  assert.equal(db.prepare('SELECT price FROM collections').get().price, 5500);
});

test('report arithmetic: rounded per-pickup amounts, local days, excludes voided and test data', async () => {
  const { app } = setup();
  const h = await phone(app);
  await upload(app, h, [
    pick('a', { quantity: 12.35 }), // 67 925
    pick('b', { productId: 2, quantity: 7.5 }), // 3333.33 * 7.5 = 24 999.975 -> 25 000
    pick('c', { quantity: 30, collectedAt: '2026-10-13T20:30:00Z' }), // next local day
    pick('d', { quantity: 99 }),
  ]);
  await upload(app, await phone(app, '900000000'), [pick('t', { quantity: 500 })]);
  const mgr = await panel(app, 'mgr');
  const list = (await app.inject({ url: '/api/admin/collections?from=2026-10-13&to=2026-10-13', headers: mgr })).json();
  const d = list.find((r) => r.quantity === 99);
  assert.equal((await app.inject({ method: 'POST', url: `/api/admin/collections/${d.id}/void`, headers: mgr, payload: { reason: 'xato' } })).statusCode, 200);

  const s = (await app.inject({ url: '/api/admin/reports/summary?from=2026-10-13&to=2026-10-13', headers: mgr })).json();
  assert.equal(s.totals.pickups, 2);
  assert.equal(s.totals.quantity, 19.85);
  assert.equal(s.totals.amount, 67925 + 25000);
  const next = (await app.inject({ url: '/api/admin/reports/summary?from=2026-10-14&to=2026-10-14', headers: mgr })).json();
  assert.equal(next.totals.amount, 165000);

  const csv = await app.inject({ url: '/api/admin/reports/export.csv?from=2026-10-13&to=2026-10-14', headers: mgr });
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.equal(csv.body.trim().split('\r\n').length, 4);
});

test('roles: viewer reads only, manager edits data, only admin manages users', async () => {
  const { app } = setup();
  const view = await panel(app, 'view');
  const mgr = await panel(app, 'mgr');
  const boss = await panel(app, 'boss');
  assert.equal((await app.inject({ url: '/api/admin/suppliers', headers: view })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/suppliers', headers: view, payload: { name: 'X' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/suppliers', headers: mgr, payload: { name: 'X' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/admin/users', headers: mgr })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/admin/users', headers: boss })).statusCode, 200);
  // The last admin cannot remove their own admin rights.
  const users = (await app.inject({ url: '/api/admin/users', headers: boss })).json();
  const me = users.find((u) => u.login === 'boss');
  const viewerRole = users.find((u) => u.login === 'view').role_id;
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/admin/users/${me.id}`, headers: boss, payload: { roleId: viewerRole } })).statusCode, 400);
});

test('login brute-force guard and deactivated collectors', async () => {
  const { app, db } = setup();
  for (let i = 0; i < 8; i++) {
    await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'boss', password: 'nope' } });
  }
  const blocked = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'boss', password: 'secret123' } });
  assert.equal(blocked.statusCode, 429);

  const h = await phone(app);
  db.prepare('UPDATE employees SET active = 0 WHERE id = 1').run();
  assert.equal((await app.inject({ url: '/api/mobile/bootstrap', headers: h })).statusCode, 401);
});

test('clearing test data removes only test collectors\' pickups', async () => {
  const { app, db } = setup();
  await upload(app, await phone(app), [pick('real')]);
  await upload(app, await phone(app, '900000000'), [pick('test')]);
  const r = (await app.inject({ method: 'DELETE', url: '/api/admin/test-data', headers: await panel(app, 'boss') })).json();
  assert.equal(r.deleted, 1);
  assert.deepEqual(db.prepare('SELECT client_uuid FROM collections').all().map((x) => x.client_uuid), ['real']);
});

test('migrates a v1 database: keeps admins, drops empty mirrored tables', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'yaya-')), 'old.db');
  const old = new Database(file);
  old.exec(`CREATE TABLE admins (id INTEGER PRIMARY KEY, login TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE suppliers (id INTEGER PRIMARY KEY, ext_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, synced_at TEXT);
    INSERT INTO admins (login, password_hash) VALUES ('admin', 'h');
    INSERT INTO settings VALUES ('jwt_secret', 'keep'), ('ext_token', 'x');`);
  old.close();
  const db = openDb(file);
  assert.equal(db.prepare('SELECT role_id FROM users WHERE login = ?').get('admin').role_id, roleIdByCode(db, 'admin'));
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get().value, 'keep');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM settings WHERE key = 'ext_token'").get().n, 0);
  assert.ok(!db.prepare('PRAGMA table_info(suppliers)').all().some((c) => c.name === 'ext_id'));
});

test('CSV neutralises formula injection', () => {
  const out = toCsv([{ a: '=HYPERLINK("x")', b: -5 }], [['a', 'A'], ['b', 'B']]);
  assert.ok(out.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(out.endsWith(';-5'));
});
