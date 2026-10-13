import bcrypt from 'bcryptjs';

// API used by the admin panel.
export default async function adminRoutes(app, { db }) {
  const auth = async (req, reply) => {
    try {
      await req.jwtVerify();
      if (req.user.role !== 'admin') throw new Error('role');
    } catch {
      return reply.code(401).send({ error: 'Avtorizatsiya kerak' });
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

    r.get('/suppliers', async () => db.prepare('SELECT * FROM suppliers ORDER BY name').all());
    r.get('/products', async () => db.prepare('SELECT * FROM products ORDER BY name').all());
    r.get('/warehouses', async () => db.prepare('SELECT * FROM warehouses ORDER BY name').all());

    r.get('/employees', async () =>
      db.prepare('SELECT id, name, phone, warehouse_id, active FROM employees ORDER BY name').all());

    r.post('/employees', async (req, reply) => {
      const { name, phone, pin, warehouseId } = req.body ?? {};
      if (!name || !phone || !pin) return reply.code(400).send({ error: 'Ism, telefon va PIN shart' });
      const info = db.prepare('INSERT INTO employees (name, phone, pin_hash, warehouse_id) VALUES (?, ?, ?, ?)')
        .run(name, phone, bcrypt.hashSync(String(pin), 10), warehouseId ?? null);
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
      SELECT sp.*, s.name AS supplier_name, p.name AS product_name
      FROM supplier_products sp JOIN suppliers s ON s.id = sp.supplier_id JOIN products p ON p.id = sp.product_id
      ORDER BY s.name`).all());

    r.put('/supplier-products', async (req, reply) => {
      const { supplierId, productId, price } = req.body ?? {};
      if (!supplierId || !productId || !(price >= 0)) return reply.code(400).send({ error: 'Noto\'g\'ri ma\'lumot' });
      db.prepare(`INSERT INTO supplier_products (supplier_id, product_id, price) VALUES (?, ?, ?)
        ON CONFLICT(supplier_id, product_id) DO UPDATE SET price = excluded.price`).run(supplierId, productId, price);
      return { ok: true };
    });

    r.get('/collections', async (req) => db.prepare(`
      SELECT c.*, e.name AS employee_name, s.name AS supplier_name, p.name AS product_name
      FROM collections c JOIN employees e ON e.id = c.employee_id
      JOIN suppliers s ON s.id = c.supplier_id JOIN products p ON p.id = c.product_id
      WHERE (? IS NULL OR c.bito_status = ?)
      ORDER BY c.collected_at DESC LIMIT 500`).all(req.query.status ?? null, req.query.status ?? null));

    // Retry rows that failed permanently (e.g. after fixing settings in Bito).
    r.post('/collections/retry', async () =>
      ({ changed: db.prepare(`UPDATE collections SET bito_status='pending', bito_attempts=0 WHERE bito_status='error'`).run().changes }));
  });
}
