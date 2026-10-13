import bcrypt from 'bcryptjs';

// API used by the collector's phone.
export default async function mobileRoutes(app, { db }) {
  const auth = async (req, reply) => {
    try {
      await req.jwtVerify();
      if (req.user.role !== 'employee') throw new Error('role');
    } catch {
      return reply.code(401).send({ error: 'Avtorizatsiya kerak' });
    }
  };

  app.post('/login', {
    schema: { body: { type: 'object', required: ['phone', 'pin'],
      properties: { phone: { type: 'string' }, pin: { type: 'string' } } } },
  }, async (req, reply) => {
    const emp = db.prepare('SELECT * FROM employees WHERE phone = ? AND active = 1').get(req.body.phone);
    if (!emp || !bcrypt.compareSync(req.body.pin, emp.pin_hash)) {
      return reply.code(401).send({ error: 'Telefon yoki PIN noto\'g\'ri' });
    }
    // Long-lived token: collectors may stay offline for days.
    const token = app.jwt.sign({ role: 'employee', id: emp.id }, { expiresIn: '180d' });
    return { token, employee: { id: emp.id, name: emp.name } };
  });

  // Everything the phone needs to work offline: assigned suppliers and the products
  // each one gives. Prices are deliberately never sent to the collector.
  app.get('/bootstrap', { preHandler: auth }, async (req) => {
    const emp = db.prepare('SELECT id, name FROM employees WHERE id = ?').get(req.user.id);
    const suppliers = db.prepare(`
      SELECT s.id, s.name, s.phone, s.address
      FROM employee_suppliers es
      JOIN suppliers s ON s.id = es.supplier_id AND s.active = 1
      WHERE es.employee_id = ?
      ORDER BY es.sort_order, s.name`).all(req.user.id);
    const productsOf = db.prepare(`
      SELECT p.id, p.name, p.unit, sp.is_default
      FROM supplier_products sp JOIN products p ON p.id = sp.product_id AND p.active = 1
      WHERE sp.supplier_id = ?
      ORDER BY sp.is_default DESC, p.name`);
    for (const s of suppliers) {
      s.products = productsOf.all(s.id).map((p) => ({ id: p.id, name: p.name, unit: p.unit, isDefault: !!p.is_default }));
    }
    return { employee: emp, suppliers, serverTime: new Date().toISOString() };
  });

  // Batch upload from the phone's offline queue. Idempotent by client_uuid:
  // re-sending the same record is acknowledged without creating a duplicate.
  app.post('/sync', {
    preHandler: auth,
    schema: { body: { type: 'object', properties: {
      shifts: { type: 'array', items: { type: 'object', required: ['uuid', 'openedAt'],
        properties: { uuid: { type: 'string' }, openedAt: { type: 'string' }, closedAt: { type: ['string', 'null'] } } } },
      collections: { type: 'array', items: { type: 'object',
        required: ['uuid', 'supplierId', 'productId', 'quantity', 'collectedAt'],
        properties: { uuid: { type: 'string' }, shiftUuid: { type: 'string' }, supplierId: { type: 'integer' },
          productId: { type: 'integer' }, quantity: { type: 'number', exclusiveMinimum: 0 },
          collectedAt: { type: 'string' } } } },
    } } },
  }, async (req) => {
    const empId = req.user.id;
    const emp = db.prepare('SELECT warehouse_id FROM employees WHERE id = ?').get(empId);
    const upsertShift = db.prepare(`INSERT INTO shifts (client_uuid, employee_id, opened_at, closed_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(client_uuid) DO UPDATE SET closed_at = COALESCE(excluded.closed_at, closed_at)`);
    const exists = db.prepare('SELECT 1 FROM collections WHERE client_uuid = ?');
    const assigned = db.prepare('SELECT 1 FROM employee_suppliers WHERE employee_id = ? AND supplier_id = ?');
    // Price is always taken from the admin-configured table, never from the phone.
    const priceOf = db.prepare('SELECT price FROM supplier_products WHERE supplier_id = ? AND product_id = ?');
    const insert = db.prepare(`INSERT INTO collections
      (client_uuid, shift_uuid, employee_id, supplier_id, product_id, warehouse_id, quantity, price, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const accepted = [];
    const rejected = [];
    db.transaction(() => {
      for (const s of req.body.shifts ?? []) upsertShift.run(s.uuid, empId, s.openedAt, s.closedAt ?? null);
      for (const c of req.body.collections ?? []) {
        if (exists.get(c.uuid)) { accepted.push(c.uuid); continue; }
        if (!assigned.get(empId, c.supplierId)) { rejected.push({ uuid: c.uuid, error: 'Yetkazib beruvchi sizga biriktirilmagan' }); continue; }
        const p = priceOf.get(c.supplierId, c.productId);
        if (!p) { rejected.push({ uuid: c.uuid, error: 'Bu mahsulot uchun narx sozlanmagan' }); continue; }
        insert.run(c.uuid, c.shiftUuid ?? null, empId, c.supplierId, c.productId, emp?.warehouse_id ?? null,
          c.quantity, p.price, c.collectedAt);
        accepted.push(c.uuid);
      }
    })();
    return { accepted, rejected };
  });
}
