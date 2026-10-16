// Browser version of db.js (Metro picks *.web.js for the web build). Same API,
// backed by localStorage, so the admin panel can run the real app UI for testing.
// The phone build always uses the SQLite version in db.js.

const PREFIX = 'yaya_test_';
const load = (k, d) => {
  try { const v = localStorage.getItem(PREFIX + k); return v == null ? d : JSON.parse(v); } catch { return d; }
};
const save = (k, v) => {
  try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch { /* storage full or blocked */ }
};
const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }));
const nowIso = () => new Date().toISOString();

const shifts = () => load('shifts', []);
const collections = () => load('collections', []);
const ops = () => load('ops', []);
const payments = () => load('payments', []);

export function getKv(key, fallback = null) {
  const kv = load('kv', {});
  return key in kv ? kv[key] : fallback;
}
export function setKv(key, value) {
  const kv = load('kv', {});
  if (value === null || value === undefined) delete kv[key]; else kv[key] = value;
  save('kv', kv);
}

export function getOpenShift() {
  return shifts().filter((s) => !s.closed_at).sort((a, b) => b.opened_at.localeCompare(a.opened_at))[0] ?? null;
}
export function openShift() {
  const shift = { uuid: uuid(), opened_at: nowIso(), closed_at: null, dirty: 1 };
  save('shifts', [...shifts(), shift]);
  return shift;
}
export function closeShift(id) {
  save('shifts', shifts().map((s) => (s.uuid === id ? { ...s, closed_at: nowIso(), dirty: 1 } : s)));
}

export function addCollectionAndClearDraft({ shiftUuid, supplier, product, quantity }) {
  save('collections', [...collections(), {
    uuid: uuid(), shift_uuid: shiftUuid, supplier_id: supplier.id, supplier_name: supplier.name,
    product_id: product.id, product_name: product.name, unit: product.unit ?? 'kg', quantity,
    collected_at: nowIso(), synced_at: null, error: null, voided_at: null, edited_at: null,
  }]);
  setKv('draft', null);
}
export function shiftCollections(shiftUuid) {
  return collections().filter((c) => c.shift_uuid === shiftUuid).sort((a, b) => b.collected_at.localeCompare(a.collected_at));
}
export function editCollection(id, { quantity, product }) {
  const c = collections().find((x) => x.uuid === id);
  if (!c) return;
  save('collections', collections().map((x) => (x.uuid === id
    ? { ...x, quantity, product_id: product.id, product_name: product.name, unit: product.unit ?? 'kg', edited_at: nowIso() } : x)));
  if (c.synced_at) save('ops', [...ops(), { uuid: uuid(), type: 'edit', target: id, quantity, product_id: product.id, created_at: nowIso(), synced_at: null, error: null }]);
}
export function voidCollection(id, reason) {
  const c = collections().find((x) => x.uuid === id);
  if (!c || c.voided_at) return;
  save('collections', collections().map((x) => (x.uuid === id ? { ...x, voided_at: nowIso() } : x)));
  if (c.synced_at) save('ops', [...ops(), { uuid: uuid(), type: 'void', target: id, reason: reason ?? null, created_at: nowIso(), synced_at: null, error: null }]);
}

export function addPayment({ supplier, amount, method, note }) {
  save('payments', [...payments(), { uuid: uuid(), supplier_id: supplier.id, supplier_name: supplier.name, amount,
    method: method ?? 'cash', note: note ?? null, paid_at: nowIso(), synced_at: null, error: null }]);
}
export const recentPayments = () => payments().sort((a, b) => b.paid_at.localeCompare(a.paid_at)).slice(0, 50);

const pendingCol = (c) => !c.synced_at && !c.error && !c.voided_at;
const pending = (x) => !x.synced_at && !x.error;
export const unsyncedCount = () => collections().filter(pendingCol).length + ops().filter(pending).length + payments().filter(pending).length;
export const errorCount = () => [...collections(), ...ops(), ...payments()].filter((x) => x.error).length;
export const errors = () => [
  ...collections().filter((x) => x.error).map((x) => ({ kind: 'pickup', name: x.supplier_name, error: x.error })),
  ...ops().filter((x) => x.error).map((x) => ({ kind: 'fix', name: x.target, error: x.error })),
  ...payments().filter((x) => x.error).map((x) => ({ kind: 'payment', name: x.supplier_name, error: x.error })),
];

export function pendingUpload() {
  return {
    shifts: shifts().filter((s) => s.dirty).map(({ uuid: u, opened_at, closed_at }) => ({ uuid: u, opened_at, closed_at })),
    collections: collections().filter(pendingCol).slice(0, 200),
    ops: ops().filter(pending).slice(0, 200),
    payments: payments().filter(pending).slice(0, 200),
  };
}
export function markUploaded(sentShifts, r) {
  const now = nowIso();
  save('shifts', shifts().map((s) => (sentShifts.some((x) => x.uuid === s.uuid && x.closed_at === s.closed_at) ? { ...s, dirty: 0 } : s)));
  const apply = (key, list, acc = [], rej = []) => {
    const a = new Set(acc);
    const e = new Map(rej.map((x) => [x.uuid, x.error]));
    save(key, list.map((x) => (a.has(x.uuid) ? { ...x, synced_at: now } : e.has(x.uuid) ? { ...x, error: e.get(x.uuid) } : x)));
  };
  apply('collections', collections(), r.accepted, r.rejected);
  apply('ops', ops(), r.ops?.accepted, r.ops?.rejected);
  apply('payments', payments(), r.payments?.accepted, r.payments?.rejected);
}
export function retryErrors() {
  for (const [k, list] of [['collections', collections()], ['ops', ops()], ['payments', payments()]]) save(k, list.map((x) => ({ ...x, error: null })));
}
export function pruneOld() {
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
  save('collections', collections().filter((c) => !((c.synced_at || c.voided_at) && c.collected_at < cutoff)));
  save('ops', ops().filter((o) => !(o.synced_at && o.created_at < cutoff)));
  save('payments', payments().filter((p) => !(p.synced_at && p.paid_at < cutoff)));
}
