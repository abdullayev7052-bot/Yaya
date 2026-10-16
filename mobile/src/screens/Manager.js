import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import * as api from '../api';
import { ask, notify } from '../dialog';
import { Chip, Header, Keypad, Logo, ShiftBadge, Tile, fmtMoney } from '../components';
import { C, fmtQty, fmtTime, s } from '../ui';

// Manager mode: the web panel's key screens, shaped for a phone. Online only —
// it reads live data from the server with the manager's own permissions.
const todayLocal = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);
const fmtDay = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const fmtDT = (iso) => (iso ? `${new Date(iso).toLocaleDateString('uz-UZ')} ${fmtTime(iso)}` : '');
const METHOD = { cash: 'Naqd', card: 'Karta', transfer: 'O\'tkazma' };

// Loads data and keeps error/refresh state in one place.
function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    setErr('');
    try { setData(await fn()); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { data, err, busy, load };
}

const Err = ({ err }) => (err ? <Text style={[s.err, { padding: 12 }]}>{err}</Text> : null);

export default function Manager({ session, onLogout }) {
  const tabs = [
    ['today', 'Bugun', 'dashboard.view'], ['debts', 'Qarzlar', 'payments.view'],
    ['shifts', 'Smenalar', 'shifts.view'], ['report', 'Hisobot', 'reports.view'],
  ].filter((t) => api.can(t[2]));
  const [tab, setTab] = useState(tabs[0]?.[0]);
  const [supplierId, setSupplierId] = useState(null);
  const [payFor, setPayFor] = useState(null);

  if (payFor) return <PaymentForm supplier={payFor} onBack={() => setPayFor(null)} onDone={() => setPayFor(null)} />;
  if (supplierId) return <SupplierCard id={supplierId} onBack={() => setSupplierId(null)} onPay={setPayFor} />;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10 }}>
        <Logo size={32} />
        <View style={{ flex: 1 }}>
          <Text style={[s.h2, { fontSize: 18 }]}>{api.getBrand().companyName || 'Yaya'}</Text>
          <Text style={s.muted}>{session.user.name || session.user.login} · {session.user.role}</Text>
        </View>
        <Pressable onPress={() => ask('Chiqish', 'Hisobdan chiqasizmi?', 'Ha', onLogout)} style={[s.btnGhost, { paddingVertical: 8, paddingHorizontal: 12 }]}>
          <Text style={s.btnGhostText}>Chiqish</Text>
        </Pressable>
      </View>
      <View style={{ flex: 1 }}>
        {!tabs.length && <Text style={[s.muted, { padding: 16 }]}>Sizda mobil ilovada ko'rish uchun ruxsat yo'q. Adminga murojaat qiling.</Text>}
        {tab === 'today' && <Today />}
        {tab === 'debts' && <Debts onOpen={setSupplierId} onPay={setPayFor} />}
        {tab === 'shifts' && <Shifts />}
        {tab === 'report' && <Report />}
      </View>
      {tabs.length > 1 && (
        <View style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: C.line, backgroundColor: C.card }}>
          {tabs.map(([k, t]) => (
            <Pressable key={k} onPress={() => setTab(k)} style={{ flex: 1, paddingVertical: 14, alignItems: 'center' }}>
              <Text style={{ fontSize: 15, fontWeight: tab === k ? '700' : '500', color: tab === k ? C.accent : C.muted }}>{t}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------- today
function Today() {
  const { data: d, err, busy, load } = useLoad(() => api.admin('GET', '/dashboard'), []);
  const money = api.can('amounts.view');
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}>
      <Err err={err} />
      {d && (
        <>
          <Text style={s.h2}>Bugun, {fmtDay(d.today.range.from)}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Tile label="Jami miqdor" value={fmtQty(d.today.totals.quantity)} sub="kg" />
            <Tile label="Yetkazib berish" value={String(d.today.totals.pickups)} sub={`${d.today.totals.suppliers} ta yetkazib beruvchi`} />
            {money && <Tile label="Summa" value={fmtMoney(d.today.totals.amount)} sub="so'm" />}
            {money && <Tile label="O'rtacha tannarx" value={d.cost.overall.avg_cost == null ? '—' : fmtMoney(d.cost.overall.avg_cost)}
              sub={d.cost.products.length ? (d.cost.final ? "so'm/kg · yakuniy" : "so'm/kg · dastlabki") : "so'm/kg"} />}
            {money && d.debt && <Tile label="Biz qarzmiz (jami)" value={fmtMoney(d.debt.weOwe)} sub="so'm" wide />}
          </View>
          <View style={[s.card, { gap: 6 }]}>
            <Text style={[s.text, { fontWeight: '700' }]}>Sut yig'uvchilar</Text>
            {d.today.byEmployee.map((r) => (
              <View key={r.id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={s.text}>{r.name}</Text>
                <Text style={s.text}>{r.suppliers} uy · <Text style={{ fontWeight: '700' }}>{fmtQty(r.quantity)} kg</Text></Text>
              </View>
            ))}
            {!d.today.byEmployee.length && <Text style={s.muted}>Bugun hali yozuv yo'q</Text>}
          </View>
          <View style={[s.card, { gap: 6 }]}>
            <Text style={[s.text, { fontWeight: '700' }]}>Smenalar</Text>
            {d.openShifts.map((x, i) => (
              <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={s.text}>{x.name} · {fmtTime(x.opened_at)} · {x.pickups} ta</Text>
                <ShiftBadge status={x.status} />
              </View>
            ))}
            {!d.openShifts.length && <Text style={s.muted}>Ochiq yoki tasdiq kutayotgan smena yo'q</Text>}
          </View>
        </>
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------- debts
function Debts({ onOpen, onPay }) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(q), 350); return () => clearTimeout(t); }, [q]);
  const { data, err, busy, load } = useLoad(() => api.admin('GET', `/balances?q=${encodeURIComponent(query)}`), [query]);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: 12, gap: 8 }}>
        {data && (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Tile label="Biz qarzmiz" value={fmtMoney(data.totals.weOwe)} sub="so'm" />
            <Tile label="Bizga qarz" value={fmtMoney(data.totals.theyOwe)} sub="so'm (avans)" />
          </View>
        )}
        <TextInput style={s.input} value={q} onChangeText={setQ} placeholder="🔍  Ism yoki telefon raqam" autoCorrect={false} />
      </View>
      <Err err={err} />
      <FlatList
        data={data?.rows ?? []}
        keyExtractor={(r) => String(r.id)}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}
        renderItem={({ item: r }) => (
          <Pressable onPress={() => onOpen(r.id)} style={({ pressed }) => [s.card, { flexDirection: 'row', alignItems: 'center', gap: 8 }, pressed && { opacity: 0.6 }]}>
            <View style={{ flex: 1 }}>
              <Text style={[s.text, { fontWeight: '600' }]}>{r.name}</Text>
              <Text style={s.muted}>{r.phone ?? ''}</Text>
            </View>
            <Text style={{ fontSize: 17, fontWeight: '700', color: r.balance < 0 ? C.warn : C.text }}>{fmtMoney(r.balance)}</Text>
            {api.can('payments.create') && (
              <Pressable onPress={() => onPay(r)} style={[s.btn, { paddingVertical: 8, paddingHorizontal: 12 }]}>
                <Text style={[s.btnText, { fontSize: 15 }]}>To'lov</Text>
              </Pressable>
            )}
          </Pressable>
        )}
      />
    </View>
  );
}

