import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { audit, roleIdByCode } from '../db/index.js';
import { createLoginGuard } from '../ratelimit.js';
import { PERMISSIONS, PERMISSION_KEYS, permsOf } from '../permissions.js';
import { summary, exportRows, toCsv, parseRange, dailyCost, todayLocal, LOCAL_DAY } from '../reports.js';
import { balances, statement } from '../ledger.js';
import { templateXlsx, importSuppliers } from '../importer.js';
import { getSetting, setSetting } from '../settings.js';

// Fields that reveal money. Stripped from every response for users without
// the amounts.view permission, so hiding prices cannot be bypassed by the UI.
const MONEY_KEYS = new Set(['price', 'amount', 'avg_price', 'avg_cost', 'min_price', 'max_price', 'balance',
  'opening_balance', 'purchased', 'paid', 'weOwe', 'theyOwe', 'opening']);
function stripMoney(v) {
  if (Array.isArray(v)) return v.map(stripMoney);
  if (v && typeof v === 'object' && !(v instanceof Buffer)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (!MONEY_KEYS.has(k)) out[k] = stripMoney(x);
    return out;
  }
  return v;
}

const METHODS = ['cash', 'card', 'transfer'];

export default async function adminRoutes(app, { db }) {
  const guard = createLoginGuard();
  const str = (v, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);
  const bad = (reply, msg) => reply.code(400).send({ error: msg });
  const num = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

  const loadUser = (id) => {
    const u = db.prepare(`SELECT u.id, u.login, u.name, u.active, u.role_id, r.name AS role_name, r.code AS role_code
      FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?`).get(id);
    if (u) u.perms = permsOf(db, u.role_id);
    return u;
  };
  const publicUser = (u) => ({ id: u.id, login: u.login, name: u.name, role: u.role_name, roleCode: u.role_code, permissions: [...u.perms] });

  // Every route declares the permission it needs; the user and role are re-read
  // on each request, so a change in the panel applies immediately.
  const need = (...perms) => ({
    preHandler: async (req, reply) => {
      try {
        await req.jwtVerify();
        if (req.user.kind !== 'user') throw new Error('kind');
      } catch {
        return reply.code(401).send({ error: 'Avtorizatsiya kerak' });
      }
      const u = loadUser(req.user.id);
      if (!u || !u.active) return reply.code(401).send({ error: 'Avtorizatsiya kerak' });
      if (!perms.every((p) => u.perms.has(p))) return reply.code(403).send({ error: 'Bu amal uchun ruxsatingiz yo\'q' });
      req.panelUser = u;
    },
  });
  const signedIn = need();
  const has = (req, p) => req.panelUser.perms.has(p);
  const log = (req, action, details) => audit(db, `user:${req.panelUser.login}`, action, details);

  app.addHook('preSerialization', async (req, reply, payload) =>
    (req.panelUser && !req.panelUser.perms.has('amounts.view') ? stripMoney(payload) : payload));

  // ---------------------------------------------------------------- auth
  app.post('/login', async (req, reply) => {
    const { login, password } = req.body ?? {};
    const key = `${req.ip}|${String(login).toLowerCase()}`;
    const wait = guard.blocked(key);
    if (wait) return reply.code(429).send({ error: `Juda ko'p urinish. ${wait} daqiqadan keyin qayta urinib ko'ring.` });
    const row = db.prepare('SELECT * FROM users WHERE login = ? AND active = 1').get(login);
    if (!row || !bcrypt.compareSync(String(password ?? ''), row.password_hash)) {
      guard.fail(key);
      return reply.code(401).send({ error: 'Login yoki parol noto\'g\'ri' });
    }
    guard.reset(key);
    audit(db, `user:${row.login}`, 'login');
    return { token: app.jwt.sign({ kind: 'user', id: row.id }, { expiresIn: '12h' }), user: publicUser(loadUser(row.id)) };
  });

  app.get('/me', signedIn, async (req) => publicUser(req.panelUser));

  app.put('/password', signedIn, async (req, reply) => {
    const { current, next } = req.body ?? {};
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.panelUser.id);
    if (!bcrypt.compareSync(String(current ?? ''), u.password_hash)) return bad(reply, 'Joriy parol noto\'g\'ri');
    if (!next || String(next).length < 8) return bad(reply, 'Yangi parol kamida 8 belgi bo\'lsin');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(next), 10), u.id);
    log(req, 'password.change');
    return { ok: true };
  });

  // ---------------------------------------------------------------- roles & permissions
  app.get('/permissions', signedIn, async () => PERMISSIONS);

  app.get('/roles', signedIn, async () => db.prepare(`SELECT r.*,
      (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS users,
      (SELECT COUNT(*) FROM employees e WHERE e.role_id = r.id) AS employees
    FROM roles r ORDER BY r.locked DESC, r.id`).all()
    .map((r) => ({ ...r, permissions: r.code === 'admin' ? PERMISSIONS.map((p) => p.key) : JSON.parse(r.permissions) })));

  const cleanPerms = (list) => [...new Set((Array.isArray(list) ? list : []).filter((k) => PERMISSION_KEYS.has(k)))];

  app.post('/roles', need('users.manage'), async (req, reply) => {
    const name = str(req.body?.name, 60);
    if (!name) return bad(reply, 'Nomi shart');
    const id = db.prepare('INSERT INTO roles (name, permissions) VALUES (?, ?)').run(name, JSON.stringify(cleanPerms(req.body?.permissions))).lastInsertRowid;
    log(req, 'role.create', { id, name });
    return { id };
  });

  app.patch('/roles/:id', need('users.manage'), async (req, reply) => {
    const r = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'Topilmadi' });
    if (r.locked) return bad(reply, 'Admin roli o\'zgartirilmaydi — u doim barcha ruxsatlarga ega');
    const name = req.body?.name === undefined ? r.name : str(req.body.name, 60);
    if (!name) return bad(reply, 'Nomi shart');
    const perms = req.body?.permissions === undefined ? JSON.parse(r.permissions) : cleanPerms(req.body.permissions);
    db.prepare('UPDATE roles SET name = ?, permissions = ? WHERE id = ?').run(name, JSON.stringify(perms), r.id);
    log(req, 'role.update', { id: r.id, name, permissions: perms });
    return { ok: true };
  });

  app.delete('/roles/:id', need('users.manage'), async (req, reply) => {
    const r = db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM users WHERE role_id = r.id) + (SELECT COUNT(*) FROM employees WHERE role_id = r.id) AS used
      FROM roles r WHERE id = ?`).get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'Topilmadi' });
    if (r.code) return bad(reply, 'Tayyor rollarni o\'chirib bo\'lmaydi');
    if (r.used) return bad(reply, 'Bu rol kimgadir biriktirilgan. Avval ularni boshqa rolga o\'tkazing.');
    db.prepare('DELETE FROM roles WHERE id = ?').run(r.id);
    log(req, 'role.delete', { id: r.id, name: r.name });
    return { ok: true };
  });

  // ---------------------------------------------------------------- panel users
  app.get('/users', need('users.manage'), async () => db.prepare(`SELECT u.id, u.login, u.name, u.role_id, r.name AS role_name, u.active, u.created_at
    FROM users u LEFT JOIN roles r ON r.id = u.role_id ORDER BY u.login`).all());

  const adminRole = () => roleIdByCode(db, 'admin');
  const activeAdmins = () => db.prepare('SELECT COUNT(*) n FROM users WHERE role_id = ? AND active = 1').get(adminRole()).n;
  const roleExists = (id) => !!db.prepare('SELECT 1 FROM roles WHERE id = ?').get(id);

  app.post('/users', need('users.manage'), async (req, reply) => {
    const { login, name, password } = req.body ?? {};
    const roleId = num(req.body?.roleId);
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(login ?? '')) return bad(reply, 'Login 3–32 belgi: harf, raqam, _ . -');
    if (!password || String(password).length < 8) return bad(reply, 'Parol kamida 8 belgi bo\'lsin');
    if (!roleId || !roleExists(roleId)) return bad(reply, 'Rolni tanlang');
    if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) return bad(reply, 'Bu login band');
    const id = db.prepare('INSERT INTO users (login, name, password_hash, role_id) VALUES (?, ?, ?, ?)')
      .run(login, str(name), bcrypt.hashSync(String(password), 10), roleId).lastInsertRowid;
    log(req, 'user.create', { login, roleId });
    return { id };
  });

  app.patch('/users/:id', need('users.manage'), async (req, reply) => {
    const id = Number(req.params.id);
    const { name, password, active } = req.body ?? {};
    const roleId = req.body?.roleId == null ? null : num(req.body.roleId);
    if (req.body?.roleId != null && (!roleId || !roleExists(roleId))) return bad(reply, 'Rol noto\'g\'ri');
    if (password != null && String(password).length < 8) return bad(reply, 'Parol kamida 8 belgi bo\'lsin');
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) return reply.code(404).send({ error: 'Topilmadi' });
    // Never lock everyone out: the last active admin keeps the admin role.
    const losesAdmin = target.role_id === adminRole() && target.active && ((roleId && roleId !== adminRole()) || active === false || active === 0);
    if (losesAdmin && activeAdmins() <= 1) return bad(reply, 'Kamida bitta faol admin qolishi kerak');
    db.prepare(`UPDATE users SET name = COALESCE(?, name), role_id = COALESCE(?, role_id),
      password_hash = COALESCE(?, password_hash), active = COALESCE(?, active) WHERE id = ?`)
      .run(str(name), roleId, password ? bcrypt.hashSync(String(password), 10) : null, active == null ? null : Number(!!active), id);
    log(req, 'user.update', { id, roleId, active, passwordChanged: !!password });
    return { ok: true };
  });

  // ---------------------------------------------------------------- reference data
  const simple = {
    suppliers: { fields: ['name', 'phone', 'address', 'note'], view: 'suppliers.view', manage: 'suppliers.manage' },
    products: { fields: ['name', 'unit'], view: null, manage: 'catalog.manage' },
    warehouses: { fields: ['name'], view: null, manage: 'catalog.manage' },
  };
  for (const [table, def] of Object.entries(simple)) {
    app.get(`/${table}`, def.view ? need(def.view) : signedIn, async () =>
      db.prepare(`SELECT * FROM ${table} ORDER BY active DESC, name`).all());

    app.post(`/${table}`, need(def.manage), async (req, reply) => {
      const vals = def.fields.map((f) => str(req.body?.[f]));
      if (!vals[0]) return bad(reply, 'Nomi shart');
      if (table === 'products' && !vals[1]) vals[1] = 'kg';
      if (table === 'suppliers' && vals[1]) vals[1] = vals[1].replace(/[^\d+]/g, '');
      const id = db.prepare(`INSERT INTO ${table} (${def.fields.join(', ')}) VALUES (${def.fields.map(() => '?').join(', ')})`).run(...vals).lastInsertRowid;
      if (table === 'suppliers' && req.body?.openingBalance != null && has(req, 'payments.create')) {
        db.prepare('UPDATE suppliers SET opening_balance = ? WHERE id = ?').run(Number(req.body.openingBalance) || 0, id);
      }
      log(req, `${table}.create`, { id, name: vals[0] });
      return { id };
    });

    app.patch(`/${table}/:id`, need(def.manage), async (req, reply) => {
      const b = req.body ?? {};
      const sets = [];
      const vals = [];
      for (const f of def.fields) {
        if (b[f] === undefined) continue;
        let v = str(b[f]);
        if (f === 'name' && !v) return bad(reply, 'Nomi bo\'sh bo\'lmasin');
        if (table === 'suppliers' && f === 'phone' && v) v = v.replace(/[^\d+]/g, '');
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

  // ---------------------------------------------------------------- supplier card, import
  app.get('/suppliers/:id/card', need('suppliers.view'), async (req, reply) => {
    const id = Number(req.params.id);
    const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    if (!s) return reply.code(404).send({ error: 'Topilmadi' });
    const to = todayLocal();
    const from = new Date(Date.parse(to) - 59 * 864e5).toISOString().slice(0, 10);
    const card = {
      supplier: s,
      products: db.prepare(`SELECT p.id, p.name, p.unit, sp.price, sp.is_default FROM supplier_products sp
        JOIN products p ON p.id = sp.product_id WHERE sp.supplier_id = ? ORDER BY sp.is_default DESC, p.name`).all(id),
      collectors: db.prepare(`SELECT e.id, e.name FROM employee_suppliers es JOIN employees e ON e.id = es.employee_id
        WHERE es.supplier_id = ? ORDER BY e.name`).all(id),
      last60: summary(db, { from, to, supplier: id }),
      allTime: summary(db, { from: '2000-01-01', to, supplier: id }).totals,
    };
    if (has(req, 'payments.view')) card.statement = statement(db, id);
    return card;
  });

  app.get('/suppliers-import/template.xlsx', need('suppliers.manage'), async (req, reply) => {
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', 'attachment; filename="yaya_yetkazib_beruvchilar_shablon.xlsx"');
    return Buffer.from(await templateXlsx(db));
  });

  // Body: { file: base64 xlsx, dryRun: true|false }. Run with dryRun first to preview.
  app.post('/suppliers-import', { ...need('suppliers.manage', 'prices.manage'), bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const b64 = String(req.body?.file ?? '').replace(/^data:.*?;base64,/, '');
    if (!b64) return bad(reply, 'Fayl yuborilmadi');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > 8 * 1024 * 1024) return bad(reply, 'Fayl 8 MB dan katta');
    try {
      const r = await importSuppliers(db, buf, { dryRun: req.body?.dryRun !== false });
      if (!r.dryRun) log(req, 'suppliers.import', r.summary);
      return r;
    } catch (err) {
      return bad(reply, err.message);
    }
  });

  // ---------------------------------------------------------------- collectors
  app.get('/employees', need('employees.manage'), async () => db.prepare(`
    SELECT e.id, e.name, e.phone, e.warehouse_id, e.role_id, r.name AS role_name, e.is_test, e.active,
      (SELECT COUNT(*) FROM employee_suppliers es WHERE es.employee_id = e.id) AS supplier_count
    FROM employees e LEFT JOIN roles r ON r.id = e.role_id ORDER BY e.is_test, e.active DESC, e.name`).all());

  // Light list for filters (anyone who can see pickups or shifts may pick a collector).
  app.get('/employees/names', signedIn, async () => db.prepare('SELECT id, name, is_test FROM employees ORDER BY is_test, name').all());

  const phoneOk = (p) => /^\d{9,12}$/.test(p ?? '');
  const pinOk = (p) => /^\d{4,6}$/.test(String(p ?? ''));

  app.post('/employees', need('employees.manage'), async (req, reply) => {
    const { name, pin, warehouseId, isTest } = req.body ?? {};
    const phone = String(req.body?.phone ?? '').replace(/\D/g, '');
    const roleId = num(req.body?.roleId) ?? roleIdByCode(db, 'collector');
    if (!str(name)) return bad(reply, 'Ism shart');
    if (!phoneOk(phone)) return bad(reply, 'Telefon 9–12 raqam bo\'lsin');
    if (!pinOk(pin)) return bad(reply, 'PIN 4–6 raqam bo\'lsin');
    if (!roleExists(roleId)) return bad(reply, 'Rol noto\'g\'ri');
    if (db.prepare('SELECT 1 FROM employees WHERE phone = ?').get(phone)) return bad(reply, 'Bu telefon raqam band');
    const id = db.prepare('INSERT INTO employees (name, phone, pin_hash, warehouse_id, role_id, is_test) VALUES (?, ?, ?, ?, ?, ?)')
      .run(str(name), phone, bcrypt.hashSync(String(pin), 10), warehouseId || null, roleId, Number(!!isTest)).lastInsertRowid;
    log(req, 'employees.create', { id, name, isTest: !!isTest, roleId });
    return { id };
  });

  app.patch('/employees/:id', need('employees.manage'), async (req, reply) => {
    const { name, pin, warehouseId, active, isTest } = req.body ?? {};
    const phone = req.body?.phone == null ? null : String(req.body.phone).replace(/\D/g, '');
    const roleId = req.body?.roleId == null ? null : num(req.body.roleId);
    if (phone != null && !phoneOk(phone)) return bad(reply, 'Telefon 9–12 raqam bo\'lsin');
    if (pin != null && pin !== '' && !pinOk(pin)) return bad(reply, 'PIN 4–6 raqam bo\'lsin');
    if (req.body?.roleId != null && (!roleId || !roleExists(roleId))) return bad(reply, 'Rol noto\'g\'ri');
    if (phone && db.prepare('SELECT 1 FROM employees WHERE phone = ? AND id != ?').get(phone, req.params.id)) return bad(reply, 'Bu telefon raqam band');
    db.prepare(`UPDATE employees SET name = COALESCE(?, name), phone = COALESCE(?, phone),
      pin_hash = COALESCE(?, pin_hash), warehouse_id = CASE WHEN ? THEN ? ELSE warehouse_id END,
      role_id = COALESCE(?, role_id), active = COALESCE(?, active), is_test = COALESCE(?, is_test) WHERE id = ?`)
      .run(str(name), phone, pin ? bcrypt.hashSync(String(pin), 10) : null,
        Number(warehouseId !== undefined), warehouseId || null, roleId,
        active == null ? null : Number(!!active), isTest == null ? null : Number(!!isTest), req.params.id);
    log(req, 'employees.update', { id: Number(req.params.id), name, phone, warehouseId, active, isTest, roleId, pinChanged: !!pin });
    return { ok: true };
  });

  app.get('/employees/:id/suppliers', need('employees.manage'), async (req) =>
    db.prepare('SELECT supplier_id FROM employee_suppliers WHERE employee_id = ? ORDER BY sort_order')
      .all(req.params.id).map((x) => x.supplier_id));

  app.put('/employees/:id/suppliers', need('employees.manage'), async (req) => {
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
  app.get('/supplier-products', need('suppliers.view'), async () => db.prepare(`
    SELECT sp.*, s.name AS supplier_name, p.name AS product_name, p.unit
    FROM supplier_products sp JOIN suppliers s ON s.id = sp.supplier_id JOIN products p ON p.id = sp.product_id
    ORDER BY s.name, sp.is_default DESC, p.name`).all());

  app.put('/supplier-products', need('prices.manage'), async (req, reply) => {
    const { supplierId, productId, isDefault } = req.body ?? {};
    const price = Number(req.body?.price);
    if (!supplierId || !productId || !Number.isFinite(price) || price < 0 || price > 1e9) return bad(reply, 'Narx noto\'g\'ri');
    db.transaction(() => {
      if (isDefault) db.prepare('UPDATE supplier_products SET is_default = 0 WHERE supplier_id = ?').run(supplierId);
      db.prepare(`INSERT INTO supplier_products (supplier_id, product_id, price, is_default) VALUES (?, ?, ?, ?)
        ON CONFLICT(supplier_id, product_id) DO UPDATE SET price = excluded.price, is_default = excluded.is_default`)
        .run(supplierId, productId, price, isDefault ? 1 : 0);
      if (!db.prepare('SELECT 1 FROM supplier_products WHERE supplier_id = ? AND is_default = 1').get(supplierId)) {
        db.prepare('UPDATE supplier_products SET is_default = 1 WHERE supplier_id = ? AND product_id = ?').run(supplierId, productId);
      }
    })();
    log(req, 'price.set', { supplierId, productId, price });
    return { ok: true };
  });

  app.delete('/supplier-products/:supplierId/:productId', need('prices.manage'), async (req) => {
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
  app.get('/collections', need('collections.view'), async (req) => {
    const q = req.query;
    const { from, to } = parseRange(q);
    return db.prepare(`
      SELECT c.id, c.collected_at, c.received_at, c.quantity, c.price, CAST(ROUND(c.quantity * c.price) AS INTEGER) AS amount,
        c.edited_at, c.edited_by, c.voided_at, c.void_reason, c.voided_by, c.product_id, c.supplier_id,
        e.name AS employee_name, e.is_test, s.name AS supplier_name, p.name AS product_name, p.unit, sh.status AS shift_status
      FROM collections c JOIN employees e ON e.id = c.employee_id
      JOIN suppliers s ON s.id = c.supplier_id JOIN products p ON p.id = c.product_id
      LEFT JOIN shifts sh ON sh.client_uuid = c.shift_uuid
      WHERE ${LOCAL_DAY} BETWEEN @from AND @to
        AND (@employee IS NULL OR c.employee_id = @employee)
        AND (@supplier IS NULL OR c.supplier_id = @supplier)
        AND (@shift IS NULL OR c.shift_uuid = @shift)
        AND (@voided = 1 OR c.voided_at IS NULL)
      ORDER BY c.collected_at DESC LIMIT 2000`).all({ from: q.shift ? '2000-01-01' : from, to: q.shift ? '2999-12-31' : to,
      employee: num(q.employee), supplier: num(q.supplier), shift: q.shift ? String(q.shift) : null, voided: q.voided === '1' ? 1 : 0 });
  });

  // Correct a pickup's quantity and/or product. Price follows the product.
  app.patch('/collections/:id', need('collections.edit'), async (req, reply) => {
    const c = db.prepare('SELECT * FROM collections WHERE id = ?').get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'Topilmadi' });
    const quantity = req.body?.quantity == null ? c.quantity : Number(req.body.quantity);
    const productId = num(req.body?.productId) ?? c.product_id;
    if (!(quantity > 0) || quantity > 100000) return bad(reply, 'Miqdor noto\'g\'ri');
    let price = c.price;
    if (productId !== c.product_id) {
      const sp = db.prepare('SELECT price FROM supplier_products WHERE supplier_id = ? AND product_id = ?').get(c.supplier_id, productId);
      if (!sp) return bad(reply, 'Bu yetkazib beruvchida bu mahsulot uchun narx yo\'q');
      price = sp.price;
    }
    db.prepare('UPDATE collections SET quantity = ?, product_id = ?, price = ?, edited_at = datetime(\'now\'), edited_by = ? WHERE id = ?')
      .run(quantity, productId, price, `user:${req.panelUser.login}`, c.id);
    log(req, 'collection.edit', { id: c.id, from: { quantity: c.quantity, productId: c.product_id }, to: { quantity, productId } });
    return { ok: true };
  });

  app.post('/collections/:id/void', need('collections.void'), async (req, reply) => {
    const reason = str(req.body?.reason, 300);
    if (!reason) return bad(reply, 'Sababini yozing');
    const r = db.prepare('UPDATE collections SET voided_at = datetime(\'now\'), void_reason = ?, voided_by = ? WHERE id = ? AND voided_at IS NULL')
      .run(reason, `user:${req.panelUser.login}`, req.params.id);
    if (!r.changes) return reply.code(404).send({ error: 'Topilmadi yoki allaqachon bekor qilingan' });
    log(req, 'collection.void', { id: Number(req.params.id), reason });
    return { ok: true };
  });

  app.post('/collections/:id/restore', need('collections.void'), async (req) => {
    db.prepare('UPDATE collections SET voided_at = NULL, void_reason = NULL, voided_by = NULL WHERE id = ?').run(req.params.id);
    log(req, 'collection.restore', { id: Number(req.params.id) });
    return { ok: true };
  });

  // ---------------------------------------------------------------- shifts
  app.get('/shifts', need('shifts.view'), async (req) => {
    const { from, to } = parseRange(req.query);
    const status = ['open', 'closed', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
    return db.prepare(`
      SELECT s.id, s.client_uuid, s.opened_at, s.closed_at, s.status, s.reviewed_by, s.reviewed_at, s.review_note,
        e.id AS employee_id, e.name AS employee_name, e.is_test,
        COUNT(c.id) AS pickups, ROUND(COALESCE(SUM(c.quantity), 0), 2) AS quantity,
        CAST(COALESCE(SUM(ROUND(c.quantity * c.price)), 0) AS INTEGER) AS amount,
        COUNT(DISTINCT c.supplier_id) AS suppliers
      FROM shifts s JOIN employees e ON e.id = s.employee_id
      LEFT JOIN collections c ON c.shift_uuid = s.client_uuid AND c.voided_at IS NULL
      WHERE date(s.opened_at, '+5 hours') BETWEEN @from AND @to
        AND (@status IS NULL OR s.status = @status) AND (@employee IS NULL OR s.employee_id = @employee)
      GROUP BY s.id ORDER BY s.opened_at DESC LIMIT 500`).all({ from, to, status, employee: num(req.query.employee) });
  });

  app.post('/shifts/:id/review', need('shifts.approve'), async (req, reply) => {
    const decision = req.body?.decision;
    const note = str(req.body?.note, 300);
    if (!['approve', 'reject'].includes(decision)) return bad(reply, 'Qaror noto\'g\'ri');
    if (decision === 'reject' && !note) return bad(reply, 'Rad etish sababini yozing');
    const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'Topilmadi' });
    if (s.status === 'open') return bad(reply, 'Smena hali yopilmagan');
    db.prepare('UPDATE shifts SET status = ?, reviewed_by = ?, reviewed_at = datetime(\'now\'), review_note = ? WHERE id = ?')
      .run(decision === 'approve' ? 'approved' : 'rejected', req.panelUser.login, note, s.id);
    log(req, `shift.${decision}`, { id: s.id, note });
    return { ok: true };
  });

  // ---------------------------------------------------------------- payments & debts
  app.get('/balances', need('payments.view'), async (req) => balances(db, { q: req.query.q }));

  app.get('/payments', need('payments.view'), async (req) => {
    const { from, to } = parseRange(req.query);
    return db.prepare(`SELECT p.*, s.name AS supplier_name FROM payments p JOIN suppliers s ON s.id = p.supplier_id
      WHERE date(p.paid_at, '+5 hours') BETWEEN @from AND @to AND (@supplier IS NULL OR p.supplier_id = @supplier)
        AND (@voided = 1 OR p.voided_at IS NULL)
      ORDER BY p.paid_at DESC LIMIT 2000`).all({ from, to, supplier: num(req.query.supplier), voided: req.query.voided === '1' ? 1 : 0 });
  });

  app.post('/payments', need('payments.create'), async (req, reply) => {
    const supplierId = num(req.body?.supplierId);
    const amount = Math.round(Number(req.body?.amount));
    const method = METHODS.includes(req.body?.method) ? req.body.method : 'cash';
    if (!supplierId || !db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplierId)) return bad(reply, 'Yetkazib beruvchini tanlang');
    if (!(amount > 0) || amount > 1e11) return bad(reply, 'Summa noto\'g\'ri');
    const paidAt = req.body?.paidAt && !Number.isNaN(Date.parse(req.body.paidAt)) ? new Date(req.body.paidAt).toISOString() : new Date().toISOString();
    const id = db.prepare(`INSERT INTO payments (client_uuid, supplier_id, amount, method, note, paid_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.body?.uuid ? String(req.body.uuid) : randomUUID(), supplierId, amount, method,
      str(req.body?.note, 300), paidAt, `user:${req.panelUser.login}`).lastInsertRowid;
    log(req, 'payment.create', { id, supplierId, amount, method });
    return { id };
  });

  app.post('/payments/:id/void', need('payments.void'), async (req, reply) => {
    const reason = str(req.body?.reason, 300);
    if (!reason) return bad(reply, 'Sababini yozing');
    const r = db.prepare('UPDATE payments SET voided_at = datetime(\'now\'), void_reason = ?, voided_by = ? WHERE id = ? AND voided_at IS NULL')
      .run(reason, `user:${req.panelUser.login}`, req.params.id);
    if (!r.changes) return reply.code(404).send({ error: 'Topilmadi yoki allaqachon bekor qilingan' });
    log(req, 'payment.void', { id: Number(req.params.id), reason });
    return { ok: true };
  });

  // ---------------------------------------------------------------- analytics
  app.get('/reports/summary', need('reports.view'), async (req) => summary(db, req.query));
  app.get('/reports/daily-cost', need('reports.view'), async (req) =>
    dailyCost(db, /^\d{4}-\d{2}-\d{2}$/.test(req.query.day ?? '') ? req.query.day : todayLocal()));

  app.get('/reports/export.csv', need('reports.export'), async (req, reply) => {
    const { from, to } = parseRange(req.query);
    const cols = [['id', 'ID'], ['local_time', 'Vaqt'], ['employee', 'Sut yig\'uvchi'], ['supplier', 'Yetkazib beruvchi'],
      ['product', 'Mahsulot'], ['unit', 'Birlik'], ['quantity', 'Miqdor']];
    if (has(req, 'amounts.view')) cols.push(['price', 'Narx'], ['amount', 'Summa']);
    const csv = toCsv(exportRows(db, req.query), cols);
    log(req, 'report.export', { from, to });
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="yaya_${from}_${to}.csv"`);
    return csv;
  });

  app.get('/dashboard', need('dashboard.view'), async () => {
    const today = parseRange({});
    const d30 = new Date(Date.parse(today.to) - 29 * 864e5).toISOString().slice(0, 10);
    const openShifts = db.prepare(`SELECT e.name, s.opened_at, s.status,
        (SELECT COUNT(*) FROM collections c WHERE c.shift_uuid = s.client_uuid AND c.voided_at IS NULL) AS pickups
      FROM shifts s JOIN employees e ON e.id = s.employee_id
      WHERE s.status IN ('open', 'closed') AND e.is_test = 0 ORDER BY s.opened_at`).all();
    const lastSync = db.prepare(`SELECT e.name, MAX(c.received_at) AS at FROM collections c
      JOIN employees e ON e.id = c.employee_id WHERE e.active = 1 AND e.is_test = 0 GROUP BY e.id ORDER BY e.name`).all();
    const debt = balances(db).totals;
    return { today: summary(db, today), month: summary(db, { from: d30, to: today.to }), cost: dailyCost(db, today.to),
      openShifts, lastSync, debt };
  });

  // ---------------------------------------------------------------- branding
  app.get('/settings', need('settings.manage'), async () => ({ companyName: getSetting(db, 'company_name') ?? '' }));
  app.put('/settings', need('settings.manage'), async (req) => {
    if (req.body?.companyName !== undefined) setSetting(db, 'company_name', str(req.body.companyName, 60));
    setSetting(db, 'brand_version', Date.now());
    log(req, 'settings.update', { companyName: req.body?.companyName });
    return { ok: true };
  });

  // Logo arrives as a PNG data URL, already squared and resized in the browser.
  app.put('/settings/logo', { ...need('settings.manage'), bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.dataUrl ?? ''));
    if (!m) return bad(reply, 'Rasm PNG formatida bo\'lishi kerak');
    const buf = Buffer.from(m[1], 'base64');
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!buf.subarray(0, 8).equals(PNG_SIG)) return bad(reply, 'Fayl PNG emas');
    if (buf.length > 2 * 1024 * 1024) return bad(reply, 'Rasm 2 MB dan katta');
    db.prepare(`INSERT INTO files (key, mime, data, updated_at) VALUES ('logo', 'image/png', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`).run(buf);
    setSetting(db, 'brand_version', Date.now());
    log(req, 'logo.update', { bytes: buf.length });
    return { ok: true };
  });

  app.delete('/settings/logo', need('settings.manage'), async (req) => {
    db.prepare("DELETE FROM files WHERE key = 'logo'").run();
    setSetting(db, 'brand_version', Date.now());
    log(req, 'logo.remove');
    return { ok: true };
  });

  // ---------------------------------------------------------------- test mode & audit
  app.delete('/test-data', need('tester.use', 'users.manage'), async (req) => {
    const r = db.transaction(() => {
      const c = db.prepare('DELETE FROM collections WHERE employee_id IN (SELECT id FROM employees WHERE is_test = 1)').run().changes;
      db.prepare('DELETE FROM payments WHERE employee_id IN (SELECT id FROM employees WHERE is_test = 1)').run();
      db.prepare('DELETE FROM shifts WHERE employee_id IN (SELECT id FROM employees WHERE is_test = 1)').run();
      return c;
    })();
    log(req, 'test-data.clear', { collections: r });
    return { deleted: r };
  });

  app.get('/audit', need('audit.view'), async () => db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300').all());
}
