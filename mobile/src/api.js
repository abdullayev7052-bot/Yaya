import Constants from 'expo-constants';
import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';
import * as store from './db';

const DEFAULT_URL = Constants.expoConfig?.extra?.apiUrl ?? '';

export const getServerUrl = () => store.getKv('serverUrl', DEFAULT_URL);
export const setServerUrl = (url) => store.setKv('serverUrl', url.trim().replace(/\/+$/, ''));
export const getSession = () => store.getKv('session');

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
  } finally {
    clearTimeout(t);
  }
}

export async function login(phone, pin) {
  const r = await call('POST', '/api/mobile/login', { phone: phone.trim(), pin });
  store.setKv('session', { token: r.token, employee: r.employee });
  await refreshBootstrap();
  return r.employee;
}

export function logout() {
  store.setKv('session', null);
  store.setKv('bootstrap', null);
}

// Suppliers list is cached on the phone so the app works with no network at all.
export const getSuppliers = () => store.getKv('bootstrap', { suppliers: [] }).suppliers;

export async function refreshBootstrap() {
  const r = await call('GET', '/api/mobile/bootstrap');
  store.setKv('bootstrap', r);
  return r;
}

// ---- background sync ----
const listeners = new Set();
export function onSyncState(fn) { listeners.add(fn); return () => listeners.delete(fn); }

let state = { online: true, syncing: false, lastSync: store.getKv('lastSync'), lastError: null };
const emit = (patch) => { state = { ...state, ...patch }; listeners.forEach((fn) => fn(state)); };
export const getSyncState = () => state;

let inFlight = null;
export function syncNow() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    if (!getSession()) return;
    emit({ syncing: true });
    try {
      // Upload in batches until the queue is empty.
      for (let i = 0; i < 50; i++) {
        const { shifts, collections } = store.pendingUpload();
        if (!shifts.length && !collections.length) break;
        const r = await call('POST', '/api/mobile/sync', {
          shifts: shifts.map((s) => ({ uuid: s.uuid, openedAt: s.opened_at, closedAt: s.closed_at })),
          collections: collections.map((c) => ({ uuid: c.uuid, shiftUuid: c.shift_uuid, supplierId: c.supplier_id,
            productId: c.product_id, quantity: c.quantity, collectedAt: c.collected_at })),
        }, { timeoutMs: 30000 });
        store.markUploaded(shifts, r.accepted, r.rejected);
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
