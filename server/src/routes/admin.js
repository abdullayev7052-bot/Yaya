import bcrypt from 'bcryptjs';
import { BitoNotConfiguredError } from '../bito/client.js';
import { syncReferenceData } from '../bito/sync.js';

// API used by the admin panel.
export default async function adminRoutes(app, { db, bito }) {
  const auth = async (req, reply) => {
    try {
      await req.jwtVerify();
      if (req.user.role !== 'admin') throw new Error('role');
    } catch {
      return reply.code(401).send({ error: 'Avtorizatsiya kerak' });
    }
  };

  // Turn Bito failures into a readable message for the admin instead of a 500.
  const viaBito = (fn) => async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (err) {
      const code = err instanceof BitoNotConfiguredError ? 503 : 502;
      return reply.code(code).send({ error: err.message });
    }
  };

  app.post('/login', async (req, reply) => {
    const { login, password } = req.body ?? {};
    const a = db.prepare('SELECT * FROM admins WHERE login = ?').get(login);
    if (!a || !bcrypt.compareSync(password ?? '', a.password_hash)) {
      return reply.code(401).send({ error: 'Login yoki parol noto\'g\'ri' });
    }
    return { token: app.jwt.sign({ role: 'admin', id: a.id }, { expiresIn: '12h' }) };
  });

  app.register(async (r) => {
    r.addHook('preHandler', auth);

    r.post('/bito/sync', viaBito(async () => syncReferenceData(db, bito)));

    r.get('/suppliers', async () => db.prepare('SELECT * FROM suppliers ORDER BY active DESC, name').all());
    r.get('/products', async () => db.prepare('SELECT * FROM products ORDER BY active DESC, name').all());
    r.get('/warehouses', async () => db.prepare('SELECT * FROM warehouses ORDER BY name').all());

    // Records created here are created in Bito first, so both sides always match.
    r.post('/suppliers', viaBito(async (req, reply) => {
      const { name, phone, address } = req.body ?? {};
      if (!name) return reply.code(400).send({ error: 'Ism shart' });
      const { bito_id } = await bito.createSupplier({ name, phone, address });
      const info = db.prepare(`INSERT INTO suppliers (bito_id, name, phone, address, synced_at)
        VALUES (?, ?, ?, ?, datetime('now'))`).run(String(bito_id), name, phone ?? null, address ?? null);
      return { id: info.lastInsertRowid };
    }));

    r.post('/products', viaBito(async (req, reply) => {
      const { name, unit } = req.body ?? {};
      if (!name) return reply.code(400).send({ error: 'Nomi shart' });
      const { bito_id } = await bito.createProduct({ name, unit });
      const info = db.prepare(`INSERT INTO products (bito_id, name, unit, synced_at)
        VALUES (?, ?, ?, datetime('now'))`).run(String(bito_id), name, unit ?? null);
      return { id: info.lastInsertRowid };
    }));

    r.post('/warehouses', viaBito(async (req, reply) => {
      const { name } = req.body ?? {};
      if (!name) return reply.code(400).send({ error: 'Nomi shart' });
      const { bito_id } = await bito.createWarehouse({ name });
      const info = db.prepare(`INSERT INTO warehouses (bito_id, name, synced_at)
        VALUES (?, ?, datetime('now'))`).run(String(bito_id), name);
      return { id: info.lastInsertRowid };
    }));

    r.get('/employees', async () =>
      db.prepare('SELECT id, name, phone, warehouse_id, active FROM employees ORDER BY name').all());

    r.post('/employees', async (req, reply) => {
      const { name, phone, pin, warehouseId } = req.body ?? {};
      if (!name || !phone || !pin) return reply.code(400).send({ error: 'Ism, telefon va PIN shart' });
      if (!warehouseId) return reply.code(400).send({ error: 'Xodimning omborini tanlang' });
      const info = db.prepare('INSERT INTO employees (name, phone, pin_hash, warehouse_id) VALUES (?, ?, ?, ?)')
        .run(name, phone, bcrypt.hashSync(String(pin), 10), warehouseId);
      return { id: info.lastInsertRowid };
    });

    r.patch('/employees/:id', async (req) => {
      const { name, phone, pin, warehouseId, active } = req.body ?? {};
      db.prepare(`UPDATE employees SET
        name = COALESCE(?, name), phone = COALESCE(?, phone),
        pin_hash = COALESCE(?, pin_hash), warehouse_id = COALESCE(?, warehouse_id),
        active = COALESCE(?, active) WHERE id = ?`)
        .run(name ?? null, phone ?? null, pin ? bcrypt.hashSync(String(pin), 10) : null,
          warehouseId ?? null, active == null ? null : Number(active), req.params.id);
      return { ok: true };
    });

    // Replace the full list of suppliers assigned to a collector.
    r.put('/employees/:id/suppliers', async (req) => {
      const ids = req.body?.supplierIds ?? [];
      db.transaction(() => {
        db.prepare('DELETE FROM employee_suppliers WHERE employee_id = ?').run(req.params.id);
        const ins = db.prepare('INSERT INTO employee_suppliers (employee_id, supplier_id, sort_order) VALUES (?, ?, ?)');
        ids.forEach((sid, i) => ins.run(req.params.id, sid, i));
      })();
      return { ok: true };
    });

    r.get('/employees/:id/suppliers', async (req) =>
      db.prepare('SELECT supplier_id FROM employee_suppliers WHERE employee_id = ? ORDER BY sort_order')
        .all(req.params.id).map((x) => x.supplier_id));

    r.get('/supplier-products', async () => db.prepare(`
      SELECT sp.*, s.name AS supplier_name, p.name AS product_name, p.unit
      FROM supplier_products sp JOIN suppliers s ON s.id = sp.supplier_id JOIN products p ON p.id = sp.product_id
      ORDER BY s.name, sp.is_default DESC, p.name`).all());

    // Set the price a given supplier gets for a given product (prices differ per supplier).
    r.put('/supplier-products', async (req, reply) => {
      const { supplierId, productId, price, isDefault } = req.body ?? {};
      if (!supplierId || !productId || !(Number(price) >= 0)) return reply.code(400).send({ error: 'Noto\'g\'ri ma\'lumot' });
      db.transaction(() => {
        if (isDefault) db.prepare('UPDATE supplier_products SET is_default = 0 WHERE supplier_id = ?').run(supplierId);
        db.prepare(`INSERT INTO supplier_products (supplier_id, product_id, price, is_default) VALUES (?, ?, ?, ?)
          ON CONFLICT(supplier_id, product_id) DO UPDATE SET price = excluded.price, is_default = excluded.is_default`)
          .run(supplierId, productId, Number(price), isDefault ? 1 : 0);
      })();
      return { ok: true };
    });

    r.delete('/supplier-products/:supplierId/:productId', async (req) => {
      db.prepare('DELETE FROM supplier_products WHERE supplier_id = ? AND product_id = ?')
        .run(req.params.supplierId, req.params.productId);
      return { ok: true };
    });

    r.get('/collections', async (req) => db.prepare(`
      SELECT c.*, e.name AS employee_name, s.name AS supplier_name, p.name AS product_name, p.unit
      FROM collections c JOIN employees e ON e.id = c.employee_id
      JOIN suppliers s ON s.id = c.supplier_id JOIN products p ON p.id = c.product_id
      WHERE (? IS NULL OR c.bito_status = ?)
      ORDER BY c.collected_at DESC LIMIT 500`).all(req.query.status ?? null, req.query.status ?? null));

    // Retry rows that failed permanently (e.g. after fixing settings in Bito).
    r.post('/collections/retry', async () =>
      ({ changed: db.prepare(`UPDATE collections SET bito_status='pending', bito_attempts=0 WHERE bito_status='error'`).run().changes }));
  });
}
