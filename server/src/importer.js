import ExcelJS from 'exceljs';
import { supplierBalance } from './ledger.js';

// Bulk supplier import from the company's own Excel template.
// One row = one supplier + one product. A supplier with several products is
// written on several rows (same phone or name); the first row's product is the
// default one. "Joriy qarz" is what we owe the supplier today; for an existing
// supplier with history, the opening balance is adjusted so the balance becomes
// exactly that figure.

export const COLUMNS = [
  { key: 'name', header: 'F.I.Sh (majburiy)', width: 32 },
  { key: 'phone', header: 'Telefon', width: 16 },
  { key: 'address', header: 'Manzil', width: 28 },
  { key: 'note', header: 'Izoh', width: 20 },
  { key: 'product', header: 'Mahsulot', width: 18 },
  { key: 'price', header: 'Narx (so\'m)', width: 14 },
  { key: 'debt', header: 'Joriy qarz (so\'m)', width: 18 },
];

export async function templateXlsx(db) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Yaya';
  const ws = wb.addWorksheet('Yetkazib beruvchilar');
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F3EE' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const products = db.prepare('SELECT name FROM products WHERE active = 1 ORDER BY name').all().map((p) => p.name);
  const p1 = products[0] ?? 'Yog\'li sut';
  ws.addRow({ name: 'Karimova Oydin', phone: '901234567', address: 'Qo\'qon, Navbahor 12', note: '', product: p1, price: 5500, debt: 120000 });
  ws.addRow({ name: 'Karimova Oydin', phone: '901234567', product: products[1] ?? 'Yog\'siz sut', price: 3500 });
  ws.addRow({ name: 'Begmatov Sobir', phone: '+998 93 111 22 33', address: 'Dang\'ara', product: p1, price: 5400, debt: 0 });

  const help = wb.addWorksheet('Yo\'riqnoma');
  help.columns = [{ width: 110 }];
  [
    'Qanday to\'ldiriladi:',
    '1. Bitta qator = bitta yetkazib beruvchi + bitta mahsulot. Bir nechta mahsulot bo\'lsa, keyingi qatorga shu ism/telefon bilan yozing.',
    '2. F.I.Sh majburiy. Telefon bo\'lsa, mavjud yetkazib beruvchi telefon orqali topiladi va yangilanadi (aks holda — ism orqali).',
    '3. Mahsulot nomi tizimdagi nom bilan bir xil bo\'lsin. Topilmasa, yangi mahsulot yaratiladi.',
    '4. Joriy qarz — bugungi kunda BIZ yetkazib beruvchiga qancha qarzmiz. U bizga qarz bo\'lsa — minus bilan yozing.',
    '5. Namuna qatorlarni o\'chirib, o\'z ma\'lumotlaringizni yozing. Import oldidan tizim tekshiradi va natijani ko\'rsatadi.',
    `Tizimdagi mahsulotlar: ${products.join(', ') || '(hali yo\'q)'}`,
  ].forEach((t) => help.addRow([t]));
  return wb.xlsx.writeBuffer();
}

const text = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text) return String(v.text);
    if (v.result != null) return String(v.result);
  }
  return String(v).trim();
};
const number = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'object' && v.result != null) v = v.result;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};
// Normalise Uzbek numbers to the 9 local digits used as login/phone elsewhere.
export const normPhone = (v) => {
  const d = text(v).replace(/\D/g, '');
  if (!d) return '';
  return d.length === 12 && d.startsWith('998') ? d.slice(3) : d;
};

async function readRows(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new Error('Faylni o\'qib bo\'lmadi. Shablondagi .xlsx formatda saqlang.');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('Faylda varaq yo\'q');
  // Map columns by header text so reordered columns still work.
  const header = {};
  ws.getRow(1).eachCell((cell, col) => {
    const h = text(cell.value).toLowerCase();
    const c = COLUMNS.find((x) => h.startsWith(x.header.toLowerCase().split(' (')[0].toLowerCase()));
    if (c) header[c.key] = col;
  });
  if (!header.name) throw new Error('"F.I.Sh" ustuni topilmadi. Shablonni yuklab olib, shunga to\'ldiring.');
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const get = (k) => (header[k] ? row.getCell(header[k]).value : null);
    const r = { row: n, name: text(get('name')), phone: normPhone(get('phone')), address: text(get('address')),
      note: text(get('note')), product: text(get('product')), price: number(get('price')), debt: number(get('debt')) };
    if (Object.values(r).some((v, i) => i > 0 && v !== '' && v != null)) rows.push(r);
  });
  if (rows.length > 5000) throw new Error('Bir martada 5000 qatordan ko\'p bo\'lmasin');
  return rows;
}

/**
 * Validate (and, unless dryRun, apply) an import. Returns a per-row report.
 */