function SupplierCard({ id, onBack, onPay }) {
  const { data: c, err, busy, load } = useLoad(() => api.admin('GET', `/suppliers/${id}/card`), [id]);
  const money = api.can('amounts.view');
  const st = c?.statement;
  return (
    <View style={{ flex: 1 }}>
      <Header title={c?.supplier.name ?? '...'} onBack={onBack}
        right={st && api.can('payments.create') ? (
          <Pressable onPress={() => onPay({ ...c.supplier, balance: st.balance })} style={[s.btn, { paddingVertical: 8, paddingHorizontal: 12 }]}>
            <Text style={[s.btnText, { fontSize: 15 }]}>To'lov</Text>
          </Pressable>) : null} />
      <Err err={err} />
      {c && (
        <FlatList
          data={st?.entries ?? []}
          keyExtractor={(e) => `${e.kind}${e.id}`}
          refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}
          contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 6 }}
          ListHeaderComponent={(
            <View style={{ gap: 8, marginBottom: 8 }}>
              <Text style={s.muted}>{[c.supplier.phone, c.supplier.address].filter(Boolean).join(' · ')}</Text>
              {money && <Text style={s.text}>{c.products.map((p) => `${p.is_default ? '★ ' : ''}${p.name}: ${fmtMoney(p.price)}`).join(' · ')}</Text>}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {st && <Tile label={st.balance >= 0 ? 'Biz qarzmiz' : 'Bizga qarz'} value={fmtMoney(Math.abs(st.balance))} sub="so'm" />}
                <Tile label="Jami olingan" value={fmtQty(c.allTime.quantity)} sub={`kg · ${c.allTime.pickups} marta`} />
                <Tile label="60 kunda" value={fmtQty(c.last60.totals.quantity)} sub="kg" />
                {money && <Tile label="Jami summa" value={fmtMoney(c.allTime.amount)} sub="so'm" />}
              </View>
              {st && <Text style={[s.text, { fontWeight: '700', marginTop: 4 }]}>Hisob-kitob tarixi</Text>}
            </View>
          )}
          renderItem={({ item: e }) => (
            <View style={[s.card, { padding: 10, flexDirection: 'row', gap: 8 }, e.voided_at && { opacity: 0.45 }]}>
              <View style={{ flex: 1 }}>
                <Text style={s.text}>{e.kind === 'pickup' ? `${e.product_name} · ${fmtQty(e.quantity)} ${e.unit}` : `To'lov · ${METHOD[e.method]}`}{e.voided_at ? ' · bekor' : ''}</Text>
                <Text style={s.muted}>{fmtDT(e.at)}{e.note ? ` · ${e.note}` : ''}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ fontWeight: '700', color: e.kind === 'pickup' ? C.text : C.ok }}>{e.kind === 'pickup' ? '+' : '−'}{fmtMoney(e.amount)}</Text>
                <Text style={s.muted}>qoldiq {fmtMoney(e.balance)}</Text>
              </View>
            </View>
          )}
        />
      )}
    </View>
  );
}

