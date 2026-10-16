'use strict';
// Minimal dependency-free SVG charts for the admin panel.
// Colors come from CSS custom properties (--series-N), so light/dark is handled in CSS.

const Charts = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const fmt = (n) => Number(n).toLocaleString('uz-UZ', { maximumFractionDigits: 1 }).replace(/,/g, ' ');

  // "Nice" axis maximum and ticks.
  function niceTicks(max, count = 4) {
    if (!(max > 0)) return [0, 1];
    const raw = max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const ticks = [];
    for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
    if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
    return ticks;
  }

  // Path for a bar with rounded top corners only (data end), square at the baseline.
  function topRoundedBar(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  function tooltip(host) {
    let tip = host.querySelector('.viz-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'viz-tip';
      tip.hidden = true;
      host.appendChild(tip);
    }
    return {
      show(html, x, y) {
        tip.innerHTML = html;
        tip.hidden = false;
        const hw = host.clientWidth;
        const tw = tip.offsetWidth;
        tip.style.left = `${Math.max(0, Math.min(hw - tw, x - tw / 2))}px`;
        tip.style.top = `${Math.max(0, y - tip.offsetHeight - 10)}px`;
      },
      hide() { tip.hidden = true; },
    };
  }

  /**
   * Stacked vertical bars over categories (days).
   * @param host element; categories: [{key,label}]; series: [{key,name}]
   * @param value(categoryKey, seriesKey) -> number; unit for tooltips
   */
  function stackedBars(host, { categories, series, value, unit = '', height = 220 }) {
    host.classList.add('viz');
    host.innerHTML = '';
    const width = Math.max(host.clientWidth, 280);
    const m = { t: 12, r: 8, b: 26, l: 44 };
    const iw = width - m.l - m.r;
    const ih = height - m.t - m.b;
    const totals = categories.map((c) => series.reduce((a, s) => a + (value(c.key, s.key) || 0), 0));
    const ticks = niceTicks(Math.max(...totals, 0));
    const ymax = ticks[ticks.length - 1];
    const y = (v) => m.t + ih - (v / ymax) * ih;
    const band = iw / categories.length;
    const bw = Math.max(2, Math.min(28, band * 0.7));

    const svg = el('svg', { width, height, role: 'img', 'aria-label': 'Kunlik miqdor grafigi' });
    for (const t of ticks) {
      svg.appendChild(el('line', { x1: m.l, x2: width - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'viz-base' : 'viz-grid' }));
      const lab = el('text', { x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'viz-axis' });
      lab.textContent = fmt(t);
      svg.appendChild(lab);
    }
    // Sparse x labels so they never collide.
    const every = Math.ceil(categories.length / Math.max(1, Math.floor(iw / 48)));
    categories.forEach((c, i) => {
      if (i % every && i !== categories.length - 1) return;
      const t = el('text', { x: m.l + band * i + band / 2, y: height - 8, 'text-anchor': 'middle', class: 'viz-axis' });
      t.textContent = c.label;
      svg.appendChild(t);
    });

    const tip = tooltip(host);
    categories.forEach((c, i) => {
      const x = m.l + band * i + (band - bw) / 2;
      let acc = 0;
      const segs = series.map((s, si) => ({ s, si, v: value(c.key, s.key) || 0 })).filter((d) => d.v > 0);
      segs.forEach((d, k) => {
        const top = y(acc + d.v);
        const bottom = y(acc);
        acc += d.v;
        // 2px surface gap between stacked segments; only the topmost gets rounded ends.
        const gap = k > 0 ? 2 : 0;
        const h = Math.max(0, bottom - top - gap);
        const isTop = k === segs.length - 1;
        svg.appendChild(el('path', {
          d: isTop ? topRoundedBar(x, top, bw, h, 4) : `M${x},${top}h${bw}v${h}h${-bw}Z`,
          class: `viz-s${(d.si % 3) + 1}`,
        }));
      });
      // Hit target spans the whole band height, bigger than the mark.
      const hit = el('rect', { x: m.l + band * i, y: m.t, width: band, height: ih, fill: 'transparent' });
      hit.addEventListener('mousemove', (e) => {
        const rect = host.getBoundingClientRect();
        const rows = series.map((s, si) => `<div><i class="viz-key viz-s${(si % 3) + 1}"></i>${s.name}: <b>${fmt(value(c.key, s.key) || 0)}</b> ${unit}</div>`).join('');
        tip.show(`<div class="viz-tip-h">${c.label}</div>${rows}${series.length > 1 ? `<div>Jami: <b>${fmt(totals[i])}</b> ${unit}</div>` : ''}`,
          e.clientX - rect.left, e.clientY - rect.top);
      });
      hit.addEventListener('mouseleave', tip.hide);
      svg.appendChild(hit);
    });
    host.prepend(svg);

    if (series.length > 1) {
      const legend = document.createElement('div');
      legend.className = 'viz-legend';
      legend.innerHTML = series.map((s, si) => `<span><i class="viz-key viz-s${(si % 3) + 1}"></i>${s.name}</span>`).join('');
      host.appendChild(legend);
    }
  }

  /** Ranked horizontal bars with direct value labels. rows: [{label, value, sub}] */
  function rankBars(host, { rows, unit = '', max = 12 }) {
    host.classList.add('viz');
    const shown = rows.slice(0, max);
    const top = Math.max(...shown.map((r) => r.value), 0) || 1;
    host.innerHTML = shown.map((r) => `
      <div class="viz-rank" title="${r.label}: ${fmt(r.value)} ${unit}">
        <div class="viz-rank-label">${r.label}</div>
        <div class="viz-rank-track"><div class="viz-rank-bar" style="width:${Math.max(1, (r.value / top) * 100)}%"></div></div>
        <div class="viz-rank-val">${fmt(r.value)} <span class="muted">${unit}</span>${r.sub ? `<div class="muted">${r.sub}</div>` : ''}</div>
      </div>`).join('') + (rows.length > max ? `<p class="muted">… yana ${rows.length - max} ta (to'liq ro'yxat jadvalda)</p>` : '')
      || '<p class="muted">Ma\'lumot yo\'q</p>';
  }

  return { stackedBars, rankBars, fmt };
})();
