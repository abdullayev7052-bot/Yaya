'use strict';

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => Number(n).toLocaleString('uz-UZ', { maximumFractionDigits: 2 });
const fmtDate = (s) => (s ? new Date(s).toLocaleString('uz-UZ') : '');

let token = null;
try { token = localStorage.getItem('yaya_admin_token'); } catch { /* storage unavailable */ }

async function api(method, path, body) {
  const res = await fetch('/api/admin' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== '/login') { logout(); throw new Error('Qayta kiring'); }
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

function logout() {
  token = null;
  try { localStorage.removeItem('yaya_admin_token'); } catch { /* ignore */ }
  show();
}

function show() {
  $('#login').hidden = !!token;
  $('#main').hidden = !token;
  if (token) route();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api('POST', '/login', { login: f.get('login'), password: f.get('password') });
    token = r.token;
    try { localStorage.setItem('yaya_admin_token', token); } catch { /* ignore */ }
    $('#loginErr').textContent = '';
    show();
  } catch (err) {
    $('#loginErr').textContent = err.message;
  }
});
$('#logout').addEventListener('click', logout);
$('#bitoSync').addEventListener('click', act(async () => {
  const r = await api('POST', '/bito/sync');
  flash(`Bitodan yangilandi: ${r.suppliers} yetkazib beruvchi, ${r.products} mahsulot, ${r.warehouses} ombor`);
  route();
}));

