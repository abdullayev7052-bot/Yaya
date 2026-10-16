import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, roleIdByCode } from '../src/db/index.js';
import { buildApp } from '../src/app.js';

function setup() {
  const db = openDb(':memory:');
  db.exec(`
    INSERT INTO suppliers (id, name, phone, opening_balance) VALUES (1, 'Karimova Oydin', '901234567', 100000), (2, 'Begmatov', '931112233', 0);
    INSERT INTO products (id, name, unit) VALUES (1, 'Yog''li sut', 'kg'), (2, 'Yog''siz sut', 'kg');
    INSERT INTO supplier_products (supplier_id, product_id, price, is_default) VALUES (1, 1, 5000, 1), (1, 2, 3000, 0), (2, 1, 6000, 1);`);
  const hash = bcrypt.hashSync('1234', 4);
  db.prepare('INSERT INTO employees (id, name, phone, pin_hash, role_id) VALUES (1, \'Ali\', \'901112233\', ?, ?)').run(hash, roleIdByCode(db, 'collector'));
  db.exec('INSERT INTO employee_suppliers (employee_id, supplier_id) VALUES (1, 1), (1, 2)');
  const pw = bcrypt.hashSync('secret123', 4);
  const addUser = db.prepare('INSERT INTO users (login, password_hash, role_id) VALUES (?, ?, ?)');
  for (const [login, code] of [['boss', 'admin'], ['store', 'storekeeper'], ['view', 'viewer']]) addUser.run(login, pw, roleIdByCode(db, code));
  return { db, app: buildApp({ db, jwtSecret: 't' }) };
}
const call = (app, method, url, headers, payload) => app.inject({ method, url, headers, payload }).then((r) => ({ status: r.statusCode, body: r.json() }));
async function panel(app, login) {
  const r = await call(app, 'POST', '/api/admin/login', {}, { login, password: 'secret123' });
  return { authorization: `Bearer ${r.body.token}` };
}
async function phone(app) {
  const r = await call(app, 'POST', '/api/mobile/login', {}, { phone: '901112233', pin: '1234' });
  return { authorization: `Bearer ${r.body.token}` };
}
const now = new Date().toISOString();

test('payments and debt: balance = opening + purchases - payments; statement runs correctly', async () => {
  const { app } = setup();
  const h = await phone(app);
  await call(app, 'POST', '/api/mobile/sync', h, { collections: [
    { uuid: 'a', supplierId: 1, productId: 1, quantity: 20, collectedAt: now }, // 100 000
    { uuid: 'b', supplierId: 1, productId: 2, quantity: 10.5, collectedAt: now }, // 31 500
  ] });
  const boss = await panel(app, 'boss');
  assert.equal((await call(app, 'POST', '/api/admin/payments', boss, { supplierId: 1, amount: 150000, method: 'cash' })).status, 200);
  const pay = await call(app, 'POST', '/api/admin/payments', boss, { supplierId: 1, amount: 999, method: 'card' });
  await call(app, 'POST', `/api/admin/payments/${pay.body.id}/void`, boss, { reason: 'xato' });

  const bal = (await call(app, 'GET', '/api/admin/balances', boss)).body;
  const k = bal.rows.find((r) => r.id === 1);
  assert.equal(k.purchased, 131500);
  assert.equal(k.paid, 150000);
  assert.equal(k.balance, 100000 + 131500 - 150000);
  // search by phone digits, with spaces
  assert.deepEqual((await call(app, 'GET', '/api/admin/balances?q=93%20111', boss)).body.rows.map((r) => r.id), [2]);

  const card = (await call(app, 'GET', '/api/admin/suppliers/1/card', boss)).body;
  assert.equal(card.statement.balance, 81500);
  assert.equal(card.statement.entries[0].balance, 81500, 'newest entry carries the final balance');
});

