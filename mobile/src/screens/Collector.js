import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import * as api from '../api';
import * as store from '../db';
import SyncBar from '../SyncBar';
import { ask, notify } from '../dialog';
import { Chip, Header, Keypad, Logo, ShiftBadge, fmtMoney, matches, toNumber } from '../components';
import { C, fmtQty, fmtTime, s } from '../ui';

// Milk collector mode: offline-first. Every action is written to the phone
// first and uploaded by the background sync.
export default function Collector({ session, tick, refresh, onLogout }) {
  const [shift, setShift] = useState(store.getOpenShift());
  // Unfinished input survives the app being killed: reopen straight into it.
  const [draft, setDraftState] = useState(() => (store.getOpenShift() ? store.getKv('draft') : null));
  const [screen, setScreen] = useState(null); // null | 'entries' | 'pay' | 'history' | 'close' | { edit: row }
  const [toast, setToast] = useState('');

  const setDraft = (d) => { store.setKv('draft', d); setDraftState(d); };
  const say = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3000); };
  const back = () => setScreen(null);

  return (
    <View style={{ flex: 1 }}>
      {!!toast && (
        <View style={{ backgroundColor: C.ok, padding: 14 }}>
          <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>{toast}</Text>
        </View>
      )}
      <View style={{ flex: 1 }}>{content()}</View>
    </View>
  );

  function content() {
    if (screen === 'history') return <History onBack={back} />;
    if (screen === 'pay') return <Payment onBack={back} onSaved={(m) => { back(); refresh(); api.syncNow(); say(m); }} />;
    if (!shift) {
      return (
        <StartShift
          employee={session.employee}
          tick={tick}
          onOpen={() => { setShift(store.openShift()); api.syncNow(); }}
          onNav={setScreen}
          onLogout={onLogout}
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
            say(`${supplier.name}: ${fmtQty(quantity)} ${product.unit || 'kg'} saqlandi ✓`);
          }}
        />
      );
    }
    if (screen?.edit) {
      return <EditEntry row={screen.edit} onBack={() => setScreen('entries')} onSaved={() => { setScreen('entries'); refresh(); api.syncNow(); say('O\'zgartirildi ✓'); }} />;
    }
    if (screen === 'entries') return <Entries shift={shift} tick={tick} onBack={back} onEdit={(row) => setScreen({ edit: row })} refresh={refresh} />;
    if (screen === 'close') return <CloseShift shift={shift} onBack={back} onClosed={() => { setShift(null); setScreen(null); api.syncNow(); refresh(); }} />;
    return (
      <ShiftView
        shift={shift}
        employee={session.employee}
        tick={tick}
        onPick={(supplier) => {
          const def = supplier.products.find((p) => p.isDefault) ?? supplier.products[0];
          setDraft({ supplierId: supplier.id, productId: def?.id ?? null, qty: '' });
        }}
        onNav={setScreen}
      />
    );
  }
}