export async function importSuppliers(db, buffer, { dryRun = true } = {}) {
  const rows = await readRows(buffer);
  const products = db.prepare('SELECT id, name FROM products').all();
  const findProduct = (name) => products.find((p) => p.name.toLowerCase() === name.toLowerCase());
  const byPhone = db.prepare("SELECT * FROM suppliers WHERE replace(replace(replace(replace(phone,' ',''),'-',''),'+',''),'(','') LIKE ?");
  const byName = db.prepare('SELECT * FROM suppliers WHERE lower(name) = lower(?)');

  // Group rows into suppliers (by phone, else by name) preserving file order.
  const groups = new Map();
  const report = [];
  for (const r of rows) {
    const errors = [];
    if (!r.name) errors.push('F.I.Sh bo\'sh');
    if (r.phone && !/^\d{9,12}$/.test(r.phone)) errors.push('Telefon noto\'g\'ri');
    if (Number.isNaN(r.price) || (r.price != null && (r.price < 0 || r.price > 1e9))) errors.push('Narx noto\'g\'ri');
    if (Number.isNaN(r.debt) || (r.debt != null && Math.abs(r.debt) > 1e12)) errors.push('Qarz noto\'g\'ri');
    if (r.product && r.price == null) errors.push('Mahsulot bor, lekin narx yo\'q');
    if (!r.product && r.price != null) errors.push('Narx bor, lekin mahsulot yo\'q');
    const key = r.phone ? `p:${r.phone}` : `n:${r.name.toLowerCase()}`;
    report.push({ row: r.row, name: r.name, phone: r.phone, product: r.product, price: r.price, debt: r.debt, errors, actions: [] });
    if (errors.length) continue;
    if (!groups.has(key)) groups.set(key, { ...r, items: [], rows: [] });
    const g = groups.get(key);
    g.rows.push(report[report.length - 1]);
    for (const f of ['address', 'note']) if (!g[f] && r[f]) g[f] = r[f];
    if (g.debt == null && r.debt != null) g.debt = r.debt;
    if (r.product) g.items.push({ product: r.product, price: r.price });
  }

  const summary = { suppliersCreated: 0, suppliersUpdated: 0, pricesSet: 0, productsCreated: 0, errorRows: report.filter((r) => r.errors.length).length };
  const createdProducts = new Set();
  const apply = () => {
    for (const g of groups.values()) {
      const existing = (g.phone && byPhone.get(`%${g.phone}`)) || byName.get(g.name);
      const first = g.rows[0];
      let id;
      if (existing) {
        id = existing.id;
        first.actions.push('mavjud — yangilanadi');
        summary.suppliersUpdated++;
        if (!dryRun) {
          db.prepare(`UPDATE suppliers SET name = ?, phone = COALESCE(NULLIF(?, ''), phone),
            address = COALESCE(NULLIF(?, ''), address), note = COALESCE(NULLIF(?, ''), note), active = 1 WHERE id = ?`)
            .run(g.name, g.phone, g.address, g.note, id);
        }
      } else {
        first.actions.push('yangi yetkazib beruvchi');
        summary.suppliersCreated++;
        if (!dryRun) {
          id = db.prepare('INSERT INTO suppliers (name, phone, address, note) VALUES (?, ?, ?, ?)')
            .run(g.name, g.phone || null, g.address || null, g.note || null).lastInsertRowid;
        }
      }
      if (g.debt != null) {
        first.actions.push(`joriy qarz: ${g.debt}`);
        if (!dryRun) {
          // Make the current balance equal the stated debt, whatever history exists.
          const current = supplierBalance(db, id);
          const opening = db.prepare('SELECT opening_balance FROM suppliers WHERE id = ?').get(id).opening_balance;
          db.prepare('UPDATE suppliers SET opening_balance = ? WHERE id = ?').run(opening + (g.debt - current), id);
        }
      }
      g.items.forEach((it, i) => {
        const row = g.rows.find((r) => r.product === it.product) ?? first;
        let prod = findProduct(it.product);
        if (!prod) {
          if (!createdProducts.has(it.product.toLowerCase())) {
            summary.productsCreated++;
            createdProducts.add(it.product.toLowerCase());
          }
          row.actions.push(`yangi mahsulot: ${it.product}`);
          if (!dryRun) {
            prod = { id: db.prepare('INSERT INTO products (name, unit) VALUES (?, \'kg\')').run(it.product).lastInsertRowid, name: it.product };
            products.push(prod);
          }
        }
        summary.pricesSet++;
        row.actions.push(`narx: ${it.product} — ${it.price}`);
        if (!dryRun) {
          if (i === 0) db.prepare('UPDATE supplier_products SET is_default = 0 WHERE supplier_id = ?').run(id);
          db.prepare(`INSERT INTO supplier_products (supplier_id, product_id, price, is_default) VALUES (?, ?, ?, ?)
            ON CONFLICT(supplier_id, product_id) DO UPDATE SET price = excluded.price, is_default = excluded.is_default`)
            .run(id, prod.id, it.price, i === 0 ? 1 : 0);
        }
      });
    }
  };
  if (dryRun) apply(); else db.transaction(apply)();
  return { dryRun, summary, rows: report };
}
