import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as api from './src/api';
import * as store from './src/db';
import SyncBar from './src/SyncBar';
import { C, fmtQty, fmtTime, s } from './src/ui';

export default function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
        <StatusBar style="dark" />
        <Root />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Root() {
  const [session, setSession] = useState(api.getSession());
  const [shift, setShift] = useState(store.getOpenShift());
  // Unfinished input survives the app being killed: reopen straight into it.
  const [draft, setDraftState] = useState(() => (store.getOpenShift() ? store.getKv('draft') : null));
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState('');
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!session) return undefined;
    api.startAutoSync();
    const off = api.onSyncState(() => {
      if (!api.getSession()) setSession(null);
      refresh();
    });
    return off;
  }, [session, refresh]);

  const setDraft = (d) => { store.setKv('draft', d); setDraftState(d); };

  if (!session) return <Login onDone={() => setSession(api.getSession())} />;
  if (!shift) {
    return (
      <StartShift
        employee={session.employee}
        tick={tick}
        onOpen={() => { setShift(store.openShift()); api.syncNow(); }}
        onLogout={() => { api.logout(); setSession(null); }}
      />
    );
  }
  if (draft) {
    return (
      <Entry
        draft={draft}
        onChange={setDraft}
        onCancel={() => setDraft(null)}
        onSave={(supplier, product, quantity) => {
          store.addCollectionAndClearDraft({ shiftUuid: shift.uuid, supplier, product, quantity });
          setDraftState(null);
          refresh();
          api.syncNow();
          setToast(`${supplier.name}: ${fmtQty(quantity)} ${product.unit || 'kg'} saqlandi ✓`);
          setTimeout(() => setToast(''), 3000);
        }}
      />
    );
  }
  return (
    <View style={{ flex: 1 }}>
      {!!toast && (
        <View style={{ backgroundColor: C.ok, padding: 14 }}>
          <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>{toast}</Text>
        </View>
      )}
      <ShiftView
      shift={shift}
      employee={session.employee}
      tick={tick}
      onPick={(supplier) => {
        const def = supplier.products.find((p) => p.isDefault) ?? supplier.products[0];
        setDraft({ supplierId: supplier.id, productId: def?.id ?? null, qty: '' });
      }}
      onClosed={() => { setShift(null); api.syncNow(); refresh(); }}
      />
    </View>
  );
}

// ---------------------------------------------------------------- Login
function Login({ onDone }) {
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [taps, setTaps] = useState(0);
  const [url, setUrl] = useState(api.getServerUrl());

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      if (taps >= 5) api.setServerUrl(url);
      await api.login(phone.replace(/\D/g, ''), pin);
      onDone();
    } catch (e) {
      setErr(e.name === 'AbortError' || e.message === 'Network request failed'
        ? 'Internet yo\'q. Birinchi kirish uchun internet kerak.' : e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[s.pad, { flexGrow: 1, justifyContent: 'center', gap: 16 }]} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => setTaps((t) => t + 1)}>
          <Text style={[s.h1, { fontSize: 40, color: C.accent }]}>Yaya</Text>
          <Text style={s.muted}>Sut yig'uvchi</Text>
        </Pressable>
        {taps >= 5 && (
          <TextInput style={s.input} value={url} onChangeText={setUrl} placeholder="https://server-manzili"
            autoCapitalize="none" autoCorrect={false} keyboardType="url" />
        )}
        <TextInput style={s.input} value={phone} onChangeText={setPhone} placeholder="Telefon: 901234567"
          keyboardType="phone-pad" />
        <TextInput style={s.input} value={pin} onChangeText={setPin} placeholder="PIN" keyboardType="number-pad"
          secureTextEntry maxLength={6} onSubmitEditing={submit} />
        {!!err && <Text style={s.err}>{err}</Text>}
        <Pressable style={[s.btn, busy && { opacity: 0.6 }]} onPress={submit} disabled={busy || !phone || !pin}>
          <Text style={s.btnText}>{busy ? 'Kirilmoqda...' : 'Kirish'}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------- Start shift