test('collector corrects own records offline; locked once the shift is approved', async () => {
  const { app, db } = setup();
  const h = await phone(app);
  await call(app, 'POST', '/api/mobile/sync', h, {
    shifts: [{ uuid: 's1', openedAt: now, closedAt: now }],
    collections: [
      { uuid: 'a', shiftUuid: 's1', supplierId: 1, productId: 1, quantity: 20, collectedAt: now },
      { uuid: 'b', shiftUuid: 's1', supplierId: 1, productId: 1, quantity: 9, collectedAt: now },
    ],
  });
  const r = (await call(app, 'POST', '/api/mobile/sync', h, { ops: [
    { uuid: 'op1', type: 'edit', target: 'a', quantity: 22, productId: 2 },
    { uuid: 'op2', type: 'void', target: 'b', reason: 'ikki marta' },
  ] })).body;
  assert.deepEqual(r.ops.accepted, ['op1', 'op2']);
  const a = db.prepare("SELECT quantity, product_id, price FROM collections WHERE client_uuid = 'a'").get();
  assert.deepEqual(a, { quantity: 22, product_id: 2, price: 3000 }, 'price follows the new product');
  assert.ok(db.prepare("SELECT voided_at FROM collections WHERE client_uuid = 'b'").get().voided_at);
  // re-sending the same op is harmless
  assert.deepEqual((await call(app, 'POST', '/api/mobile/sync', h, { ops: [{ uuid: 'op1', type: 'edit', target: 'a', quantity: 99 }] })).body.ops.accepted, ['op1']);
  assert.equal(db.prepare("SELECT quantity FROM collections WHERE client_uuid = 'a'").get().quantity, 22);

  // storekeeper approves the closed shift -> further edits are refused
  const store = await panel(app, 'store');
  const shift = (await call(app, 'GET', '/api/admin/shifts', store)).body[0];
  assert.equal(shift.status, 'closed');
  assert.equal((await call(app, 'POST', `/api/admin/shifts/${shift.id}/review`, store, { decision: 'approve' })).status, 200);
  const late = (await call(app, 'POST', '/api/mobile/sync', h, { ops: [{ uuid: 'op3', type: 'edit', target: 'a', quantity: 1 }] })).body;
  assert.equal(late.ops.rejected[0].uuid, 'op3');
});

test('permissions: collector without app.void_own cannot void; custom role works', async () => {
  const { app, db } = setup();
  const boss = await panel(app, 'boss');
  const role = await call(app, 'POST', '/api/admin/roles', boss, { name: 'Faqat yig\'ish', permissions: ['app.collect', 'nonsense'] });
  assert.equal(role.status, 200);
  assert.deepEqual(JSON.parse(db.prepare('SELECT permissions FROM roles WHERE id = ?').get(role.body.id).permissions), ['app.collect']);
  await call(app, 'PATCH', '/api/admin/employees/1', boss, { roleId: role.body.id });
  const h = await phone(app);
  await call(app, 'POST', '/api/mobile/sync', h, { collections: [{ uuid: 'a', supplierId: 1, productId: 1, quantity: 5, collectedAt: now }] });
  const r = (await call(app, 'POST', '/api/mobile/sync', h, { ops: [{ uuid: 'x', type: 'void', target: 'a' }] })).body;
  assert.equal(r.ops.rejected.length, 1);
  const boot = (await call(app, 'GET', '/api/mobile/bootstrap', h)).body;
  assert.deepEqual(boot.permissions, ['app.collect']);
  // a role in use cannot be deleted; the locked admin role cannot be edited
  assert.equal((await call(app, 'DELETE', `/api/admin/roles/${role.body.id}`, boss)).status, 400);
  assert.equal((await call(app, 'PATCH', `/api/admin/roles/${roleIdByCode(db, 'admin')}`, boss, { permissions: [] })).status, 400);
});

test('amounts are stripped server-side for roles without amounts.view', async () => {
  const { app } = setup();
  const h = await phone(app);
  await call(app, 'POST', '/api/mobile/sync', h, { collections: [{ uuid: 'a', supplierId: 1, productId: 1, quantity: 5, collectedAt: now }] });
  const store = await panel(app, 'store'); // storekeeper: no amounts.view
  const rows = (await call(app, 'GET', '/api/admin/collections', store)).body;
  assert.equal(rows[0].quantity, 5);
  assert.equal(rows[0].price, undefined);
  assert.equal(rows[0].amount, undefined);
  assert.equal((await call(app, 'GET', '/api/admin/balances', store)).status, 403);
});

test('daily weighted average cost and its "final" flag', async () => {
  const { app } = setup();
  const h = await phone(app);
  await call(app, 'POST', '/api/mobile/sync', h, {
    shifts: [{ uuid: 's1', openedAt: now, closedAt: null }],
    collections: [
      { uuid: 'a', shiftUuid: 's1', supplierId: 1, productId: 1, quantity: 100, collectedAt: now }, // 5000
      { uuid: 'b', shiftUuid: 's1', supplierId: 2, productId: 1, quantity: 50, collectedAt: now }, // 6000
    ],
  });
  const boss = await panel(app, 'boss');
  let c = (await call(app, 'GET', '/api/admin/reports/daily-cost', boss)).body;
  // (100*5000 + 50*6000) / 150 = 5333.33 — not the plain average 5500
  assert.equal(c.products[0].avg_cost, 5333.33);
  assert.equal(c.final, false);
  await call(app, 'POST', '/api/mobile/sync', h, { shifts: [{ uuid: 's1', openedAt: now, closedAt: now }] });
  const shift = (await call(app, 'GET', '/api/admin/shifts', boss)).body[0];
  await call(app, 'POST', `/api/admin/shifts/${shift.id}/review`, boss, { decision: 'approve' });
  c = (await call(app, 'GET', '/api/admin/reports/daily-cost', boss)).body;
  assert.equal(c.final, true);
});

