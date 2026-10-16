'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('uz-UZ', { maximumFractionDigits: d }).replace(/,/g, ' '));
const fmtMoney = (n) => (n == null ? '—' : fmtNum(Math.round(n), 0));
// Server stores UTC; show Tashkent time (UTC+5, no DST).
const fmtDate = (s) => {
  if (!s) return '';
  const d = new Date(/Z$|[+-]\d\d:\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  return new Date(d.getTime() + 5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
};
const todayLocal = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);
const dayLabel = (day) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const METHOD = { cash: 'Naqd', card: 'Karta', transfer: 'O\'tkazma' };
const SHIFT_STATUS = { open: ['Ochiq', 'pending'], closed: ['Tasdiq kutmoqda', 'pending'], approved: ['Tasdiqlangan', 'sent'], rejected: ['Rad etilgan', 'error'] };

let token = null;
let me = null;
let brand = { companyName: '', logoUrl: null };
try { token = localStorage.getItem('yaya_token'); } catch { /* storage unavailable */ }
const can = (perm) => !!me?.permissions.includes(perm);

async function api(method, path, body) {
  const res = await fetch('/api/admin' + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== '/login') { logout(); throw new Error('Sessiya tugadi, qayta kiring'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Xatolik: ' + res.status);
  return data;
}

// Downloads need the auth header, so fetch the file instead of following a link.
async function download(path, filename) {
  const res = await fetch('/api/admin' + path, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('Yuklab bo\'lmadi');
  const url = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function flash(msg, kind = 'ok') {
  const el = $('#flash');
  el.textContent = msg;
  el.className = kind;
  el.hidden = false;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { el.hidden = true; }, kind === 'err' ? 8000 : 3000);
}
// Wraps an async action so any error is shown instead of silently lost.
const act = (fn) => async (...args) => { try { await fn(...args); } catch (e) { flash(e.message, 'err'); } };

// Generic edit dialog. fields: [{name,label,type,value,options:[[v,t]],required,hint}]
function openForm({ title, fields, submit = 'Saqlash', onSubmit, intro = '' }) {
  const dlg = $('#dlg');
  dlg.innerHTML = `<form method="dialog">
    <h2>${esc(title)}</h2>${intro}
    ${fields.map((f) => {
      if (f.type === 'checkbox') return `<label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="${f.name}" ${f.value ? 'checked' : ''}> ${esc(f.label)}</label>`;
      if (f.type === 'select') return `<label>${esc(f.label)}<select name="${f.name}" ${f.required ? 'required' : ''}>${f.options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(f.value ?? '') ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
      return `<label>${esc(f.label)}<input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" ${f.required ? 'required' : ''}
        ${f.pattern ? `pattern="${f.pattern}"` : ''} ${f.inputmode ? `inputmode="${f.inputmode}"` : ''} ${f.step ? `step="${f.step}"` : ''} ${f.min != null ? `min="${f.min}"` : ''} placeholder="${esc(f.placeholder ?? '')}" autocomplete="off">
        ${f.hint ? `<span class="muted">${esc(f.hint)}</span>` : ''}</label>`;
    }).join('')}
    <p class="err" id="dlgErr"></p>
    <div class="actions"><button type="button" class="ghost" value="cancel">Bekor</button><button value="ok">${esc(submit)}</button></div>
  </form>`;
  const form = $('form', dlg);
  $('button[value=cancel]', dlg).onclick = () => dlg.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = {};
    for (const f of fields) {
      const input = form.elements[f.name];
      data[f.name] = f.type === 'checkbox' ? input.checked : input.value;
    }
    try {
      await onSubmit(data);
      dlg.close();
      route();
    } catch (err) {
      $('#dlgErr').textContent = err.message;
    }
  };
  dlg.showModal();
  $('input, select', dlg)?.focus();
}

function paymentForm(supplier, balance) {
  openForm({
    title: `To'lov: ${supplier.name}`,
    intro: balance != null ? `<p class="muted">Joriy qarzimiz: <b>${fmtMoney(balance)}</b> so'm</p>` : '',
    fields: [
      { name: 'amount', label: 'Summa (so\'m)', type: 'number', min: 1, step: 1, required: true, value: balance > 0 ? Math.round(balance) : '' },
      { name: 'method', label: 'Usul', type: 'select', options: Object.entries(METHOD), value: 'cash' },
      { name: 'paidAt', label: 'Sana', type: 'date', value: todayLocal() },
      { name: 'note', label: 'Izoh' },
    ],
    submit: 'To\'lovni saqlash',
    onSubmit: async (d) => {
      // A date-only value means "that day, now-ish" in Tashkent.
      const paidAt = d.paidAt === todayLocal() ? new Date().toISOString() : new Date(`${d.paidAt}T12:00:00+05:00`).toISOString();
      await api('POST', '/payments', { supplierId: supplier.id, amount: Number(d.amount), method: d.method, note: d.note, paidAt });
      flash('To\'lov saqlandi');
    },
  });
}

function voidForm(title, path) {
  openForm({
    title, submit: 'Bekor qilish',
    fields: [{ name: 'reason', label: 'Sababi', required: true }],
    onSubmit: async (d) => { await api('POST', path, d); flash('Bekor qilindi'); },
  });
}

function logout() {
  token = null;
  me = null;
  try { localStorage.removeItem('yaya_token'); } catch { /* ignore */ }
  show();
}

async function loadBrand() {
  try { brand = await (await fetch('/api/public/brand')).json(); } catch { /* keep defaults */ }
  const logo = brand.logoUrl ? `<img src="${esc(brand.logoUrl)}" alt="" class="logo">` : '';
  const name = esc(brand.companyName || 'Yaya');
  $('#brandLogin').innerHTML = `${logo}<h1>${name}</h1>`;
  $('#brandHead').innerHTML = `${logo}<b>${name}</b>`;
  document.title = `${brand.companyName || 'Yaya'} — Boshqaruv`;
  if (brand.logoUrl) {
    let link = $('link[rel=icon]');
    if (!link) document.head.appendChild(link = Object.assign(document.createElement('link'), { rel: 'icon' }));
    link.href = brand.logoUrl;
  }
}

const PAGES = [
  ['dashboard', 'Bugun', 'dashboard.view'], ['reports', 'Hisobotlar', 'reports.view'], ['collections', 'Xaridlar', 'collections.view'],
  ['shifts', 'Smenalar', 'shifts.view'], ['debts', 'Qarzlar va to\'lovlar', 'payments.view'],
  ['suppliers', 'Yetkazib beruvchilar', 'suppliers.view'], ['employees', 'Sut yig\'uvchilar', 'employees.manage'],
  ['catalog', 'Mahsulot va omborlar', 'catalog.manage'], ['tester', 'Ilovani sinash', 'tester.use'],
  ['users', 'Foydalanuvchilar va ruxsatlar', 'users.manage'], ['settings', 'Sozlamalar', null],
];

async function show() {
  if (token && !me) {
    try { me = await api('GET', '/me'); } catch { token = null; }
  }
  $('#login').hidden = !!me;
  $('#main').hidden = !me;
  if (!me) return;
  $('#nav').innerHTML = PAGES.filter((p) => !p[2] || can(p[2])).map(([k, t]) => `<a href="#${k}">${t}</a>`).join('');
  $('#whoami').textContent = `${me.name || me.login} · ${me.role}`;
  route();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api('POST', '/login', { login: f.get('login'), password: f.get('password') });
    token = r.token;
    me = r.user;
    try { localStorage.setItem('yaya_token', token); } catch { /* ignore */ }
    $('#loginErr').textContent = '';
    e.target.reset();
    show();
  } catch (err) {
    $('#loginErr').textContent = err.message;
  }
});
$('#logout').addEventListener('click', logout);

const hashParams = () => new URLSearchParams(location.hash.split('?')[1] || '');
const setHash = (name, params) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
  location.hash = name + (qs ? '?' + qs : '');
};
const money = () => can('amounts.view');

