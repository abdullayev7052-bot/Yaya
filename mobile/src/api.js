import Constants from 'expo-constants';
import NetInfo from '@react-native-community/netinfo';
import { AppState, Platform } from 'react-native';
import * as store from './db';

// In the browser tester the app is served by the same server it talks to.
const DEFAULT_URL = Platform.OS === 'web' ? globalThis.location?.origin ?? '' : Constants.expoConfig?.extra?.apiUrl ?? '';

export const getServerUrl = () => store.getKv('serverUrl', DEFAULT_URL);
export const setServerUrl = (url) => store.setKv('serverUrl', url.trim().replace(/\/+$/, ''));
// session: { mode: 'collector' | 'manager', token, employee?, user? }
export const getSession = () => {
  const s = store.getKv('session');
  return s && !s.mode ? { ...s, mode: 'collector' } : s;
};

async function call(method, path, body, { timeoutMs = 15000 } = {}) {
  const session = getSession();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(getServerUrl() + path, {
      method,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Server xatosi (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError' || e.message === 'Network request failed' || e.message === 'Failed to fetch') {
      const err = new Error('Internet yo\'q yoki server javob bermadi');
      err.offline = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- branding
// The logo is cached as a data URI so it shows even with no network.
export const getBrand = () => store.getKv('brand', { companyName: '', version: '', logo: null });
const toDataUri = async (url) => {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
};
export async function refreshBrand(knownVersion) {
  const cur = getBrand();
  if (knownVersion && cur.version === String(knownVersion)) return cur;
  try {
    const b = await call('GET', '/api/public/brand');
    const logo = b.logoUrl ? await toDataUri(getServerUrl() + b.logoUrl) : null;
    const next = { companyName: b.companyName, version: String(b.version), logo };
    store.setKv('brand', next);
    return next;
  } catch {
    return cur;
  }
}

// ---------------------------------------------------------------- sessions
export async function login(phone, pin) {
  const r = await call('POST', '/api/mobile/login', { phone: phone.trim(), pin });
  store.setKv('session', { mode: 'collector', token: r.token, employee: r.employee });
  await refreshBootstrap();
  return r.employee;
}

export async function managerLogin(login, password) {
  const r = await call('POST', '/api/admin/login', { login: login.trim(), password });
  store.setKv('session', { mode: 'manager', token: r.token, user: r.user });
  return r.user;
}

export function logout() {
  store.setKv('session', null);
  store.setKv('bootstrap', null);
}

// Manager mode talks to the same API as the web panel (online only).
export async function admin(method, path, body) {
  try {
    return await call(method, '/api/admin' + path, body);
  } catch (e) {
    if (e.status === 401) logout();
    throw e;
  }
}
export const can = (perm) => {
  const s = getSession();
  if (s?.mode === 'manager') return !!s.user?.permissions?.includes(perm);
  return !!store.getKv('bootstrap')?.permissions?.includes(perm);
};

// ---------------------------------------------------------------- collector data
// Suppliers list is cached on the phone so the app works with no network at all.
export const getSuppliers = () => store.getKv('bootstrap', { suppliers: [] }).suppliers;
export const shiftStatus = (uuid) => (store.getKv('bootstrap')?.shifts ?? []).find((s) => s.uuid === uuid);

export async function refreshBootstrap() {
  const r = await call('GET', '/api/mobile/bootstrap');
  store.setKv('bootstrap', r);
  refreshBrand(r.brand?.version);
  return r;
}
export const history = () => call('GET', '/api/mobile/history');

// ---------------------------------------------------------------- background sync
const listeners = new Set();
export function onSyncState(fn) { listeners.add(fn); return () => listeners.delete(fn); }

let state = { online: true, syncing: false, lastSync: store.getKv('lastSync'), lastError: null };
const emit = (patch) => { state = { ...state, ...patch }; listeners.forEach((fn) => fn(state)); };
export const getSyncState = () => state;

let inFlight = null;
export function syncNow() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    if (getSession()?.mode !== 'collector') return;
    emit({ syncing: true });
    try {
      // Upload in batches until the queue is empty.
      for (let i = 0; i < 50; i++) {
        const p = store.pendingUpload();
        if (!p.shifts.length && !p.collections.length && !p.ops.length && !p.payments.length) break;
        const r = await call('POST', '/api/mobile/sync', {
          shifts: p.shifts.map((s) => ({ uuid: s.uuid, openedAt: s.opened_at, closedAt: s.closed_at })),
          collections: p.collections.map((c) => ({ uuid: c.uuid, shiftUuid: c.shift_uuid, supplierId: c.supplier_id,
            productId: c.product_id, quantity: c.quantity, collectedAt: c.collected_at })),
          ops: p.ops.map((o) => ({ uuid: o.uuid, type: o.type, target: o.target, ...(o.quantity != null ? { quantity: o.quantity } : {}),
            ...(o.product_id != null ? { productId: o.product_id } : {}), ...(o.reason ? { reason: o.reason } : {}) })),
          payments: p.payments.map((x) => ({ uuid: x.uuid, supplierId: x.supplier_id, amount: x.amount, method: x.method,
            ...(x.note ? { note: x.note } : {}), paidAt: x.paid_at })),
        }, { timeoutMs: 30000 });
        store.markUploaded(p.shifts, r);
      }
      await refreshBootstrap();
      store.pruneOld();
      const now = new Date().toISOString();
      store.setKv('lastSync', now);
      emit({ syncing: false, online: true, lastSync: now, lastError: null });
    } catch (err) {
      if (err.status === 401) logout();
      emit({ syncing: false, lastError: err.message });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

let started = false;
export function startAutoSync() {
  if (started) return;
  started = true;
  NetInfo.addEventListener((s) => {
    const online = !!s.isConnected && s.isInternetReachable !== false;
    emit({ online });
    if (online) syncNow();
  });
  AppState.addEventListener('change', (s) => { if (s === 'active') syncNow(); });
  setInterval(syncNow, 30000);
  syncNow();
}
