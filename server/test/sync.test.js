import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { openDb } from '../src/db/index.js';
import { buildApp } from '../src/app.js';
import { pushPendingCollections } from '../src/bito/worker.js';
import { createBitoClient } from '../src/bito/client.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO suppliers (id, bito_id, name) VALUES (1, 'S1', 'Karimova Oydin'), (2, 'S2', 'Begmatov')`).run();
  db.prepare(`INSERT INTO products (id, bito_id, name, unit) VALUES (1, 'P1', 'Sut', 'kg')`).run();
  db.prepare(`INSERT INTO warehouses (id, bito_id, name) VALUES (1, 'W1', 'Mashina 01')`).run();
  db.prepare(`INSERT INTO employees (id, name, phone, pin_hash, warehouse_id) VALUES (1, 'Ali', '901112233', ?, 1)`)
    .run(bcrypt.hashSync('1234', 4));
  db.prepare(`INSERT INTO employee_suppliers (employee_id, supplier_id) VALUES (1, 1)`).run();
  db.prepare(`INSERT INTO supplier_products (supplier_id, product_id, price) VALUES (1, 1, 5500)`).run();
  const app = buildApp({ db, jwtSecret: 'test-secret' });
  return { db, app };
}

async function login(app) {
  const res = await app.inject({ method: 'POST', url: '/api/mobile/login', payload: { phone: '901112233', pin: '1234' } });
  return res.json().token;
}

test('collector sees only assigned suppliers with price', async () => {
  const { app } = setup();
  const token = await login(app);
  const res = await app.inject({ url: '/api/mobile/bootstrap', headers: { authorization: `Bearer ${token}` } });
  const { suppliers } = res.json();
  assert.equal(suppliers.length, 1);
  assert.equal(suppliers[0].name, 'Karimova Oydin');
  assert.equal(suppliers[0].price, 5500);
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
