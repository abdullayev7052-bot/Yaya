import bcrypt from 'bcryptjs';
import { audit, roleIdByCode } from '../db/index.js';
import { createLoginGuard } from '../ratelimit.js';
import { permsOf } from '../permissions.js';
import { getSetting } from '../settings.js';

// API used by the collector's phone. Everything a collector does offline is
// uploaded through /sync and is idempotent by client-generated UUIDs.
export default async function mobileRoutes(app, { db }) {
  const guard = createLoginGuard();

  const auth = async (req, reply) => {
    try {
      await req.jwtVerify();
      if (req.user.kind !== 'employee') throw new Error('kind');
    } catch {
      return reply.code(401).send({ error: 'Avtorizatsiya kerak' });
    }
    const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND active = 1').get(req.user.id);
    // A deactivated collector is logged out on the next sync.
    if (!emp) return reply.code(401).send({ error: 'Hisobingiz o\'chirilgan. Adminga murojaat qiling.' });
    req.emp = emp;
    req.perms = permsOf(db, emp.role_id ?? roleIdByCode(db, 'collector'));
  };

  app.post('/login', {
    schema: { body: { type: 'object', required: ['phone', 'pin'],
      properties: { phone: { type: 'string' }, pin: { type: 'string' } } } },
  }, async (req, reply) => {
    const phone = req.body.phone.replace(/\D/g, '');
    const key = `${req.ip}|${phone}`;
    const wait = guard.blocked(key);
    if (wait) return reply.code(429).send({ error: `Juda ko'p urinish. ${wait} daqiqadan keyin qayta urinib ko'ring.` });
    const emp = db.prepare('SELECT * FROM employees WHERE phone = ? AND active = 1').get(phone);
    if (!emp || !bcrypt.compareSync(req.body.pin, emp.pin_hash)) {
      guard.fail(key);
      return reply.code(401).send({ error: 'Telefon yoki PIN noto\'g\'ri' });
    }
    guard.reset(key);
    audit(db, `employee:${emp.phone}`, 'login');
    // Long-lived token: collectors may stay offline for days.
    const token = app.jwt.sign({ kind: 'employee', id: emp.id }, { expiresIn: '180d' });
    return { token, employee: { id: emp.id, name: emp.name, isTest: !!emp.is_test } };
  });

  // Everything the phone needs to work offline. Prices are never sent to collectors.
  app.get('/bootstrap', { preHandler: auth }, async (req) => {
    const suppliers = db.prepare(`
      SELECT s.id, s.name, s.phone, s.address
      FROM employee_suppliers es
      JOIN suppliers s ON s.id = es.supplier_id AND s.active = 1
      WHERE es.employee_id = ?
      ORDER BY es.sort_order, s.name`).all(req.emp.id);
    const productsOf = db.prepare(`
      SELECT p.id, p.name, p.unit, sp.is_default
      FROM supplier_products sp JOIN products p ON p.id = sp.product_id AND p.active = 1
      WHERE sp.supplier_id = ?
      ORDER BY sp.is_default DESC, p.name`);
    for (const s of suppliers) {
      s.products = productsOf.all(s.id).map((p) => ({ id: p.id, name: p.name, unit: p.unit, isDefault: !!p.is_default }));
    }
    // Review state of recent shifts, so the phone knows which records are locked.
    const shifts = db.prepare(`SELECT client_uuid AS uuid, status, review_note FROM shifts
      WHERE employee_id = ? ORDER BY opened_at DESC LIMIT 20`).all(req.emp.id);
    return {
      employee: { id: req.emp.id, name: req.emp.name, isTest: !!req.emp.is_test },
      permissions: [...req.perms].filter((p) => p.startsWith('app.')),
      suppliers,
      shifts,
      brand: { companyName: getSetting(db, 'company_name') ?? '', version: getSetting(db, 'brand_version') ?? '0' },
      serverTime: new Date().toISOString(),
    };
  });

  app.get('/history', { preHandler: auth }, async (req, reply) => {
    if (!req.perms.has('app.history')) return reply.code(403).send({ error: 'Ruxsat yo\'q' });
    return db.prepare(`
      SELECT s.client_uuid AS uuid, s.opened_at, s.closed_at, s.status, s.review_note,
        COUNT(c.id) AS pickups, ROUND(COALESCE(SUM(c.quantity), 0), 2) AS quantity
      FROM shifts s LEFT JOIN collections c ON c.shift_uuid = s.client_uuid AND c.voided_at IS NULL
      WHERE s.employee_id = ? GROUP BY s.id ORDER BY s.opened_at DESC LIMIT 60`).all(req.emp.id);
  });

  const str = { type: 'string' };
  app.post('/sync', {
    preHandler: auth,
    schema: { body: { type: 'object', properties: {
      shifts: { type: 'array', maxItems: 500, items: { type: 'object', required: ['uuid', 'openedAt'],
        properties: { uuid: str, openedAt: str, closedAt: { type: ['string', 'null'] } } } },
      collections: { type: 'array', maxItems: 1000, items: { type: 'object',
        required: ['uuid', 'supplierId', 'productId', 'quantity', 'collectedAt'],
        properties: { uuid: str, shiftUuid: str, supplierId: { type: 'integer' }, productId: { type: 'integer' },
          quantity: { type: 'number', exclusiveMinimum: 0, maximum: 100000 }, collectedAt: str } } },
      // Corrections to records already on the server.
      ops: { type: 'array', maxItems: 500, items: { type: 'object', required: ['uuid', 'type', 'target'],
        properties: { uuid: str, type: { enum: ['edit', 'void'] }, target: str,
          quantity: { type: 'number', exclusiveMinimum: 0, maximum: 100000 }, productId: { type: 'integer' }, reason: str } } },
      payments: { type: 'array', maxItems: 500, items: { type: 'object', required: ['uuid', 'supplierId', 'amount', 'paidAt'],
        properties: { uuid: str, supplierId: { type: 'integer' }, amount: { type: 'number', exclusiveMinimum: 0, maximum: 1e11 },
          method: { enum: ['cash', 'card', 'transfer'] }, note: str, paidAt: str } } },
    } } },
  }, async (req) => {
    const emp = req.emp;
    const can = (p) => req.perms.has(p);
    const actor = `employee:${emp.phone}`;
    const upsertShift = db.prepare(`INSERT INTO shifts (client_uuid, employee_id, opened_at, closed_at, status)
      VALUES (@uuid, @emp, @openedAt, @closedAt, CASE WHEN @closedAt IS NULL THEN 'open' ELSE 'closed' END)
      ON CONFLICT(client_uuid) DO UPDATE SET closed_at = COALESCE(excluded.closed_at, closed_at),
        status = CASE WHEN status = 'open' AND excluded.closed_at IS NOT NULL THEN 'closed' ELSE status END
      WHERE employee_id = @emp`);
    const exists = db.prepare('SELECT 1 FROM collections WHERE client_uuid = ?');
    const assigned = db.prepare('SELECT 1 FROM employee_suppliers WHERE employee_id = ? AND supplier_id = ?');
    // Price is always taken from the admin-configured table, never from the phone.
    const priceOf = db.prepare('SELECT price FROM supplier_products WHERE supplier_id = ? AND product_id = ?');
    const insert = db.prepare(`INSERT INTO collections
      (client_uuid, shift_uuid, employee_id, supplier_id, product_id, warehouse_id, quantity, price, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const own = db.prepare(`SELECT c.*, s.status AS shift_status FROM collections c
      LEFT JOIN shifts s ON s.client_uuid = c.shift_uuid WHERE c.client_uuid = ? AND c.employee_id = ?`);
    const opDone = db.prepare('SELECT 1 FROM applied_ops WHERE uuid = ?');
    const markOp = db.prepare('INSERT INTO applied_ops (uuid) VALUES (?)');

    const out = { accepted: [], rejected: [], ops: { accepted: [], rejected: [] }, payments: { accepted: [], rejected: [] } };
    db.transaction(() => {
      for (const s of req.body.shifts ?? []) upsertShift.run({ uuid: s.uuid, emp: emp.id, openedAt: s.openedAt, closedAt: s.closedAt ?? null });

      for (const c of req.body.collections ?? []) {
        if (exists.get(c.uuid)) { out.accepted.push(c.uuid); continue; }
        if (!can('app.collect')) { out.rejected.push({ uuid: c.uuid, error: 'Sut qabul qilishga ruxsat yo\'q' }); continue; }
        if (!assigned.get(emp.id, c.supplierId)) { out.rejected.push({ uuid: c.uuid, error: 'Yetkazib beruvchi sizga biriktirilmagan' }); continue; }
        const p = priceOf.get(c.supplierId, c.productId);
        if (!p) { out.rejected.push({ uuid: c.uuid, error: 'Bu mahsulot uchun narx sozlanmagan' }); continue; }
        insert.run(c.uuid, c.shiftUuid ?? null, emp.id, c.supplierId, c.productId, emp.warehouse_id ?? null, c.quantity, p.price, c.collectedAt);
        out.accepted.push(c.uuid);
      }

      for (const op of req.body.ops ?? []) {
        const reject = (error) => out.ops.rejected.push({ uuid: op.uuid, error });
        if (opDone.get(op.uuid)) { out.ops.accepted.push(op.uuid); continue; }
        const c = own.get(op.target, emp.id);
        if (!c) { reject('Yozuv topilmadi'); continue; }
        if (['approved'].includes(c.shift_status)) { reject('Smena tasdiqlangan — o\'zgartirib bo\'lmaydi'); continue; }
        if (op.type === 'void') {
          if (!can('app.void_own')) { reject('Bekor qilishga ruxsat yo\'q'); continue; }
          db.prepare('UPDATE collections SET voided_at = datetime(\'now\'), void_reason = ?, voided_by = ? WHERE id = ? AND voided_at IS NULL')
            .run(op.reason || 'Sut yig\'uvchi bekor qildi', actor, c.id);
        } else {
          if (!can('app.edit_own')) { reject('Tahrirlashga ruxsat yo\'q'); continue; }
          if (c.voided_at) { reject('Yozuv bekor qilingan'); continue; }
          const productId = op.productId ?? c.product_id;
          const p = priceOf.get(c.supplier_id, productId);
          if (!p) { reject('Bu mahsulot uchun narx sozlanmagan'); continue; }
          db.prepare('UPDATE collections SET quantity = ?, product_id = ?, price = ?, edited_at = datetime(\'now\'), edited_by = ? WHERE id = ?')
            .run(op.quantity ?? c.quantity, productId, productId === c.product_id ? c.price : p.price, actor, c.id);
        }
        markOp.run(op.uuid);
        audit(db, actor, 'app.op', { op: op.uuid, type: op.type, target: op.target, quantity: op.quantity, productId: op.productId, from: { quantity: c.quantity, productId: c.product_id } });
        out.ops.accepted.push(op.uuid);
      }

      for (const p of req.body.payments ?? []) {
        if (db.prepare('SELECT 1 FROM payments WHERE client_uuid = ?').get(p.uuid)) { out.payments.accepted.push(p.uuid); continue; }
        if (!can('app.pay')) { out.payments.rejected.push({ uuid: p.uuid, error: 'To\'lov kiritishga ruxsat yo\'q' }); continue; }
        if (!assigned.get(emp.id, p.supplierId)) { out.payments.rejected.push({ uuid: p.uuid, error: 'Yetkazib beruvchi sizga biriktirilmagan' }); continue; }
        db.prepare(`INSERT INTO payments (client_uuid, supplier_id, amount, method, note, paid_at, created_by, employee_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(p.uuid, p.supplierId, Math.round(p.amount), p.method ?? 'cash',
          p.note ? String(p.note).slice(0, 300) : null, p.paidAt, actor, emp.id);
        out.payments.accepted.push(p.uuid);
      }
    })();
    return out;
  });
}