const views = {
  async dashboard(v) {
    const q = new URLSearchParams(location.hash.split('?')[1]);
    const d = await api('GET', '/dashboard' + (q.get('date') ? '?date=' + q.get('date') : ''));
    const totals = {};
    for (const r of d.byEmployee) {
      const k = `${r.product_name} (${r.unit || 'kg'})`;
      totals[k] = (totals[k] || 0) + r.quantity;
    }
    const sumAmount = d.byEmployee.reduce((a, r) => a + r.amount, 0);
    v.innerHTML = `
      ${d.bitoConfigured ? '' : '<div class="card err">Bito ulanishi sozlanmagan — xaridlar navbatda turibdi. "Sozlamalar" bo\'limiga o\'ting.</div>'}
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <h2>Kunlik hisobot</h2>
          <input type="date" id="day" value="${esc(d.date)}">
        </div>
        <div class="row" style="gap:24px">
          ${Object.entries(totals).map(([k, n]) => `<div><div class="muted">${esc(k)}</div><div style="font-size:28px;font-weight:700">${fmtNum(n)}</div></div>`).join('')
            || '<p class="muted">Bu kunda xarid yo\'q</p>'}
          ${d.byEmployee.length ? `<div><div class="muted">Summa</div><div style="font-size:28px;font-weight:700">${fmtNum(sumAmount)}</div></div>` : ''}
        </div>
      </div>
      <div class="card"><div class="table-wrap"><table>
        <tr><th>Xodim</th><th>Mahsulot</th><th>Uylar</th><th>Miqdor</th><th>Summa</th></tr>
        ${d.byEmployee.map((r) => `<tr><td>${esc(r.employee_name)}</td><td>${esc(r.product_name)}</td><td>${r.pickups}</td>
          <td>${fmtNum(r.quantity)} ${esc(r.unit)}</td><td>${fmtNum(r.amount)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">—</td></tr>'}
      </table></div></div>
      <div class="card">
        <h2>Holat</h2>
        <p>Bitoga yuborilgan: <b>${d.queue.sent || 0}</b> · Navbatda: <b>${d.queue.pending || 0}</b> ·
          Xato: <b class="${d.queue.error ? 'err' : ''}">${d.queue.error || 0}</b></p>
        <p>Ochiq smenalar: ${d.openShifts.map((s) => `${esc(s.name)} (${esc(fmtDate(s.opened_at))})`).join(', ') || '<span class="muted">yo\'q</span>'}</p>
      </div>`;
    $('#day').onchange = (e) => { location.hash = 'dashboard?date=' + e.target.value; };
  },

  async settings(v) {
    const st = await api('GET', '/settings');
    v.innerHTML = `
      <form class="card" id="bito">
        <h2>Bito ulanishi ${st.bitoConfigured ? '<span class="badge sent">sozlangan</span>' : '<span class="badge error">sozlanmagan</span>'}</h2>
        <div class="row">
          <label>Bito API manzili <input name="bitoBaseUrl" value="${esc(st.bitoBaseUrl)}" placeholder="https://..."></label>
          <label>Token ${st.bitoTokenSet ? '(saqlangan — o\'zgartirish uchun yangisini kiriting)' : ''}
            <input name="bitoToken" type="password" autocomplete="off"></label>
          <button>Saqlash</button>
          <button type="button" class="ghost" id="test">Tekshirish</button>
        </div>
      </form>
      <form class="card" id="pw">
        <h2>Admin parolini o'zgartirish</h2>
        <div class="row">
          <label>Joriy parol <input name="current" type="password" required autocomplete="current-password"></label>
          <label>Yangi parol (kamida 8 belgi) <input name="next" type="password" required minlength="8" autocomplete="new-password"></label>
          <button>O'zgartirish</button>
        </div>
      </form>`;
    $('#bito').onsubmit = act(async (e) => {
      e.preventDefault();
      await api('PUT', '/settings', Object.fromEntries(new FormData(e.target)));
      flash('Saqlandi');
      route();
    });
    $('#test').onclick = act(async () => {
      const r = await api('POST', '/bito/sync');
      flash(`Ulanish ishlayapti: ${r.suppliers} yetkazib beruvchi, ${r.products} mahsulot, ${r.warehouses} ombor`);
    });
    $('#pw').onsubmit = act(async (e) => {
      e.preventDefault();
      await api('PUT', '/password', Object.fromEntries(new FormData(e.target)));
      e.target.reset();
      flash('Parol o\'zgartirildi');
    });
  },

  async collections(v) {
    const status = new URLSearchParams(location.hash.split('?')[1]).get('status') || '';
    const rows = await api('GET', '/collections' + (status ? '?status=' + status : ''));
    const label = { pending: 'Navbatda', sent: 'Bitoda', error: 'Xato' };
    v.innerHTML = `
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <h2>Xaridlar (oxirgi 500)</h2>
          <div class="row">
            <select id="st">
              <option value="">Hammasi</option>
              ${Object.entries(label).map(([k, t]) => `<option value="${k}" ${k === status ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
            <button class="ghost" id="retry">Xatolarni qayta yuborish</button>
          </div>
        </div>
        <div class="table-wrap"><table>
          <tr><th>Vaqt</th><th>Xodim</th><th>Yetkazib beruvchi</th><th>Mahsulot</th><th>Miqdor</th><th>Narx</th><th>Summa</th><th>Bito</th></tr>
          ${rows.map((r) => `<tr>
            <td>${esc(fmtDate(r.collected_at))}</td><td>${esc(r.employee_name)}</td><td>${esc(r.supplier_name)}</td>
            <td>${esc(r.product_name)}</td><td>${fmtNum(r.quantity)} ${esc(r.unit)}</td><td>${fmtNum(r.price)}</td>
            <td>${fmtNum(r.quantity * r.price)}</td>
            <td><span class="badge ${r.bito_status}" title="${esc(r.bito_error)}">${label[r.bito_status]}</span>
              ${r.bito_doc_id ? `<div class="muted">${esc(r.bito_doc_id)}</div>` : ''}
              ${r.bito_error ? `<div class="err">${esc(r.bito_error)}</div>` : ''}</td>
          </tr>`).join('') || '<tr><td colspan="8" class="muted">Hali xarid yo\'q</td></tr>'}
        </table></div>
      </div>`;
    $('#st').onchange = (e) => { location.hash = 'collections' + (e.target.value ? '?status=' + e.target.value : ''); };
    $('#retry').onclick = act(async () => { const r = await api('POST', '/collections/retry'); flash(`${r.changed} ta yozuv navbatga qaytarildi`); route(); });
  },

  async employees(v) {
    const [emps, whs, sups] = await Promise.all([api('GET', '/employees'), api('GET', '/warehouses'), api('GET', '/suppliers')]);
    const whName = Object.fromEntries(whs.map((w) => [w.id, w.name]));
    const whOptions = (sel) => whs.map((w) => `<option value="${w.id}" ${w.id === sel ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
    v.innerHTML = `
      <form class="card" id="add">
        <h2>Yangi sut yig'uvchi</h2>
        <div class="row">
          <label>Ism <input name="name" required></label>
          <label>Telefon (login) <input name="phone" required inputmode="tel" placeholder="901234567"></label>
          <label>PIN (4–6 raqam) <input name="pin" required inputmode="numeric" pattern="\\d{4,6}"></label>
          <label>Ombori (mashina) <select name="warehouseId" required><option value="">— tanlang —</option>${whOptions()}</select></label>
          <button>Qo'shish</button>
        </div>
        ${whs.length ? '' : '<p class="muted">Omborlar ro\'yxati bo\'sh — avval "Bitodan yangilash" ni bosing yoki Omborlar bo\'limida yarating.</p>'}
      </form>
      <div class="card"><div class="table-wrap"><table>
        <tr><th>Ism</th><th>Telefon</th><th>Ombor</th><th>Holat</th><th></th></tr>
        ${emps.map((e) => `<tr>
          <td>${esc(e.name)}</td><td>${esc(e.phone)}</td><td>${esc(whName[e.warehouse_id] || '—')}</td>
          <td>${e.active ? 'Faol' : '<span class="muted">O\'chirilgan</span>'}</td>
          <td class="row">
            <button class="small" data-assign="${e.id}">Yetkazib beruvchilar</button>
            <button class="small ghost" data-pin="${e.id}">PIN</button>
            <button class="small ghost" data-toggle="${e.id}" data-active="${e.active}">${e.active ? 'O\'chirish' : 'Yoqish'}</button>
          </td></tr>`).join('') || '<tr><td colspan="5" class="muted">Xodim yo\'q</td></tr>'}
      </table></div></div>
      <div id="assign"></div>`;

    $('#add').onsubmit = act(async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      await api('POST', '/employees', { ...f, warehouseId: Number(f.warehouseId) });
      flash('Xodim qo\'shildi');
      route();
    });
    v.querySelectorAll('[data-toggle]').forEach((b) => { b.onclick = act(async () => {
      await api('PATCH', '/employees/' + b.dataset.toggle, { active: b.dataset.active === '1' ? 0 : 1 });
      route();
    }); });
    v.querySelectorAll('[data-pin]').forEach((b) => { b.onclick = act(async () => {
      const pin = prompt('Yangi PIN (4–6 raqam):');
      if (!pin) return;
      if (!/^\d{4,6}$/.test(pin)) throw new Error('PIN 4–6 raqamdan iborat bo\'lsin');
      await api('PATCH', '/employees/' + b.dataset.pin, { pin });
      flash('PIN yangilandi');
    }); });
    v.querySelectorAll('[data-assign]').forEach((b) => { b.onclick = act(async () => {
      const id = b.dataset.assign;
      const emp = emps.find((x) => String(x.id) === id);
      const chosen = new Set(await api('GET', `/employees/${id}/suppliers`));
      const box = $('#assign');
      box.innerHTML = `<div class="card">
        <h2>${esc(emp.name)} — biriktirilgan yetkazib beruvchilar</h2>
        <input id="flt" placeholder="Qidirish..." style="width:100%;margin-bottom:8px">
        <div class="checks">${sups.filter((s) => s.active).map((s) => `<label data-name="${esc(s.name.toLowerCase())}">
          <input type="checkbox" value="${s.id}" ${chosen.has(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')}</div>
        <p><button id="saveAssign">Saqlash</button></p></div>`;
      $('#flt').oninput = (e) => box.querySelectorAll('.checks label').forEach((l) => { l.hidden = !l.dataset.name.includes(e.target.value.toLowerCase()); });
      $('#saveAssign').onclick = act(async () => {
        const ids = [...box.querySelectorAll('.checks input:checked')].map((c) => Number(c.value));
        await api('PUT', `/employees/${id}/suppliers`, { supplierIds: ids });
        flash(`${ids.length} ta yetkazib beruvchi biriktirildi`);
      });
      box.scrollIntoView({ behavior: 'smooth' });
    }); });
  },

  async suppliers(v) {
    const [sups, prods, links] = await Promise.all([api('GET', '/suppliers'), api('GET', '/products'), api('GET', '/supplier-products')]);
    const bySup = {};
    for (const l of links) (bySup[l.supplier_id] ||= []).push(l);
    const prodOptions = prods.filter((p) => p.active).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    v.innerHTML = `
      <form class="card" id="add">
        <h2>Yangi yetkazib beruvchi <span class="muted">(Bitoda ham yaratiladi)</span></h2>
        <div class="row">
          <label>F.I.Sh <input name="name" required></label>
          <label>Telefon <input name="phone" inputmode="tel"></label>
          <label>Manzil <input name="address"></label>
          <button>Qo'shish</button>
        </div>
      </form>
      <div class="card">
        <input id="flt" placeholder="Qidirish..." style="width:100%;margin-bottom:8px">
        <div class="table-wrap"><table>
        <tr><th>Yetkazib beruvchi</th><th>Mahsulot va narx (xodimga ko'rinmaydi)</th><th>Qo'shish</th></tr>
        ${sups.map((s) => `<tr data-name="${esc(s.name.toLowerCase())}" ${s.active ? '' : 'class="muted"'}>
          <td><b>${esc(s.name)}</b>${s.active ? '' : ' (Bitoda yo\'q)'}<div class="muted">${esc(s.phone)} ${esc(s.address)}</div></td>
          <td>${(bySup[s.id] || []).map((l) => `<div class="row" style="align-items:center">
              ${l.is_default ? '★' : ''} ${esc(l.product_name)}: <b>${fmtNum(l.price)}</b> so'm/${esc(l.unit || 'birlik')}
              <button class="small ghost" data-del="${s.id}/${l.product_id}">✕</button></div>`).join('') || '<span class="err">Mahsulot biriktirilmagan</span>'}</td>
          <td><form class="row" data-sup="${s.id}">
            <select name="productId" required><option value="">mahsulot</option>${prodOptions}</select>
            <input name="price" type="number" min="0" step="any" placeholder="narx" required style="width:110px">
            <label style="display:flex;gap:4px;align-items:center"><input type="checkbox" name="isDefault" ${(bySup[s.id] || []).length ? '' : 'checked'}> asosiy</label>
            <button class="small">Saqlash</button></form></td>
        </tr>`).join('') || '<tr><td colspan="3" class="muted">Ro\'yxat bo\'sh — "Bitodan yangilash" ni bosing</td></tr>'}
      </table></div></div>`;

    $('#flt').oninput = (e) => v.querySelectorAll('tr[data-name]').forEach((tr) => { tr.hidden = !tr.dataset.name.includes(e.target.value.toLowerCase()); });
    $('#add').onsubmit = act(async (e) => {
      e.preventDefault();
      await api('POST', '/suppliers', Object.fromEntries(new FormData(e.target)));
      flash('Yetkazib beruvchi Bitoda va ilovada yaratildi');
      route();
    });
    v.querySelectorAll('form[data-sup]').forEach((f) => { f.onsubmit = act(async (e) => {
      e.preventDefault();
      const d = new FormData(f);
      await api('PUT', '/supplier-products', { supplierId: Number(f.dataset.sup), productId: Number(d.get('productId')),
        price: Number(d.get('price')), isDefault: d.get('isDefault') === 'on' });
      flash('Narx saqlandi');
      route();
    }); });
    v.querySelectorAll('[data-del]').forEach((b) => { b.onclick = act(async () => {
      if (!confirm('Bu mahsulotni yetkazib beruvchidan olib tashlaysizmi?')) return;
      await api('DELETE', '/supplier-products/' + b.dataset.del);
      route();
    }); });
  },

  async products(v) {
    const prods = await api('GET', '/products');
    v.innerHTML = `
      <form class="card" id="add">
        <h2>Yangi mahsulot <span class="muted">(Bitoda ham yaratiladi)</span></h2>
        <div class="row">
          <label>Nomi <input name="name" required placeholder="Yog'li sut"></label>
          <label>O'lchov birligi <input name="unit" placeholder="kg"></label>
          <button>Qo'shish</button>
        </div>
      </form>
      <div class="card"><table>
        <tr><th>Mahsulot</th><th>Birlik</th><th>Bito ID</th></tr>
        ${prods.map((p) => `<tr ${p.active ? '' : 'class="muted"'}><td>${esc(p.name)}</td><td>${esc(p.unit)}</td><td>${esc(p.bito_id)}</td></tr>`).join('')
          || '<tr><td colspan="3" class="muted">Ro\'yxat bo\'sh — "Bitodan yangilash" ni bosing</td></tr>'}
      </table></div>`;
    $('#add').onsubmit = act(async (e) => {
      e.preventDefault();
      await api('POST', '/products', Object.fromEntries(new FormData(e.target)));
      flash('Mahsulot yaratildi');
      route();
    });
  },

  async warehouses(v) {
    const whs = await api('GET', '/warehouses');
    v.innerHTML = `
      <form class="card" id="add">
        <h2>Yangi ombor <span class="muted">(har bir sut yig'uvchi uchun alohida; Bitoda ham yaratiladi)</span></h2>
        <div class="row"><label>Nomi <input name="name" required placeholder="Mashina — Ali"></label><button>Qo'shish</button></div>
      </form>
      <div class="card"><table>
        <tr><th>Ombor</th><th>Bito ID</th></tr>
        ${whs.map((w) => `<tr><td>${esc(w.name)}</td><td>${esc(w.bito_id)}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">Ro\'yxat bo\'sh</td></tr>'}
      </table></div>`;
    $('#add').onsubmit = act(async (e) => {
      e.preventDefault();
      await api('POST', '/warehouses', Object.fromEntries(new FormData(e.target)));
      flash('Ombor yaratildi');
      route();
    });
  },
};

const route = act(async () => {
  const name = (location.hash.slice(1).split('?')[0]) || 'dashboard';
  document.querySelectorAll('header nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + name));
  const v = $('#view');
  v.innerHTML = '<p class="muted">Yuklanmoqda...</p>';
  await (views[name] || views.dashboard)(v);
});

window.addEventListener('hashchange', () => token && route());
show();