function tiles(t) {
  return `<div class="tiles">
    <div class="tile"><div class="k">Jami miqdor</div><div class="v">${fmtNum(t.quantity)}</div><div class="s">kg</div></div>
    ${money() ? `<div class="tile"><div class="k">Summa</div><div class="v">${fmtMoney(t.amount)}</div><div class="s">so'm</div></div>` : ''}
    <div class="tile"><div class="k">Yetkazib berishlar</div><div class="v">${t.pickups}</div><div class="s">${t.suppliers} ta yetkazib beruvchidan</div></div>
    ${money() ? `<div class="tile"><div class="k">O'rtacha tannarx</div><div class="v">${t.quantity ? fmtMoney(t.amount / t.quantity) : '—'}</div><div class="s">so'm / kg (vaznli)</div></div>` : ''}
  </div>`;
}

function dailyChart(host, byDay, from, to) {
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const products = [];
  for (const r of byDay) if (!products.find((p) => p.key === r.product_id)) products.push({ key: r.product_id, name: esc(r.product_name) });
  // More than three products fold into "Boshqa" so colors stay distinguishable.
  const series = products.length > 3 ? [...products.slice(0, 2), { key: 'other', name: 'Boshqa' }] : products;
  const keep = new Set(series.map((s) => s.key));
  const map = new Map();
  for (const r of byDay) {
    const k = keep.has(r.product_id) ? r.product_id : 'other';
    map.set(`${r.day}|${k}`, (map.get(`${r.day}|${k}`) || 0) + r.quantity);
  }
  Charts.stackedBars(host, {
    categories: days.map((d) => ({ key: d, label: dayLabel(d) })),
    series: series.length ? series : [{ key: 'none', name: 'Miqdor' }],
    value: (d, s) => map.get(`${d}|${s}`) || 0,
    unit: 'kg',
  });
}

function costBlock(c) {
  const st = c.shifts;
  const status = !c.products.length ? '' : c.final
    ? '<span class="badge sent">Yakuniy — barcha smenalar yopilgan va tasdiqlangan</span>'
    : `<span class="badge pending">Dastlabki — ochiq: ${st.open}, tasdiq kutmoqda: ${st.closed}, rad etilgan: ${st.rejected}</span>`;
  return `<div class="card">
    <div class="row" style="justify-content:space-between;align-items:center"><h2>O'rtacha tannarx — ${esc(c.day)}</h2>${status}</div>
    <p class="muted">Hisoblash: <b>jami to'langan summa ÷ jami miqdor</b> (har bir yetkazib beruvchi o'z hajmi bo'yicha hisobga olinadi).</p>
    <div class="table-wrap"><table>
      <tr><th>Mahsulot</th><th class="num">Yetkazib beruvchi</th><th class="num">Miqdor</th><th class="num">Summa</th><th class="num">Min narx</th><th class="num">Max narx</th><th class="num">O'rtacha tannarx</th></tr>
      ${c.products.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${p.suppliers}</td><td class="num">${fmtNum(p.quantity)} ${esc(p.unit)}</td>
        <td class="num">${fmtMoney(p.amount)}</td><td class="num">${fmtMoney(p.min_price)}</td><td class="num">${fmtMoney(p.max_price)}</td>
        <td class="num"><b>${fmtNum(p.avg_cost)}</b></td></tr>`).join('') || '<tr><td colspan="7" class="muted">Bu kunda xarid yo\'q</td></tr>'}
      ${c.products.length > 1 ? `<tr><td><b>Hammasi</b></td><td></td><td class="num"><b>${fmtNum(c.overall.quantity)}</b></td><td class="num"><b>${fmtMoney(c.overall.amount)}</b></td><td></td><td></td><td class="num"><b>${fmtNum(c.overall.avg_cost)}</b></td></tr>` : ''}
    </table></div></div>`;
}

const shiftBadge = (s) => `<span class="badge ${SHIFT_STATUS[s]?.[1] ?? ''}">${SHIFT_STATUS[s]?.[0] ?? esc(s)}</span>`;

const views = {
  // ------------------------------------------------------------------ today
  async dashboard(v) {
    const d = await api('GET', '/dashboard');
    const t = d.today;
    v.innerHTML = `
      <h2>Bugun, ${esc(t.range.from)}</h2>
      ${tiles(t.totals)}
      ${money() && can('payments.view') ? `<div class="tiles">
        <div class="tile"><div class="k">Biz qarzmiz (jami)</div><div class="v">${fmtMoney(d.debt.weOwe)}</div><div class="s">so'm · <a href="#debts">batafsil</a></div></div>
        <div class="tile"><div class="k">Bizga qarz (avans)</div><div class="v">${fmtMoney(d.debt.theyOwe)}</div><div class="s">so'm</div></div></div>` : ''}
      ${money() ? costBlock(d.cost) : ''}
      <div class="card"><h2>Oxirgi 30 kun — kunlik miqdor (kg)</h2><div id="chart30"></div>
        <p class="muted">30 kunda: ${fmtNum(d.month.totals.quantity)} kg${money() ? ` · ${fmtMoney(d.month.totals.amount)} so'm` : ''} · ${d.month.totals.pickups} ta yetkazib berish</p></div>
      <div class="grid2">
        <div class="card"><h2>Bugun — sut yig'uvchilar</h2>
          <table><tr><th>Ism</th><th class="num">Uylar</th><th class="num">kg</th>${money() ? '<th class="num">Summa</th>' : ''}</tr>
          ${t.byEmployee.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${r.suppliers}</td><td class="num">${fmtNum(r.quantity)}</td>${money() ? `<td class="num">${fmtMoney(r.amount)}</td>` : ''}</tr>`).join('')
            || '<tr><td colspan="4" class="muted">Bugun hali yozuv yo\'q</td></tr>'}</table></div>
        <div class="card"><h2>Smenalar</h2>
          ${d.openShifts.map((s) => `<p>${esc(s.name)} — ${shiftBadge(s.status)} <span class="muted">${esc(fmtDate(s.opened_at))}, ${s.pickups} ta</span></p>`).join('') || '<p class="muted">Ochiq yoki tasdiq kutayotgan smena yo\'q</p>'}
          ${can('shifts.view') ? '<p><a href="#shifts">Smenalar sahifasi →</a></p>' : ''}
          <h2 style="margin-top:16px">Oxirgi sinxronlash</h2>
          <table>${d.lastSync.map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${esc(fmtDate(s.at))}</td></tr>`).join('') || '<tr><td class="muted">—</td></tr>'}</table>
        </div>
      </div>`;
    dailyChart($('#chart30', v), d.month.byDay, d.month.range.from, d.month.range.to);
  },

  // ------------------------------------------------------------------ analytics
  async reports(v) {
    const q = hashParams();
    const today = todayLocal();
    const from = q.get('from') || addDays(today, -6);
    const to = q.get('to') || today;
    const costDay = q.get('day') || today;
    const filt = { employee: q.get('employee') || '', supplier: q.get('supplier') || '' };
    const qs = new URLSearchParams({ from, to, ...filt }).toString();
    const [s, cost, emps, sups] = await Promise.all([api('GET', '/reports/summary?' + qs), api('GET', '/reports/daily-cost?day=' + costDay),
      api('GET', '/employees/names'), can('suppliers.view') ? api('GET', '/suppliers') : []]);
    const monthStart = today.slice(0, 8) + '01';
    const prevMonthEnd = addDays(monthStart, -1);
    const presets = [
      ['Bugun', today, today], ['Kecha', addDays(today, -1), addDays(today, -1)], ['7 kun', addDays(today, -6), today],
      ['30 kun', addDays(today, -29), today], ['Bu oy', monthStart, today], ["O'tgan oy", prevMonthEnd.slice(0, 8) + '01', prevMonthEnd],
    ];
    v.innerHTML = `
      ${money() ? `<div class="card row" style="align-items:end"><label>Tannarx kuni <input type="date" id="costDay" value="${costDay}"></label></div>${costBlock(cost)}` : ''}
      <div class="card">
        <div class="row">
          <div class="presets">${presets.map(([t, f, tt]) => `<button class="ghost small ${f === from && tt === to ? 'on' : ''}" data-f="${f}" data-t="${tt}">${t}</button>`).join('')}</div>
          <label>Dan <input type="date" id="from" value="${from}"></label>
          <label>Gacha <input type="date" id="to" value="${to}"></label>
          <label>Sut yig'uvchi <select id="emp"><option value="">Hammasi</option>${emps.filter((e) => !e.is_test).map((e) => `<option value="${e.id}" ${String(e.id) === filt.employee ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>
          ${sups.length ? `<label>Yetkazib beruvchi <select id="sup"><option value="">Hammasi</option>${sups.map((x) => `<option value="${x.id}" ${String(x.id) === filt.supplier ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>` : ''}
          ${can('reports.export') ? '<button type="button" class="ghost" id="csv">⬇ Excel (CSV)</button>' : ''}
        </div>
      </div>
      ${tiles(s.totals)}
      <div class="card"><h2>Kunlik miqdor (kg)</h2><div id="daily"></div></div>
      <div class="grid2">
        <div class="card"><h2>Yetkazib beruvchilar bo'yicha (kg)</h2><div id="rankSup"></div></div>
        <div class="card"><h2>Sut yig'uvchilar bo'yicha (kg)</h2><div id="rankEmp"></div></div>
      </div>
      <div class="card"><h2>Mahsulotlar</h2><div class="table-wrap"><table>
        <tr><th>Mahsulot</th><th class="num">Yetkazib berish</th><th class="num">Miqdor</th>${money() ? '<th class="num">O\'rtacha tannarx</th><th class="num">Summa</th>' : ''}</tr>
        ${s.byProduct.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${p.pickups}</td><td class="num">${fmtNum(p.quantity)} ${esc(p.unit)}</td>${money() ? `<td class="num">${fmtNum(p.avg_price)}</td><td class="num">${fmtMoney(p.amount)}</td>` : ''}</tr>`).join('')
          || '<tr><td colspan="5" class="muted">Bu davrda yozuv yo\'q</td></tr>'}
      </table></div></div>
      <div class="card"><h2>Yetkazib beruvchilar — to'liq jadval</h2><div class="table-wrap"><table>
        <tr><th>Yetkazib beruvchi</th><th class="num">Yetkazib berish</th><th class="num">Miqdor (kg)</th>${money() ? '<th class="num">Summa</th>' : ''}<th class="num">Oxirgi</th></tr>
        ${s.bySupplier.map((r) => `<tr><td>${can('suppliers.view') ? `<a href="#supplier?id=${r.id}">${esc(r.name)}</a>` : esc(r.name)}</td><td class="num">${r.pickups}</td><td class="num">${fmtNum(r.quantity)}</td>${money() ? `<td class="num">${fmtMoney(r.amount)}</td>` : ''}<td class="num">${esc(fmtDate(r.last_at))}</td></tr>`).join('')
          || '<tr><td colspan="5" class="muted">—</td></tr>'}
      </table></div></div>`;
    dailyChart($('#daily', v), s.byDay, s.range.from, s.range.to);
    Charts.rankBars($('#rankSup', v), { rows: s.bySupplier.map((r) => ({ label: esc(r.name), value: r.quantity, sub: money() ? `${fmtMoney(r.amount)} so'm` : '' })), unit: 'kg' });
    Charts.rankBars($('#rankEmp', v), { rows: s.byEmployee.map((r) => ({ label: esc(r.name), value: r.quantity, sub: `${r.pickups} ta${money() ? ` · ${fmtMoney(r.amount)} so'm` : ''}` })), unit: 'kg' });

    const go = (patch) => setHash('reports', { from, to, day: costDay, ...filt, ...patch });
    $$('.presets button', v).forEach((b) => { b.onclick = () => go({ from: b.dataset.f, to: b.dataset.t }); });
    $('#from', v).onchange = (e) => go({ from: e.target.value });
    $('#to', v).onchange = (e) => go({ to: e.target.value });
    $('#emp', v).onchange = (e) => go({ employee: e.target.value });
    $('#sup', v) && ($('#sup', v).onchange = (e) => go({ supplier: e.target.value }));
    $('#costDay', v) && ($('#costDay', v).onchange = (e) => go({ day: e.target.value }));
    $('#csv', v) && ($('#csv', v).onclick = act(() => download(`/reports/export.csv?${qs}`, `yaya_${from}_${to}.csv`)));
  },

  // ------------------------------------------------------------------ pickups
  async collections(v) {
    const q = hashParams();
    const today = todayLocal();
    const params = { from: q.get('from') || today, to: q.get('to') || today, employee: q.get('employee') || '', supplier: q.get('supplier') || '', voided: q.get('voided') || '', shift: q.get('shift') || '' };
    const [rows, emps, sups, links] = await Promise.all([
      api('GET', '/collections?' + new URLSearchParams(params)), api('GET', '/employees/names'),
      can('suppliers.view') ? api('GET', '/suppliers') : [], can('collections.edit') && can('suppliers.view') ? api('GET', '/supplier-products') : [],
    ]);
    const live = rows.filter((r) => !r.voided_at && !r.is_test);
    v.innerHTML = `
      <div class="card">${params.shift ? `<p><b>Bitta smena yozuvlari</b> · <a href="#collections">barchasini ko'rsatish</a></p>` : `<div class="row">
        <label>Dan <input type="date" id="from" value="${params.from}"></label>
        <label>Gacha <input type="date" id="to" value="${params.to}"></label>
        <label>Sut yig'uvchi <select id="emp"><option value="">Hammasi</option>${emps.map((e) => `<option value="${e.id}" ${String(e.id) === params.employee ? 'selected' : ''}>${esc(e.name)}${e.is_test ? ' (test)' : ''}</option>`).join('')}</select></label>
        ${sups.length ? `<label>Yetkazib beruvchi <select id="sup"><option value="">Hammasi</option>${sups.map((x) => `<option value="${x.id}" ${String(x.id) === params.supplier ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>` : ''}
        <label style="display:flex;gap:6px;align-items:center;color:var(--text)"><input type="checkbox" id="voided" ${params.voided ? 'checked' : ''}> Bekor qilinganlar ham</label>
      </div>`}
      <p class="muted">${live.length} ta yozuv · ${fmtNum(live.reduce((a, r) => a + r.quantity, 0))} kg${money() ? ` · ${fmtMoney(live.reduce((a, r) => a + r.amount, 0))} so'm` : ''} (test va bekor qilinganlarsiz)</p></div>
      <div class="card"><div class="table-wrap"><table>
        <tr><th>Vaqt</th><th>Sut yig'uvchi</th><th>Yetkazib beruvchi</th><th>Mahsulot</th><th class="num">Miqdor</th>${money() ? '<th class="num">Narx</th><th class="num">Summa</th>' : ''}<th>Smena</th><th></th></tr>
        ${rows.map((r) => `<tr class="${r.voided_at ? 'voided' : ''}">
          <td>${esc(fmtDate(r.collected_at))}${r.edited_at ? ` <span class="muted" title="${esc(r.edited_by)} · ${esc(fmtDate(r.edited_at))}">✎</span>` : ''}</td>
          <td>${esc(r.employee_name)} ${r.is_test ? '<span class="badge test">test</span>' : ''}</td>
          <td>${esc(r.supplier_name)}</td><td>${esc(r.product_name)}</td>
          <td class="num">${fmtNum(r.quantity)} ${esc(r.unit)}</td>${money() ? `<td class="num">${fmtMoney(r.price)}</td><td class="num">${fmtMoney(r.amount)}</td>` : ''}
          <td>${r.shift_status ? shiftBadge(r.shift_status) : ''}</td>
          <td class="row">${r.voided_at
            ? `<span class="muted" title="${esc(r.voided_by)} · ${esc(fmtDate(r.voided_at))}">Bekor: ${esc(r.void_reason)}</span> ${can('collections.void') ? `<button class="small ghost" data-restore="${r.id}">Tiklash</button>` : ''}`
            : `${can('collections.edit') ? `<button class="small ghost" data-edit="${r.id}">Tahrirlash</button>` : ''}${can('collections.void') ? `<button class="small ghost" data-void="${r.id}">Bekor qilish</button>` : ''}`}</td>
        </tr>`).join('') || '<tr><td colspan="9" class="muted">Yozuv yo\'q</td></tr>'}
      </table></div></div>`;
    const go = (patch) => setHash('collections', { ...params, ...patch });
    $('#from', v) && ($('#from', v).onchange = (e) => go({ from: e.target.value }));
    $('#to', v) && ($('#to', v).onchange = (e) => go({ to: e.target.value }));
    $('#emp', v) && ($('#emp', v).onchange = (e) => go({ employee: e.target.value }));
    $('#sup', v) && ($('#sup', v).onchange = (e) => go({ supplier: e.target.value }));
    $('#voided', v) && ($('#voided', v).onchange = (e) => go({ voided: e.target.checked ? '1' : '' }));
    $$('[data-void]', v).forEach((b) => { b.onclick = () => voidForm('Yozuvni bekor qilish', `/collections/${b.dataset.void}/void`); });
    $$('[data-restore]', v).forEach((b) => { b.onclick = act(async () => { await api('POST', `/collections/${b.dataset.restore}/restore`); route(); }); });
    $$('[data-edit]', v).forEach((b) => { b.onclick = () => {
      const r = rows.find((x) => String(x.id) === b.dataset.edit);
      const opts = links.filter((l) => l.supplier_id === r.supplier_id).map((l) => [l.product_id, l.product_name]);
      openForm({
        title: `Tahrirlash: ${r.supplier_name}`,
        fields: [
          { name: 'quantity', label: `Miqdor (${r.unit})`, type: 'number', step: 'any', min: 0.01, value: r.quantity, required: true },
          ...(opts.length > 1 ? [{ name: 'productId', label: 'Mahsulot', type: 'select', options: opts, value: r.product_id }] : []),
        ],
        onSubmit: async (d) => { await api('PATCH', `/collections/${r.id}`, { quantity: Number(d.quantity), productId: d.productId ? Number(d.productId) : undefined }); flash('Saqlandi'); },
      });
    }; });
  },

  // ------------------------------------------------------------------ shifts
  async shifts(v) {
    const q = hashParams();
    const today = todayLocal();
    const params = { from: q.get('from') || addDays(today, -6), to: q.get('to') || today, status: q.get('status') || '', employee: q.get('employee') || '' };
    const [rows, emps] = await Promise.all([api('GET', '/shifts?' + new URLSearchParams(params)), api('GET', '/employees/names')]);
    v.innerHTML = `
      <div class="card"><div class="row">
        <label>Dan <input type="date" id="from" value="${params.from}"></label>
        <label>Gacha <input type="date" id="to" value="${params.to}"></label>
        <label>Holat <select id="st"><option value="">Hammasi</option>${Object.entries(SHIFT_STATUS).map(([k, [t]]) => `<option value="${k}" ${k === params.status ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Sut yig'uvchi <select id="emp"><option value="">Hammasi</option>${emps.map((e) => `<option value="${e.id}" ${String(e.id) === params.employee ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>
      </div><p class="muted">Sut yig'uvchi smenani yopgach, u "Tasdiq kutmoqda" holatiga o'tadi. Tasdiqlangan smenadagi yozuvlarni sut yig'uvchi endi o'zgartira olmaydi.</p></div>
      <div class="card"><div class="table-wrap"><table>
        <tr><th>Sut yig'uvchi</th><th>Ochilgan</th><th>Yopilgan</th><th class="num">Yetkazib berish</th><th class="num">kg</th>${money() ? '<th class="num">Summa</th>' : ''}<th>Holat</th><th></th></tr>
        ${rows.map((s) => `<tr>
          <td>${esc(s.employee_name)} ${s.is_test ? '<span class="badge test">test</span>' : ''}</td>
          <td>${esc(fmtDate(s.opened_at))}</td><td>${esc(fmtDate(s.closed_at))}</td>
          <td class="num">${s.pickups}</td><td class="num">${fmtNum(s.quantity)}</td>${money() ? `<td class="num">${fmtMoney(s.amount)}</td>` : ''}
          <td>${shiftBadge(s.status)}${s.review_note ? `<div class="muted">${esc(s.review_note)}</div>` : ''}${s.reviewed_by ? `<div class="muted">${esc(s.reviewed_by)} · ${esc(fmtDate(s.reviewed_at))}</div>` : ''}</td>
          <td class="row">${can('collections.view') ? `<a href="#collections?shift=${encodeURIComponent(s.client_uuid)}&voided=1"><button class="small ghost">Yozuvlar</button></a>` : ''}
            ${can('shifts.approve') && s.status !== 'open' ? `${s.status !== 'approved' ? `<button class="small" data-ok="${s.id}">Tasdiqlash</button>` : ''}${s.status !== 'rejected' ? `<button class="small ghost" data-no="${s.id}">Rad etish</button>` : ''}` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="8" class="muted">Smena yo\'q</td></tr>'}
      </table></div></div>`;
    const go = (patch) => setHash('shifts', { ...params, ...patch });
    $('#from', v).onchange = (e) => go({ from: e.target.value });
    $('#to', v).onchange = (e) => go({ to: e.target.value });
    $('#st', v).onchange = (e) => go({ status: e.target.value });
    $('#emp', v).onchange = (e) => go({ employee: e.target.value });
    $$('[data-ok]', v).forEach((b) => { b.onclick = act(async () => { await api('POST', `/shifts/${b.dataset.ok}/review`, { decision: 'approve' }); flash('Tasdiqlandi'); route(); }); });
    $$('[data-no]', v).forEach((b) => { b.onclick = () => openForm({
      title: 'Smenani rad etish', submit: 'Rad etish',
      fields: [{ name: 'note', label: 'Sababi (sut yig\'uvchi ilovada ko\'radi)', required: true }],
      onSubmit: async (d) => { await api('POST', `/shifts/${b.dataset.no}/review`, { decision: 'reject', note: d.note }); flash('Rad etildi'); },
    }); });
  },

  // ------------------------------------------------------------------ debts & payments
  async debts(v) {
    const q = hashParams();
    const today = todayLocal();
    const params = { q: q.get('q') || '', from: q.get('from') || addDays(today, -29), to: q.get('to') || today };
    const [b, pays] = await Promise.all([api('GET', '/balances?q=' + encodeURIComponent(params.q)), api('GET', `/payments?from=${params.from}&to=${params.to}&voided=1`)]);
    v.innerHTML = `
      <div class="tiles">
        <div class="tile"><div class="k">Biz qarzmiz</div><div class="v">${fmtMoney(b.totals.weOwe)}</div><div class="s">so'm, ${b.rows.filter((r) => r.balance > 0).length} ta yetkazib beruvchiga</div></div>
        <div class="tile"><div class="k">Bizga qarz (avans)</div><div class="v">${fmtMoney(b.totals.theyOwe)}</div><div class="s">so'm</div></div>
      </div>
      <div class="card">
        <input id="q" value="${esc(params.q)}" placeholder="Ism, telefon yoki manzil bo'yicha qidirish..." style="width:100%">
        <div class="table-wrap"><table>
          <tr><th>Yetkazib beruvchi</th><th>Telefon</th><th class="num">Olingan</th><th class="num">To'langan</th><th class="num">Qarz</th><th>Oxirgi to'lov</th><th></th></tr>
          ${b.rows.map((r) => `<tr ${r.active ? '' : 'class="muted"'}>
            <td><a href="#supplier?id=${r.id}">${esc(r.name)}</a></td><td>${esc(r.phone)}</td>
            <td class="num">${fmtMoney(r.purchased)}</td><td class="num">${fmtMoney(r.paid)}</td>
            <td class="num"><b class="${r.balance < 0 ? 'warn' : ''}">${fmtMoney(r.balance)}</b></td>
            <td>${esc(fmtDate(r.last_payment).slice(0, 10))}</td>
            <td>${can('payments.create') ? `<button class="small" data-pay="${r.id}">To'lov</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Topilmadi</td></tr>'}
        </table></div>
        <p class="muted">Qarz = boshlang'ich qarz + olingan sut summasi − to'lovlar. Musbat — biz qarzmiz, manfiy — yetkazib beruvchi bizga qarz (avans).</p>
      </div>
      <div class="card"><div class="row" style="justify-content:space-between"><h2>To'lovlar tarixi</h2>
        <div class="row"><label>Dan <input type="date" id="from" value="${params.from}"></label><label>Gacha <input type="date" id="to" value="${params.to}"></label></div></div>
        <div class="table-wrap"><table>
          <tr><th>Sana</th><th>Yetkazib beruvchi</th><th class="num">Summa</th><th>Usul</th><th>Izoh</th><th>Kim</th><th></th></tr>
          ${pays.map((p) => `<tr class="${p.voided_at ? 'voided' : ''}"><td>${esc(fmtDate(p.paid_at))}</td><td><a href="#supplier?id=${p.supplier_id}">${esc(p.supplier_name)}</a></td>
            <td class="num">${fmtMoney(p.amount)}</td><td>${METHOD[p.method]}</td><td>${esc(p.note)}</td><td class="muted">${esc(p.created_by.replace(/^\w+:/, ''))}</td>
            <td>${p.voided_at ? `<span class="muted">Bekor: ${esc(p.void_reason)}</span>` : can('payments.void') ? `<button class="small ghost" data-void="${p.id}">Bekor qilish</button>` : ''}</td></tr>`).join('')
            || '<tr><td colspan="7" class="muted">Bu davrda to\'lov yo\'q</td></tr>'}
        </table></div></div>`;
    let t;
    $('#q', v).oninput = (e) => { clearTimeout(t); t = setTimeout(() => setHash('debts', { ...params, q: e.target.value }), 400); };
    $('#q', v).focus();
    $('#q', v).setSelectionRange(params.q.length, params.q.length);
    $('#from', v).onchange = (e) => setHash('debts', { ...params, from: e.target.value });
    $('#to', v).onchange = (e) => setHash('debts', { ...params, to: e.target.value });
    $$('[data-pay]', v).forEach((btn) => { btn.onclick = () => { const r = b.rows.find((x) => String(x.id) === btn.dataset.pay); paymentForm(r, r.balance); }; });
    $$('[data-void]', v).forEach((btn) => { btn.onclick = () => voidForm('To\'lovni bekor qilish', `/payments/${btn.dataset.void}/void`); });
  },

  // ------------------------------------------------------------------ supplier card
  async supplier(v) {
    const id = hashParams().get('id');
    const c = await api('GET', `/suppliers/${id}/card`);
    const s = c.supplier;
    const st = c.statement;
    v.innerHTML = `
      <p><a href="#suppliers">← Yetkazib beruvchilar</a></p>
      <div class="card"><div class="row" style="justify-content:space-between;align-items:start">
        <div><h2 style="margin-bottom:4px">${esc(s.name)} ${s.active ? '' : '<span class="badge error">o\'chirilgan</span>'}</h2>
          <div class="muted">${esc(s.phone)} ${esc(s.address)}</div>${s.note ? `<div class="muted">${esc(s.note)}</div>` : ''}
          <div class="muted">Sut yig'uvchi: ${c.collectors.map((e) => esc(e.name)).join(', ') || '—'}</div>
          ${money() ? `<div style="margin-top:6px">${c.products.map((p) => `${p.is_default ? '★ ' : ''}${esc(p.name)}: <b>${fmtMoney(p.price)}</b> so'm/${esc(p.unit)}`).join(' · ') || '<span class="err">Narx belgilanmagan</span>'}</div>` : ''}</div>
        <div class="row">${st && can('payments.create') ? '<button id="pay">+ To\'lov</button>' : ''}${can('suppliers.manage') ? '<a href="#suppliers"><button class="ghost">Tahrirlash</button></a>' : ''}</div>
      </div></div>
      <div class="tiles">
        ${st ? `<div class="tile"><div class="k">${st.balance >= 0 ? 'Biz qarzmiz' : 'Bizga qarz (avans)'}</div><div class="v">${fmtMoney(Math.abs(st.balance))}</div><div class="s">so'm</div></div>` : ''}
        <div class="tile"><div class="k">Jami olingan</div><div class="v">${fmtNum(c.allTime.quantity)}</div><div class="s">kg · ${c.allTime.pickups} marta</div></div>
        ${money() ? `<div class="tile"><div class="k">Jami summa</div><div class="v">${fmtMoney(c.allTime.amount)}</div><div class="s">so'm</div></div>` : ''}
        <div class="tile"><div class="k">60 kunda</div><div class="v">${fmtNum(c.last60.totals.quantity)}</div><div class="s">kg</div></div>
      </div>
      <div class="card"><h2>Oxirgi 60 kun — kunlik miqdor (kg)</h2><div id="chart"></div></div>
      ${st ? `<div class="card"><h2>Hisob-kitob tarixi (akt-sverka)</h2><div class="table-wrap"><table>
        <tr><th>Sana</th><th>Amal</th><th class="num">Miqdor</th><th class="num">Narx</th><th class="num">Olindi (+)</th><th class="num">To'landi (−)</th><th class="num">Qarz qoldig'i</th><th>Kim</th></tr>
        ${st.entries.map((e) => `<tr class="${e.voided_at ? 'voided' : ''}">
          <td>${esc(fmtDate(e.at))}</td>
          <td>${e.kind === 'pickup' ? esc(e.product_name) : `To'lov (${METHOD[e.method]})${e.note ? ` — ${esc(e.note)}` : ''}`}${e.voided_at ? ` <span class="muted">bekor: ${esc(e.void_reason)}</span>` : ''}</td>
          <td class="num">${e.kind === 'pickup' ? `${fmtNum(e.quantity)} ${esc(e.unit)}` : ''}</td><td class="num">${e.kind === 'pickup' ? fmtMoney(e.price) : ''}</td>
          <td class="num">${e.kind === 'pickup' ? fmtMoney(e.amount) : ''}</td><td class="num">${e.kind === 'payment' ? fmtMoney(e.amount) : ''}</td>
          <td class="num"><b>${fmtMoney(e.balance)}</b></td><td class="muted">${esc(String(e.by_name).replace(/^\w+:/, ''))}</td></tr>`).join('')}
        <tr><td></td><td class="muted">Boshlang'ich qarz</td><td></td><td></td><td></td><td></td><td class="num">${fmtMoney(st.opening)}</td><td></td></tr>
      </table></div></div>` : ''}`;
    dailyChart($('#chart', v), c.last60.byDay, c.last60.range.from, c.last60.range.to);
    $('#pay', v) && ($('#pay', v).onclick = () => paymentForm(s, st.balance));
  },

  // ------------------------------------------------------------------ suppliers & prices
  async suppliers(v) {
    const [sups, prods, links] = await Promise.all([api('GET', '/suppliers'), api('GET', '/products'), api('GET', '/supplier-products')]);
    const bySup = {};
    for (const l of links) (bySup[l.supplier_id] ||= []).push(l);
    const manage = can('suppliers.manage');
    const prices = can('prices.manage');
    const form = (s = {}) => [
      { name: 'name', label: 'F.I.Sh', value: s.name, required: true },
      { name: 'phone', label: 'Telefon', value: s.phone, inputmode: 'tel' },
      { name: 'address', label: 'Manzil', value: s.address },
      { name: 'note', label: 'Izoh', value: s.note },
      ...(!s.id && can('payments.create') ? [{ name: 'openingBalance', label: 'Hozirgi qarzimiz (so\'m, ixtiyoriy)', type: 'number', step: 1, hint: 'U bizga qarz bo\'lsa — minus bilan' }] : []),
    ];
    const prodOpts = prods.filter((p) => p.active).map((p) => [p.id, `${p.name} (${p.unit})`]);
    v.innerHTML = `
      <div class="card"><div class="row" style="justify-content:space-between"><h2>Yetkazib beruvchilar (${sups.filter((s) => s.active).length})</h2>
        <div class="row">${manage ? '<button id="add">+ Yangi</button>' : ''}${manage && prices ? '<button class="ghost" id="tpl">⬇ Excel shablon</button><button class="ghost" id="imp">⬆ Excel\'dan import</button>' : ''}</div></div>
        <input id="flt" placeholder="Ism, telefon yoki manzil bo'yicha qidirish..." style="width:100%;margin-top:8px">
      </div>
      <div id="impBox"></div>
      <div class="card"><div class="table-wrap"><table>
        <tr><th>Yetkazib beruvchi</th><th>Mahsulot${money() ? ' va narx <span class="muted">(sut yig\'uvchiga ko\'rinmaydi)</span>' : ''}</th><th></th></tr>
        ${sups.map((s) => `<tr data-name="${esc(`${s.name} ${s.address ?? ''}`.toLowerCase())}" data-phone="${digits(s.phone)}" ${s.active ? '' : 'class="muted"'}>
          <td><a href="#supplier?id=${s.id}"><b>${esc(s.name)}</b></a>${s.active ? '' : ' (o\'chirilgan)'}<div class="muted">${esc(s.phone)} ${esc(s.address)}</div>${s.note ? `<div class="muted">${esc(s.note)}</div>` : ''}</td>
          <td>${(bySup[s.id] || []).map((l) => `<div class="row" style="align-items:center">
              ${l.is_default ? '<span title="Asosiy mahsulot">★</span>' : ''} ${esc(l.product_name)}${money() ? `: <b>${fmtMoney(l.price)}</b> so'm/${esc(l.unit)}` : ''}
              ${prices ? `<button class="small ghost" data-price="${s.id}|${l.product_id}">✎</button><button class="small ghost" data-del="${s.id}/${l.product_id}">✕</button>` : ''}</div>`).join('')
              || '<span class="err">Mahsulot va narx belgilanmagan — ilovada tanlab bo\'lmaydi</span>'}</td>
          <td class="row">${prices ? `<button class="small" data-price="${s.id}|">+ Narx</button>` : ''}
            ${manage ? `<button class="small ghost" data-edit="${s.id}">Tahrirlash</button><button class="small ghost" data-toggle="${s.id}">${s.active ? 'O\'chirish' : 'Yoqish'}</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="3" class="muted">Hali yetkazib beruvchi yo\'q</td></tr>'}
      </table></div></div>`;
    $('#flt', v).oninput = (e) => {
      const t = e.target.value.toLowerCase().trim();
      const d = digits(t);
      $$('tr[data-name]', v).forEach((tr) => { tr.hidden = !!t && !tr.dataset.name.includes(t) && !(d.length >= 2 && tr.dataset.phone.includes(d)); });
    };
    $('#add', v) && ($('#add', v).onclick = () => openForm({ title: 'Yangi yetkazib beruvchi', fields: form(),
      onSubmit: async (d) => { await api('POST', '/suppliers', { ...d, openingBalance: d.openingBalance === '' ? undefined : Number(d.openingBalance) }); flash('Qo\'shildi. Endi unga mahsulot va narx belgilang.'); } }));
    $('#tpl', v) && ($('#tpl', v).onclick = act(() => download('/suppliers-import/template.xlsx', 'yaya_yetkazib_beruvchilar_shablon.xlsx')));
    $('#imp', v) && ($('#imp', v).onclick = () => importFlow($('#impBox', v)));
    $$('[data-edit]', v).forEach((b) => { b.onclick = () => {
      const s = sups.find((x) => String(x.id) === b.dataset.edit);
      openForm({ title: 'Tahrirlash', fields: form(s), onSubmit: async (d) => { await api('PATCH', `/suppliers/${s.id}`, d); flash('Saqlandi'); } });
    }; });
    $$('[data-toggle]', v).forEach((b) => { b.onclick = act(async () => {
      const s = sups.find((x) => String(x.id) === b.dataset.toggle);
      await api('PATCH', `/suppliers/${s.id}`, { active: !s.active });
      route();
    }); });
    $$('[data-price]', v).forEach((b) => { b.onclick = () => {
      if (!prodOpts.length) { flash('Avval "Mahsulot va omborlar" bo\'limida mahsulot qo\'shing', 'err'); return; }
      const [sid, pid] = b.dataset.price.split('|');
      const cur = links.find((l) => String(l.supplier_id) === sid && String(l.product_id) === pid);
      const hasAny = (bySup[sid] || []).length > 0;
      openForm({
        title: `${sups.find((x) => String(x.id) === sid).name} — narx`,
        fields: [
          { name: 'productId', label: 'Mahsulot', type: 'select', options: prodOpts, value: pid },
          { name: 'price', label: 'Narx (so\'m, 1 birlik uchun)', type: 'number', step: 'any', value: cur?.price, required: true },
          { name: 'isDefault', label: 'Asosiy mahsulot (ilovada avtomatik tanlanadi)', type: 'checkbox', value: cur ? cur.is_default : !hasAny },
        ],
        onSubmit: async (d) => {
          await api('PUT', '/supplier-products', { supplierId: Number(sid), productId: Number(d.productId), price: Number(d.price), isDefault: d.isDefault });
          flash('Narx saqlandi');
        },
      });
    }; });
    $$('[data-del]', v).forEach((b) => { b.onclick = act(async () => {
      if (!confirm('Bu mahsulotni yetkazib beruvchidan olib tashlaysizmi?')) return;
      await api('DELETE', '/supplier-products/' + b.dataset.del);
      route();
    }); });
  },

  // ------------------------------------------------------------------ collectors
  async employees(v) {
    const [emps, whs, sups, roles] = await Promise.all([api('GET', '/employees'), api('GET', '/warehouses'), api('GET', '/suppliers'), api('GET', '/roles')]);
    const whName = Object.fromEntries(whs.map((w) => [w.id, w.name]));
    const whOpts = [['', '— tanlanmagan —'], ...whs.filter((w) => w.active).map((w) => [w.id, w.name])];
    // Collectors get roles that include app permissions; list those first.
    const roleOpts = roles.filter((r) => r.code !== 'admin').sort((a, b) => b.permissions.some((p) => p.startsWith('app.')) - a.permissions.some((p) => p.startsWith('app.')))
      .map((r) => [r.id, r.name]);
    const form = (e = {}) => [
      { name: 'name', label: 'Ism', value: e.name, required: true },
      { name: 'phone', label: 'Telefon (login)', value: e.phone, required: true, inputmode: 'tel', placeholder: '901234567' },
      { name: 'pin', label: e.id ? 'Yangi PIN (o\'zgartirmaslik uchun bo\'sh qoldiring)' : 'PIN (4–6 raqam)', inputmode: 'numeric', pattern: '\\d{4,6}', required: !e.id },
      { name: 'warehouseId', label: 'Ombori (mashina)', type: 'select', options: whOpts, value: e.warehouse_id },
      { name: 'roleId', label: 'Ruxsatlar (rol)', type: 'select', options: roleOpts, value: e.role_id ?? roles.find((r) => r.code === 'collector')?.id },
      { name: 'isTest', label: 'Test xodim (hisobotlarga kirmaydi)', type: 'checkbox', value: e.is_test },
    ];
    const toBody = (d) => ({ ...d, warehouseId: d.warehouseId ? Number(d.warehouseId) : null, roleId: Number(d.roleId), pin: d.pin || undefined });
    v.innerHTML = `
      <div class="card"><div class="row" style="justify-content:space-between"><h2>Sut yig'uvchilar</h2><button id="add">+ Yangi sut yig'uvchi</button></div>
      <div class="table-wrap"><table>
        <tr><th>Ism</th><th>Telefon</th><th>Ombor</th><th>Ruxsatlar</th><th class="num">Yetkazib beruvchilar</th><th>Holat</th><th></th></tr>
        ${emps.map((e) => `<tr ${e.active ? '' : 'class="muted"'}>
          <td>${esc(e.name)} ${e.is_test ? '<span class="badge test">test</span>' : ''}</td><td>${esc(e.phone)}</td>
          <td>${esc(whName[e.warehouse_id] || '—')}</td><td>${esc(e.role_name)}</td><td class="num">${e.supplier_count}</td>
          <td>${e.active ? 'Faol' : 'O\'chirilgan'}</td>
          <td class="row"><button class="small" data-assign="${e.id}">Biriktirish</button>
            <button class="small ghost" data-edit="${e.id}">Tahrirlash</button>
            <button class="small ghost" data-toggle="${e.id}">${e.active ? 'O\'chirish' : 'Yoqish'}</button></td></tr>`).join('')
          || '<tr><td colspan="7" class="muted">Hali sut yig\'uvchi yo\'q</td></tr>'}
      </table></div>
      ${can('users.manage') ? '<p class="muted">Ruxsatlarni "Foydalanuvchilar va ruxsatlar" bo\'limida sozlaysiz (masalan: o\'z xatosini bekor qilish, to\'lov kiritish).</p>' : ''}</div>
      <div id="assign"></div>`;
    $('#add', v).onclick = () => openForm({ title: 'Yangi sut yig\'uvchi', fields: form(),
      onSubmit: async (d) => { await api('POST', '/employees', toBody(d)); flash('Qo\'shildi'); } });
    $$('[data-edit]', v).forEach((b) => { b.onclick = () => {
      const e = emps.find((x) => String(x.id) === b.dataset.edit);
      openForm({ title: `${e.name} — tahrirlash`, fields: form(e), onSubmit: async (d) => { await api('PATCH', `/employees/${e.id}`, toBody(d)); flash('Saqlandi'); } });
    }; });
    $$('[data-toggle]', v).forEach((b) => { b.onclick = act(async () => {
      const e = emps.find((x) => String(x.id) === b.dataset.toggle);
      if (e.active && !confirm(`${e.name} ilovaga kira olmaydi. Davom etasizmi?`)) return;
      await api('PATCH', `/employees/${e.id}`, { active: !e.active });
      route();
    }); });
    $$('[data-assign]', v).forEach((b) => { b.onclick = act(async () => {
      const id = b.dataset.assign;
      const emp = emps.find((x) => String(x.id) === id);
      const chosen = await api('GET', `/employees/${id}/suppliers`);
      const box = $('#assign', v);
      const active = sups.filter((s) => s.active);
      const ordered = [...chosen.map((cid) => active.find((s) => s.id === cid)).filter(Boolean), ...active.filter((s) => !chosen.includes(s.id))];
      box.innerHTML = `<div class="card">
        <h2>${esc(emp.name)} — yetkazib beruvchilar</h2>
        <p class="muted">Belgilanganlar ilovada shu tartibda (yo'nalish bo'yicha) chiqadi. ↑ ↓ bilan tartibni o'zgartiring.</p>
        <input id="flt" placeholder="Ism yoki telefon bo'yicha qidirish..." style="width:100%;margin-bottom:8px">
        <div id="list">${ordered.map((s) => `<div class="row" data-id="${s.id}" data-name="${esc(s.name.toLowerCase())}" data-phone="${digits(s.phone)}" style="align-items:center;padding:4px 0">
          <label style="display:flex;gap:8px;align-items:center;color:var(--text);flex:1"><input type="checkbox" ${chosen.includes(s.id) ? 'checked' : ''}> ${esc(s.name)} <span class="muted">${esc(s.phone)} ${esc(s.address)}</span></label>
          <button type="button" class="small ghost" data-up>↑</button><button type="button" class="small ghost" data-down>↓</button></div>`).join('')
          || '<p class="muted">Avval "Yetkazib beruvchilar" bo\'limida yetkazib beruvchi qo\'shing.</p>'}</div>
        <p><button id="saveAssign">Saqlash</button></p></div>`;
      $('#flt', box).oninput = (e) => {
        const t = e.target.value.toLowerCase();
        const d = digits(t);
        $$('#list > div', box).forEach((r) => { r.hidden = !!t && !r.dataset.name.includes(t) && !(d.length >= 2 && r.dataset.phone.includes(d)); });
      };
      $$('[data-up]', box).forEach((u) => { u.onclick = () => { const r = u.parentElement; r.previousElementSibling?.before(r); }; });
      $$('[data-down]', box).forEach((d) => { d.onclick = () => { const r = d.parentElement; r.nextElementSibling?.after(r); }; });
      $('#saveAssign', box).onclick = act(async () => {
        const ids = $$('#list > div', box).filter((r) => $('input', r).checked).map((r) => Number(r.dataset.id));
        await api('PUT', `/employees/${id}/suppliers`, { supplierIds: ids });
        flash(`${ids.length} ta yetkazib beruvchi biriktirildi`);
        route();
      });
      box.scrollIntoView({ behavior: 'smooth' });
    }); });
  },

  // ------------------------------------------------------------------ products & warehouses
  async catalog(v) {
    const [prods, whs] = await Promise.all([api('GET', '/products'), api('GET', '/warehouses')]);
    const block = (title, kind, rows, cols, addLabel) => `
      <div class="card"><div class="row" style="justify-content:space-between"><h2>${title}</h2><button data-add="${kind}">${addLabel}</button></div>
      <table><tr>${cols.map((c) => `<th>${c[1]}</th>`).join('')}<th></th></tr>
      ${rows.map((r) => `<tr ${r.active ? '' : 'class="muted"'}>${cols.map((c) => `<td>${esc(r[c[0]])}</td>`).join('')}
        <td class="row"><button class="small ghost" data-edit="${kind}|${r.id}">Tahrirlash</button>
          <button class="small ghost" data-toggle="${kind}|${r.id}">${r.active ? 'O\'chirish' : 'Yoqish'}</button></td></tr>`).join('')
        || `<tr><td colspan="${cols.length + 1}" class="muted">Ro'yxat bo'sh</td></tr>`}</table></div>`;
    v.innerHTML = `<div class="grid2">
      ${block('Mahsulotlar', 'products', prods, [['name', 'Nomi'], ['unit', 'Birlik']], '+ Mahsulot')}
      ${block('Omborlar (har bir sut yig\'uvchi mashinasi)', 'warehouses', whs, [['name', 'Nomi']], '+ Ombor')}
    </div>`;
    const fields = { products: (r = {}) => [{ name: 'name', label: 'Nomi', value: r.name, required: true, placeholder: 'Yog\'li sut' }, { name: 'unit', label: 'O\'lchov birligi', value: r.unit ?? 'kg' }],
      warehouses: (r = {}) => [{ name: 'name', label: 'Nomi', value: r.name, required: true, placeholder: 'Mashina — Ali' }] };
    const all = { products: prods, warehouses: whs };
    $$('[data-add]', v).forEach((b) => { b.onclick = () => openForm({ title: 'Yangi', fields: fields[b.dataset.add](),
      onSubmit: async (d) => { await api('POST', `/${b.dataset.add}`, d); flash('Qo\'shildi'); } }); });
    $$('[data-edit]', v).forEach((b) => { b.onclick = () => {
      const [kind, id] = b.dataset.edit.split('|');
      const r = all[kind].find((x) => String(x.id) === id);
      openForm({ title: 'Tahrirlash', fields: fields[kind](r), onSubmit: async (d) => { await api('PATCH', `/${kind}/${id}`, d); flash('Saqlandi'); } });
    }; });
    $$('[data-toggle]', v).forEach((b) => { b.onclick = act(async () => {
      const [kind, id] = b.dataset.toggle.split('|');
      const r = all[kind].find((x) => String(x.id) === id);
      await api('PATCH', `/${kind}/${id}`, { active: !r.active });
      route();
    }); });
  },

  // ------------------------------------------------------------------ in-browser app tester
  async tester(v) {
    const emps = can('employees.manage') ? await api('GET', '/employees') : [];
    const testers = emps.filter((e) => e.is_test && e.active);
    v.innerHTML = `<div class="grid2">
      <div class="card">
        <h2>Ilovani noutbukda sinash</h2>
        <p>O'ngda — telefondagi ilova bilan <b>aynan bir xil</b> ilova, faqat brauzerda ishlaydi.</p>
        <ol>
          <li><b>Sut yig'uvchi rejimi:</b> test xodim bilan kiring — uning yozuvlari hisobotlarga kirmaydi.</li>
          <li><b>Rahbar rejimi:</b> kirish ekranida "Rahbar" ni tanlab, panel login/parolingiz bilan kiring.</li>
          <li>kg ni noutbuk klaviaturasidan yozib, Enter bosishingiz mumkin.</li>
          <li>Oflaynni sinash: F12 → Network → "Offline".</li>
        </ol>
        ${can('employees.manage') ? `<p><b>Test xodimlar:</b> ${testers.map((e) => `${esc(e.name)} — <code>${esc(e.phone)}</code>`).join(', ') || '<span class="muted">yo\'q</span>'}</p>` : ''}
        <div class="row">
          ${can('employees.manage') ? '<button id="mk">+ Test xodim yaratish</button>' : ''}
          <a href="/app/" target="_blank" rel="noopener"><button class="ghost" type="button">Alohida oynada ochish ↗</button></a>
          ${can('users.manage') ? '<button class="ghost" id="clr">Test ma\'lumotlarini tozalash</button>' : ''}
        </div>
      </div>
      <div class="card"><div class="phone"><iframe src="/app/" title="Yaya ilovasi"></iframe></div></div>
    </div>`;
    $('#mk', v) && ($('#mk', v).onclick = () => openForm({
      title: 'Test xodim',
      fields: [
        { name: 'name', label: 'Ism', value: 'Test', required: true },
        { name: 'phone', label: 'Telefon (login)', value: '900000000', required: true, inputmode: 'tel' },
        { name: 'pin', label: 'PIN', value: '1111', required: true, inputmode: 'numeric' },
      ],
      onSubmit: async (d) => { await api('POST', '/employees', { ...d, isTest: true }); flash('Test xodim yaratildi. Endi unga yetkazib beruvchilar biriktiring.'); },
    }));
    $('#clr', v) && ($('#clr', v).onclick = act(async () => {
      if (!confirm('Test xodimlar kiritgan barcha yozuvlar o\'chiriladi. Davom etasizmi?')) return;
      const r = await api('DELETE', '/test-data');
      flash(`${r.deleted} ta test yozuv o'chirildi`);
    }));
  },

  // ------------------------------------------------------------------ users, roles, permissions
  async users(v) {
    const [users, roles, perms] = await Promise.all([api('GET', '/users'), api('GET', '/roles'), api('GET', '/permissions')]);
    const roleOpts = roles.map((r) => [r.id, r.name]);
    const groups = [];
    for (const p of perms) {
      let g = groups.find((x) => x.name === p.group);
      if (!g) groups.push(g = { name: p.group, items: [] });
      g.items.push(p);
    }
    v.innerHTML = `
      <div class="card"><div class="row" style="justify-content:space-between"><h2>Rollar (ruxsatlar to'plami)</h2><button id="addRole">+ Yangi rol</button></div>
        <p class="muted">Rol — bu ruxsatlar to'plami. Rolni bir marta tuzib, bir nechta xodim yoki foydalanuvchiga biriktirasiz. Rolni o'zgartirsangiz, hammaga darhol ta'sir qiladi.</p>
        <div class="table-wrap"><table><tr><th>Rol</th><th class="num">Ruxsatlar</th><th class="num">Foydalanuvchi</th><th class="num">Sut yig'uvchi</th><th></th></tr>
        ${roles.map((r) => `<tr><td><b>${esc(r.name)}</b>${r.locked ? ' <span class="muted">(doim barcha ruxsatlar)</span>' : ''}</td>
          <td class="num">${r.permissions.length} / ${perms.length}</td><td class="num">${r.users}</td><td class="num">${r.employees}</td>
          <td class="row">${r.locked ? '' : `<button class="small" data-role="${r.id}">Ruxsatlarni sozlash</button>`}
            ${!r.code && !r.users && !r.employees ? `<button class="small ghost" data-delrole="${r.id}">O'chirish</button>` : ''}</td></tr>`).join('')}
        </table></div></div>
      <div id="roleEditor"></div>
      <div class="card"><div class="row" style="justify-content:space-between"><h2>Boshqaruv paneli foydalanuvchilari</h2><button id="add">+ Foydalanuvchi</button></div>
      <p class="muted">Ular panelga va mobil ilovaning "Rahbar" rejimiga login/parol bilan kiradi.</p>
      <table><tr><th>Login</th><th>Ism</th><th>Rol</th><th>Holat</th><th></th></tr>
        ${users.map((u) => `<tr ${u.active ? '' : 'class="muted"'}><td>${esc(u.login)}</td><td>${esc(u.name)}</td><td>${esc(u.role_name)}</td>
          <td>${u.active ? 'Faol' : 'O\'chirilgan'}</td>
          <td class="row"><button class="small ghost" data-edit="${u.id}">Tahrirlash</button>
            <button class="small ghost" data-toggle="${u.id}">${u.active ? 'O\'chirish' : 'Yoqish'}</button></td></tr>`).join('')}
      </table></div>`;

    const editRole = (role) => {
      const box = $('#roleEditor', v);
      const cur = new Set(role?.permissions ?? []);
      box.innerHTML = `<form class="card" id="roleForm">
        <h2>${role ? `Rol: ${esc(role.name)}` : 'Yangi rol'}</h2>
        <label>Rol nomi <input name="name" required value="${esc(role?.name ?? '')}" placeholder="masalan: Omborchi, Buxgalter, Katta sut yig'uvchi"></label>
        ${groups.map((g) => `<fieldset style="border:1px solid var(--line);border-radius:8px;margin:10px 0;padding:8px 12px">
          <legend><b>${esc(g.name)}</b> <button type="button" class="small ghost" data-all="${esc(g.name)}">hammasi</button></legend>
          <div class="checks" style="max-height:none">${g.items.map((p) => `<label title="${esc(p.hint ?? '')}"><input type="checkbox" name="perm" value="${p.key}" data-group="${esc(g.name)}" ${cur.has(p.key) ? 'checked' : ''}> ${esc(p.label)}</label>`).join('')}</div>
        </fieldset>`).join('')}
        <div class="row"><button>Saqlash</button><button type="button" class="ghost" id="cancelRole">Yopish</button></div>
      </form>`;
      $$('[data-all]', box).forEach((b) => { b.onclick = () => {
        const boxes = $$(`input[data-group="${CSS.escape(b.dataset.all)}"]`, box);
        const on = !boxes.every((x) => x.checked);
        boxes.forEach((x) => { x.checked = on; });
      }; });
      $('#cancelRole', box).onclick = () => { box.innerHTML = ''; };
      $('#roleForm', box).onsubmit = act(async (e) => {
        e.preventDefault();
        const body = { name: e.target.elements.name.value, permissions: $$('input[name=perm]:checked', box).map((x) => x.value) };
        if (role) await api('PATCH', `/roles/${role.id}`, body); else await api('POST', '/roles', body);
        flash('Rol saqlandi');
        route();
      });
      box.scrollIntoView({ behavior: 'smooth' });
    };
    $('#addRole', v).onclick = () => editRole(null);
    $$('[data-role]', v).forEach((b) => { b.onclick = () => editRole(roles.find((r) => String(r.id) === b.dataset.role)); });
    $$('[data-delrole]', v).forEach((b) => { b.onclick = act(async () => {
      if (!confirm('Rolni o\'chirasizmi?')) return;
      await api('DELETE', `/roles/${b.dataset.delrole}`);
      route();
    }); });
    $('#add', v).onclick = () => openForm({ title: 'Yangi foydalanuvchi', fields: [
      { name: 'login', label: 'Login', required: true }, { name: 'name', label: 'Ism' },
      { name: 'password', label: 'Parol (kamida 8 belgi)', type: 'password', required: true },
      { name: 'roleId', label: 'Rol', type: 'select', options: roleOpts, value: roles.find((r) => r.code === 'viewer')?.id },
    ], onSubmit: async (d) => { await api('POST', '/users', { ...d, roleId: Number(d.roleId) }); flash('Qo\'shildi'); } });
    $$('[data-edit]', v).forEach((b) => { b.onclick = () => {
      const u = users.find((x) => String(x.id) === b.dataset.edit);
      openForm({ title: u.login, fields: [
        { name: 'name', label: 'Ism', value: u.name }, { name: 'roleId', label: 'Rol', type: 'select', options: roleOpts, value: u.role_id },
        { name: 'password', label: 'Yangi parol (o\'zgartirmaslik uchun bo\'sh)', type: 'password' },
      ], onSubmit: async (d) => { await api('PATCH', `/users/${u.id}`, { ...d, roleId: Number(d.roleId), password: d.password || undefined }); flash('Saqlandi'); } });
    }; });
    $$('[data-toggle]', v).forEach((b) => { b.onclick = act(async () => {
      const u = users.find((x) => String(x.id) === b.dataset.toggle);
      await api('PATCH', `/users/${u.id}`, { active: !u.active });
      route();
    }); });
  },

  // ------------------------------------------------------------------ settings
  async settings(v) {
    const st = can('settings.manage') ? await api('GET', '/settings') : null;
    v.innerHTML = `
      ${st ? `<div class="card" style="max-width:640px">
        <h2>Brend</h2>
        <form id="brandForm" class="row" style="align-items:end">
          <label style="flex:1">Kompaniya nomi (ilova va panelda ko'rinadi) <input name="companyName" value="${esc(st.companyName)}" maxlength="60"></label>
          <button>Saqlash</button>
        </form>
        <div class="row" style="align-items:center;margin-top:12px">
          <div class="logo-preview">${brand.logoUrl ? `<img src="${esc(brand.logoUrl)}" alt="Logo">` : '<span class="muted">Logo yo\'q</span>'}</div>
          <div><label class="ghost" style="display:inline-block"><input type="file" id="logoFile" accept="image/png,image/jpeg,image/webp" hidden><span class="btnlike">⬆ Logo yuklash</span></label>
            ${brand.logoUrl ? '<button class="ghost" id="logoDel">Logoni olib tashlash</button>' : ''}
            <p class="muted">PNG/JPG, kvadrat bo'lgani yaxshi. Panel, ilova va kirish ekranida darhol ko'rinadi.
              Telefon ekranidagi ilova belgisi (ikonka) keyingi APK yig'ishda shu logoga almashadi.</p></div>
        </div>
      </div>` : ''}
      <form class="card" id="pw" style="max-width:520px">
        <h2>Parolni o'zgartirish</h2>
        <label>Joriy parol <input name="current" type="password" required autocomplete="current-password"></label>
        <label>Yangi parol (kamida 8 belgi) <input name="next" type="password" required minlength="8" autocomplete="new-password"></label>
        <button>O'zgartirish</button>
      </form>
      ${can('audit.view') ? '<div class="card"><h2>Harakatlar jurnali</h2><div id="audit" class="table-wrap"><p class="muted">Yuklanmoqda...</p></div></div>' : ''}`;
    $('#pw', v).onsubmit = act(async (e) => {
      e.preventDefault();
      await api('PUT', '/password', Object.fromEntries(new FormData(e.target)));
      e.target.reset();
      flash('Parol o\'zgartirildi');
    });
    if (st) {
      $('#brandForm', v).onsubmit = act(async (e) => {
        e.preventDefault();
        await api('PUT', '/settings', { companyName: e.target.elements.companyName.value });
        await loadBrand();
        flash('Saqlandi');
      });
      $('#logoFile', v).onchange = act(async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const dataUrl = await squarePng(file, 512);
        await api('PUT', '/settings/logo', { dataUrl });
        await loadBrand();
        flash('Logo yangilandi');
        route();
      });
      $('#logoDel', v) && ($('#logoDel', v).onclick = act(async () => {
        await api('DELETE', '/settings/logo');
        await loadBrand();
        route();
      }));
    }
    if (can('audit.view')) {
      const log = await api('GET', '/audit');
      $('#audit', v).innerHTML = `<table><tr><th>Vaqt</th><th>Kim</th><th>Amal</th><th>Tafsilot</th></tr>
        ${log.map((a) => `<tr><td>${esc(fmtDate(a.at))}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td class="muted" style="word-break:break-word">${esc(a.details)}</td></tr>`).join('')}</table>`;
    }
  },
};

// Fit any picture into a square transparent PNG, so it works as an app icon too.
function squarePng(file, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = Object.assign(document.createElement('canvas'), { width: size, height: size });
      const k = Math.min(size / img.width, size / img.height);
      const w = img.width * k;
      const h = img.height * k;
      c.getContext('2d').drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Rasmni o\'qib bo\'lmadi'));
    img.src = URL.createObjectURL(file);
  });
}

// Excel import: choose file -> server preview (nothing saved) -> confirm -> apply.
function importFlow(box) {
  box.innerHTML = `<div class="card"><h2>Excel'dan import</h2>
    <ol class="muted"><li>"⬇ Excel shablon" ni yuklab oling va to'ldiring (yo'riqnoma shablonning 2-varag'ida).</li>
      <li>Faylni tanlang — avval tekshiriladi, hech narsa saqlanmaydi.</li><li>Natijani ko'rib, "Import qilish" ni bosing.</li></ol>
    <input type="file" id="xls" accept=".xlsx"><div id="impRes"></div></div>`;
  box.scrollIntoView({ behavior: 'smooth' });
  let file64 = null;
  const send = async (dryRun) => api('POST', '/suppliers-import', { file: file64, dryRun });
  $('#xls', box).onchange = act(async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    file64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
    const r = await send(true);
    const s = r.summary;
    $('#impRes', box).innerHTML = `
      <p><b>Tekshiruv natijasi:</b> yangi — ${s.suppliersCreated}, yangilanadi — ${s.suppliersUpdated}, narxlar — ${s.pricesSet}, yangi mahsulot — ${s.productsCreated},
        <span class="${s.errorRows ? 'err' : ''}">xato qatorlar — ${s.errorRows}</span></p>
      <div class="table-wrap" style="max-height:360px;overflow:auto"><table><tr><th>Qator</th><th>F.I.Sh</th><th>Telefon</th><th>Mahsulot</th><th class="num">Narx</th><th class="num">Qarz</th><th>Natija</th></tr>
        ${r.rows.map((x) => `<tr><td>${x.row}</td><td>${esc(x.name)}</td><td>${esc(x.phone)}</td><td>${esc(x.product)}</td><td class="num">${fmtMoney(x.price)}</td><td class="num">${fmtMoney(x.debt)}</td>
          <td>${x.errors.length ? `<span class="err">${esc(x.errors.join('; '))}</span>` : `<span class="muted">${esc(x.actions.join('; '))}</span>`}</td></tr>`).join('')}
      </table></div>
      <p>${s.errorRows ? '<span class="err">Xato qatorlar o\'tkazib yuboriladi.</span> ' : ''}<button id="go" ${s.suppliersCreated + s.suppliersUpdated ? '' : 'disabled'}>Import qilish</button></p>`;
    $('#go', box).onclick = act(async () => {
      const done = await send(false);
      flash(`Import tugadi: ${done.summary.suppliersCreated} ta yangi, ${done.summary.suppliersUpdated} ta yangilandi`);
      route();
    });
  });
}

const route = act(async () => {
  if (!me) return;
  const name = location.hash.slice(1).split('?')[0] || 'dashboard';
  const page = name === 'supplier' ? 'suppliers' : name;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + page));
  // Each navigation renders into a fresh container, so a slow, older page that
  // finishes loading late can never overwrite the page the user is now on.
  const v = document.createElement('main');
  v.id = 'view';
  v.innerHTML = '<p class="muted">Yuklanmoqda...</p>';
  $('#view').replaceWith(v);
  // Land on the first page this user may open.
  const allowed = PAGES.filter((p) => !p[2] || can(p[2])).map((p) => p[0]);
  const target = views[name] && (allowed.includes(page) || (name === 'supplier' && can('suppliers.view'))) ? name : allowed[0];
  await views[target](v);
});

window.addEventListener('hashchange', route);
loadBrand();
show();