function StartShift({ employee, tick, onOpen, onLogout }) {
  const suppliers = api.getSuppliers();
  const pending = store.unsyncedCount();
  void tick;
  return (
    <View style={{ flex: 1 }}>
      <SyncBar tick={tick} />
      <View style={[s.pad, { flex: 1, justifyContent: 'center', gap: 20 }]}>
        <Text style={s.h1}>Assalomu alaykum, {employee?.name}</Text>
        <Text style={s.muted}>Sizga biriktirilgan yetkazib beruvchilar: {suppliers.length} ta</Text>
        <Pressable style={[s.btn, { paddingVertical: 32 }]} onPress={onOpen}>
          <Text style={[s.btnText, { fontSize: 26 }]}>Smenani ochish</Text>
        </Pressable>
      </View>
      <View style={[s.pad, { gap: 10 }]}>
        <Pressable style={s.btnGhost} onPress={() => api.syncNow()}>
          <Text style={s.btnGhostText}>Ro'yxatni yangilash</Text>
        </Pressable>
        <Pressable
          style={s.btnGhost}
          onPress={() => {
            if (pending) {
              Alert.alert('Chiqib bo\'lmaydi', `${pending} ta yozuv hali serverga yuborilmagan. Internetga ulaning.`);
              return;
            }
            Alert.alert('Chiqish', 'Hisobdan chiqasizmi?', [{ text: 'Yo\'q' }, { text: 'Ha', onPress: onLogout }]);
          }}
        >
          <Text style={[s.btnGhostText, { color: C.muted }]}>Hisobdan chiqish</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- Shift: supplier list
function ShiftView({ shift, employee, tick, onPick, onClosed }) {
  const [q, setQ] = useState('');
  const [closing, setClosing] = useState(false);
  const suppliers = api.getSuppliers();
  const rows = useMemo(() => store.shiftCollections(shift.uuid), [shift.uuid, tick]);

  // Totals per supplier for this shift, so the collector sees who is already done.
  const done = useMemo(() => {
    const m = {};
    for (const r of rows) (m[r.supplier_id] ||= []).push(r);
    return m;
  }, [rows]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? suppliers.filter((x) => x.name.toLowerCase().includes(needle) || (x.address || '').toLowerCase().includes(needle)
        || (x.phone || '').includes(needle))
      : suppliers;
    // Not yet visited first; keep the admin's route order within each group.
    return [...filtered].sort((a, b) => (done[a.id] ? 1 : 0) - (done[b.id] ? 1 : 0));
  }, [suppliers, q, done]);

  if (closing) return <CloseShift shift={shift} rows={rows} onBack={() => setClosing(false)} onClosed={onClosed} />;

  const totalByUnit = rows.reduce((m, r) => ({ ...m, [r.product_name]: (m[r.product_name] || 0) + r.quantity }), {});

  return (
    <View style={{ flex: 1 }}>
      <SyncBar tick={tick} />
      <View style={{ padding: 12, gap: 8 }}>
        <Text style={s.muted}>
          {employee?.name} · smena {fmtTime(shift.opened_at)} · {rows.length} ta ·{' '}
          {Object.entries(totalByUnit).map(([k, v]) => `${k} ${fmtQty(v)}`).join(', ') || '0'}
        </Text>
        <TextInput style={s.input} value={q} onChangeText={setQ} placeholder="🔍  Ism bo'yicha qidirish"
          autoCorrect={false} clearButtonMode="while-editing" />
      </View>
      <FlatList
        data={list}
        keyExtractor={(x) => String(x.id)}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}
        ListEmptyComponent={<Text style={[s.muted, { padding: 16 }]}>{suppliers.length ? 'Topilmadi' : 'Sizga yetkazib beruvchi biriktirilmagan. Adminga murojaat qiling.'}</Text>}
        renderItem={({ item }) => {
          const got = done[item.id];
          const noProduct = !item.products?.length;
          return (
            <Pressable
              onPress={() => (noProduct
                ? Alert.alert('Mahsulot yo\'q', 'Bu yetkazib beruvchiga admin mahsulot biriktirmagan.')
                : onPick(item))}
              style={({ pressed }) => [s.card, { flexDirection: 'row', alignItems: 'center', minHeight: 68 },
                got && { borderColor: C.ok }, pressed && { opacity: 0.6 }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[s.text, { fontSize: 19, fontWeight: '600' }]}>{item.name}</Text>
                {!!item.address && <Text style={s.muted}>{item.address}</Text>}
              </View>
              {got && (
                <Text style={{ color: C.ok, fontSize: 18, fontWeight: '700' }}>
                  ✓ {fmtQty(got.reduce((a, r) => a + r.quantity, 0))}
                </Text>
              )}
            </Pressable>
          );
        }}
      />
      <View style={{ padding: 12 }}>
        <Pressable style={s.btnGhost} onPress={() => setClosing(true)}>
          <Text style={s.btnGhostText}>Smenani yopish</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- Quantity entry
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', '⌫'];

function Entry({ draft, onChange, onCancel, onSave }) {
  const supplier = api.getSuppliers().find((x) => x.id === draft.supplierId);
  useEffect(() => {
    // Supplier was unassigned while a draft was open: drop the draft.
    if (!supplier) onCancel();
  }, [supplier, onCancel]);
  if (!supplier) return null;

  const product = supplier.products.find((p) => p.id === draft.productId) ?? supplier.products[0];
  const qty = draft.qty;
  const value = Number(qty.replace(',', '.'));

  const press = (k) => {
    let next = qty;
    if (k === '⌫') next = qty.slice(0, -1);
    else if (k === ',') { if (!qty.includes(',')) next = (qty || '0') + ','; }
    else if (qty === '0') next = k;
    else if (/,\d{2}$/.test(qty) || qty.replace(',', '').length >= 6) return;
    else next = qty + k;
    onChange({ ...draft, productId: product.id, qty: next });
  };

  const save = () => {
    if (!(value > 0)) return;
    const doSave = () => onSave(supplier, product, value);
    if (value > 1000) {
      Alert.alert('Tekshiring', `${fmtQty(value)} ${product.unit || 'kg'} — to'g'rimi?`, [{ text: 'Yo\'q' }, { text: 'Ha, saqlash', onPress: doSave }]);
    } else doSave();
  };

  return (
    <View style={{ flex: 1, padding: 12, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Pressable onPress={onCancel} hitSlop={16} style={{ paddingRight: 12 }}>
          <Text style={{ fontSize: 28, color: C.muted }}>←</Text>
        </Pressable>
        <Text style={[s.h2, { flex: 1 }]} numberOfLines={2}>{supplier.name}</Text>
      </View>

      {supplier.products.length > 1 && (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {supplier.products.map((p) => {
            const on = p.id === product.id;
            return (
              <Pressable key={p.id} onPress={() => onChange({ ...draft, productId: p.id })}
                style={[s.btnGhost, { flexGrow: 1, paddingHorizontal: 16 }, on && { backgroundColor: C.accent, borderColor: C.accent }]}>
                <Text style={[s.btnGhostText, on && { color: C.accentText }]}>{p.name}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
      {supplier.products.length === 1 && <Text style={s.muted}>{product.name}</Text>}

      <View style={[s.card, { alignItems: 'flex-end', paddingVertical: 20 }]}>
        <Text style={{ fontSize: 56, fontWeight: '700', color: qty ? C.text : C.line }} adjustsFontSizeToFit numberOfLines={1}>
          {qty || '0'} <Text style={{ fontSize: 28, color: C.muted }}>{product.unit || 'kg'}</Text>
        </Text>
      </View>

      <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {KEYS.map((k) => (
          <Pressable key={k} onPress={() => press(k)}
            style={({ pressed }) => [s.card, { width: '31.5%', flexGrow: 1, alignItems: 'center', justifyContent: 'center',
              padding: 0, minHeight: 64 }, pressed && { backgroundColor: C.line }]}>
            <Text style={{ fontSize: 32, fontWeight: '600', color: C.text }}>{k}</Text>
          </Pressable>
        ))}
      </View>

      <Pressable style={[s.btn, { paddingVertical: 22 }, !(value > 0) && { opacity: 0.4 }]} onPress={save} disabled={!(value > 0)}>
        <Text style={[s.btnText, { fontSize: 26 }]}>OK — saqlash</Text>
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------- Close shift
function CloseShift({ shift, rows, onBack, onClosed }) {
  const byProduct = rows.reduce((m, r) => ({ ...m, [`${r.product_name}|${r.unit}`]: (m[`${r.product_name}|${r.unit}`] || 0) + r.quantity }), {});
  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={[s.pad, { gap: 12 }]}>
        <Text style={s.h1}>Smenani yopish</Text>
        <Text style={s.muted}>Ochilgan: {fmtTime(shift.opened_at)} · {rows.length} ta yetkazib berish</Text>
        <View style={[s.card, { gap: 6 }]}>
          {Object.entries(byProduct).map(([k, v]) => {
            const [name, unit] = k.split('|');
            return <Text key={k} style={[s.text, { fontSize: 22, fontWeight: '700' }]}>{name}: {fmtQty(v)} {unit}</Text>;
          })}
          {!rows.length && <Text style={s.muted}>Bu smenada yozuv yo'q</Text>}
        </View>
        {rows.map((r) => (
          <View key={r.uuid} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6,
            borderBottomWidth: 1, borderColor: C.line }}>
            <Text style={[s.text, { flex: 1 }]}>{fmtTime(r.collected_at)}  {r.supplier_name}</Text>
            <Text style={[s.text, { fontWeight: '600' }]}>{fmtQty(r.quantity)} {r.unit}</Text>
            <Text style={{ width: 28, textAlign: 'right', color: r.error ? C.err : r.synced_at ? C.ok : C.warn }}>
              {r.error ? '!' : r.synced_at ? '✓' : '…'}
            </Text>
          </View>
        ))}
      </ScrollView>
      <View style={[s.pad, { gap: 10 }]}>
        <Pressable style={s.btn} onPress={() => { store.closeShift(shift.uuid); onClosed(); }}>
          <Text style={s.btnText}>Ha, smenani yopish</Text>
        </Pressable>
        <Pressable style={s.btnGhost} onPress={onBack}>
          <Text style={s.btnGhostText}>Orqaga</Text>
        </Pressable>
      </View>
    </View>
  );
}
