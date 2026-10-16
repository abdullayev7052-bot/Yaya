// All money/quantity arithmetic for reports lives here, in SQL, so every screen
// and export agrees to the last so'm. Amount per pickup = round(quantity * price);
// totals are sums of those rounded amounts. Voided pickups and test collectors
// are always excluded.

// Uzbekistan is UTC+5 all year (no DST); report days follow local time.
export const LOCAL_DAY = "date(c.collected_at, '+5 hours')";
export const todayLocal = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');

export function parseRange(q = {}) {
  const to = isDay(q.to) ? q.to : todayLocal();
  const from = isDay(q.from) ? q.from : to;
  return from <= to ? { from, to } : { from: to, to: from };
}

function where(q) {
  const parts = [`${LOCAL_DAY} BETWEEN @from AND @to`, 'c.voided_at IS NULL', 'e.is_test = 0'];
  const params = parseRange(q);
  for (const k of ['employee', 'supplier', 'product']) {
    const v = Number(q[k]);
    if (Number.isInteger(v) && v > 0) {
      parts.push(`c.${k}_id = @${k}`);
      params[k] = v;
    }
  }
  return { sql: parts.join(' AND '), params };
}

const BASE = `FROM collections c JOIN employees e ON e.id = c.employee_id
  JOIN suppliers s ON s.id = c.supplier_id JOIN products p ON p.id = c.product_id`;
const AGG = `COUNT(*) AS pickups, ROUND(SUM(c.quantity), 2) AS quantity,
  CAST(SUM(ROUND(c.quantity * c.price)) AS INTEGER) AS amount`;

export function summary(db, q) {
  const w = where(q);
  const run = (sql) => db.prepare(sql).all(w.params);
  const totals = db.prepare(`SELECT ${AGG}, COUNT(DISTINCT c.supplier_id) AS suppliers ${BASE} WHERE ${w.sql}`).get(w.params);
  return {
    range: parseRange(q),
    totals: { pickups: totals.pickups, quantity: totals.quantity ?? 0, amount: totals.amount ?? 0, suppliers: totals.suppliers },
    byProduct: run(`SELECT p.id, p.name, p.unit, ${AGG},
        ROUND(CAST(SUM(ROUND(c.quantity * c.price)) AS REAL) / SUM(c.quantity), 2) AS avg_price
      ${BASE} WHERE ${w.sql} GROUP BY p.id ORDER BY quantity DESC`),
    byDay: run(`SELECT ${LOCAL_DAY} AS day, p.id AS product_id, p.name AS product_name, ${AGG}
      ${BASE} WHERE ${w.sql} GROUP BY day, p.id ORDER BY day`),
    byEmployee: run(`SELECT e.id, e.name, ${AGG}, COUNT(DISTINCT c.supplier_id) AS suppliers
      ${BASE} WHERE ${w.sql} GROUP BY e.id ORDER BY quantity DESC`),
    bySupplier: run(`SELECT s.id, s.name, ${AGG}, MAX(c.collected_at) AS last_at
      ${BASE} WHERE ${w.sql} GROUP BY s.id ORDER BY quantity DESC`),
  };
}

// Flat rows for CSV export (opens directly in Excel).
export function exportRows(db, q) {
  const w = where(q);
  return db.prepare(`SELECT c.id, datetime(c.collected_at, '+5 hours') AS local_time, e.name AS employee,
      s.name AS supplier, p.name AS product, p.unit, c.quantity, c.price,
      CAST(ROUND(c.quantity * c.price) AS INTEGER) AS amount
    ${BASE} WHERE ${w.sql} ORDER BY c.collected_at`).all(w.params);
}

export function toCsv(rows, headers) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    // Neutralise spreadsheet formula injection and quote when needed.
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [headers.map((h) => cell(h[1])).join(';')];
  for (const r of rows) lines.push(headers.map((h) => cell(r[h[0]])).join(';'));
  // BOM so Excel reads UTF-8 (Uzbek letters) correctly.
  return '﻿' + lines.join('\r\n');
}

// Weighted average purchase cost per product for one local day:
//   average cost = Σ round(quantity × price) / Σ quantity
// i.e. the total money spent divided by the total amount bought — not the plain
// average of prices, which would give a small supplier the same weight as a big one.
// The figure is "final" only when every shift that day is closed and approved.
export function dailyCost(db, day) {
  const w = where({ from: day, to: day });
  const products = db.prepare(`SELECT p.id, p.name, p.unit, ${AGG},
      COUNT(DISTINCT c.supplier_id) AS suppliers, MIN(c.price) AS min_price, MAX(c.price) AS max_price
    ${BASE} WHERE ${w.sql} GROUP BY p.id ORDER BY quantity DESC`).all(w.params)
    .map((p) => ({ ...p, avg_cost: p.quantity ? Math.round((p.amount / p.quantity) * 100) / 100 : null }));
  const shifts = db.prepare(`SELECT s.status, COUNT(*) AS n FROM shifts s JOIN employees e ON e.id = s.employee_id
    WHERE e.is_test = 0 AND date(s.opened_at, '+5 hours') = ? GROUP BY s.status`).all(day);
  const count = Object.fromEntries(shifts.map((r) => [r.status, r.n]));
  const qty = products.reduce((a, p) => a + p.quantity, 0);
  const amount = products.reduce((a, p) => a + p.amount, 0);
  return {
    day,
    products,
    overall: { quantity: Math.round(qty * 100) / 100, amount, avg_cost: qty ? Math.round((amount / qty) * 100) / 100 : null },
    shifts: { open: count.open ?? 0, closed: count.closed ?? 0, approved: count.approved ?? 0, rejected: count.rejected ?? 0 },
    final: !(count.open || count.closed || count.rejected),
  };
}