test('Excel import: preview, then apply; existing supplier matched by phone; debt becomes exact', async () => {
  const { app, db } = setup();
  const boss = await panel(app, 'boss');
  const tpl = await app.inject({ url: '/api/admin/suppliers-import/template.xlsx', headers: boss });
  assert.equal(tpl.statusCode, 200);
  assert.ok(tpl.rawPayload.length > 1000);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.addRow(['F.I.Sh (majburiy)', 'Telefon', 'Manzil', 'Izoh', 'Mahsulot', 'Narx (so\'m)', 'Joriy qarz (so\'m)']);
  ws.addRow(['Karimova Oydin', '+998 90 123 45 67', 'Qo\'qon', '', 'Yog\'li sut', 5200, 50000]);
  ws.addRow(['Yangi Fermer', '977777777', 'Buvayda', '', 'Qaymoq', 20000, -10000]);
  ws.addRow(['', '', '', '', '', '', '']);
  ws.addRow(['Xato', 'abc', '', '', 'Yog\'li sut', '', '']);
  const file = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');

  const preview = (await call(app, 'POST', '/api/admin/suppliers-import', boss, { file, dryRun: true })).body;
  assert.equal(preview.summary.suppliersUpdated, 1);
  assert.equal(preview.summary.suppliersCreated, 1);
  assert.equal(preview.summary.productsCreated, 1);
  assert.equal(preview.summary.errorRows, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM suppliers').get().n, 2, 'dry run changes nothing');

  const done = (await call(app, 'POST', '/api/admin/suppliers-import', boss, { file, dryRun: false })).body;
  assert.equal(done.dryRun, false);
  const bal = (await call(app, 'GET', '/api/admin/balances', boss)).body.rows;
  assert.equal(bal.find((r) => r.id === 1).balance, 50000);
  assert.equal(bal.find((r) => r.name === 'Yangi Fermer').balance, -10000);
  assert.equal(db.prepare('SELECT price FROM supplier_products WHERE supplier_id = 1 AND product_id = 1').get().price, 5200);
});

test('logo upload accepts only PNG and is served publicly with a version', async () => {
  const { app } = setup();
  const boss = await panel(app, 'boss');
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  assert.equal((await call(app, 'PUT', '/api/admin/settings/logo', boss, { dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400);
  assert.equal((await call(app, 'PUT', '/api/admin/settings/logo', boss, { dataUrl: `data:image/png;base64,${png.toString('base64')}` })).status, 200);
  const brand = (await call(app, 'GET', '/api/public/brand', {})).body;
  assert.match(brand.logoUrl, /^\/api\/public\/logo\.png\?v=\d+/);
  const img = await app.inject({ url: brand.logoUrl });
  assert.equal(img.headers['content-type'], 'image/png');
  assert.equal((await call(app, 'PUT', '/api/admin/settings/logo', await panel(app, 'view'), { dataUrl: 'x' })).status, 403);
});

test('migrates a v2 database: fixed roles become role_id, closed shifts get status', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'yaya-')), 'v2.db');
  const old = new Database(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, login TEXT UNIQUE NOT NULL, name TEXT, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, pin_hash TEXT NOT NULL,
      warehouse_id INTEGER, is_test INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE shifts (id INTEGER PRIMARY KEY, client_uuid TEXT UNIQUE NOT NULL, employee_id INTEGER NOT NULL, opened_at TEXT NOT NULL, closed_at TEXT);
    CREATE TABLE suppliers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, address TEXT, note TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO users (login, password_hash, role) VALUES ('a', 'h', 'admin'), ('m', 'h', 'manager');
    INSERT INTO employees (name, phone, pin_hash) VALUES ('Ali', '901', 'h');
    INSERT INTO shifts (client_uuid, employee_id, opened_at, closed_at) VALUES ('s1', 1, 'x', 'y'), ('s2', 1, 'x', NULL);
    INSERT INTO suppliers (name) VALUES ('S');
    PRAGMA user_version = 2;`);
  old.close();
  const db = openDb(file);
  assert.equal(db.prepare("SELECT role_id FROM users WHERE login = 'a'").get().role_id, roleIdByCode(db, 'admin'));
  assert.equal(db.prepare("SELECT role_id FROM users WHERE login = 'm'").get().role_id, roleIdByCode(db, 'manager'));
  assert.equal(db.prepare('SELECT role_id FROM employees').get().role_id, roleIdByCode(db, 'collector'));
  assert.deepEqual(db.prepare('SELECT status FROM shifts ORDER BY id').all().map((r) => r.status), ['closed', 'open']);
  assert.equal(db.prepare('SELECT opening_balance FROM suppliers').get().opening_balance, 0);
});