function PaymentForm({ supplier, onBack, onDone }) {
  const [amount, setAmount] = useState(supplier.balance > 0 ? String(Math.round(supplier.balance)) : '');
  const [method, setMethod] = useState('cash');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const value = Number(amount);
  const save = () => {
    if (!(value > 0) || busy) return;
    ask('To\'lovni tasdiqlang', `${supplier.name}\n${fmtMoney(value)} so'm (${METHOD[method]})`, 'Ha, saqlash', async () => {
      setBusy(true);
      setErr('');
      try {
        await api.admin('POST', '/payments', { supplierId: supplier.id, amount: value, method });
        onDone();
      } catch (e) { setErr(e.message); } finally { setBusy(false); }
    });
  };
  return (
    <View style={{ flex: 1, padding: 12, gap: 10 }}>
      <Header title={`To'lov: ${supplier.name}`} onBack={onBack} />
      {supplier.balance != null && <Text style={s.muted}>Joriy qarzimiz: {fmtMoney(supplier.balance)} so'm</Text>}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {Object.entries(METHOD).map(([k, t]) => <Chip key={k} label={t} on={method === k} onPress={() => setMethod(k)} />)}
      </View>
      <View style={[s.card, { alignItems: 'flex-end', paddingVertical: 18 }]}>
        <Text style={{ fontSize: 44, fontWeight: '700', color: amount ? C.text : C.line }} adjustsFontSizeToFit numberOfLines={1}>
          {fmtMoney(value || 0)} <Text style={{ fontSize: 22, color: C.muted }}>so'm</Text>
        </Text>
      </View>
      {!!err && <Text style={s.err}>{err}</Text>}
      <Keypad value={amount} onChange={setAmount} onSubmit={save} onCancel={onBack} decimals={0} maxDigits={11} />
      <Pressable style={[s.btn, { paddingVertical: 20 }, (!(value > 0) || busy) && { opacity: 0.4 }]} onPress={save} disabled={!(value > 0) || busy}>
        <Text style={s.btnText}>{busy ? 'Saqlanmoqda...' : 'To\'lovni saqlash'}</Text>
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------- shifts
function Shifts() {
  const [status, setStatus] = useState('closed');
  const from = addDays(todayLocal(), -13);
  const { data, err, busy, load } = useLoad(() => api.admin('GET', `/shifts?from=${from}&status=${status}`), [status]);
  const [rejecting, setRejecting] = useState(null);
  const [note, setNote] = useState('');
  const review = async (id, decision, reason) => {
    try {
      await api.admin('POST', `/shifts/${id}/review`, { decision, note: reason });
      setRejecting(null);
      setNote('');
      load();
    } catch (e) { notify('Xato', e.message); }
  };
  const money = api.can('amounts.view');
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', gap: 6, padding: 12 }}>
        {[['closed', 'Kutmoqda'], ['open', 'Ochiq'], ['approved', 'Tasdiq'], ['rejected', 'Rad']].map(([k, t]) => <Chip key={k} label={t} on={status === k} onPress={() => setStatus(k)} />)}
      </View>
      <Err err={err} />
      <FlatList
        data={data ?? []}
        keyExtractor={(x) => String(x.id)}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}
        ListEmptyComponent={<Text style={[s.muted, { padding: 16 }]}>{data ? 'Smena yo\'q (oxirgi 14 kun)' : 'Yuklanmoqda...'}</Text>}
        renderItem={({ item: x }) => (
          <View style={[s.card, { gap: 6 }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={[s.text, { fontWeight: '700' }]}>{x.employee_name}{x.is_test ? ' (test)' : ''}</Text>
              <ShiftBadge status={x.status} />
            </View>
            <Text style={s.muted}>{fmtDT(x.opened_at)} — {x.closed_at ? fmtTime(x.closed_at) : '...'}</Text>
            <Text style={s.text}>{x.pickups} ta · {x.suppliers} uy · <Text style={{ fontWeight: '700' }}>{fmtQty(x.quantity)} kg</Text>{money ? ` · ${fmtMoney(x.amount)} so'm` : ''}</Text>
            {!!x.review_note && <Text style={{ color: x.status === 'rejected' ? C.err : C.muted }}>{x.review_note}</Text>}
            {api.can('shifts.approve') && x.status !== 'open' && (rejecting === x.id ? (
              <View style={{ gap: 8 }}>
                <TextInput style={s.input} value={note} onChangeText={setNote} placeholder="Rad etish sababi" autoFocus />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable style={[s.btnGhost, { flex: 1 }]} onPress={() => setRejecting(null)}><Text style={s.btnGhostText}>Bekor</Text></Pressable>
                  <Pressable style={[s.btn, { flex: 1, backgroundColor: C.err }, !note.trim() && { opacity: 0.4 }]} disabled={!note.trim()} onPress={() => review(x.id, 'reject', note.trim())}>
                    <Text style={s.btnText}>Rad etish</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {x.status !== 'approved' && <Pressable style={[s.btn, { flex: 1, paddingVertical: 12 }]} onPress={() => review(x.id, 'approve')}><Text style={[s.btnText, { fontSize: 17 }]}>Tasdiqlash</Text></Pressable>}
                {x.status !== 'rejected' && <Pressable style={[s.btnGhost, { flex: 1 }]} onPress={() => setRejecting(x.id)}><Text style={s.btnGhostText}>Rad etish</Text></Pressable>}
              </View>
            ))}
          </View>
        )}
      />
    </View>
  );
}

// ---------------------------------------------------------------- daily report & average cost
function Report() {
  const [day, setDay] = useState(todayLocal());
  const money = api.can('amounts.view');
  const { data, err, busy, load } = useLoad(async () => {
    const [cost, sum] = await Promise.all([api.admin('GET', `/reports/daily-cost?day=${day}`), api.admin('GET', `/reports/summary?from=${day}&to=${day}`)]);
    return { cost, sum };
  }, [day]);
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Pressable style={[s.btnGhost, { paddingHorizontal: 18 }]} onPress={() => setDay(addDays(day, -1))}><Text style={s.btnGhostText}>‹</Text></Pressable>
        <Text style={[s.h2, { flex: 1, textAlign: 'center' }]}>{fmtDay(day)}</Text>
        <Pressable style={[s.btnGhost, { paddingHorizontal: 18 }, day >= todayLocal() && { opacity: 0.3 }]} disabled={day >= todayLocal()} onPress={() => setDay(addDays(day, 1))}><Text style={s.btnGhostText}>›</Text></Pressable>
      </View>
      <Err err={err} />
      {data && (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Tile label="Jami miqdor" value={fmtQty(data.sum.totals.quantity)} sub="kg" />
            <Tile label="Yetkazib berish" value={String(data.sum.totals.pickups)} sub={`${data.sum.totals.suppliers} ta yetkazib beruvchi`} />
            {money && <Tile label="Summa" value={fmtMoney(data.sum.totals.amount)} sub="so'm" />}
            {money && <Tile label="O'rtacha tannarx" value={data.cost.overall.avg_cost == null ? '—' : fmtMoney(data.cost.overall.avg_cost)} sub="so'm/kg" />}
          </View>
          {money && (
            <View style={[s.card, { gap: 6 }]}>
              <Text style={[s.text, { fontWeight: '700' }]}>O'rtacha tannarx (mahsulot bo'yicha)</Text>
              {!!data.cost.products.length && (
                <Text style={{ color: data.cost.final ? C.ok : C.warn, fontWeight: '600' }}>
                  {data.cost.final ? 'Yakuniy — barcha smenalar tasdiqlangan'
                    : `Dastlabki — ochiq: ${data.cost.shifts.open}, kutmoqda: ${data.cost.shifts.closed}, rad: ${data.cost.shifts.rejected}`}
                </Text>
              )}
              {data.cost.products.map((p) => (
                <View key={p.id} style={{ borderTopWidth: 1, borderColor: C.line, paddingTop: 6 }}>
                  <Text style={[s.text, { fontWeight: '600' }]}>{p.name}: {fmtMoney(p.avg_cost)} so'm/{p.unit}</Text>
                  <Text style={s.muted}>{fmtQty(p.quantity)} {p.unit} · {fmtMoney(p.amount)} so'm · narx {fmtMoney(p.min_price)}–{fmtMoney(p.max_price)}</Text>
                </View>
              ))}
              {!data.cost.products.length && <Text style={s.muted}>Bu kunda xarid yo'q</Text>}
              <Text style={s.muted}>Hisoblash: jami summa ÷ jami miqdor</Text>
            </View>
          )}
          <View style={[s.card, { gap: 6 }]}>
            <Text style={[s.text, { fontWeight: '700' }]}>Sut yig'uvchilar faoliyati</Text>
            {data.sum.byEmployee.map((r) => (
              <View key={r.id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={s.text}>{r.name}</Text>
                <Text style={s.text}>{r.pickups} ta · <Text style={{ fontWeight: '700' }}>{fmtQty(r.quantity)} kg</Text></Text>
              </View>
            ))}
            {!data.sum.byEmployee.length && <Text style={s.muted}>—</Text>}
          </View>
          <View style={[s.card, { gap: 6 }]}>
            <Text style={[s.text, { fontWeight: '700' }]}>Yetkazib beruvchilar</Text>
            {data.sum.bySupplier.map((r) => (
              <View key={r.id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={[s.text, { flex: 1 }]} numberOfLines={1}>{r.name}</Text>
                <Text style={s.text}>{fmtQty(r.quantity)} kg{money ? ` · ${fmtMoney(r.amount)}` : ''}</Text>
              </View>
            ))}
          </View>
        </>
      )}
    </ScrollView>
  );
}
