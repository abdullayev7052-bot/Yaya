import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { openDb } from '../src/db/index.js';
import { buildApp } from '../src/app.js';
import { pushPendingCollections } from '../src/bito/worker.js';
import { createBitoClient } from '../src/bito/client.js';
import { bitoConfig } from '../src/settings.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO suppliers (id, bito_id, name) VALUES (1, 'S1', 'Karimova Oydin'), (2, 'S2', 'Begmatov')`).run();
  db.prepare(`INSERT INTO products (id, bito_id, name, unit) VALUES (1, 'P1', 'Sut', 'kg')`).run();
  db.prepare(`INSERT INTO warehouses (id, bito_id, name) VALUES (1, 'W1', 'Mashina 01')`).run();
  db.prepare(`INSERT INTO employees (id, name, phone, pin_hash, warehouse_id) VALUES (1, 'Ali', '901112233', ?, 1)`)
    .run(bcrypt.hashSync('1234', 4));
  db.prepare(`INSERT INTO employee_suppliers (employee_id, supplier_id) VALUES (1, 1)`).run();
  db.prepare(`INSERT INTO supplier_products (supplier_id, product_id, price) VALUES (1, 1, 5500)`).run();
  const app = buildApp({ db, jwtSecret: 'test-secret', bito: createBitoClient({ getConfig: () => bitoConfig(db, {}) }) });
  return { db, app };
}

async function login(app) {
  const res = await app.inject({ method: 'POST', url: '/api/mobile/login', payload: { phone: '901112233', pin: '1234' } });
  return res.json().token;
}

test('collector sees only assigned suppliers, without prices', async () => {
  const { app } = setup();
  const token = await login(app);
  const res = await app.inject({ url: '/api/mobile/bootstrap', headers: { authorization: `Bearer ${token}` } });
  const { suppliers } = res.json();
  assert.equal(suppliers.length, 1);
  assert.equal(suppliers[0].name, 'Karimova Oydin');
  assert.deepEqual(suppliers[0].products, [{ id: 1, name: 'Sut', unit: 'kg', isDefault: true }]);
  assert.ok(!JSON.stringify(res.json()).includes('5500'), 'price must never reach the phone');
});

test('sync is idempotent and uses server price', async () => {
  const { app, db } = setup();
  const token = await login(app);
  const payload = { collections: [
    { uuid: 'u-1', supplierId: 1, productId: 1, quantity: 42.5, collectedAt: '2026-10-13T06:00:00Z' },
    { uuid: 'u-2', supplierId: 2, productId: 1, quantity: 10, collectedAt: '2026-10-13T06:05:00Z' },
  ] };
  const send = () => app.inject({ method: 'POST', url: '/api/mobile/sync', payload, headers: { authorization: `Bearer ${token}` } });

  const first = (await send()).json();
  assert.deepEqual(first.accepted, ['u-1']);
  assert.equal(first.rejected[0].uuid, 'u-2');

  const second = (await send()).json();
  assert.deepEqual(second.accepted, ['u-1']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM collections').get().n, 1);
  assert.equal(db.prepare('SELECT price FROM collections').get().price, 5500);
});

test('worker leaves rows pending while Bito is not configured', async () => {
  const { app, db } = setup();
  const token = await login(app);
  await app.inject({ method: 'POST', url: '/api/mobile/sync', headers: { authorization: `Bearer ${token}` },
    payload: { collections: [{ uuid: 'u-1', supplierId: 1, productId: 1, quantity: 5, collectedAt: '2026-10-13T06:00:00Z' }] } });
  const r = await pushPendingCollections(db, createBitoClient({}));
  assert.equal(r.sent, 0);
  assert.equal(db.prepare('SELECT bito_status FROM collections').get().bito_status, 'pending');
});

test('worker marks rows sent when Bito accepts', async () => {
  const { app, db } = setup();
  const token = await login(app);
  await app.inject({ method: 'POST', url: '/api/mobile/sync', headers: { authorization: `Bearer ${token}` },
    payload: { collections: [{ uuid: 'u-1', supplierId: 1, productId: 1, quantity: 5, collectedAt: '2026-10-13T06:00:00Z' }] } });
  const calls = [];
  const fakeBito = { createPurchase: async (p) => { calls.push(p); return { docId: 'DOC-1' }; } };
  await pushPendingCollections(db, fakeBito);
  assert.equal(calls[0].supplierBitoId, 'S1');
  assert.equal(calls[0].warehouseBitoId, 'W1');
  assert.deepEqual(calls[0].items, [{ productBitoId: 'P1', quantity: 5, price: 5500 }]);
  assert.equal(db.prepare('SELECT bito_status FROM collections').get().bito_status, 'sent');
});

test('admin dashboard and runtime Bito settings', async () => {
  const { app, db } = setup();
  db.prepare(`INSERT INTO admins (login, password_hash) VALUES ('admin', ?)`).run(bcrypt.hashSync('secret123', 4));
  const token = await login(app);
  await app.inject({ method: 'POST', url: '/api/mobile/sync', headers: { authorization: `Bearer ${token}` },
    payload: { collections: [{ uuid: 'u-1', supplierId: 1, productId: 1, quantity: 30, collectedAt: '2026-10-13T20:30:00Z' }] } });
  const adm = (await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'secret123' } })).json().token;
  const h = { authorization: `Bearer ${adm}` };

  // 20:30 UTC is already the next day in Tashkent (UTC+5).
  const d = (await app.inject({ url: '/api/admin/dashboard?date=2026-10-14', headers: h })).json();
  assert.equal(d.byEmployee[0].quantity, 30);
  assert.equal(d.byEmployee[0].amount, 30 * 5500);
  assert.equal(d.queue.pending, 1);

  await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: h, payload: { bitoBaseUrl: 'https://x.bito.online/', bitoToken: 'tok' } });
  const st = (await app.inject({ url: '/api/admin/settings', headers: h })).json();
  assert.equal(st.bitoBaseUrl, 'https://x.bito.online');
  assert.equal(st.bitoTokenSet, true);
  assert.ok(!JSON.stringify(st).includes('tok"'), 'token must not be returned');
});
