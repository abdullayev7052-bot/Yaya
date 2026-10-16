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

const shifts = () => load('shifts', []);
const collections = () => load('collections', []);

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
  const shift = { uuid: uuid(), opened_at: new Date().toISOString(), closed_at: null, dirty: 1 };
  save('shifts', [...shifts(), shift]);
  return shift;
}
export function closeShift(id) {
  save('shifts', shifts().map((s) => (s.uuid === id ? { ...s, closed_at: new Date().toISOString(), dirty: 1 } : s)));
}

export function addCollectionAndClearDraft({ shiftUuid, supplier, product, quantity }) {
  save('collections', [...collections(), {
    uuid: uuid(), shift_uuid: shiftUuid, supplier_id: supplier.id, supplier_name: supplier.name,
    product_id: product.id, product_name: product.name, unit: product.unit ?? 'kg', quantity,
    collected_at: new Date().toISOString(), synced_at: null, error: null,
  }]);
  setKv('draft', null);
}
export function shiftCollections(shiftUuid) {
  return collections().filter((c) => c.shift_uuid === shiftUuid).sort((a, b) => b.collected_at.localeCompare(a.collected_at));
}
export const unsyncedCount = () => collections().filter((c) => !c.synced_at && !c.error).length;
export const errorCount = () => collections().filter((c) => c.error).length;

export function pendingUpload() {
  return {
    shifts: shifts().filter((s) => s.dirty).map(({ uuid: u, opened_at, closed_at }) => ({ uuid: u, opened_at, closed_at })),
    collections: collections().filter((c) => !c.synced_at && !c.error).slice(0, 200),
  };
}
export function markUploaded(sentShifts, accepted, rejected) {
  const now = new Date().toISOString();
  save('shifts', shifts().map((s) => (sentShifts.some((x) => x.uuid === s.uuid && x.closed_at === s.closed_at) ? { ...s, dirty: 0 } : s)));
  const acc = new Set(accepted);
  const rej = new Map(rejected.map((r) => [r.uuid, r.error]));
  save('collections', collections().map((c) => (acc.has(c.uuid) ? { ...c, synced_at: now } : rej.has(c.uuid) ? { ...c, error: rej.get(c.uuid) } : c)));
}
export function retryErrors() {
  save('collections', collections().map((c) => ({ ...c, error: null })));
}
export function pruneOld() {
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
  save('collections', collections().filter((c) => !(c.synced_at && c.collected_at < cutoff)));
}