// ---------------------------------------------------------------- Start shift
function StartShift({ employee, tick, onOpen, onNav, onLogout }) {
  const suppliers = api.getSuppliers();
  const pending = store.unsyncedCount();
  const rejected = (store.getKv('bootstrap')?.shifts ?? []).filter((x) => x.status === 'rejected');
  void tick;
  return (
    <View style={{ flex: 1 }}>
      <SyncBar tick={tick} />
      <ScrollView contentContainerStyle={[s.pad, { flexGrow: 1, justifyContent: 'center', gap: 16 }]}>
        <View style={{ alignItems: 'center' }}><Logo size={72} /></View>
        <Text style={s.h1}>Assalomu alaykum, {employee?.name}</Text>
        <Text style={s.muted}>Sizga biriktirilgan yetkazib beruvchilar: {suppliers.length} ta</Text>
        {rejected.map((r) => (
          <View key={r.uuid} style={[s.card, { borderColor: C.err }]}>
            <Text style={{ color: C.err, fontWeight: '700' }}>Smena rad etildi</Text>
            <Text style={s.text}>{r.review_note}</Text>
          </View>
        ))}
        <Pressable style={[s.btn, { paddingVertical: 32 }]} onPress={onOpen}>
          <Text style={[s.btnText, { fontSize: 26 }]}>Smenani ochish</Text>
        </Pressable>
      </ScrollView>
      <View style={[s.pad, { gap: 10 }]}>
        {api.can('app.pay') && (
          <Pressable style={s.btnGhost} onPress={() => onNav('pay')}><Text style={s.btnGhostText}>To'lov kiritish</Text></Pressable>
        )}
        {api.can('app.history') && (
          <Pressable style={s.btnGhost} onPress={() => onNav('history')}><Text style={s.btnGhostText}>Smenalarim tarixi</Text></Pressable>
        )}
        <Pressable style={s.btnGhost} onPress={() => api.syncNow()}>
          <Text style={s.btnGhostText}>Ro'yxatni yangilash</Text>
        </Pressable>
        <Pressable
          style={s.btnGhost}
          onPress={() => {
            if (pending) {
              notify('Chiqib bo\'lmaydi', `${pending} ta yozuv hali serverga yuborilmagan. Internetga ulaning.`);
              return;
            }
            ask('Chiqish', 'Hisobdan chiqasizmi?', 'Ha', onLogout);
          }}
        >
          <Text style={[s.btnGhostText, { color: C.muted }]}>Hisobdan chiqish</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- Shift: supplier list
function ShiftView({ shift, employee, tick, onPick, onNav }) {
  const [q, setQ] = useState('');
  const suppliers = api.getSuppliers();
  const rows = useMemo(() => store.shiftCollections(shift.uuid).filter((r) => !r.voided_at), [shift.uuid, tick]);

  // Totals per supplier for this shift, so the collector sees who is already done.
  const done = useMemo(() => {
    const m = {};
    for (const r of rows) (m[r.supplier_id] ||= []).push(r);
    return m;
  }, [rows]);

  const list = useMemo(() => [...suppliers.filter((x) => matches(x, q))]
    // Not yet visited first; keep the admin's route order within each group.
    .sort((a, b) => (done[a.id] ? 1 : 0) - (done[b.id] ? 1 : 0)), [suppliers, q, done]);

  const totalByUnit = rows.reduce((m, r) => ({ ...m, [r.product_name]: (m[r.product_name] || 0) + r.quantity }), {});

  return (
    <View style={{ flex: 1 }}>
      <SyncBar tick={tick} />
      <View style={{ padding: 12, gap: 8 }}>
        <Text style={s.muted}>
          {employee?.name} · smena {fmtTime(shift.opened_at)} · {rows.length} ta ·{' '}
          {Object.entries(totalByUnit).map(([k, v]) => `${k} ${fmtQty(v)}`).join(', ') || '0'}
        </Text>
        <TextInput style={s.input} value={q} onChangeText={setQ} placeholder="🔍  Ism yoki telefon raqam"
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
                ? notify('Mahsulot yo\'q', 'Bu yetkazib beruvchiga admin mahsulot biriktirmagan.')
                : onPick(item))}
              style={({ pressed }) => [s.card, { flexDirection: 'row', alignItems: 'center', minHeight: 68 },
                got && { borderColor: C.ok }, pressed && { opacity: 0.6 }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[s.text, { fontSize: 19, fontWeight: '600' }]}>{item.name}</Text>
                {!!(item.address || item.phone) && <Text style={s.muted}>{[item.address, item.phone].filter(Boolean).join(' · ')}</Text>}
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
      <View style={{ padding: 12, flexDirection: 'row', gap: 8 }}>
        <Pressable style={[s.btnGhost, { flex: 1 }]} onPress={() => onNav('entries')}><Text style={s.btnGhostText}>Yozuvlar</Text></Pressable>
        {api.can('app.pay') && <Pressable style={[s.btnGhost, { flex: 1 }]} onPress={() => onNav('pay')}><Text style={s.btnGhostText}>To'lov</Text></Pressable>}
        <Pressable style={[s.btnGhost, { flex: 1 }]} onPress={() => onNav('close')}><Text style={s.btnGhostText}>Yopish</Text></Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- Quantity entry
function Entry({ draft, onChange, onCancel, onSave }) {
  const supplier = api.getSuppliers().find((x) => x.id === draft.supplierId);
  useEffect(() => {
    // Supplier was unassigned while a draft was open: drop the draft.
    if (!supplier) onCancel();
  }, [supplier, onCancel]);
  if (!supplier) return null;
  const product = supplier.products.find((p) => p.id === draft.productId) ?? supplier.products[0];
  return (
    <QuantityPad
      title={supplier.name}
      products={supplier.products}
      product={product}
      qty={draft.qty}
      onProduct={(p) => onChange({ ...draft, productId: p.id })}
      onQty={(qty) => onChange({ ...draft, productId: product.id, qty })}
      onCancel={onCancel}
      onSave={(value) => onSave(supplier, product, value)}
      saveLabel="OK — saqlash"
    />
  );
}

function QuantityPad({ title, products, product, qty, onProduct, onQty, onCancel, onSave, saveLabel }) {
  const value = toNumber(qty);
  const save = () => {
    if (!(value > 0)) return;
    if (value > 1000) ask('Tekshiring', `${fmtQty(value)} ${product.unit || 'kg'} — to'g'rimi?`, 'Ha, saqlash', () => onSave(value));
    else onSave(value);
  };
  return (
    <View style={{ flex: 1, padding: 12, gap: 10 }}>
      <Header title={title} onBack={onCancel} />
      {products.length > 1 ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {products.map((p) => <Chip key={p.id} label={p.name} on={p.id === product.id} onPress={() => onProduct(p)} />)}
        </View>
      ) : <Text style={s.muted}>{product.name}</Text>}
      <View style={[s.card, { alignItems: 'flex-end', paddingVertical: 20 }]}>
        <Text style={{ fontSize: 56, fontWeight: '700', color: qty ? C.text : C.line }} adjustsFontSizeToFit numberOfLines={1}>
          {qty || '0'} <Text style={{ fontSize: 28, color: C.muted }}>{product.unit || 'kg'}</Text>
        </Text>
      </View>
      <Keypad value={qty} onChange={onQty} onSubmit={save} onCancel={onCancel} />
      <Pressable style={[s.btn, { paddingVertical: 22 }, !(value > 0) && { opacity: 0.4 }]} onPress={save} disabled={!(value > 0)}>
        <Text style={[s.btnText, { fontSize: 26 }]}>{saveLabel}</Text>
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------- Own entries: edit / void
function locked(row) {
  return api.shiftStatus(row.shift_uuid)?.status === 'approved';
}

function Entries({ shift, tick, onBack, onEdit, refresh }) {
  const rows = useMemo(() => store.shiftCollections(shift.uuid), [shift.uuid, tick]);
  const canEdit = api.can('app.edit_own');
  const canVoid = api.can('app.void_own');
  return (
    <View style={{ flex: 1 }}>
      <Header title="Bu smenadagi yozuvlar" onBack={onBack} />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.uuid}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}
        ListEmptyComponent={<Text style={[s.muted, { padding: 16 }]}>Hali yozuv yo'q</Text>}
        renderItem={({ item: r }) => (
          <View style={[s.card, { gap: 6 }, r.voided_at && { opacity: 0.5 }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={[s.text, { fontWeight: '600', flex: 1 }]}>{fmtTime(r.collected_at)}  {r.supplier_name}</Text>
              <Text style={[s.text, { fontWeight: '700' }]}>{fmtQty(r.quantity)} {r.unit}</Text>
            </View>
            <Text style={s.muted}>
              {r.product_name}{r.edited_at ? ' · tahrirlangan' : ''}{r.voided_at ? ' · BEKOR QILINGAN' : ''}
              {' · '}{r.error ? `xato: ${r.error}` : r.synced_at ? 'yuborilgan ✓' : 'telefonda'}
            </Text>
            {!r.voided_at && !locked(r) && (canEdit || canVoid) && (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {canEdit && <Pressable style={[s.btnGhost, { flex: 1, paddingVertical: 10 }]} onPress={() => onEdit(r)}><Text style={s.btnGhostText}>Tahrirlash</Text></Pressable>}
                {canVoid && (
                  <Pressable style={[s.btnGhost, { flex: 1, paddingVertical: 10 }]}
                    onPress={() => ask('Bekor qilish', `${r.supplier_name}: ${fmtQty(r.quantity)} ${r.unit} — bekor qilinsinmi?`, 'Ha, bekor qilish', () => {
                      store.voidCollection(r.uuid, 'Sut yig\'uvchi bekor qildi');
                      refresh();
                      api.syncNow();
                    })}>
                    <Text style={[s.btnGhostText, { color: C.err }]}>Bekor qilish</Text>
                  </Pressable>
                )}
              </View>
            )}
            {locked(r) && <Text style={s.muted}>Smena tasdiqlangan — o'zgartirib bo'lmaydi</Text>}
          </View>
        )}
      />
    </View>
  );
}

function EditEntry({ row, onBack, onSaved }) {
  const supplier = api.getSuppliers().find((x) => x.id === row.supplier_id);
  const products = supplier?.products?.length ? supplier.products : [{ id: row.product_id, name: row.product_name, unit: row.unit }];
  const [product, setProduct] = useState(products.find((p) => p.id === row.product_id) ?? products[0]);
  const [qty, setQty] = useState(String(row.quantity).replace('.', ','));
  return (
    <QuantityPad
      title={`Tahrirlash: ${row.supplier_name}`}
      products={products}
      product={product}
      qty={qty}
      onProduct={setProduct}
      onQty={setQty}
      onCancel={onBack}
      onSave={(value) => { store.editCollection(row.uuid, { quantity: value, product }); onSaved(); }}
      saveLabel="Saqlash"
    />
  );
}

// ---------------------------------------------------------------- Payment in the field
const METHODS = [['cash', 'Naqd'], ['card', 'Karta'], ['transfer', 'O\'tkazma']];

function Payment({ onBack, onSaved }) {
  const [supplier, setSupplier] = useState(null);
  const [q, setQ] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const suppliers = api.getSuppliers().filter((x) => matches(x, q));
  const recent = store.recentPayments().slice(0, 5);

  if (!supplier) {
    return (
      <View style={{ flex: 1 }}>
        <Header title="To'lov: kimga?" onBack={onBack} />
        <View style={{ paddingHorizontal: 12 }}>
          <TextInput style={s.input} value={q} onChangeText={setQ} placeholder="🔍  Ism yoki telefon raqam" autoCorrect={false} />
        </View>
        <FlatList
          data={suppliers}
          keyExtractor={(x) => String(x.id)}
          contentContainerStyle={{ padding: 12, gap: 8 }}
          ListFooterComponent={recent.length ? (
            <View style={{ marginTop: 12, gap: 4 }}>
              <Text style={s.muted}>Oxirgi to'lovlar:</Text>
              {recent.map((p) => (
                <Text key={p.uuid} style={s.text}>{fmtTime(p.paid_at)}  {p.supplier_name} — {fmtMoney(p.amount)} so'm {p.error ? `(xato: ${p.error})` : p.synced_at ? '✓' : '…'}</Text>
              ))}
            </View>
          ) : null}
          renderItem={({ item }) => (
            <Pressable onPress={() => setSupplier(item)} style={({ pressed }) => [s.card, pressed && { opacity: 0.6 }]}>
              <Text style={[s.text, { fontSize: 18, fontWeight: '600' }]}>{item.name}</Text>
              {!!item.phone && <Text style={s.muted}>{item.phone}</Text>}
            </Pressable>
          )}
        />
      </View>
    );
  }
  const value = Number(amount);
  const save = () => {
    if (!(value > 0)) return;
    ask('To\'lovni tasdiqlang', `${supplier.name}\n${fmtMoney(value)} so'm (${METHODS.find((m) => m[0] === method)[1]})`, 'Ha, saqlash', () => {
      store.addPayment({ supplier, amount: value, method });
      onSaved(`To'lov saqlandi: ${supplier.name} — ${fmtMoney(value)} so'm ✓`);
    });
  };
  return (
    <View style={{ flex: 1, padding: 12, gap: 10 }}>
      <Header title={`To'lov: ${supplier.name}`} onBack={() => setSupplier(null)} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {METHODS.map(([k, t]) => <Chip key={k} label={t} on={method === k} onPress={() => setMethod(k)} />)}
      </View>
      <View style={[s.card, { alignItems: 'flex-end', paddingVertical: 20 }]}>
        <Text style={{ fontSize: 48, fontWeight: '700', color: amount ? C.text : C.line }} adjustsFontSizeToFit numberOfLines={1}>
          {fmtMoney(value || 0)} <Text style={{ fontSize: 24, color: C.muted }}>so'm</Text>
        </Text>
      </View>
      <Keypad value={amount} onChange={setAmount} onSubmit={save} onCancel={() => setSupplier(null)} decimals={0} maxDigits={10} />
      <Pressable style={[s.btn, { paddingVertical: 22 }, !(value > 0) && { opacity: 0.4 }]} onPress={save} disabled={!(value > 0)}>
        <Text style={[s.btnText, { fontSize: 24 }]}>To'lovni saqlash</Text>
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------- History (online)
function History({ onBack }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => { setErr(''); api.history().then(setRows).catch((e) => setErr(e.message)); }, []);
  useEffect(load, [load]);
  return (
    <View style={{ flex: 1 }}>
      <Header title="Smenalarim tarixi" onBack={onBack} />
      {!!err && <Text style={[s.err, { padding: 12 }]}>{err}</Text>}
      <FlatList
        data={rows ?? []}
        keyExtractor={(r) => r.uuid}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}
        ListEmptyComponent={<Text style={[s.muted, { padding: 16 }]}>{rows ? 'Hali smena yo\'q' : 'Yuklanmoqda...'}</Text>}
        renderItem={({ item: r }) => (
          <View style={[s.card, { gap: 4 }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={[s.text, { fontWeight: '600' }]}>{new Date(r.opened_at).toLocaleDateString('uz-UZ')}  {fmtTime(r.opened_at)}–{r.closed_at ? fmtTime(r.closed_at) : '...'}</Text>
              <ShiftBadge status={r.status} />
            </View>
            <Text style={s.text}>{r.pickups} ta yetkazib berish · {fmtQty(r.quantity)} kg</Text>
            {!!r.review_note && <Text style={{ color: r.status === 'rejected' ? C.err : C.muted }}>{r.review_note}</Text>}
          </View>
        )}
      />
    </View>
  );
}

// ---------------------------------------------------------------- Close shift
function CloseShift({ shift, onBack, onClosed }) {
  const rows = store.shiftCollections(shift.uuid).filter((r) => !r.voided_at);
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
        <Text style={s.muted}>Yopilgandan keyin smena omborchi/rahbar tasdig'iga yuboriladi.</Text>
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
