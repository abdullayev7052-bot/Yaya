'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n, d = 2) => Number(n || 0).toLocaleString('uz-UZ', { maximumFractionDigits: d }).replace(/,/g, ' ');
const fmtMoney = (n) => fmtNum(Math.round(n || 0), 0);
// Server stores UTC; show Tashkent time (UTC+5, no DST).
const fmtDate = (s) => {
  if (!s) return '';
  const d = new Date(/Z$|[+-]\d\d:\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  return new Date(d.getTime() + 5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
};
const todayLocal = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);
const dayLabel = (day) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
const ROLE_NAMES = { admin: 'Admin', manager: 'Menejer', viewer: 'Kuzatuvchi' };

let token = null;
let me = null;
try { token = localStorage.getItem('yaya_token'); } catch { /* storage unavailable */ }
const can = (role) => me && { viewer: 1, manager: 2, admin: 3 }[me.role] >= { viewer: 1, manager: 2, admin: 3 }[role];

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
function openForm({ title, fields, submit = 'Saqlash', onSubmit }) {
  const dlg = $('#dlg');
  dlg.innerHTML = `<form method="dialog">
    <h2>${esc(title)}</h2>
    ${fields.map((f) => {
      if (f.type === 'checkbox') return `<label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="${f.name}" ${f.value ? 'checked' : ''}> ${esc(f.label)}</label>`;
      if (f.type === 'select') return `<label>${esc(f.label)}<select name="${f.name}" ${f.required ? 'required' : ''}>${f.options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(f.value ?? '') ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
      return `<label>${esc(f.label)}<input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" ${f.required ? 'required' : ''}
        ${f.pattern ? `pattern="${f.pattern}"` : ''} ${f.inputmode ? `inputmode="${f.inputmode}"` : ''} ${f.step ? `step="${f.step}"` : ''} placeholder="${esc(f.placeholder ?? '')}" autocomplete="off">
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

function logout() {
  token = null;
  me = null;
  try { localStorage.removeItem('yaya_token'); } catch { /* ignore */ }
  show();
}

async function show() {
  if (token && !me) {
    try { me = await api('GET', '/me'); } catch { token = null; }
  }
  $('#login').hidden = !!me;
  $('#main').hidden = !me;
  if (!me) return;
  const pages = [
    ['dashboard', 'Bugun', 'viewer'], ['reports', 'Hisobotlar', 'viewer'], ['collections', 'Xaridlar', 'viewer'],
    ['employees', 'Sut yig\'uvchilar', 'viewer'], ['suppliers', 'Yetkazib beruvchilar', 'viewer'],
    ['catalog', 'Mahsulot va omborlar', 'viewer'], ['tester', 'Ilovani sinash', 'manager'],
    ['users', 'Foydalanuvchilar', 'admin'], ['settings', 'Sozlamalar', 'viewer'],
  ];
  $('#nav').innerHTML = pages.filter((p) => can(p[2])).map(([k, t]) => `<a href="#${k}">${t}</a>`).join('');
  $('#whoami').textContent = `${me.name || me.login} · ${ROLE_NAMES[me.role]}`;
  route();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api('POST', '/login', { login: f.get('login'), password: f.get('password') });
    token = r.token;
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

function tiles(t, extra = '') {
  return `<div class="tiles">
    <div class="tile"><div class="k">Jami miqdor</div><div class="v">${fmtNum(t.quantity)}</div><div class="s">kg</div></div>
    <div class="tile"><div class="k">Summa</div><div class="v">${fmtMoney(t.amount)}</div><div class="s">so'm</div></div>
    <div class="tile"><div class="k">Yetkazib berishlar</div><div class="v">${t.pickups}</div><div class="s">${t.suppliers} ta yetkazib beruvchidan</div></div>
    <div class="tile"><div class="k">O'rtacha narx</div><div class="v">${t.quantity ? fmtMoney(t.amount / t.quantity) : '—'}</div><div class="s">so'm / kg</div></div>
    ${extra}
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

const views = {
  // ------------------------------------------------------------------ today
  async dashboard(v) {
    const d = await api('GET', '/dashboard');
    const t = d.today;
    v.innerHTML = `
      <h2>Bugun, ${esc(t.range.from)}</h2>
      ${tiles(t.totals)}
      <div class="card"><h2>Oxirgi 30 kun — kunlik miqdor (kg)</h2><div id="chart30"></div>
        <p class="muted">30 kunda: ${fmtNum(d.month.totals.quantity)} kg · ${fmtMoney(d.month.totals.amount)} so'm · ${d.month.totals.pickups} ta yetkazib berish</p></div>
      <div class="grid2">
        <div class="card"><h2>Bugun — sut yig'uvchilar</h2>
          <table><tr><th>Ism</th><th class="num">Uylar</th><th class="num">kg</th><th class="num">Summa</th></tr>
          ${t.byEmployee.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${r.suppliers}</td><td class="num">${fmtNum(r.quantity)}</td><td class="num">${fmtMoney(r.amount)}</td></tr>`).join('')
            || '<tr><td colspan="4" class="muted">Bugun hali yozuv yo\'q</td></tr>'}</table></div>
        <div class="card"><h2>Holat</h2>
          <p><b>Ochiq smenalar:</b> ${d.openShifts.map((s) => `${esc(s.name)} (${esc(fmtDate(s.opened_at).slice(11))}, ${s.pickups} ta)`).join(', ') || '<span class="muted">yo\'q</span>'}</p>
          <p><b>Oxirgi sinxronlash:</b></p>
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
    const filt = { employee: q.get('employee') || '', supplier: q.get('supplier') || '' };
    const qs = new URLSearchParams({ from, to, ...filt }).toString();
    const [s, emps, sups] = await Promise.all([api('GET', '/reports/summary?' + qs), api('GET', '/employees'), api('GET', '/suppliers')]);
    const monthStart = today.slice(0, 8) + '01';
    const prevMonthEnd = addDays(monthStart, -1);
    const presets = [
      ['Bugun', today, today], ['Kecha', addDays(today, -1), addDays(today, -1)], ['7 kun', addDays(today, -6), today],
      ['30 kun', addDays(today, -29), today], ['Bu oy', monthStart, today], ["O'tgan oy", prevMonthEnd.slice(0, 8) + '01', prevMonthEnd],
    ];
    v.innerHTML = `
      <div class="card">
        <div class="row">
          <div class="presets">${presets.map(([t, f, tt]) => `<button class="ghost small ${f === from && tt === to ? 'on' : ''}" data-f="${f}" data-t="${tt}">${t}</button>`).join('')}</div>
          <label>Dan <input type="date" id="from" value="${from}"></label>
          <label>Gacha <input type="date" id="to" value="${to}"></label>
          <label>Sut yig'uvchi <select id="emp"><option value="">Hammasi</option>${emps.filter((e) => !e.is_test).map((e) => `<option value="${e.id}" ${String(e.id) === filt.employee ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>
          <label>Yetkazib beruvchi <select id="sup"><option value="">Hammasi</option>${sups.map((x) => `<option value="${x.id}" ${String(x.id) === filt.supplier ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
          <a class="ghost" href="/api/admin/reports/export.csv?${qs}" id="csv"><button type="button" class="ghost">⬇ Excel (CSV)</button></a>
        </div>
      </div>
      ${tiles(s.totals)}
      <div class="card"><h2>Kunlik miqdor (kg)</h2><div id="daily"></div></div>
      <div class="grid2">
        <div class="card"><h2>Yetkazib beruvchilar bo'yicha (kg)</h2><div id="rankSup"></div></div>
        <div class="card"><h2>Sut yig'uvchilar bo'yicha (kg)</h2><div id="rankEmp"></div></div>
      </div>
      <div class="card"><h2>Mahsulotlar</h2><div class="table-wrap"><table>
        <tr><th>Mahsulot</th><th class="num">Yetkazib berish</th><th class="num">Miqdor</th><th class="num">O'rtacha narx</th><th class="num">Summa</th></tr>
        ${s.byProduct.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${p.pickups}</td><td class="num">${fmtNum(p.quantity)} ${esc(p.unit)}</td><td class="num">${fmtMoney(p.avg_price)}</td><td class="num">${fmtMoney(p.amount)}</td></tr>`).join('')
          || '<tr><td colspan="5" class="muted">Bu davrda yozuv yo\'q</td></tr>'}
      </table></div></div>
      <div class="card"><h2>Yetkazib beruvchilar — to'liq jadval</h2><div class="table-wrap"><table>
        <tr><th>Yetkazib beruvchi</th><th class="num">Yetkazib berish</th><th class="num">Miqdor (kg)</th><th class="num">Summa</th><th class="num">Oxirgi</th></tr>
        ${s.bySupplier.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${r.pickups}</td><td class="num">${fmtNum(r.quantity)}</td><td class="num">${fmtMoney(r.amount)}</td><td class="num">${esc(fmtDate(r.last_at))}</td></tr>`).join('')
          || '<tr><td colspan="5" class="muted">—</td></tr>'}
      </table></div></div>`;
    dailyChart($('#daily', v), s.byDay, s.range.from, s.range.to);
    Charts.rankBars($('#rankSup', v), { rows: s.bySupplier.map((r) => ({ label: esc(r.name), value: r.quantity, sub: `${fmtMoney(r.amount)} so'm` })), unit: 'kg' });
    Charts.rankBars($('#rankEmp', v), { rows: s.byEmployee.map((r) => ({ label: esc(r.name), value: r.quantity, sub: `${r.pickups} ta · ${fmtMoney(r.amount)} so'm` })), unit: 'kg' });

    const go = (patch) => setHash('reports', { from, to, ...filt, ...patch });
    $$('.presets button', v).forEach((b) => { b.onclick = () => go({ from: b.dataset.f, to: b.dataset.t }); });
    $('#from', v).onchange = (e) => go({ from: e.target.value });
    $('#to', v).onchange = (e) => go({ to: e.target.value });
    $('#emp', v).onchange = (e) => go({ employee: e.target.value });
    $('#sup', v).onchange = (e) => go({ supplier: e.target.value });
    // CSV download needs the auth header, so fetch it instead of following the link.
    $('#csv', v).onclick = act(async (e) => {
      e.preventDefault();
      const res = await fetch(`/api/admin/reports/export.csv?${qs}`, { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) throw new Error('Yuklab bo\'lmadi');
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: `yaya_${from}_${to}.csv` });
      a.click();
      URL.revokeObjectURL(url);
    });
  },

  // ------------------------------------------------------------------ pickups
  async collections(v) {
    const q = hashParams();
    const today = todayLocal();
    const params = { from: q.get('from') || today, to: q.get('to') || today, employee: q.get('employee') || '', supplier: q.get('supplier') || '', voided: q.get('voided') || '' };
    const [rows, emps, sups] = await Promise.all([
      api('GET', '/collections?' + new URLSearchParams(params)), api('GET', '/employees'), api('GET', '/suppliers'),
    ]);
    const live = rows.filter((r) => !r.voided_at && !r.is_test);
    v.innerHTML = `
      <div class="card"><div class="row">
        <label>Dan <input type="date" id="from" value="${params.from}"></label>
        <label>Gacha <input type="date" id="to" value="${params.to}"></label>
        <label>Sut yig'uvchi <select id="emp"><option value="">Hammasi</option>${emps.map((e) => `<option value="${e.id}" ${String(e.id) === params.employee ? 'selected' : ''}>${esc(e.name)}${e.is_test ? ' (test)' : ''}</option>`).join('')}</select></label>
        <label>Yetkazib beruvchi <select id="sup"><option value="">Hammasi</option>${sups.map((x) => `<option value="${x.id}" ${String(x.id) === params.supplier ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
        <label style="display:flex;gap:6px;align-items:center;color:var(--text)"><input type="checkbox" id="voided" ${params.voided ? 'checked' : ''}> Bekor qilinganlar ham</label>
      </div>
      <p class="muted">${live.length} ta yozuv · ${fmtNum(live.reduce((a, r) => a + r.quantity, 0))} kg · ${fmtMoney(live.reduce((a, r) => a + r.amount, 0))} so'm (test va bekor qilinganlarsiz)</p></div>
      <div class="card"><div class="table-wrap"><table>
        <tr><th>Vaqt</th><th>Sut yig'uvchi</th><th>Yetkazib beruvchi</th><th>Mahsulot</th><th class="num">Miqdor</th><th class="num">Narx</th><th class="num">Summa</th><th></th></tr>
        ${rows.map((r) => `<tr class="${r.voided_at ? 'voided' : ''}">
          <td>${esc(fmtDate(r.collected_at))}</td><td>${esc(r.employee_name)} ${r.is_test ? '<span class="badge test">test</span>' : ''}</td>
          <td>${esc(r.supplier_name)}</td><td>${esc(r.product_name)}</td>
          <td class="num">${fmtNum(r.quantity)} ${esc(r.unit)}</td><td class="num">${fmtMoney(r.price)}</td><td class="num">${fmtMoney(r.amount)}</td>
          <td>${r.voided_at
            ? `<span class="muted" title="${esc(r.voided_by)} · ${esc(fmtDate(r.voided_at))}">Bekor: ${esc(r.void_reason)}</span> ${can('manager') ? `<button class="small ghost" data-restore="${r.id}">Tiklash</button>` : ''}`
            : can('manager') ? `<button class="small ghost" data-void="${r.id}">Bekor qilish</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="8" class="muted">Yozuv yo\'q</td></tr>'}
      </table></div></div>`;
    const go = (patch) => setHash('collections', { ...params, ...patch });
    $('#from', v).onchange = (e) => go({ from: e.target.value });
    $('#to', v).onchange = (e) => go({ to: e.target.value });
    $('#emp', v).onchange = (e) => go({ employee: e.target.value });
    $('#sup', v).onchange = (e) => go({ supplier: e.target.value });
    $('#voided', v).onchange = (e) => go({ voided: e.target.checked ? '1' : '' });
    $$('[data-void]', v).forEach((b) => { b.onclick = () => openForm({
      title: 'Yozuvni bekor qilish',
      fields: [{ name: 'reason', label: 'Sababi (masalan: noto\'g\'ri kg kiritilgan)', required: true }],
      submit: 'Bekor qilish',
      onSubmit: async (d) => { await api('POST', `/collections/${b.dataset.void}/void`, d); flash('Bekor qilindi'); },
    }); });
    $$('[data-restore]', v).forEach((b) => { b.onclick = act(async () => { await api('POST', `/collections/${b.dataset.restore}/restore`); route(); }); });
  },

  // ------------------------------------------------------------------ collectors
  async employees(v) {
    const [emps, whs, sups] = await Promise.all([api('GET', '/employees'), api('GET', '/warehouses'), api('GET', '/suppliers')]);
    const whName = Object.fromEntries(whs.map((w) => [w.id, w.name]));
    const whOpts = [['', '— tanlanmagan —'], ...whs.filter((w) => w.active).map((w) => [w.id, w.name])];
    const form = (e = {}) => [
      { name: 'name', label: 'Ism', value: e.name, required: true },
      { name: 'phone', label: 'Telefon (login)', value: e.phone, required: true, inputmode: 'tel', placeholder: '901234567' },
      { name: 'pin', label: e.id ? 'Yangi PIN (o\'zgartirmaslik uchun bo\'sh qoldiring)' : 'PIN (4–6 raqam)', inputmode: 'numeric', pattern: '\\d{4,6}', required: !e.id },
      { name: 'warehouseId', label: 'Ombori (mashina)', type: 'select', options: whOpts, value: e.warehouse_id },
      { name: 'isTest', label: 'Test xodim (hisobotlarga kirmaydi)', type: 'checkbox', value: e.is_test },
    ];
    const toBody = (d) => ({ ...d, warehouseId: d.warehouseId ? Number(d.warehouseId) : null, pin: d.pin || undefined });
    v.innerHTML = `
      <div class="card"><div class="row" style="justify-content:space-between"><h2>Sut yig'uvchilar</h2>
        ${can('manager') ? '<button id="add">+ Yangi sut yig\'uvchi</button>' : ''}</div>
      <div class="table-wrap"><table>
        <tr><th>Ism</th><th>Telefon</th><th>Ombor</th><th class="num">Yetkazib beruvchilar</th><th>Holat</th><th></th></tr>
        ${emps.map((e) => `<tr ${e.active ? '' : 'class="muted"'}>
          <td>${esc(e.name)} ${e.is_test ? '<span class="badge test">test</span>' : ''}</td><td>${esc(e.phone)}</td>
          <td>${esc(whName[e.warehouse_id] || '—')}</td><td class="num">${e.supplier_count}</td>
          <td>${e.active ? 'Faol' : 'O\'chirilgan'}</td>
          <td class="row">${can('manager') ? `<button class="small" data-assign="${e.id}">Biriktirish</button>
            <button class="small ghost" data-edit="${e.id}">Tahrirlash</button>
            <button class="small ghost" data-toggle="${e.id}">${e.active ? 'O\'chirish' : 'Yoqish'}</button>` : ''}</td></tr>`).join('')
          || '<tr><td colspan="6" class="muted">Hali sut yig\'uvchi yo\'q</td></tr>'}
      </table></div></div>
      <div id="assign"></div>`;
    $('#add', v) && ($('#add', v).onclick = () => openForm({ title: 'Yangi sut yig\'uvchi', fields: form(),
      onSubmit: async (d) => { await api('POST', '/employees', toBody(d)); flash('Qo\'shildi'); } }));
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
      // Chosen first in route order, then the rest alphabetically.
      const ordered = [...chosen.map((cid) => active.find((s) => s.id === cid)).filter(Boolean), ...active.filter((s) => !chosen.includes(s.id))];
      box.innerHTML = `<div class="card">
        <h2>${esc(emp.name)} — yetkazib beruvchilar</h2>
        <p class="muted">Belgilanganlar ilovada shu tartibda (yo'nalish bo'yicha) chiqadi. ↑ ↓ bilan tartibni o'zgartiring.</p>
        <input id="flt" placeholder="Qidirish..." style="width:100%;margin-bottom:8px">
        <div id="list">${ordered.map((s) => `<div class="row" data-id="${s.id}" data-name="${esc(s.name.toLowerCase())}" style="align-items:center;padding:4px 0">
          <label style="display:flex;gap:8px;align-items:center;color:var(--text);flex:1"><input type="checkbox" ${chosen.includes(s.id) ? 'checked' : ''}> ${esc(s.name)} <span class="muted">${esc(s.address)}</span></label>
          <button type="button" class="small ghost" data-up>↑</button><button type="button" class="small ghost" data-down>↓</button></div>`).join('')
          || '<p class="muted">Avval "Yetkazib beruvchilar" bo\'limida yetkazib beruvchi qo\'shing.</p>'}</div>
        <p><button id="saveAssign">Saqlash</button></p></div>`;
      $('#flt', v).oninput = (e) => $$('#list > div', box).forEach((r) => { r.hidden = !r.dataset.name.includes(e.target.value.toLowerCase()); });
      $$('[data-up]', box).forEach((u) => { u.onclick = () => { const r = u.parentElement; r.previousElementSibling?.before(r); }; });
      $$('[data-down]', box).forEach((d) => { d.onclick = () => { const r = d.parentElement; r.nextElementSibling?.after(r); }; });
      $('#saveAssign', v).onclick = act(async () => {
        const ids = $$('#list > div', box).filter((r) => $('input', r).checked).map((r) => Number(r.dataset.id));
        await api('PUT', `/employees/${id}/suppliers`, { supplierIds: ids });
        flash(`${ids.length} ta yetkazib beruvchi biriktirildi`);
        route();
      });
      box.scrollIntoView({ behavior: 'smooth' });
    }); });
  },

  // ------------------------------------------------------------------ suppliers & prices
  async suppliers(v) {
    const [sups, prods, links] = await Promise.all([api('GET', '/suppliers'), api('GET', '/products'), api('GET', '/supplier-products')]);
    const bySup = {};
    for (const l of links) (bySup[l.supplier_id] ||= []).push(l);
    const form = (s = {}) => [
      { name: 'name', label: 'F.I.Sh', value: s.name, required: true },
      { name: 'phone', label: 'Telefon', value: s.phone, inputmode: 'tel' },
      { name: 'address', label: 'Manzil', value: s.address },
      { name: 'note', label: 'Izoh', value: s.note },
    ];
    const prodOpts = prods.filter((p) => p.active).map((p) => [p.id, `${p.name} (${p.unit})`]);
    v.innerHTML = `
      <div class="card"><div class="row" style="justify-content:space-between"><h2>Yetkazib beruvchilar (${sups.filter((s) => s.active).length})</h2>
        ${can('manager') ? '<button id="add">+ Yangi yetkazib beruvchi</button>' : ''}</div>
        <input id="flt" placeholder="Ism, telefon yoki manzil bo'yicha qidirish..." style="width:100%;margin-top:8px">
      </div>
      <div class="card"><div class="table-wrap"><table>
        <tr><th>Yetkazib beruvchi</th><th>Mahsulot va narx <span class="muted">(sut yig'uvchiga ko'rinmaydi)</span></th><th></th></tr>
        ${sups.map((s) => `<tr data-name="${esc(`${s.name} ${s.phone ?? ''} ${s.address ?? ''}`.toLowerCase())}" ${s.active ? '' : 'class="muted"'}>
          <td><b>${esc(s.name)}</b>${s.active ? '' : ' (o\'chirilgan)'}<div class="muted">${esc(s.phone)} ${esc(s.address)}</div>${s.note ? `<div class="muted">${esc(s.note)}</div>` : ''}</td>
          <td>${(bySup[s.id] || []).map((l) => `<div class="row" style="align-items:center">
              ${l.is_default ? '<span title="Asosiy mahsulot">★</span>' : ''} ${esc(l.product_name)}: <b>${fmtMoney(l.price)}</b> so'm/${esc(l.unit)}
              ${can('manager') ? `<button class="small ghost" data-price="${s.id}|${l.product_id}">✎</button><button class="small ghost" data-del="${s.id}/${l.product_id}">✕</button>` : ''}</div>`).join('')
              || '<span class="err">Mahsulot va narx belgilanmagan — ilovada tanlab bo\'lmaydi</span>'}</td>
          <td class="row">${can('manager') ? `<button class="small" data-price="${s.id}|">+ Narx</button>
            <button class="small ghost" data-edit="${s.id}">Tahrirlash</button>
            <button class="small ghost" data-toggle="${s.id}">${s.active ? 'O\'chirish' : 'Yoqish'}</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="3" class="muted">Hali yetkazib beruvchi yo\'q</td></tr>'}
      </table></div></div>`;
    $('#flt', v).oninput = (e) => $$('tr[data-name]', v).forEach((tr) => { tr.hidden = !tr.dataset.name.includes(e.target.value.toLowerCase()); });
    $('#add', v) && ($('#add', v).onclick = () => openForm({ title: 'Yangi yetkazib beruvchi', fields: form(),
      onSubmit: async (d) => { await api('POST', '/suppliers', d); flash('Qo\'shildi. Endi unga mahsulot va narx belgilang.'); } }));
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

  // ------------------------------------------------------------------ products & warehouses
  async catalog(v) {
    const [prods, whs] = await Promise.all([api('GET', '/products'), api('GET', '/warehouses')]);
    const block = (title, kind, rows, cols, addLabel) => `
      <div class="card"><div class="row" style="justify-content:space-between"><h2>${title}</h2>
        ${can('manager') ? `<button data-add="${kind}">${addLabel}</button>` : ''}</div>
      <table><tr>${cols.map((c) => `<th>${c[1]}</th>`).join('')}<th></th></tr>
      ${rows.map((r) => `<tr ${r.active ? '' : 'class="muted"'}>${cols.map((c) => `<td>${esc(r[c[0]])}</td>`).join('')}
        <td class="row">${can('manager') ? `<button class="small ghost" data-edit="${kind}|${r.id}">Tahrirlash</button>
          <button class="small ghost" data-toggle="${kind}|${r.id}">${r.active ? 'O\'chirish' : 'Yoqish'}</button>` : ''}</td></tr>`).join('')
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
    const emps = await api('GET', '/employees');
    const testers = emps.filter((e) => e.is_test && e.active);
    v.innerHTML = `<div class="grid2">
      <div class="card">
        <h2>Ilovani noutbukda sinash</h2>
        <p>O'ngda — sut yig'uvchining telefondagi ilovasi bilan <b>aynan bir xil</b> ilova, faqat brauzerda ishlaydi.
          Telefonga o'rnatmasdan barcha o'zgarishlarni shu yerda sinab ko'ring.</p>
        <ol>
          <li><b>Test xodim</b> bilan kiring — uning yozuvlari hisobotlarga kirmaydi.</li>
          <li>Unga yetkazib beruvchilar biriktiring ("Sut yig'uvchilar" → Biriktirish).</li>
          <li>Smenani oching, yetkazib beruvchini tanlang, kg kiriting.</li>
          <li>Oflaynni sinash: brauzerda F12 → Network → "Offline".</li>
        </ol>
        <p><b>Test xodimlar:</b> ${testers.map((e) => `${esc(e.name)} — <code>${esc(e.phone)}</code>`).join(', ') || '<span class="muted">yo\'q</span>'}</p>
        <div class="row">
          <button id="mk">+ Test xodim yaratish</button>
          <a href="/app/" target="_blank" rel="noopener"><button class="ghost" type="button">Alohida oynada ochish ↗</button></a>
          ${can('admin') ? '<button class="ghost" id="clr">Test ma\'lumotlarini tozalash</button>' : ''}
        </div>
      </div>
      <div class="card"><div class="phone"><iframe src="/app/" title="Yaya ilovasi"></iframe></div></div>
    </div>`;
    $('#mk', v).onclick = () => openForm({
      title: 'Test xodim',
      fields: [
        { name: 'name', label: 'Ism', value: 'Test', required: true },
        { name: 'phone', label: 'Telefon (login)', value: '900000000', required: true, inputmode: 'tel' },
        { name: 'pin', label: 'PIN', value: '1111', required: true, inputmode: 'numeric' },
      ],
      onSubmit: async (d) => { await api('POST', '/employees', { ...d, isTest: true }); flash('Test xodim yaratildi. Endi unga yetkazib beruvchilar biriktiring.'); },
    });
    $('#clr', v) && ($('#clr', v).onclick = act(async () => {
      if (!confirm('Test xodimlar kiritgan barcha yozuvlar o\'chiriladi. Davom etasizmi?')) return;
      const r = await api('DELETE', '/test-data');
      flash(`${r.deleted} ta test yozuv o'chirildi`);
    }));
  },

  // ------------------------------------------------------------------ panel users
  async users(v) {
    const users = await api('GET', '/users');
    const roleOpts = Object.entries(ROLE_NAMES);
    v.innerHTML = `
      <div class="card"><div class="row" style="justify-content:space-between"><h2>Boshqaruv paneli foydalanuvchilari</h2><button id="add">+ Foydalanuvchi</button></div>
        <p class="muted"><b>Admin</b> — hammasi. <b>Menejer</b> — xodimlar, yetkazib beruvchilar, narxlar, yozuvlarni bekor qilish.
          <b>Kuzatuvchi</b> — faqat ko'rish va hisobotlar (masalan, buxgalter).</p>
      <table><tr><th>Login</th><th>Ism</th><th>Rol</th><th>Holat</th><th></th></tr>
        ${users.map((u) => `<tr ${u.active ? '' : 'class="muted"'}><td>${esc(u.login)}</td><td>${esc(u.name)}</td><td>${ROLE_NAMES[u.role]}</td>
          <td>${u.active ? 'Faol' : 'O\'chirilgan'}</td>
          <td class="row"><button class="small ghost" data-edit="${u.id}">Tahrirlash</button>
            <button class="small ghost" data-toggle="${u.id}">${u.active ? 'O\'chirish' : 'Yoqish'}</button></td></tr>`).join('')}
      </table></div>
      <div class="card"><h2>Harakatlar jurnali</h2><div id="audit" class="table-wrap"><p class="muted">Yuklanmoqda...</p></div></div>`;
    $('#add', v).onclick = () => openForm({ title: 'Yangi foydalanuvchi', fields: [
      { name: 'login', label: 'Login', required: true }, { name: 'name', label: 'Ism' },
      { name: 'password', label: 'Parol (kamida 8 belgi)', type: 'password', required: true },
      { name: 'role', label: 'Rol', type: 'select', options: roleOpts, value: 'viewer' },
    ], onSubmit: async (d) => { await api('POST', '/users', d); flash('Qo\'shildi'); } });
    $$('[data-edit]', v).forEach((b) => { b.onclick = () => {
      const u = users.find((x) => String(x.id) === b.dataset.edit);
      openForm({ title: u.login, fields: [
        { name: 'name', label: 'Ism', value: u.name }, { name: 'role', label: 'Rol', type: 'select', options: roleOpts, value: u.role },
        { name: 'password', label: 'Yangi parol (o\'zgartirmaslik uchun bo\'sh)', type: 'password' },
      ], onSubmit: async (d) => { await api('PATCH', `/users/${u.id}`, { ...d, password: d.password || undefined }); flash('Saqlandi'); } });
    }; });
    $$('[data-toggle]', v).forEach((b) => { b.onclick = act(async () => {
      const u = users.find((x) => String(x.id) === b.dataset.toggle);
      await api('PATCH', `/users/${u.id}`, { active: !u.active });
      route();
    }); });
    const log = await api('GET', '/audit');
    $('#audit', v).innerHTML = `<table><tr><th>Vaqt</th><th>Kim</th><th>Amal</th><th>Tafsilot</th></tr>
      ${log.map((a) => `<tr><td>${esc(fmtDate(a.at))}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td class="muted">${esc(a.details)}</td></tr>`).join('')}</table>`;
  },

  // ------------------------------------------------------------------ own settings
  async settings(v) {
    v.innerHTML = `
      <form class="card" id="pw" style="max-width:520px">
        <h2>Parolni o'zgartirish</h2>
        <label>Joriy parol <input name="current" type="password" required autocomplete="current-password"></label>
        <label>Yangi parol (kamida 8 belgi) <input name="next" type="password" required minlength="8" autocomplete="new-password"></label>
        <button>O'zgartirish</button>
      </form>`;
    $('#pw', v).onsubmit = act(async (e) => {
      e.preventDefault();
      await api('PUT', '/password', Object.fromEntries(new FormData(e.target)));
      e.target.reset();
      flash('Parol o\'zgartirildi');
    });
  },
};

const route = act(async () => {
  if (!me) return;
  const name = location.hash.slice(1).split('?')[0] || 'dashboard';
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + name));
  // Each navigation renders into a fresh container, so a slow, older page that
  // finishes loading late can never overwrite the page the user is now on.
  const v = document.createElement('main');
  v.id = 'view';
  v.innerHTML = '<p class="muted">Yuklanmoqda...</p>';
  $('#view').replaceWith(v);
  await (views[name] || views.dashboard)(v);
});

window.addEventListener('hashchange', route);
show();
