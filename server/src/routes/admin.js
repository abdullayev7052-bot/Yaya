import bcrypt from 'bcryptjs';
import { audit } from '../db/index.js';
import { createLoginGuard } from '../ratelimit.js';
import { summary, exportRows, toCsv, parseRange, LOCAL_DAY } from '../reports.js';

// What each panel role may do. Higher roles include everything of lower ones.
const LEVEL = { viewer: 1, manager: 2, admin: 3 };
const ROLES = Object.keys(LEVEL);

// API used by the admin panel.
export default async function adminRoutes(app, { db }) {
  const guard = createLoginGuard();

  const authAs = (minRole) => async (req, reply) => {
    try {
      await req.jwtVerify();
      if (req.user.kind !== 'user') throw new Error('kind');
    } catch {
      return reply.code(401).send({ error: 'Avtorizatsiya kerak' });
    }
    // Re-read the user each time so deactivation or a role change applies at once.
    const u = db.prepare('SELECT id, login, name, role, active FROM users WHERE id = ?').get(req.user.id);
    if (!u || !u.active) return reply.code(401).send({ error: 'Avtorizatsiya kerak' });
    if (LEVEL[u.role] < LEVEL[minRole]) return reply.code(403).send({ error: 'Bu amal uchun ruxsatingiz yo\'q' });
    req.panelUser = u;
  };
  const viewer = { preHandler: authAs('viewer') };
  const manager = { preHandler: authAs('manager') };
  const admin = { preHandler: authAs('admin') };
  const log = (req, action, details) => audit(db, `user:${req.panelUser.login}`, action, details);

  const str = (v, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);
  const bad = (reply, msg) => reply.code(400).send({ error: msg });

  // ---------------------------------------------------------------- auth
  app.post('/login', async (req, reply) => {
    const { login, password } = req.body ?? {};
    const key = `${req.ip}|${String(login).toLowerCase()}`;
    const wait = guard.blocked(key);
    if (wait) return reply.code(429).send({ error: `Juda ko'p urinish. ${wait} daqiqadan keyin qayta urinib ko'ring.` });
    const u = db.prepare('SELECT * FROM users WHERE login = ? AND active = 1').get(login);
    if (!u || !bcrypt.compareSync(String(password ?? ''), u.password_hash)) {
      guard.fail(key);
      return reply.code(401).send({ error: 'Login yoki parol noto\'g\'ri' });
    }
    guard.reset(key);
    audit(db, `user:${u.login}`, 'login');
    return { token: app.jwt.sign({ kind: 'user', id: u.id }, { expiresIn: '12h' }), user: { login: u.login, name: u.name, role: u.role } };
  });

  app.get('/me', viewer, async (req) => req.panelUser);

  app.put('/password', viewer, async (req, reply) => {
    const { current, next } = req.body ?? {};
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.panelUser.id);
    if (!bcrypt.compareSync(String(current ?? ''), u.password_hash)) return bad(reply, 'Joriy parol noto\'g\'ri');
    if (!next || String(next).length < 8) return bad(reply, 'Yangi parol kamida 8 belgi bo\'lsin');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(next), 10), u.id);
    log(req, 'password.change');
    return { ok: true };
  });

  // ---------------------------------------------------------------- panel users (admin only)
  app.get('/users', admin, async () =>
    db.prepare('SELECT id, login, name, role, active, created_at FROM users ORDER BY login').all());

  app.post('/users', admin, async (req, reply) => {
    const { login, name, password, role } = req.body ?? {};
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(login ?? '')) return bad(reply, 'Login 3–32 belgi: harf, raqam, _ . -');
    if (!password || String(password).length < 8) return bad(reply, 'Parol kamida 8 belgi bo\'lsin');
    if (!ROLES.includes(role)) return bad(reply, 'Rol noto\'g\'ri');
    if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) return bad(reply, 'Bu login band');
    const info = db.prepare('INSERT INTO users (login, name, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(login, str(name), bcrypt.hashSync(String(password), 10), role);
    log(req, 'user.create', { login, role });
    return { id: info.lastInsertRowid };
  });

  app.patch('/users/:id', admin, async (req, reply) => {
    const id = Number(req.params.id);
    const { name, password, role, active } = req.body ?? {};
    if (role != null && !ROLES.includes(role)) return bad(reply, 'Rol noto\'g\'ri');
    if (password != null && String(password).length < 8) return bad(reply, 'Parol kamida 8 belgi bo\'lsin');
    // Never lock everyone out: the last active admin cannot be demoted or disabled.
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) return reply.code(404).send({ error: 'Topilmadi' });
    const losesAdmin = target.role === 'admin' && target.active && ((role && role !== 'admin') || active === 0 || active === false);
    if (losesAdmin && db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1").get().n <= 1) {
      return bad(reply, 'Kamida bitta faol admin qolishi kerak');
    }
    db.prepare(`UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role),
      password_hash = COALESCE(?, password_hash), active = COALESCE(?, active) WHERE id = ?`)
      .run(str(name), role ?? null, password ? bcrypt.hashSync(String(password), 10) : null,
        active == null ? null : Number(!!active), id);
    log(req, 'user.update', { id, role, active, passwordChanged: !!password });
    return { ok: true };
  });

  // ---------------------------------------------------------------- reference data
  // Generic list/create/update for the simple tables.
  const simple = {
    suppliers: { fields: ['name', 'phone', 'address', 'note'], required: 'name' },
    products: { fields: ['name', 'unit'], required: 'name' },
    warehouses: { fields: ['name'], required: 'name' },
  };
  for (const [table, def] of Object.entries(simple)) {
    app.get(`/${table}`, viewer, async () => db.prepare(`SELECT * FROM ${table} ORDER BY active DESC, name`).all());

    app.post(`/${table}`, manager, async (req, reply) => {
      const vals = def.fields.map((f) => str(req.body?.[f]));
      if (!vals[def.fields.indexOf(def.required)]) return bad(reply, 'Nomi shart');
      if (table === 'products' && !vals[1]) vals[1] = 'kg';
      const info = db.prepare(`INSERT INTO ${table} (${def.fields.join(', ')}) VALUES (${def.fields.map(() => '?').join(', ')})`).run(...vals);
      log(req, `${table}.create`, { id: info.lastInsertRowid, name: vals[0] });
      return { id: info.lastInsertRowid };
    });

    app.patch(`/${table}/:id`, manager, async (req, reply) => {
      const b = req.body ?? {};
      const sets = [];
      const vals = [];
      for (const f of def.fields) {
        if (b[f] === undefined) continue;
        const v = str(b[f]);
        if (f === def.required && !v) return bad(reply, 'Nomi bo\'sh bo\'lmasin');
        sets.push(`${f} = ?`);
        vals.push(v);
      }
      if (b.active !== undefined) { sets.push('active = ?'); vals.push(Number(!!b.active)); }
      if (!sets.length) return { ok: true };
      const r = db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...vals, Number(req.params.id));
      if (!r.changes) return reply.code(404).send({ error: 'Topilmadi' });
      log(req, `${table}.update`, { id: Number(req.params.id), ...b });
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------- collectors
  app.get('/employees', viewer, async () => db.prepare(`
    SELECT e.id, e.name, e.phone, e.warehouse_id, e.is_test, e.active,
      (SELECT COUNT(*) FROM employee_suppliers es WHERE es.employee_id = e.id) AS supplier_count
    FROM employees e ORDER BY e.is_test, e.active DESC, e.name`).all());

  const phoneOk = (p) => /^\d{9,12}$/.test(p ?? '');
  const pinOk = (p) => /^\d{4,6}$/.test(String(p ?? ''));

  app.post('/employees', manager, async (req, reply) => {
    const { name, pin, warehouseId, isTest } = req.body ?? {};
    const phone = String(req.body?.phone ?? '').replace(/\D/g, '');
    if (!str(name)) return bad(reply, 'Ism shart');
    if (!phoneOk(phone)) return bad(reply, 'Telefon 9–12 raqam bo\'lsin');
    if (!pinOk(pin)) return bad(reply, 'PIN 4–6 raqam bo\'lsin');
    if (db.prepare('SELECT 1 FROM employees WHERE phone = ?').get(phone)) return bad(reply, 'Bu telefon raqam band');
    const info = db.prepare('INSERT INTO employees (name, phone, pin_hash, warehouse_id, is_test) VALUES (?, ?, ?, ?, ?)')
      .run(str(name), phone, bcrypt.hashSync(String(pin), 10), warehouseId || null, Number(!!isTest));
    log(req, 'employees.create', { id: info.lastInsertRowid, name, isTest: !!isTest });
    return { id: info.lastInsertRowid };
  });

  app.patch('/employees/:id', manager, async (req, reply) => {
    const { name, pin, warehouseId, active, isTest } = req.body ?? {};
    const phone = req.body?.phone == null ? null : String(req.body.phone).replace(/\D/g, '');
    if (phone != null && !phoneOk(phone)) return bad(reply, 'Telefon 9–12 raqam bo\'lsin');
    if (pin != null && pin !== '' && !pinOk(pin)) return bad(reply, 'PIN 4–6 raqam bo\'lsin');
    if (phone && db.prepare('SELECT 1 FROM employees WHERE phone = ? AND id != ?').get(phone, req.params.id)) return bad(reply, 'Bu telefon raqam band');
    db.prepare(`UPDATE employees SET name = COALESCE(?, name), phone = COALESCE(?, phone),
      pin_hash = COALESCE(?, pin_hash), warehouse_id = CASE WHEN ? THEN ? ELSE warehouse_id END,
      active = COALESCE(?, active), is_test = COALESCE(?, is_test) WHERE id = ?`)
      .run(str(name), phone, pin ? bcrypt.hashSync(String(pin), 10) : null,
        Number(warehouseId !== undefined), warehouseId || null,
        active == null ? null : Number(!!active), isTest == null ? null : Number(!!isTest), req.params.id);
    log(req, 'employees.update', { id: Number(req.params.id), name, phone, warehouseId, active, isTest, pinChanged: !!pin });
    return { ok: true };
  });

  app.get('/employees/:id/suppliers', viewer, async (req) =>
    db.prepare('SELECT supplier_id FROM employee_suppliers WHERE employee_id = ? ORDER BY sort_order')
      .all(req.params.id).map((x) => x.supplier_id));

  // Replace the full, ordered list of suppliers assigned to a collector.
  app.put('/employees/:id/suppliers', manager, async (req) => {
    const ids = (req.body?.supplierIds ?? []).map(Number).filter(Number.isInteger);
    db.transaction(() => {
      db.prepare('DELETE FROM employee_suppliers WHERE employee_id = ?').run(req.params.id);
      const ins = db.prepare('INSERT OR IGNORE INTO employee_suppliers (employee_id, supplier_id, sort_order) VALUES (?, ?, ?)');
      ids.forEach((sid, i) => ins.run(req.params.id, sid, i));
    })();
    log(req, 'employees.assign', { id: Number(req.params.id), count: ids.length });
    return { ok: true };
  });

  // ---------------------------------------------------------------- prices
  app.get('/supplier-products', viewer, async () => db.prepare(`
    SELECT sp.*, s.name AS supplier_name, p.name AS product_name, p.unit
    FROM supplier_products sp JOIN suppliers s ON s.id = sp.supplier_id JOIN products p ON p.id = sp.product_id
    ORDER BY s.name, sp.is_default DESC, p.name`).all());

  app.put('/supplier-products', manager, async (req, reply) => {
    const { supplierId, productId, isDefault } = req.body ?? {};
    const price = Number(req.body?.price);
    if (!supplierId || !productId || !Number.isFinite(price) || price < 0 || price > 1e9) return bad(reply, 'Narx noto\'g\'ri');
    db.transaction(() => {
      if (isDefault) db.prepare('UPDATE supplier_products SET is_default = 0 WHERE supplier_id = ?').run(supplierId);
      db.prepare(`INSERT INTO supplier_products (supplier_id, product_id, price, is_default) VALUES (?, ?, ?, ?)
        ON CONFLICT(supplier_id, product_id) DO UPDATE SET price = excluded.price, is_default = excluded.is_default`)
        .run(supplierId, productId, price, isDefault ? 1 : 0);
      // A supplier with products must always have exactly one default.
      if (!db.prepare('SELECT 1 FROM supplier_products WHERE supplier_id = ? AND is_default = 1').get(supplierId)) {
        db.prepare('UPDATE supplier_products SET is_default = 1 WHERE supplier_id = ? AND product_id = ?').run(supplierId, productId);
      }
    })();
    log(req, 'price.set', { supplierId, productId, price });
    return { ok: true };
  });

  app.delete('/supplier-products/:supplierId/:productId', manager, async (req) => {
    const { supplierId, productId } = req.params;
    db.transaction(() => {
      db.prepare('DELETE FROM supplier_products WHERE supplier_id = ? AND product_id = ?').run(supplierId, productId);
      if (!db.prepare('SELECT 1 FROM supplier_products WHERE supplier_id = ? AND is_default = 1').get(supplierId)) {
        db.prepare('UPDATE supplier_products SET is_default = 1 WHERE rowid = (SELECT MIN(rowid) FROM supplier_products WHERE supplier_id = ?)').run(supplierId);
      }
    })();
    log(req, 'price.remove', { supplierId: Number(supplierId), productId: Number(productId) });
    return { ok: true };
  });

  // ---------------------------------------------------------------- pickups
  app.get('/collections', viewer, async (req) => {
    const q = req.query;
    const { from, to } = parseRange(q);
    const num = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
    return db.prepare(`
      SELECT c.id, c.collected_at, c.received_at, c.quantity, c.price, CAST(ROUND(c.quantity * c.price) AS INTEGER) AS amount,
        c.voided_at, c.void_reason, c.voided_by, e.name AS employee_name, e.is_test,
        s.name AS supplier_name, p.name AS product_name, p.unit
      FROM collections c JOIN employees e ON e.id = c.employee_id
      JOIN suppliers s ON s.id = c.supplier_id JOIN products p ON p.id = c.product_id
      WHERE ${LOCAL_DAY} BETWEEN @from AND @to
        AND (@employee IS NULL OR c.employee_id = @employee)
        AND (@supplier IS NULL OR c.supplier_id = @supplier)
        AND (@voided = 1 OR c.voided_at IS NULL)
      ORDER BY c.collected_at DESC LIMIT 2000`).all({ from, to, employee: num(q.employee), supplier: num(q.supplier), voided: q.voided === '1' ? 1 : 0 });
  });

  // Mistakes are never deleted: they are voided with a reason and drop out of all totals.
  app.post('/collections/:id/void', manager, async (req, reply) => {
    const reason = str(req.body?.reason, 300);
    if (!reason) return bad(reply, 'Sababini yozing');
    const r = db.prepare('UPDATE collections SET voided_at = datetime(\'now\'), void_reason = ?, voided_by = ? WHERE id = ? AND voided_at IS NULL')
      .run(reason, req.panelUser.login, req.params.id);
    if (!r.changes) return reply.code(404).send({ error: 'Topilmadi yoki allaqachon bekor qilingan' });
    log(req, 'collection.void', { id: Number(req.params.id), reason });
    return { ok: true };
  });

  app.post('/collections/:id/restore', manager, async (req) => {
    db.prepare('UPDATE collections SET voided_at = NULL, void_reason = NULL, voided_by = NULL WHERE id = ?').run(req.params.id);
    log(req, 'collection.restore', { id: Number(req.params.id) });
    return { ok: true };
  });

  // ---------------------------------------------------------------- analytics
  app.get('/reports/summary', viewer, async (req) => summary(db, req.query));

  app.get('/reports/export.csv', viewer, async (req, reply) => {
    const { from, to } = parseRange(req.query);
    const csv = toCsv(exportRows(db, req.query), [
      ['id', 'ID'], ['local_time', 'Vaqt'], ['employee', 'Sut yig\'uvchi'], ['supplier', 'Yetkazib beruvchi'],
      ['product', 'Mahsulot'], ['unit', 'Birlik'], ['quantity', 'Miqdor'], ['price', 'Narx'], ['amount', 'Summa'],
    ]);
    log(req, 'report.export', { from, to });
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="yaya_${from}_${to}.csv"`);
    return csv;
  });

  app.get('/dashboard', viewer, async () => {
    const today = parseRange({});
    const d30 = new Date(Date.parse(today.to) - 29 * 864e5).toISOString().slice(0, 10);
    const openShifts = db.prepare(`SELECT e.name, s.opened_at,
        (SELECT COUNT(*) FROM collections c WHERE c.shift_uuid = s.client_uuid AND c.voided_at IS NULL) AS pickups
      FROM shifts s JOIN employees e ON e.id = s.employee_id
      WHERE s.closed_at IS NULL AND e.is_test = 0 ORDER BY s.opened_at`).all();
    const lastSync = db.prepare(`SELECT e.name, MAX(c.received_at) AS at FROM collections c
      JOIN employees e ON e.id = c.employee_id WHERE e.active = 1 AND e.is_test = 0 GROUP BY e.id ORDER BY e.name`).all();
    return { today: summary(db, today), month: summary(db, { from: d30, to: today.to }), openShifts, lastSync };
  });

  // ---------------------------------------------------------------- test mode & audit
  // Removes everything entered by test collectors (the in-browser app tester).
  app.delete('/test-data', admin, async (req) => {
    const r = db.transaction(() => {
      const c = db.prepare('DELETE FROM collections WHERE employee_id IN (SELECT id FROM employees WHERE is_test = 1)').run().changes;
      db.prepare('DELETE FROM shifts WHERE employee_id IN (SELECT id FROM employees WHERE is_test = 1)').run();
      return c;
    })();
    log(req, 'test-data.clear', { collections: r });
    return { deleted: r };
  });

  app.get('/audit', admin, async () =>
    db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300').all());
}
