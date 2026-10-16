// Supplier money: what we bought (pickups), what we paid, and what we still owe.
//
//   balance = opening_balance + Σ round(quantity × price) − Σ payments
//
// Positive balance = we owe the supplier ("qarzimiz"); negative = the supplier
// owes us (an advance). Voided pickups/payments and test collectors' pickups
// never count. Amounts are whole so'm.

const PURCHASED = `COALESCE((SELECT SUM(ROUND(c.quantity * c.price)) FROM collections c
  JOIN employees e ON e.id = c.employee_id
  WHERE c.supplier_id = s.id AND c.voided_at IS NULL AND e.is_test = 0), 0)`;
const NOT_TEST = 'NOT EXISTS (SELECT 1 FROM employees t WHERE t.id = p.employee_id AND t.is_test = 1)';
const PAID = `COALESCE((SELECT SUM(p.amount) FROM payments p
  WHERE p.supplier_id = s.id AND p.voided_at IS NULL AND ${NOT_TEST}), 0)`;

export const BALANCE_SQL = `ROUND(s.opening_balance + ${PURCHASED} - ${PAID})`;

export function balances(db, { q } = {}) {
  const rows = db.prepare(`
    SELECT s.id, s.name, s.phone, s.address, s.active, s.opening_balance,
      ${PURCHASED} AS purchased, ${PAID} AS paid, ${BALANCE_SQL} AS balance,
      (SELECT MAX(c.collected_at) FROM collections c WHERE c.supplier_id = s.id AND c.voided_at IS NULL) AS last_pickup,
      (SELECT MAX(p.paid_at) FROM payments p WHERE p.supplier_id = s.id AND p.voided_at IS NULL AND ${NOT_TEST}) AS last_payment
    FROM suppliers s ORDER BY balance DESC, s.name`).all();
  const needle = (q ?? '').trim().toLowerCase();
  const digits = needle.replace(/\D/g, '');
  const list = needle
    ? rows.filter((r) => r.name.toLowerCase().includes(needle) || (r.address ?? '').toLowerCase().includes(needle)
      || (digits.length >= 2 && (r.phone ?? '').replace(/\D/g, '').includes(digits)))
    : rows;
  const totals = {
    weOwe: list.reduce((a, r) => a + Math.max(0, r.balance), 0),
    theyOwe: list.reduce((a, r) => a + Math.max(0, -r.balance), 0),
  };
  return { rows: list, totals };
}

export function supplierBalance(db, supplierId) {
  return db.prepare(`SELECT ${BALANCE_SQL} AS b FROM suppliers s WHERE s.id = ?`).get(supplierId)?.b ?? 0;
}

// Chronological statement (akt-sverka) with a running balance.
export function statement(db, supplierId, { limit = 500 } = {}) {
  const s = db.prepare('SELECT opening_balance, created_at FROM suppliers WHERE id = ?').get(supplierId);
  if (!s) return null;
  const pickups = db.prepare(`
    SELECT 'pickup' AS kind, c.id, c.collected_at AS at, c.quantity, c.price, p.name AS product_name, p.unit,
      CAST(ROUND(c.quantity * c.price) AS INTEGER) AS amount, e.name AS by_name, c.voided_at, c.void_reason
    FROM collections c JOIN products p ON p.id = c.product_id JOIN employees e ON e.id = c.employee_id
    WHERE c.supplier_id = ? AND e.is_test = 0`).all(supplierId);
  const pays = db.prepare(`
    SELECT 'payment' AS kind, id, paid_at AS at, amount, method, note, created_by AS by_name, voided_at, void_reason
    FROM payments p WHERE supplier_id = ? AND ${NOT_TEST}`).all(supplierId);
  const entries = [...pickups, ...pays].sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind) || a.id - b.id);
  let running = s.opening_balance;
  for (const e of entries) {
    if (!e.voided_at) running += e.kind === 'pickup' ? e.amount : -e.amount;
    e.balance = Math.round(running);
  }
  // Newest first for display; keep the most recent `limit` rows.
  return { opening: s.opening_balance, balance: Math.round(running), entries: entries.reverse().slice(0, limit) };
}
