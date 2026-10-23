'use strict';
// Analyze: talks only to the password-protected Worker; Plaid keys never reach the phone.

const DEFAULT_SERVER = 'https://finances.vishalg.workers.dev';
// Settings saved to the server so they follow the account, with a local copy for fast startup.
let settingsReady = false;
const SYNCED = ['recurring', 'graphs', 'cats', 'sort', 'show'];
const store = {
  get: (k, d) => { try { const v = localStorage.getItem('fin.' + k), r = v == null ? null : JSON.parse(v); return r == null ? d : r; } catch (_) { return d; } },
  set: (k, v) => {
    try { localStorage.setItem('fin.' + k, JSON.stringify(v)); } catch (_) {}
    if (SYNCED.includes(k) && settingsReady) { localStorage.setItem('fin.settingsAt', Date.now()); localStorage.setItem('fin.settingsDirty', '1'); pushSettings(); }
  },
  del: (k) => localStorage.removeItem('fin.' + k),
};

let data = store.get('data', null);
let recurring = store.get('recurring', []);
let view = 'overview';
const connBy = store.get('connBy', {});
let conn = connBy[view] || 'all';
let month = null;
let open = new Set();
let range = null;
let lastSync = 0, syncing = null, pollTimer = null, pollCount = 0;

const $ = (id) => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const el = tag === 'svg' ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const money = (n, cents) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US',
  { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
const monthKey = (d) => d.slice(0, 7);
const monthName = (k, long) => new Date(k + '-15T12:00').toLocaleDateString('en-US', long ? { month: 'long', year: 'numeric' } : { month: 'short' });
const dayName = (d) => new Date(d + 'T12:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const isoOf = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const todayISO = () => isoOf(new Date());
const shiftDays = (iso, n) => { const d = new Date(iso + 'T12:00'); d.setDate(d.getDate() + n); return isoOf(d); };
const nice = (cat) => (cat || 'OTHER').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600); }

// ---------- server ----------
async function api(path, body) {
  const server = store.get('server', DEFAULT_SERVER), pass = store.get('pass', '');
  const res = await fetch(server.replace(/\/$/, '') + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + pass, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(); throw new Error('Wrong password'); }
  if (!res.ok) throw new Error(json.message || json.error || 'Server error');
  return json;
}
let pushTimer = null;
function pushSettings() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    const values = Object.fromEntries(SYNCED.map((k) => [k, store.get(k, null)]));
    api('/settings/save', { values, updated: Number(localStorage.getItem('fin.settingsAt')) || Date.now() })
      .then(() => localStorage.removeItem('fin.settingsDirty')).catch(() => {});
  }, 800);
}
async function pullSettings() {
  let s;
  try { s = await api('/settings', {}); } catch (_) { settingsReady = true; return; }
  settingsReady = true;
  const localAt = Number(localStorage.getItem('fin.settingsAt')) || 0;
  if (localStorage.getItem('fin.settingsDirty') || !s || !s.values) { if (localAt || !s) pushSettings(); return; }
  if (s.updated <= localAt) return;
  for (const k of SYNCED) {
    if (s.values[k] == null) localStorage.removeItem('fin.' + k); else localStorage.setItem('fin.' + k, JSON.stringify(s.values[k]));
  }
  localStorage.setItem('fin.settingsAt', s.updated);
  recurring = store.get('recurring', []); cats = store.get('cats', { tx: {}, rules: {} }); txSort = store.get('sort', 'time');
  graphs = loadGraphs();
  render(); if (panel) renderPanel();
}
function gotData(d) {
  data = d; store.set('data', d);
  for (const k in connBy) if (connBy[k] !== 'all' && !d.connections.some((c) => c.item_id === connBy[k] && (c.accounts || []).some(isCard))) delete connBy[k];
  conn = connBy[view] || 'all';
  render(); pollIfLoading();
}
async function refresh(manual) {
  if (syncing) return syncing;
  const b = $('sync-btn'); b.classList.add('spin');
  syncing = (async () => {
    try { gotData(await api('/sync', {})); lastSync = Date.now(); if (manual) toast('Up to date'); }
    catch (e) { toast(e.message); }
    finally { b.classList.remove('spin'); syncing = null; }
  })();
  return syncing;
}
// Right after a bank is linked Plaid is still pulling its history; keep checking until it lands.
const loadingConns = () => (data ? data.connections.filter((c) => c.tx_status === 'NOT_READY') : []);
function pollIfLoading() {
  clearTimeout(pollTimer);
  if (!loadingConns().length) { pollCount = 0; return; }
  if (pollCount++ > 20) return;
  pollTimer = setTimeout(() => refresh(false), 15000);
}

// ---------- Plaid Link ----------
function busy(text) { $('overlay').hidden = !text; if (text) $('overlay-text').textContent = text; }
let linkHandler = null;
function openLink(token, received) {
  if (linkHandler) linkHandler.destroy();
  busy('Opening Plaid…');
  linkHandler = Plaid.create({
    token, receivedRedirectUri: received,
    onEvent: (name) => { if (name === 'OPEN' || name === 'TRANSITION_VIEW') busy(null); },
    onSuccess: async (public_token, meta) => {
      store.del('linkToken');
      if (received) history.replaceState(null, '', location.pathname);
      const bank = (meta.institution && meta.institution.name) || 'your account';
      busy('Adding ' + bank + '…');
      try {
        const d = await api('/exchange', { public_token, institution: meta.institution && meta.institution.name });
        closePanel(true); view = 'overview'; conn = connBy.overview = d.added_item || 'all'; store.set('connBy', connBy);
        gotData(d); setTab(); toast(bank + ' connected');
      } catch (e) { toast(e.message); }
      finally { busy(null); }
    },
    onExit: (err) => {
      busy(null); store.del('linkToken');
      if (err) toast(err.display_message || err.error_message || 'Couldn’t connect');
    },
  });
  linkHandler.open();
}
async function connect(item_id) {
  busy('Opening Plaid…');
  try {
    const { link_token } = await api('/link-token', { item_id });
    store.set('linkToken', link_token);
    openLink(link_token);
  } catch (e) { busy(null); toast(e.message); }
}

// ---------- derived data ----------
// Only credit cards count. The chips at the top pick one card issuer or all of them.
const isCard = (a) => a.type === 'credit';
const cardConns = () => (data ? data.connections.filter((c) => (c.accounts || []).some(isCard)) : []);
const shownConns = () => cardConns().filter((c) => conn === 'all' || c.item_id === conn);
const allAccounts = () => shownConns().flatMap((c) => (c.accounts || []).filter(isCard).map((a) => ({ ...a, institution: c.institution, brand: c.brand })));
// Card payments come through as credits under these; charges under them (e.g. Venmo on the card) still count.
const SPEND_OUT = new Set(['TRANSFER_OUT', 'LOAN_PAYMENTS']);
const isSpend = (t) => t.category !== 'INCOME' && t.category !== 'TRANSFER_IN' && !(t.amount < 0 && SPEND_OUT.has(t.category));
let cats = store.get('cats', { tx: {}, rules: {} }), catsCache = null;
const allTxns = () => {
  if (!data) return [];
  if (catsCache && catsCache.src === data.transactions && catsCache.v === cats && catsCache.r === recurring && catsCache.d === todayISO()) return catsCache.out;
  const out = data.transactions.concat(recurringTxns()).map((t) => { const c = cats.tx[t.transaction_id] || cats.rules[t.name]; return c && c !== t.category ? { ...t, category: c, origCategory: t.category } : t; });
  catsCache = { src: data.transactions, v: cats, r: recurring, d: todayISO(), out };
  return out;
};
const txns = () => { const ids = new Set(allAccounts().map((a) => a.account_id)); if (conn === 'all') ids.add('manual'); return allTxns().filter((t) => ids.has(t.account_id)); };
// Finalized charges only; a refund cancels its matching charge, and partial refunds net against the merchant.
let spendCache = { key: null, list: [] };
function spending() {
  const all = txns(), key = (data && data.synced) + '|' + conn + '|' + all.length;
  if (spendCache.key === key && spendCache.cats === cats && spendCache.r === recurring) return spendCache.list;
  const list = all.filter((t) => !t.pending && isSpend(t));
  const charges = list.filter((t) => t.amount > 0), refunds = list.filter((t) => t.amount < 0), drop = new Set();
  const names = new Set(charges.map((t) => t.name));
  for (const r of refunds.sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const c = charges.find((x) => !drop.has(x.id) && x.name === r.name && Math.abs(x.amount + r.amount) < 0.01 && x.date <= r.date && daysBetween(x.date, r.date) <= 120);
    if (c) { drop.add(c.id); drop.add(r.id); }
  }
  spendCache = { key, cats, r: recurring, list: list.filter((t) => !drop.has(t.id) && (t.amount > 0 || names.has(t.name))) };
  return spendCache.list;
}
function byMonth(list, sign = 1) {
  const m = {};
  for (const t of list) m[monthKey(t.date)] = (m[monthKey(t.date)] || 0) + t.amount * sign;
  return m;
}
function lastMonths(n) {
  const out = [], d = new Date(); d.setDate(15);
  for (let i = n - 1; i >= 0; i--) { const x = new Date(d); x.setMonth(d.getMonth() - i); out.push(x.toISOString().slice(0, 7)); }
  return out;
}
// A merchant that charges about the same amount on a regular schedule (and still does) looks like a subscription.
const CADENCES = [['Weekly', 7, 5, 9], ['Every 2 weeks', 14, 12, 17], ['Monthly', 30.4, 26, 35], ['Quarterly', 91, 84, 98], ['Yearly', 365, 345, 385]];
function subscriptions() {
  const groups = {};
  for (const t of spending().filter((x) => x.amount > 0 && !x.manual)) (groups[t.name] = groups[t.name] || []).push(t);
  const subs = [];
  for (const [name, list] of Object.entries(groups)) {
    list.sort((a, b) => (a.date < b.date ? 1 : -1));
    const latest = list[0], similar = list.filter((t) => Math.abs(t.amount - latest.amount) <= Math.max(1, latest.amount * 0.05));
    if (similar.length < 2) continue;
    const gaps = similar.slice(0, -1).map((t, i) => daysBetween(similar[i + 1].date, t.date)).sort((x, y) => x - y), gap = gaps[Math.floor(gaps.length / 2)];
    const c = CADENCES.find(([, , lo, hi]) => gap >= lo && gap <= hi);
    if (!c || similar.length < (c[1] >= 84 ? 2 : 3)) continue;
    if (gaps.filter((g) => Math.abs(g - gap) <= Math.max(3, gap * 0.25)).length < gaps.length * 0.7) continue;
    if (daysBetween(latest.date, todayISO()) > c[1] * 1.5 + 7) continue;
    subs.push({ name, amount: latest.amount, monthly: (latest.amount * 30.4) / c[1], every: c[0], last: latest.date, next: shiftDays(latest.date, Math.round(c[1])), logo: latest.logo, history: similar });
  }
  return subs.sort((a, b) => b.monthly - a.monthly);
}

const daysBetween = (a, b) => Math.max(0, Math.round((new Date(b + 'T12:00') - new Date(a + 'T12:00')) / 864e5));

// ---------- recurring payments you enter yourself ----------
const EVERY = [['weekly', 'Weekly'], ['2weeks', 'Every 2 weeks'], ['monthly', 'Monthly'], ['yearly', 'Yearly']];
const PER_MONTH = { weekly: 52 / 12, '2weeks': 26 / 12, monthly: 1, yearly: 1 / 12 };
const everyName = (k) => (EVERY.find((e) => e[0] === k) || [, 'Monthly'])[1];
const perMo = (l) => l.reduce((s, r) => s + r.amount * (PER_MONTH[r.every] || 1), 0);
function recurringDates(r, to) {
  const out = [], end = r.end && r.end < to ? r.end : to;
  if (!r.start) return out;
  const [y, m, d] = r.start.split('-').map(Number);
  for (let i = 0; i < 5000; i++) {
    let iso;
    if (r.every === 'weekly' || r.every === '2weeks') iso = shiftDays(r.start, i * (r.every === 'weekly' ? 7 : 14));
    else { const mm = m - 1 + (r.every === 'yearly' ? 12 * i : i); iso = isoOf(new Date(y, mm, Math.min(d, new Date(y, mm + 1, 0).getDate()))); }
    if (iso > end) break;
    out.push(iso);
  }
  return out;
}
const nextDate = (r) => { const d = recurringDates({ ...r, end: '' }, shiftDays(todayISO(), 400)).find((x) => x > todayISO()); return d && (!r.end || d <= r.end) ? d : null; };
// Each counted payment becomes a paid transaction on every date it repeats, up to today.
const recurringTxns = () => recurring.filter((r) => r.count !== false && r.amount > 0).flatMap((r) => recurringDates(r, todayISO()).map((d) => ({
  id: 'rec:' + r.id + ':' + d, transaction_id: 'rec:' + r.id + ':' + d, account_id: 'manual', manual: true,
  name: r.name || 'Recurring', amount: r.amount, date: d, category: r.category || 'OTHER', pending: false })));
const saveRecurring = (l) => { recurring = l; store.set('recurring', recurring); render(); renderPanel(); };

// ---------- charts ----------
const fullDay = (d) => new Date(d + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.slice(0, 4) === todayISO().slice(0, 4) ? undefined : 'numeric' });
const PALETTE = ['#1fd286', '#4f8cff', '#ffb547', '#ff6b8b', '#a37bff', '#2fd0d6', '#ff8a4c', '#c3d84a', '#6b7280'];
function holdUntilTapOutside(wrap, end) {
  const off = (e) => {
    if (!wrap.isConnected) return document.removeEventListener('pointerdown', off, true);
    if (!wrap.contains(e.target)) end();
  };
  document.addEventListener('pointerdown', off, true);
}
function lineChart(points, onScrub) {
  if (points.length < 2) return null;
  const W = 340, H = 140, vals = points.map((p) => p.v), lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const X = (i) => (i / (points.length - 1)) * W, Y = (v) => H - 12 - ((v - lo) / span) * (H - 24);
  const d = points.map((p, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.v).toFixed(1)).join(' ');
  const up = vals[vals.length - 1] >= vals[0], col = up ? '#1fd286' : '#ff5a5f', id = 'g' + Math.random().toString(36).slice(2, 7);
  const svg = h('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, html:
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".3"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>` +
    `<path class="area" d="${d} L ${W} ${H} L 0 ${H} Z" fill="url(#${id})"/>` +
    `<path class="stroke" pathLength="1" d="${d}" fill="none" stroke="${col}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>` });
  const pos = (i) => `left:${(X(i) / W) * 100}%;top:${(Y(points[i].v) / H) * 100}%`;
  const last = points.length - 1;
  const pulse = h('i', { class: 'pulse', style: pos(last) + `;--c:${col}` });
  const cursor = h('i', { class: 'cursor', hidden: true });
  const wrap = h('div', { class: 'linewrap' }, svg, cursor, pulse);
  const move = (e) => {
    const r = wrap.getBoundingClientRect(), i = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * last);
    cursor.hidden = false; cursor.style.left = (X(i) / W) * 100 + '%';
    pulse.setAttribute('style', pos(i) + `;--c:${col}`); pulse.classList.add('still');
    onScrub && onScrub(points[i]);
  };
  const end = () => { cursor.hidden = true; pulse.setAttribute('style', pos(last) + `;--c:${col}`); pulse.classList.remove('still'); onScrub && onScrub(null); };
  wrap.addEventListener('pointerdown', move); wrap.addEventListener('pointermove', (e) => { if (e.buttons) move(e); });
  holdUntilTapOutside(wrap, end);
  return wrap;
}
function barChart(months, values, onPick, selected) {
  const W = 320, H = 120, max = Math.max(1, ...values), bw = W / months.length;
  const svg = h('svg', { class: 'chart bars', viewBox: `0 0 ${W} ${H + 16}` });
  svg.innerHTML = months.map((m, i) => {
    const bh = (Math.max(0, values[i]) / max) * (H - 4), on = m === selected;
    return `<g data-m="${m}"><rect x="${i * bw}" y="0" width="${bw}" height="${H + 16}" fill="transparent"/>` +
      `<rect class="b" style="animation-delay:${i * 30}ms" x="${i * bw + bw * 0.2}" y="${H - bh}" width="${bw * 0.6}" height="${Math.max(bh, 1)}" rx="3" fill="${on ? 'var(--accent)' : 'var(--bar)'}"/>` +
      `<text x="${i * bw + bw / 2}" y="${H + 13}" font-size="10" text-anchor="middle" fill="${on ? 'var(--fg)' : 'var(--dim)'}">${monthName(m)[0]}</text></g>`;
  }).join('');
  if (onPick) svg.addEventListener('click', (e) => { const g = e.target.closest('g'); if (g) onPick(g.dataset.m); });
  return svg;
}
function donut(segments, center, onPick) {
  const R = 54, C = 2 * Math.PI * R, total = segments.reduce((s, x) => s + Math.max(0, x.v), 0) || 1;
  let off = 0;
  const arcs = segments.map((s, i) => {
    const len = (Math.max(0, s.v) / total) * C, gap = segments.length > 1 ? Math.min(3, len / 3) : 0;
    const a = `<circle class="seg${s.on ? ' on' : ''}" data-k="${i}" r="${R}" cx="70" cy="70" fill="none" stroke="${s.color}" stroke-width="${s.on ? 20 : 16}"
      stroke-dasharray="${Math.max(0, len - gap)} ${C}" stroke-dashoffset="${-off}" style="animation-delay:${i * 60}ms"/>`;
    off += len; return a;
  }).join('');
  const svg = h('svg', { class: 'donut', viewBox: '0 0 140 140', html: `<g transform="rotate(-90 70 70)">${arcs}</g>` });
  svg.addEventListener('click', (e) => { const c = e.target.closest('.seg'); if (c) onPick(+c.dataset.k); });
  return h('div', { class: 'donutwrap' }, svg, h('div', { class: 'donut-center' }, center));
}
const mark = (brand, name) => h('div', { class: 'bank', style: brand && brand.color ? `background:${brand.color}` : null },
  brand && brand.logo ? h('img', { src: 'data:image/png;base64,' + brand.logo, alt: '' }) : (name || '?')[0].toUpperCase());
function paint(node, v, cents) {
  const str = money(v, cents), i = str.lastIndexOf('.');
  if (cents && i > 0 && node.classList.contains('hero-num')) node.replaceChildren(str.slice(0, i), h('span', { class: 'cents' }, str.slice(i)));
  else node.textContent = str;
}
function paceChart() {
  const t = todayISO(), d = new Date(t + 'T12:00'), y = d.getFullYear(), mo = d.getMonth(), today = d.getDate();
  const curDays = new Date(y, mo + 1, 0).getDate(), prevDays = new Date(y, mo, 0).getDate();
  const cur = monthKey(t), prev = lastMonths(2)[0];
  const running = (m, n) => { const a = Array(n).fill(0); for (const x of spending()) if (monthKey(x.date) === m) a[+x.date.slice(8) - 1] += x.amount; let s = 0; return a.map((v) => (s += v)); };
  const c = running(cur, curDays).slice(0, today), p = running(prev, prevDays);
  if (!p[p.length - 1]) return null;
  const W = 320, H = 86, n = Math.max(curDays, prevDays), max = Math.max(1, ...c, ...p);
  const xy = (v, i) => [((i / (n - 1)) * W).toFixed(1), (H - 4 - (Math.max(0, v) / max) * (H - 10)).toFixed(1)];
  const pts = (arr) => arr.map((v, i) => xy(v, i).join(',')).join(' ');
  const [ex, ey] = xy(c[c.length - 1], c.length - 1);
  const svg = h('svg', { class: 'chart pace', viewBox: `0 0 ${W} ${H}`, html:
    `<polyline points="${pts(p)}" fill="none" stroke="var(--dim)" stroke-width="2" stroke-dasharray="2 5" stroke-linecap="round"/>` +
    `<polyline class="stroke" pathLength="1" points="${pts(c)}" fill="none" stroke="var(--accent)" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${ex}" cy="${ey}" r="4" fill="var(--accent)"/>` });
  return { svg, diff: c[c.length - 1] - p[Math.min(today, prevDays) - 1] };
}
const logo = (t) => h('div', { class: 'logo' }, t.logo ? h('img', { src: t.logo, alt: '' }) : (t.name || '?')[0].toUpperCase());

// ---------- motion ----------
const shownVals = {};
function countUp(node, key, to, cents) {
  const from = key in shownVals ? shownVals[key] : 0; shownVals[key] = to;
  if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { paint(node, to, cents); return node; }
  const t0 = performance.now(), dur = 750;
  const step = (t) => {
    if (!node.isConnected && t - t0 > 50) return;
    const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    paint(node, from + (to - from) * e, cents);
    if (p < 1) requestAnimationFrame(step); else fitText();
  };
  paint(node, from, cents); requestAnimationFrame(step);
  return node;
}
const num = (cls, key, v, cents) => countUp(h('div', { class: cls + ' fit' }), key, v, cents);
function setGlow(dir) { document.body.style.setProperty('--glow', dir > 0 ? 'rgba(31,210,134,.16)' : dir < 0 ? 'rgba(255,90,95,.14)' : 'rgba(120,130,150,.08)'); }

// ---------- shared pieces ----------
const greeting = () => { const hr = new Date().getHours(); return hr < 5 ? 'Good evening' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'; };
const TITLES = { overview: 'Home', categories: 'Categories', merchants: 'Merchants', paidwith: 'Paid with', graphs: 'Graphs' };
const isDebt = (a) => a.type === 'credit' || a.type === 'loan';
const accLabel = (a) => a.name + (a.mask ? ' ••' + a.mask : '');
const shortDay = (d) => new Date(d + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const txnRow = (t) => h('div', { class: 'row tap', onclick: (e) => { e.stopPropagation(); pickCategory(t); } }, logo(t), h('div', { class: 'grow' }, h('div', { class: 'name' }, t.name),
  h('div', { class: 'sub' }, shortDay(t.date) + ' · ' + catName(t.category) + (t.pending ? ' · pending' : '') + (t.amount < 0 && isSpend(t) ? ' · refund' : ''),
    t.stmt && t.stmt !== 'pending' ? h('span', { class: 'stag ' + t.stmt.split(' ')[0] }, ' · ' + t.stmt) : null)),
  h('div', { class: 'amt ' + (t.amount < 0 ? 'pos' : 'neg') }, (t.amount < 0 ? '+' : '−') + money(Math.abs(t.amount), true)));
const CAT_LIST = ['FOOD_AND_DRINK', 'RENT_AND_UTILITIES', 'GENERAL_MERCHANDISE', 'TRANSPORTATION', 'TRAVEL', 'ENTERTAINMENT', 'PERSONAL_CARE', 'MEDICAL', 'GENERAL_SERVICES', 'HOME_IMPROVEMENT', 'GOVERNMENT_AND_NON_PROFIT', 'BANK_FEES', 'OTHER', 'LOAN_PAYMENTS', 'INCOME', 'TRANSFER_OUT', 'TRANSFER_IN'];
const catName = (c) => ({ TRANSFER_OUT: 'Transfer out', TRANSFER_IN: 'Transfer in', RENT_AND_UTILITIES: 'Rent & utilities', FOOD_AND_DRINK: 'Food & drink', GOVERNMENT_AND_NON_PROFIT: 'Government & nonprofit' }[c] || nice(c));
function pickCategory(t) {
  const orig = t.origCategory || t.category, ruled = !!cats.rules[t.name];
  let all = ruled;
  const close = () => { ov.classList.add('closing'); setTimeout(() => ov.remove(), 200); };
  const apply = (c) => {
    const tx = { ...cats.tx }, rules = { ...cats.rules };
    if (all) { delete tx[t.transaction_id]; if (c === orig) delete rules[t.name]; else rules[t.name] = c; for (const x of data.transactions) if (x.name === t.name) delete tx[x.transaction_id]; }
    else { if (c === (rules[t.name] || orig)) delete tx[t.transaction_id]; else tx[t.transaction_id] = c; }
    cats = { tx, rules }; store.set('cats', cats); close(); render(); renderPanel();
  };
  const body = () => [
    h('div', { class: 'pk-head' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, t.name), h('div', { class: 'sub' }, shortDay(t.date) + ' · ' + (t.amount < 0 ? '+' : '−') + money(Math.abs(t.amount), true))), h('button', { class: 'gbtn', onclick: close }, 'Done')),
    h('div', { class: 'pk-scope' }, h('button', { class: 'chip' + (!all ? ' on' : ''), onclick: () => { all = false; draw(); } }, 'Just this one'),
      h('button', { class: 'chip' + (all ? ' on' : ''), onclick: () => { all = true; draw(); } }, 'All from ' + t.name)),
    h('div', { class: 'pk-list' }, CAT_LIST.map((c) => h('button', { class: 'pk-cat' + (c === t.category ? ' on' : ''), onclick: () => apply(c) },
      catName(c), c === orig ? h('span', { class: 'muted' }, ' · bank\'s pick') : null, c === 'TRANSFER_IN' || c === 'INCOME' ? h('span', { class: 'muted' }, ' · not spending') : null))),
  ];
  const card = h('div', { class: 'pk-card' }), draw = () => card.replaceChildren(...body());
  const ov = h('div', { class: 'picker', onclick: (e) => { if (e.target === ov) close(); } }, card);
  draw(); document.body.append(ov); swipeClose(card, close);
}
// Pull a pop-up sheet down from its top to close it.
function swipeClose(card, close) {
  card.prepend(h('div', { class: 'pk-grab' }));
  let y0 = null, dy = 0;
  card.addEventListener('touchstart', (e) => { y0 = card.scrollTop <= 0 ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
  card.addEventListener('touchmove', (e) => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); card.style.transform = dy ? `translateY(${dy}px)` : ''; }, { passive: true });
  card.addEventListener('touchend', () => { if (y0 == null) return; y0 = null; if (dy > 90) close(); else card.style.transform = ''; });
}
const toggle = (k) => { open.has(k) ? open.delete(k) : open.add(k); render(); };
function loadingBanner() {
  const l = loadingConns().filter((c) => conn === 'all' || c.item_id === conn);
  return l.length ? h('div', { class: 'syncpill' }, h('div', { class: 'spinner' }), 'Syncing ' + l.map((c) => c.institution || 'bank').join(', ')) : null;
}
function whenText(iso) {
  const d = new Date(iso), now = new Date(), t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = (x) => x.toDateString(), y = new Date(now); y.setDate(now.getDate() - 1);
  if (day(d) === day(now)) return t;
  if (day(d) === day(y)) return 'yesterday ' + t;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + t;
}
function updatedLine() {
  const l = shownConns().filter((c) => c.updated);
  if (!l.length) return null;
  return h('div', { class: 'updated' }, l.map((c) => (l.length > 1 || conn === 'all' ? (c.institution || 'Bank') + ' updated ' : 'Updated ') + whenText(c.updated)).join(' · '));
}
function noData(el) {
  if (!data) { el.append(h('div', { class: 'empty' }, h('p', {}, 'Loading your cards…'))); return; }
  el.append(h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, '$'),
    h('button', { class: 'btn primary', onclick: () => connect() }, 'Connect an account')));
}

// ---------- Home ----------
function viewHome(el) {
  if (!data || !data.connections.length) { noData(el); return; }
  { const lb = loadingBanner(); if (lb) el.append(lb); }
  const cards = allAccounts(), ids = new Set(cards.map((a) => a.account_id)), owed = cards.reduce((s, a) => s + (a.balances.current || 0), 0);
  el.append(h('section', { class: 'hero-block tap', onclick: () => openSheet({ title: 'You owe', list: () => owedTxns(false).filter((t) => ids.has(t.account_id)) }) },
    h('div', { class: 'label' }, 'You owe'), num('hero-num', 'owe' + conn, owed, true),
    updatedLine()));
  const m = monthKey(todayISO()), spent = byMonth(spending())[m] || 0, recSpent = byMonth(spending().filter((t) => t.manual))[m] || 0;
  const lastM = lastMonths(2)[0], lastSpent = byMonth(spending())[lastM] || 0;
  const pace = paceChart();
  el.append(h('div', { class: 'card tap spendcard', onclick: () => openSheet({ title: 'Spent this month', graph: { type: 'spend', period: '1Y', by: 'month' }, list: () => spending().filter((t) => monthKey(t.date) === m), head: () => h('button', { class: 'btn small', onclick: () => { closePanel(true); showView('categories'); } }, 'By category') }) },
    h('div', { class: 'label' }, 'Spent this month'), num('big', 'spent' + conn, spent, true),
    recSpent ? h('div', { class: 'change muted' }, money(spent - recSpent, true) + ' on cards · ' + money(recSpent, true) + ' recurring') : null,
    pace ? h('div', { class: 'linewrap' }, pace.svg) : null,
    pace ? h('div', { class: 'pace-foot' },
      h('span', { class: pace.diff > 0 ? 'neg' : 'pos' }, `${money(Math.abs(pace.diff))} ${pace.diff > 0 ? 'more' : 'less'} than this time last month`),
      h('span', { class: 'pace-key' }, h('i', { class: 'k1' }), 'Now', h('i', { class: 'k2' }), 'Last')) : null));
  setGlow(pace ? -pace.diff : 0);
  const recs = recurring.filter((r) => r.amount > 0), counted = recs.filter((r) => r.count !== false);
  el.append(h('div', { class: 'card list tap', onclick: openRecurringList }, h('h2', {}, 'Recurring payments', h('span', {}, recs.length ? money(perMo(counted), true) + '/mo counted' : '')),
    recs.length ? recs.slice(0, 5).map((r) => recRow(r)) : h('div', { class: 'sub muted' }, 'Add rent, subscriptions or anything else you pay on a schedule.')));
}
const recRow = (r, extra) => { const k = r.category || 'OTHER', nx = nextDate(r);
  return h('div', { class: 'row' }, catBadge({ k, color: catColor(k) }),
    h('div', { class: 'grow' }, h('div', { class: 'name' }, r.name), h('div', { class: 'sub' }, everyName(r.every) + (nx ? ' · next ' + shortDay(nx) : ' · ended') + (r.count === false ? ' · not counted' : ''))),
    h('div', { class: 'amt' }, money(r.amount, true)), extra || null); };
function openRecurringList() {
  openSheet({ title: 'Recurring payments', render: (el) => {
    const counted = recurring.filter((r) => r.count !== false);
    if (recurring.length) el.append(h('div', { class: 'card' }, h('div', { class: 'label' }, 'Counted in spending'), h('div', { class: 'big' }, money(perMo(counted), true), h('small', { class: 'permo' }, '/mo')),
      h('div', { class: 'sub muted' }, `${counted.length} of ${recurring.length} counted · ${money(perMo(recurring), true)}/mo in all`)));
    if (recurring.length) el.append(h('div', { class: 'card list' }, recurring.map((r) => {
      const row = recRow(r, h('input', { type: 'checkbox', class: 'switch', 'aria-label': 'Count in spending', checked: r.count !== false ? true : null, onclick: (e) => e.stopPropagation(),
        onchange: (e) => saveRecurring(recurring.map((x) => (x.id === r.id ? { ...x, count: e.target.checked } : x))) }));
      row.classList.add('tap'); row.onclick = () => recurringForm(el, r); return row; })));
    else el.append(h('div', { class: 'empty small' }, 'Nothing added yet'));
    el.append(h('button', { class: 'btn primary', onclick: () => recurringForm(el) }, '+ Add recurring payment'));
    el.append(h('p', { class: 'muted', style: 'font-size:13px' }, 'Counted payments show up as Paid on each date they repeat, in Categories, Merchants, Paid with and Graphs. Turn the switch off to keep one listed without adding it to your totals.'));
  } });
}
function recurringForm(el, existing) {
  const r = existing ? { ...existing } : { id: Date.now().toString(36), name: '', amount: '', every: 'monthly', start: todayISO().slice(0, 8) + '01', end: '', category: 'RENT_AND_UTILITIES', count: true };
  const f = (label, key, type, extra = {}) => h('div', { class: 'field' }, h('label', {}, label), h('input', { type, value: r[key] ?? '', step: type === 'number' ? 'any' : null, inputmode: type === 'number' ? 'decimal' : null,
    oninput: (e) => { r[key] = type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value; }, ...extra }));
  const chips = (opts, key) => { const box = h('div', { class: 'presets wrap' }), draw = () => box.replaceChildren(...opts.map(([v, l]) => h('button', { class: 'chip' + (r[key] === v ? ' on' : ''), onclick: () => { r[key] = v; draw(); } }, l))); draw(); return box; };
  el.replaceChildren(h('div', { class: 'card' }, h('h2', {}, existing ? 'Edit recurring payment' : 'Add a recurring payment'),
    f('Name', 'name', 'text', { placeholder: 'Rent' }), f('Amount', 'amount', 'number', { placeholder: '0.00' }),
    h('div', { class: 'label' }, 'Repeats'), chips(EVERY, 'every'),
    f('First payment', 'start', 'date'), f('Last payment (optional)', 'end', 'date'),
    h('div', { class: 'label' }, 'Category'), chips(CAT_LIST.map((c) => [c, catName(c)]), 'category'),
    h('label', { class: 'row tap' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, 'Count in spending'), h('div', { class: 'sub' }, 'Adds it to your totals and graphs')),
      h('input', { type: 'checkbox', class: 'switch', checked: r.count !== false ? true : null, onchange: (e) => { r.count = e.target.checked; } })),
    h('button', { class: 'btn primary', onclick: () => {
      r.name = String(r.name || '').trim();
      if (!r.name || !(r.amount > 0) || !r.start) return toast('Add a name, an amount and a first payment date.');
      if (r.end && r.end < r.start) r.end = '';
      saveRecurring(recurring.some((x) => x.id === r.id) ? recurring.map((x) => (x.id === r.id ? r : x)) : recurring.concat(r));
    } }, 'Save'),
    existing ? h('button', { class: 'btn danger', onclick: () => saveRecurring(recurring.filter((x) => x.id !== r.id)) }, 'Delete') : null,
    h('button', { class: 'btn', onclick: renderPanel }, 'Cancel')));
}

// ---------- date range (spending tabs) ----------
const thisMonthRange = () => ({ from: todayISO().slice(0, 8) + '01', to: todayISO() });
function rangePresets() {
  const t = todayISO(), d = new Date(t + 'T12:00');
  const lastStart = isoOf(new Date(d.getFullYear(), d.getMonth() - 1, 1)), lastEnd = isoOf(new Date(d.getFullYear(), d.getMonth(), 0));
  const first = txns().reduce((m, x) => (x.date < m ? x.date : m), t);
  return [['This month', thisMonthRange()], ['Last month', { from: lastStart, to: lastEnd }],
    ['30D', { from: shiftDays(t, -29), to: t }], ['3M', { from: shiftDays(t, -89), to: t }],
    ['YTD', { from: t.slice(0, 4) + '-01-01', to: t }], ['All', { from: first, to: t }]];
}
const fmtShort = (iso) => new Date(iso + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: iso.slice(0, 4) === todayISO().slice(0, 4) ? undefined : 'numeric' });
const presetOf = (r) => rangePresets().find(([, x]) => x.from === r.from && x.to === r.to);
const rangeLabel = (r) => { const p = presetOf(r); return p ? p[0] : fmtShort(r.from) + ' – ' + (r.live ? 'Now' : fmtShort(r.to)); };
// End-date picker: "Now" keeps the range running through today; a picked date stays fixed.
function pickEnd(to, live, onPick) {
  const close = () => { ov.classList.add('closing'); setTimeout(() => ov.remove(), 200); };
  const done = (d, l) => { close(); onPick(d, l); };
  const input = h('input', { type: 'date', value: to, max: todayISO(), onchange: (e) => e.target.value && done(e.target.value, false) });
  const card = h('div', { class: 'pk-card' },
    h('div', { class: 'pk-head' }, h('div', { class: 'grow name' }, 'End date'), h('button', { class: 'gbtn', onclick: close }, 'Done')),
    h('div', { class: 'pk-list' },
      h('button', { class: 'pk-cat' + (live ? ' on' : ''), onclick: () => done(todayISO(), true) }, 'Now', h('span', { class: 'muted' }, ' · always runs through today')),
      h('div', { class: 'pk-cat' + (!live ? ' on' : '') }, 'A specific date', h('div', { class: 'field' }, input))));
  const ov = h('div', { class: 'picker', onclick: (e) => { if (e.target === ov) close(); } }, card);
  document.body.append(ov); swipeClose(card, close);
}
const endText = (to, live) => (live ? 'Now' : fullDay(to));
function rangeBar(rerender) {
  const set = (r, live = r.to === todayISO()) => { if (r.from > r.to) r = { from: r.to, to: r.from }; range = { ...range, from: r.from, to: r.to, live }; open.clear(); rerender(); };
  const date = (key) => key === 'to'
    ? h('button', { type: 'button', class: 'dfield dend', onclick: () => pickEnd(range.to, range.live, (d, l) => set({ from: range.from, to: d }, l)) }, h('span', {}, 'To'), h('b', {}, endText(range.to, range.live)))
    : h('label', { class: 'dfield' }, h('span', {}, 'From'),
      h('input', { type: 'date', value: range.from, max: todayISO(), onchange: (e) => e.target.value && set({ from: e.target.value, to: range.to }, range.live) }));
  return h('div', { class: 'rangebar' },
    h('div', { class: 'presets' }, rangePresets().map(([label, r]) =>
      h('button', { class: 'chip' + (r.from === range.from && r.to === range.to ? ' on' : ''), onclick: () => set(r) }, label))),
    h('div', { class: 'range' }, date('from'), date('to')));
}
// Spending tabs can switch to the charges behind what's owed on cards now (same list as the You owe tile).

// Charges behind each card's current balance: newest posted charges and refunds until they add up to what's owed.
const CARD_PAYMENT = new Set(['LOAN_PAYMENTS', 'TRANSFER_IN']);
function owedTxns(withPending) {
  const out = [];
  for (const a of allAccounts().filter((x) => x.type === 'credit')) {
    const mine = allTxns().filter((t) => t.account_id === a.account_id);
    let left = a.balances.current || 0;
    for (const t of mine.filter((t) => !t.pending && !(t.amount < 0 && CARD_PAYMENT.has(t.category))).sort((x, y) => (x.date < y.date ? 1 : -1))) {
      if (left <= 0.005) break;
      out.push(t.amount > left ? { ...t, amount: Math.round(left * 100) / 100 } : t); left -= t.amount;
    }
    if (withPending) out.push(...mine.filter((t) => t.pending));
  }
  return out;
}

// Paid / unpaid card spending plus recurring payments you entered, each tagged paid / unpaid / recurring.
const txKey = (t) => t.transaction_id || t.id || [t.account_id, t.date, t.name, t.amount].join('|');
const cardIds = () => new Set(allAccounts().filter((a) => a.type === 'credit').map((a) => a.account_id));
const SHOWS = [['paid', 'Paid'], ['unpaid', 'Unpaid'], ['recurring', 'Recurring']];
const normShow = (x) => { if (!x) return { paid: true, unpaid: true, recurring: true }; const n = { paid: !!x.paid, unpaid: !!x.unpaid, recurring: x.recurring !== false }; if (!n.paid && !n.unpaid && !n.recurring) n.paid = n.unpaid = true; return n; };
const allShown = (s) => s.paid && s.unpaid && s.recurring;
const showHeading = (s) => (allShown(s) ? 'Spent' : s.paid && s.unpaid && !s.recurring ? 'Spent on cards' : SHOWS.filter(([k]) => s[k]).map(([k, l]) => (k === 'unpaid' && !s.paid ? 'Owed' : l)).join(' + '));
const showOf = () => normShow(range.show || store.get('show', null));
function toggleBar(rerender) {
  const s = showOf();
  const flip = (k) => { const n = { ...s, [k]: !s[k] }; if (!n.paid && !n.unpaid && !n.recurring) return; range = { ...range, show: n }; store.set('show', n); open.clear(); rerender(); };
  return h('div', { class: 'modebar' }, h('div', { class: 'seg small toggles' },
    SHOWS.map(([k, l]) => h('button', { class: s[k] ? 'on ' + k : '', onclick: () => flip(k) }, l))));
}
// Paid and unpaid parts of card spending in the range, plus recurring. Without Paid, unpaid is exactly what's owed on cards, any date.
function shownTxns(s, r) {
  const cards = cardIds(), dated = s.paid, out = [];
  const inR = (t) => t.date >= r.from && t.date <= r.to;
  if (s.recurring) for (const t of spending()) if (t.manual && inR(t)) out.push({ ...t, recPart: t.amount, stmt: 'recurring' });
  if (s.paid || s.unpaid) {
    const unpaid = new Map(owedTxns(false).map((t) => [txKey(t), t.amount]));
    for (const t of dated ? spending().filter((t) => !t.manual && inR(t)) : owedTxns(false)) {
      const u = !dated ? t.amount : cards.has(t.account_id) ? unpaid.get(txKey(t)) || 0 : 0;
      const paidPart = s.paid ? t.amount - u : 0, unpaidPart = s.unpaid ? u : 0;
      if (Math.abs(paidPart + unpaidPart) < 0.005) continue;
      const stmt = !dated || !cards.has(t.account_id) || t.amount <= 0 ? '' : Math.abs(u) < 0.005 ? 'paid' : Math.abs(u - t.amount) < 0.005 ? 'unpaid' : 'partly paid';
      out.push({ ...t, amount: Math.round((paidPart + unpaidPart) * 100) / 100, paidPart, unpaidPart, stmt });
    }
  }
  return out;
}
function statusSplit(list, s) {
  const sum = (f) => list.reduce((n, t) => n + f(t), 0);
  const parts = [['paid', 'paid', 'Paid', sum((t) => t.paidPart || 0)], ['unpaid', 'posted', 'Unpaid', sum((t) => t.unpaidPart || 0)], ['recurring', 'rec', 'Recurring', sum((t) => t.recPart || 0)]].filter((p) => s[p[0]]);
  return h('div', { class: 'split stmt-split' },
    h('div', { class: 'splitbar' }, parts.map(([, cls, , v]) => h('i', { class: cls, style: `flex:${Math.max(v, 0.01)}` }))),
    h('div', { class: 'splitlegend' }, parts.map(([, cls, label, v]) => h('div', {}, h('span', { class: 'sw ' + cls }), h('div', {}, h('b', {}, money(v, true)), h('small', {}, label))))));
}

// ---------- Breakdowns (categories / merchants / paid with) ----------
function breakdown(el, keyOf, labelOf, layout, icon) {
  if (!data || !data.connections.length) return noData(el);
  { const lb = loadingBanner(); if (lb) el.append(lb); }
  range = range || { ...thisMonthRange(), live: true };
  if (range.live && range.to !== todayISO()) range = { ...range, to: todayISO() };
  const s = showOf(), plain = allShown(s), on = SHOWS.filter(([k]) => s[k]).length;
  const heading = showHeading(s);
  const list = spending(), inR = (t, r) => t.date >= r.from && t.date <= r.to;
  const inRange = shownTxns(s, range), total = inRange.reduce((s, t) => s + t.amount, 0);
  const days = daysBetween(range.from, range.to) + 1;
  const prevTotal = !plain ? 0 : list.filter((t) => inR(t, { from: shiftDays(range.from, -days), to: shiftDays(range.from, -1) })).reduce((s, t) => s + t.amount, 0);
  const diff = prevTotal ? ((total - prevTotal) / prevTotal) * 100 : null;
  setGlow(diff == null ? 0 : -diff);
  el.append(toggleBar(render));
  if (s.paid || s.recurring) el.append(rangeBar(render));
  const groups = {};
  for (const t of inRange) (groups[keyOf(t)] = groups[keyOf(t)] || []).push(t);
  const sorted = Object.entries(groups).map(([k, l]) => ({ k, l, v: l.reduce((s, t) => s + t.amount, 0) })).filter((g) => Math.abs(g.v) > 0.005).sort((a, b) => b.v - a.v);
  sorted.forEach((g, i) => (g.color = PALETTE[Math.min(i, PALETTE.length - 1)]));
  const diffEl = diff == null ? null : h('div', { class: 'change ' + (diff > 0 ? 'neg' : 'pos') }, `${diff > 0 ? '▲' : '▼'} ${Math.abs(diff).toFixed(0)}%`);
  if (layout === 'donut') {
    const top = sorted.slice(0, 7), rest = sorted.slice(7);
    const segs = top.map((g) => ({ v: g.v, color: g.color, on: open.has(g.k) }));
    if (rest.length) segs.push({ v: rest.reduce((s, g) => s + g.v, 0), color: PALETTE[8] });
    el.append(h('div', { class: 'card hero-card' }, donut(segs, [h('div', { class: 'label' }, heading), num('donut-num', 'tot' + view + conn, total), diffEl],
      (i) => top[i] && toggle(top[i].k))));
  } else {
    el.append(h('section', { class: 'hero-block' }, h('div', { class: 'label' }, heading), num('hero-num', 'tot' + view + conn, total, true), diffEl));
  }
  if (on > 1) el.append(h('div', { class: 'card stmt-card' }, statusSplit(inRange, s)));
  if (!sorted.length) { el.append(h('div', { class: 'empty small' }, s.paid || s.recurring ? 'Nothing spent in this range' : 'Nothing owed on your cards')); return; }
  const max = sorted[0].v || 1;
  if (layout === 'cards') {
    const grid = h('div', { class: 'cardgrid' });
    sorted.forEach((g, i) => grid.append(h('div', { class: 'ccard' + (open.has(g.k) ? ' on' : ''), style: `--c1:${g.color};--c2:${PALETTE[(i + 3) % 8]}`, onclick: () => toggle(g.k) },
      h('div', { class: 'ccard-name' }, labelOf(g.k)), h('div', { class: 'ccard-amt' }, money(g.v)))));
    el.append(grid);
    const opened = sorted.filter((g) => open.has(g.k));
    for (const g of opened) el.append(h('div', { class: 'card' }, h('h2', {}, labelOf(g.k)), sortBar(render), sortTx(g.l).map(txnRow)));
    return;
  }
  const card = h('div', { class: 'card list' });
  for (const g of sorted) {
    const isOpen = open.has(g.k);
    card.append(h('div', { class: 'row tap' + (isOpen ? ' open' : ''), onclick: () => toggle(g.k) },
      icon(g), h('div', { class: 'grow' }, h('div', { class: 'name' }, labelOf(g.k)),
        h('div', { class: 'bar' }, h('i', { style: `width:${Math.max(2, (g.v / max) * 100)}%;background:${g.color}` }))),
      h('div', { class: 'amt' }, money(g.v, true))));
    if (isOpen) card.append(h('div', { class: 'drill' }, sortBar(render), sortTx(g.l).map(txnRow)));
  }
  el.append(card);
}
const catBadge = (g) => h('div', { class: 'cat', style: `background:${g.color}22;color:${g.color}` }, nice(g.k)[0]);
function viewCategories(el) { breakdown(el, (t) => t.category || 'OTHER', (k) => catName(k), 'donut', catBadge); }
function viewMerchants(el) {
  breakdown(el, (t) => t.name || 'Unknown', (k) => k, 'rows', (g) => logo(g.l[0]));
  const subs = data && data.connections.length ? subscriptions() : [];
  if (subs.length) el.append(h('div', { class: 'card list tap', onclick: openRecurring }, h('h2', {}, 'Recurring', h('span', {}, money(subs.reduce((t, x) => t + x.monthly, 0), true) + '/mo')),
    subs.slice(0, 5).map((x) => h('div', { class: 'row' }, logo(x), h('div', { class: 'grow' }, h('div', { class: 'name' }, x.name), h('div', { class: 'sub' }, x.every)), h('div', { class: 'amt' }, money(x.amount, true))))));
}
function viewPaidWith(el) {
  const accs = Object.fromEntries(allAccounts().map((a) => [a.account_id, a]));
  breakdown(el, (t) => t.account_id, (k) => (accs[k] ? accLabel(accs[k]) : k === 'manual' ? 'Recurring payments' : 'Other'), 'cards', null);
}

// ---------- graphs ----------
const GTYPES = [['spend', 'Spending']];
const ago = (n) => ({ from: shiftDays(todayISO(), -n + 1), to: todayISO() });
const GPERIODS = [
  ['month', 'This month', thisMonthRangeG], ['lastmonth', 'Last month', () => { const f = shiftDays(todayISO().slice(0, 8) + '01', -1).slice(0, 8) + '01'; return { from: f, to: shiftDays(todayISO().slice(0, 8) + '01', -1) }; }],
  ['ytd', 'This year', () => ({ from: todayISO().slice(0, 4) + '-01-01', to: todayISO() })],
  ['3M', '3M', () => ago(92)], ['6M', '6M', () => ago(183)], ['1Y', '1Y', () => ago(365)], ['2Y', '2Y', () => ago(730)],
  ['all', 'All', () => ({ from: txns().reduce((m, t) => (t.date < m ? t.date : m), todayISO()), to: todayISO() })]];
function thisMonthRangeG() { return { from: todayISO().slice(0, 8) + '01', to: todayISO() }; }
const GBY = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];
const DEFAULT_GRAPHS = [{ type: 'spend' }, { type: 'spend', cat: 'FOOD_AND_DRINK' }, { type: 'spend', cat: 'GENERAL_MERCHANDISE' }, { type: 'spend', cat: 'TRANSPORTATION' }];
function loadGraphs() { const saved = store.get('graphs', null); return saved ? saved.filter((g) => g.type === 'spend') : DEFAULT_GRAPHS.map((g, i) => ({ id: 'd' + i, period: '1Y', by: 'month', ...g })); }
let graphs = loadGraphs();
const saveGraphs = () => store.set('graphs', graphs);
const everyAccount = () => cardConns().flatMap((c) => (c.accounts || []).filter(isCard).map((a) => ({ ...a, institution: c.institution, brand: c.brand })));
const weekStart = (iso) => { const d = new Date(iso + 'T12:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoOf(d); };
const bucketOf = (by, iso) => (by === 'month' ? monthKey(iso) : by === 'week' ? weekStart(iso) : iso);
const bucketEnd = (by, k, to = todayISO()) => {
  const e = by === 'month' ? shiftDays(shiftDays(k + '-01', 32).slice(0, 8) + '01', -1) : by === 'week' ? shiftDays(k, 6) : k;
  return e > to ? to : e;
};
const bucketLabel = (by, k) => (by === 'month' ? monthName(k) : shortDay(k));
const meanOf = (v) => v.reduce((t, y) => t + y, 0) / (v.length || 1);
const catColor = (k) => PALETTE[[...(k || '')].reduce((s, c) => s + c.charCodeAt(0), 0) % 8];
function gRange(g) {
  if (g.period === 'Custom' && g.from) return { from: g.from, to: !g.toNow && g.to && g.to < todayISO() ? g.to : todayISO() };
  return (GPERIODS.find((p) => p[0] === g.period) || GPERIODS[5])[2]();
}
const periodLabel = (g) => (g.period === 'Custom' && g.from ? `${shortDay(gRange(g).from)} – ${g.toNow ? 'Now' : shortDay(gRange(g).to)}` : (GPERIODS.find((p) => p[0] === g.period) || [, g.period])[1]);
function bucketKeys(g) {
  const { from, to } = gRange(g), span = daysBetween(from, to);
  const make = (by) => { const keys = []; for (let d = from; d <= to; d = shiftDays(d, 1)) { const k = bucketOf(by, d); if (keys[keys.length - 1] !== k) keys.push(k); } return keys; };
  let by = g.by === 'day' && span > 183 ? 'week' : g.by || 'month', keys = make(by);
  if (keys.length < 3 && by === 'month') keys = make((by = span > 45 ? 'week' : 'day'));
  if (keys.length < 3 && by === 'week') keys = make((by = 'day'));
  return { keys, by, from, to };
}
const gCats = (g) => g.cats || (g.cat ? [g.cat] : []);
const gMerch = (g) => g.merchants || (g.merchant ? [g.merchant] : []);
function series(g) {
  const { keys, by, from, to } = bucketKeys(g), idx = new Map(keys.map((k, i) => [k, i]));
  const ids = g.accts && g.accts.length ? new Set(g.accts) : null;
  const sumBy = (list, sign) => {
    const v = keys.map(() => 0);
    for (const t of list) { if ((ids && !ids.has(t.account_id)) || t.date < from || t.date > to) continue; const i = idx.get(bucketOf(by, t.date)); if (i != null) v[i] += sign * t.amount; }
    return v;
  };
  const base = { keys, by, from, to, kind: 'bars' };
  const cs = new Set(gCats(g)), ms = new Set(gMerch(g)), any = !cs.size && !ms.size;
  const c = cs.size === 1 && !ms.size ? catColor([...cs][0]) : '#ff5a5f';
  return { ...base, sets: [{ c, v: sumBy(shownTxns(gShow(g), { from, to }).filter((t) => any || cs.has(t.category) || ms.has(t.name)), 1) }] };
}
const gShow = (g) => normShow(g.show);
const gShowLabel = (g) => { const s = gShow(g); return allShown(s) ? '' : showHeading(s); };
function gTitle(g) {
  if (g.title) return g.title;
  const accs = (g.accts || []).map((id) => everyAccount().find((a) => a.account_id === id)).filter(Boolean);
  const an = accs.length === 1 ? accs[0].name : accs.length ? accs.length + ' accounts' : '';
  const items = [...gCats(g).map(catName), ...gMerch(g)];
  const base = g.type === 'spend' ? (!items.length ? 'Spending' : items.slice(0, 2).join(' + ') + (items.length > 2 ? ` +${items.length - 2}` : '')) : (GTYPES.find((t) => t[0] === g.type) || [, ''])[1];
  return [base, an, gShowLabel(g)].filter(Boolean).join(' · ');
}
function linesChart(s, onScrub) {
  const W = 340, H = 130, n = s.keys.length, max = Math.max(1, ...s.sets.flatMap((x) => x.v)) * 1.08;
  const X = (i) => (n < 2 ? W / 2 : (i / (n - 1)) * W), Y = (v) => H - 6 - (Math.max(0, v) / max) * (H - 14);
  const curve = (v) => v.map((y, i) => {
    if (!i) return `M0 ${Y(y).toFixed(1)}`;
    const x0 = X(i - 1), x1 = X(i), cx = (x0 + x1) / 2;
    return `C${cx.toFixed(1)} ${Y(v[i - 1]).toFixed(1)} ${cx.toFixed(1)} ${Y(y).toFixed(1)} ${x1.toFixed(1)} ${Y(y).toFixed(1)}`;
  }).join(' ');
  const id = 'g' + Math.random().toString(36).slice(2, 7), single = s.sets.length === 1;
  const ticks = s.keys.map((k, i) => ((n - 1 - i) % Math.ceil(n / 6) === 0 ? `<text x="${Math.min(W - 12, Math.max(12, X(i))).toFixed(1)}" y="${H + 13}" font-size="10" text-anchor="middle" fill="var(--dim)">${bucketLabel(s.by, k)}</text>` : '')).join('');
  const svg = h('svg', { class: 'chart', viewBox: `0 0 ${W} ${H + 16}`, html:
    s.sets.map((x, j) => `<linearGradient id="${id}${j}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${x.c}" stop-opacity="${single ? 0.32 : 0.14}"/><stop offset="1" stop-color="${x.c}" stop-opacity="0"/></linearGradient>`).join('') +
    s.sets.map((x, j) => { const d = curve(x.v); return `<path class="area" d="${d} L ${W} ${H} L 0 ${H} Z" fill="url(#${id}${j})"/><path class="stroke" pathLength="1" d="${d}" fill="none" stroke="${x.c}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`; }).join('') + ticks });
  const pos = (i, x) => `left:${(X(i) / W) * 100}%;top:${(Y(x.v[i]) / (H + 16)) * 100}%;--c:${x.c}`;
  const last = n - 1, cursor = h('i', { class: 'cursor', hidden: true });
  const dots = s.sets.map((x) => h('i', { class: 'pulse', style: pos(last, x) }));
  const wrap = h('div', { class: 'linewrap glines' }, svg, cursor, ...dots);
  const move = (e) => {
    const r = wrap.getBoundingClientRect(), i = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * last);
    cursor.hidden = false; cursor.style.left = (X(i) / W) * 100 + '%';
    dots.forEach((d, j) => { d.setAttribute('style', pos(i, s.sets[j])); d.classList.add('still'); });
    onScrub({ i, label: bucketLabel(s.by, s.keys[i]) + (s.by === 'month' ? ' ' + s.keys[i].slice(0, 4) : '') });
  };
  const end = () => { cursor.hidden = true; dots.forEach((d, j) => { d.setAttribute('style', pos(last, s.sets[j])); d.classList.remove('still'); }); onScrub(null); };
  wrap.addEventListener('pointerdown', move); wrap.addEventListener('pointermove', (e) => { if (e.buttons) move(e); });
  holdUntilTapOutside(wrap, end);
  return wrap;
}
function graphCard(g, opts = {}) {
  const s = series(g), first = s.sets[0].v, big = h('div', { class: 'big fit' }), sub = h('div', { class: 'gsub muted' });
  const per = { month: 'mo', week: 'wk', day: 'day' }[s.by];
  const lbl = (i) => (s.by === 'month' ? monthName(s.keys[i], true) : s.by === 'week' ? 'Week of ' + shortDay(s.keys[i]) : dayName(s.keys[i]));
  const range = `${fullDay(s.from)} – ${fullDay(s.to)}`, unit = (u) => h('span', { class: 'unit' }, u);
  const show = (sc) => {
    big.className = 'big fit';
    if (s.kind === 'line') {
      const pts = first.filter((v) => v != null);
      big.replaceChildren(!pts.length ? '—' : money(sc ? sc.v : meanOf(pts), true));
      sub.textContent = sc ? sc.label : pts.length ? 'Average · ' + range : 'Not enough history yet';
      return;
    }
    const v = (x) => (sc ? x.v[sc.i] : meanOf(x.v)), u = sc ? '' : unit('/' + per);
    if (s.sets.length > 1) big.replaceChildren(h('span', { class: 'pos' }, '+' + money(v(s.sets[0]))), h('span', { class: 'gslash' }, ' / '), h('span', { class: 'neg' }, '−' + money(v(s.sets[1]))), u);
    else big.replaceChildren(money(v(s.sets[0]), true), u);
    sub.textContent = sc ? lbl(sc.i) : `Average per ${({ mo: 'month', wk: 'week', day: 'day' })[per]} · ${range}`;
  };
  show(null);
  const chart = s.kind === 'line'
    ? lineChart(s.keys.map((k, i) => ({ v: first[i], date: bucketEnd(s.by, k, s.to) })).filter((p) => p.v != null), (p) => show(p ? { v: p.v, label: dayName(p.date) } : null))
    : linesChart(s, show);
  return h('div', { class: 'card graph' + (opts.flat ? ' flat' : '') },
    h('div', { class: 'ghead' }, h('div', { class: 'gtitle' }, gTitle(g)),
      opts.edit ? h('button', { class: 'gbtn', 'aria-label': 'Edit graph', onclick: opts.edit }, '•••') : null,
      opts.save ? h('button', { class: 'gbtn', onclick: (e) => { graphs.push({ ...g, id: Date.now().toString(36) }); saveGraphs(); e.target.textContent = 'Added'; e.target.disabled = true; } }, '+ Graphs') : null),
    big, sub, chart || h('div', { class: 'empty small' }, 'Not enough history yet'),
    s.sets.length > 1 ? h('div', { class: 'legend' }, s.sets.map((x) => h('span', {}, h('i', { style: `background:${x.c}` }), x.l))) : null,
    opts.edit ? h('div', { class: 'gper' }, [...GPERIODS.map(([p, l]) => [p, l]), ['Custom', 'Custom']].map(([p, pl]) => h('button', { class: 'chip' + (g.period === p ? ' on' : ''),
      onclick: () => { if (p === 'Custom') return opts.edit('Custom'); g.period = p; saveGraphs(); render(); } }, p === 'Custom' && g.period === 'Custom' ? periodLabel(g) : pl))) : null);
}
function viewGraphs(el) {
  if (!data || !data.connections.length) return noData(el);
  { const lb = loadingBanner(); if (lb) el.append(lb); }
  for (const g of graphs) el.append(graphCard(g, { edit: (p) => openGraphEditor(g, p) }));
  el.append(h('button', { class: 'btn', onclick: () => openGraphEditor(null) }, '+ Add graph'));
}
function openGraphEditor(orig, preset) {
  const f = orig ? { ...orig, accts: [...(orig.accts || [])], cats: [...gCats(orig)], merchants: [...gMerch(orig)] } : { type: 'spend', period: '1Y', by: 'month', accts: [], cats: [], merchants: [] };
  delete f.cat; delete f.merchant;
  if (preset === 'Custom') { f.period = 'Custom'; if (!f.from) { f.from = shiftDays(todayISO(), -364); f.to = todayISO(); f.toNow = true; } }
  const chips = (opts, key, cond) => h('div', { class: 'presets wrap' }, opts.filter(cond || (() => true)).map(([v, l]) =>
    h('button', { class: 'chip' + (f[key] === v ? ' on' : ''), onclick: () => { f[key] = v; if (v === 'Custom' && !f.from) { f.from = shiftDays(todayISO(), -364); f.to = todayISO(); f.toNow = true; } renderPanel(); } }, l)));
  openSheet({ title: orig ? 'Edit graph' : 'New graph', render: (el) => {
    const prev = h('div', {}, graphCard(f, { flat: true })), refresh = () => prev.replaceChildren(graphCard(f, { flat: true }));
    el.append(prev);
    el.append(h('div', { class: 'card' }, h('div', { class: 'field' }, h('label', {}, 'Name'),
      h('input', { type: 'text', value: f.title || '', placeholder: gTitle({ ...f, title: '' }), oninput: (e) => { f.title = e.target.value.trim() || undefined; refresh(); } }))));
    { const sh = gShow(f);
      el.append(h('div', { class: 'card' }, h('div', { class: 'label' }, 'Include'), h('div', { class: 'presets wrap' }, SHOWS.map(([k, l]) =>
        h('button', { class: 'chip' + (sh[k] ? ' on' : ''), onclick: () => { const n = { ...sh, [k]: !sh[k] }; if (n.paid || n.unpaid || n.recurring) { f.show = n; renderPanel(); } } }, l))))); }
    if (f.type === 'spend') {
      const tot = {}; for (const t of spending()) if (t.amount > 0) { tot['c' + t.category] = (tot['c' + t.category] || 0) + t.amount; tot['m' + t.name] = (tot['m' + t.name] || 0) + t.amount; }
      const top = (p) => Object.keys(tot).filter((k) => k[0] === p).sort((a, b) => tot[b] - tot[a]).map((k) => k.slice(1));
      const opts = [...top('c').map((k) => ['cats', k]), ...top('m').map((k) => ['merchants', k])];
      const on = ([key, k]) => f[key].includes(k), list = h('div', {}), q = { v: '' };
      const label = () => { const n = f.cats.length + f.merchants.length; return n ? `Includes ${n} · added together` : 'Includes · all spending'; };
      const head = h('div', { class: 'label' }, label());
      const row = (o) => { const [key, k] = o, tx = key === 'merchants' && spending().find((t) => t.name === k);
        return h('label', { class: 'row tap' }, tx ? logo(tx) : catBadge({ k, color: catColor(k) }),
          h('div', { class: 'grow' }, h('div', { class: 'name' }, key === 'cats' ? catName(k) : k), h('div', { class: 'sub' }, (key === 'cats' ? 'Category · ' : '') + money(tot[(key === 'cats' ? 'c' : 'm') + k] || 0) + ' all time')),
          h('input', { type: 'checkbox', class: 'switch', checked: on(o) ? true : null, onchange: (e) => {
            f[key] = e.target.checked ? [...f[key], k] : f[key].filter((x) => x !== k); head.textContent = label(); refresh(); } })); };
      const draw = () => {
        const s2 = q.v.toLowerCase(), hits = s2 ? opts.filter(([key, k]) => (key === 'cats' ? catName(k) : k).toLowerCase().includes(s2)).slice(0, 40)
          : [...opts.filter(on), ...opts.filter((o) => !on(o) && o[0] === 'cats'), ...opts.filter((o) => !on(o) && o[0] === 'merchants').slice(0, 12)];
        list.replaceChildren(...(hits.length ? hits.map(row) : [h('div', { class: 'empty small' }, 'No matches')]));
      };
      draw();
      el.append(h('div', { class: 'card' }, head, h('div', { class: 'field' },
        h('input', { type: 'search', placeholder: 'Search merchants or categories', oninput: (e) => { q.v = e.target.value; draw(); } })), list));
    }
    if (everyAccount().length > 1) {
      const accs = everyAccount();
      el.append(h('div', { class: 'card' }, h('div', { class: 'label' }, f.accts.length ? 'Cards' : 'Cards · all'),
        accs.map((a) => h('label', { class: 'row tap' }, mark(a.brand, a.institution), h('div', { class: 'grow' }, h('div', { class: 'name' }, a.name, h('span', { class: 'mask' }, ' ' + (a.mask || ''))), h('div', { class: 'sub' }, a.institution || '')),
          h('input', { type: 'checkbox', class: 'switch', checked: f.accts.includes(a.account_id) ? true : null,
            onchange: (e) => { f.accts = e.target.checked ? [...f.accts, a.account_id] : f.accts.filter((x) => x !== a.account_id); renderPanel(); } })))));
    }
    el.append(h('div', { class: 'card' }, h('div', { class: 'label' }, 'Period'), chips([...GPERIODS.map(([p, l]) => [p, l]), ['Custom', 'Custom']], 'period'),
      f.period === 'Custom' ? h('div', { class: 'gdates' }, ['from', 'to'].map((key) => h('div', { class: 'field' }, h('label', {}, key === 'from' ? 'From' : 'To'),
        key === 'to'
          ? h('button', { type: 'button', class: 'dend-g', onclick: () => pickEnd(f.to, f.toNow, (d, l) => { f.to = d; f.toNow = l; if (f.from > f.to) [f.from, f.to] = [f.to, f.from]; renderPanel(); }) }, endText(f.toNow ? todayISO() : f.to, f.toNow))
          : h('input', { type: 'date', value: f.from, max: todayISO(), onchange: (e) => { if (e.target.value) { f.from = e.target.value; if (f.from > f.to) [f.from, f.to] = [f.to, f.from]; renderPanel(); } } })))) : null,
      h('div', { class: 'label', style: 'margin-top:12px' }, 'Group by'), chips(GBY, 'by', ([v]) => v !== 'day' || daysBetween(gRange(f).from, gRange(f).to) <= 183)));
    const i = orig ? graphs.indexOf(orig) : -1;
    const done = () => { if (f.type !== 'spend') { delete f.cats; delete f.merchants; } if (i >= 0) graphs[i] = f; else graphs.push({ ...f, id: Date.now().toString(36) }); saveGraphs(); closePanel(); render(); };
    const move = (d) => { const j = i + d; if (j < 0 || j >= graphs.length) return; graphs.splice(i, 1); graphs.splice(j, 0, f); saveGraphs(); closePanel(); render(); };
    el.append(h('button', { class: 'btn primary', onclick: done }, orig ? 'Save' : 'Add graph'));
    if (i >= 0) el.append(h('div', { class: 'gmoves' }, h('button', { class: 'btn', disabled: i === 0 ? true : null, onclick: () => move(-1) }, 'Move up'),
      h('button', { class: 'btn', disabled: i === graphs.length - 1 ? true : null, onclick: () => move(1) }, 'Move down')),
      h('button', { class: 'btn danger', onclick: () => { graphs.splice(i, 1); saveGraphs(); closePanel(); render(); } }, 'Remove graph'));
  } });
}

// ---------- transaction sheet ----------
let sheet = null, sheetLimit = 150, txSort = store.get('sort', 'time');
const SORTS = [['time', 'Newest'], ['high', 'Price ↓'], ['low', 'Price ↑']];
const sortTx = (l) => l.slice().sort(txSort === 'high' ? (a, b) => Math.abs(b.amount) - Math.abs(a.amount) : txSort === 'low' ? (a, b) => Math.abs(a.amount) - Math.abs(b.amount) : (a, b) => (a.date < b.date ? 1 : -1));
const sortBar = (redraw) => h('div', { class: 'sortbar' }, h('span', {}, 'Sort'), SORTS.map(([v, l]) =>
  h('button', { class: 'chip' + (txSort === v ? ' on' : ''), onclick: (e) => { e.stopPropagation(); txSort = v; store.set('sort', v); redraw(); } }, l)));
function openSheet(sh) { sheet = sh; sheetLimit = 150; openPanel('txns'); }
function viewSheet(el) {
  if (!sheet) return;
  if (sheet.render) return sheet.render(el);
  const head = sheet.head && sheet.head();
  if (head) el.append(head.classList.contains('card') || head.classList.contains('btn') ? head : h('div', { class: 'card' }, head));
  if (sheet.graph) el.append(graphCard(sheet.graph, { save: true }));
  const list = sheet.list().slice().sort((a, b) => (a.pending !== b.pending ? (a.pending ? -1 : 1) : a.date < b.date ? 1 : -1));
  if (!list.length) return el.append(h('div', { class: 'empty small' }, 'No transactions yet'));
  el.append(sortBar(renderPanel));
  if (txSort !== 'time') {
    el.append(h('div', { class: 'card list' }, sortTx(list).slice(0, sheetLimit).map(txnRow)));
    if (list.length > sheetLimit) el.append(h('button', { class: 'btn', onclick: () => { sheetLimit += 300; renderPanel(); } }, `Show more (${list.length - sheetLimit})`));
    return;
  }
  const months = {};
  for (const t of list) if (!t.pending && t.amount > 0) months[monthKey(t.date)] = (months[monthKey(t.date)] || 0) + t.amount;
  let card = null, cur = null;
  for (const t of list.slice(0, sheetLimit)) {
    const k = t.pending ? 'pending' : monthKey(t.date);
    if (k !== cur) {
      cur = k; card = h('div', { class: 'card list' }, h('h2', {}, k === 'pending' ? 'Pending' : monthName(k, true), k === 'pending' ? null : h('span', {}, money(months[k] || 0, true) + ' out')));
      el.append(card);
    }
    card.append(txnRow(t));
  }
  if (list.length > sheetLimit) el.append(h('button', { class: 'btn', onclick: () => { sheetLimit += 300; renderPanel(); } }, `Show more (${list.length - sheetLimit})`));
}
function openRecurring() {
  openSheet({ title: 'Recurring', render: (el) => {
    const subs = subscriptions();
    if (!subs.length) return el.append(h('div', { class: 'empty small' }, 'No recurring charges found yet'));
    el.append(h('div', { class: 'card' }, h('div', { class: 'label' }, 'About'), h('div', { class: 'big' }, money(subs.reduce((t, x) => t + x.monthly, 0), true), h('small', { class: 'permo' }, '/mo')),
      h('div', { class: 'sub muted' }, money(subs.reduce((t, x) => t + x.monthly, 0) * 12) + ' a year · ' + subs.length + ' subscriptions')));
    const card = h('div', { class: 'card list' });
    for (const x of subs) {
      const k = 'r:' + x.name, isOpen = open.has(k);
      card.append(h('div', { class: 'row tap' + (isOpen ? ' open' : ''), onclick: () => { isOpen ? open.delete(k) : open.add(k); renderPanel(); } },
        logo(x), h('div', { class: 'grow' }, h('div', { class: 'name' }, x.name), h('div', { class: 'sub' }, `${x.every} · next ~${shortDay(x.next)}`)),
        h('div', { class: 'amt' }, money(x.amount, true)), h('span', { class: 'chev' }, '›')));
      if (isOpen) card.append(h('div', { class: 'drill' }, x.history.map(txnRow)));
    }
    el.append(card);
  } });
}

// ---------- panels: settings ----------
let panel = null;
function openPanel(name) { panel = name; $('panel').hidden = false; $('panel').classList.remove('closing'); renderPanel(); }
function closePanel(instant) {
  if (!panel) return; panel = null;
  if (instant) { $('panel').hidden = true; return; }
  $('panel').classList.add('closing');
  setTimeout(() => { if (!panel) $('panel').hidden = true; }, 220);
}
function renderPanel() {
  if (!panel) return;
  const el = $('panel-body'); el.replaceChildren();
  $('panel-title').textContent = panel === 'txns' ? sheet.title : 'Settings';
  $('panel-back').onclick = () => closePanel();
  (panel === 'txns' ? viewSheet : viewSettings)(el);
}
function viewSettings(el) {
  el.append(h('button', { class: 'btn primary', onclick: () => connect() }, '+ Connect an account'));
  const conns = data ? data.connections : [];
  if (conns.length) el.append(h('div', { class: 'card' }, h('h2', {}, `Connections · ${conns.length} of 10`), conns.map((c) =>
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, c.institution || 'Bank'),
      h('div', { class: 'sub' }, (c.accounts || []).length + ' accounts' + (c.updated ? ' · updated ' + whenText(c.updated) : '')), c.error ? h('div', { class: 'warn' }, nice(c.error)) : null),
      c.error ? h('button', { class: 'btn small', onclick: () => connect(c.item_id) }, 'Fix') : null,
      h('button', { class: 'btn small danger', onclick: async () => {
        if (!confirm(`Disconnect ${c.institution || 'this bank'}? This doesn’t free up one of your 10 Plaid slots.`)) return;
        busy('Removing…');
        try { gotData(await api('/remove', { item_id: c.item_id })); renderPanel(); } catch (e) { toast(e.message); } finally { busy(null); }
      } }, 'Remove')))));
  el.append(h('button', { class: 'btn', onclick: openRecurringList }, 'Recurring payments ›'));
  el.append(h('p', { class: 'muted', style: 'font-size:13px' }, 'Pulls the latest every time you open the app. Banks themselves update about 1–4 times a day.'));
  el.append(h('button', { class: 'btn danger', onclick: () => { closePanel(true); logout(); } }, 'Lock'));
}

// ---------- layout ----------
const VIEWS = { overview: viewHome, categories: viewCategories, merchants: viewMerchants, paidwith: viewPaidWith, graphs: viewGraphs };
function renderChips() {
  const box = $('conns'), conns = cardConns();
  box.hidden = conns.length < 2;
  const opts = [['all', 'All']].concat(conns.map((c) => [c.item_id, c.institution || 'Bank']));
  const key = opts.map((o) => o.join(':')).join('|') + '#' + conn + conns.map((c) => !!(c.brand && c.brand.logo)).join('');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(...opts.map(([id, label]) => { const c = conns.find((x) => x.item_id === id);
    return h('button', { class: 'chip' + (id === conn ? ' on' : '') + (c ? ' withmark' : ''), onclick: () => pickConn(id) }, c ? mark(c.brand, label) : null, label); }));
  const on = box.querySelector('.on');
  if (on) box.scrollTo({ left: on.offsetLeft - box.clientWidth / 2 + on.offsetWidth / 2, behavior: 'smooth' });
}
function pickConn(id, dir) {
  if (id === conn) return;
  const ids = ['all'].concat(cardConns().map((c) => c.item_id));
  dir = dir || (ids.indexOf(id) > ids.indexOf(conn) ? 'l' : 'r');
  conn = connBy[view] = id; store.set('connBy', connBy); open.clear(); render('slide-' + dir);
}
function render(anim) {
  renderChips();
  $('title').textContent = view === 'overview' ? greeting() : TITLES[view];
  const el = $('view'); el.replaceChildren();
  VIEWS[view](el);
  fitText();
  if (anim) [...el.children].forEach((c, i) => { c.classList.add('rise'); c.style.animationDelay = Math.min(i, 8) * 45 + 'ms'; });
  if (anim) { el.classList.remove('slide-l', 'slide-r', 'fade'); void el.offsetWidth; el.classList.add(anim); }
  renderPanel();
}
// Big numbers shrink to fit their box instead of running off the screen.
function fitText() {
  requestAnimationFrame(() => {
    for (const n of document.querySelectorAll('.fit')) {
      n.style.fontSize = '';
      let size = parseFloat(getComputedStyle(n).fontSize);
      while (n.scrollWidth > n.clientWidth && size > 14) n.style.fontSize = (size -= 1) + 'px';
    }
  });
}
addEventListener('resize', fitText);
// iOS home-screen apps can start with a too-short viewport until the page scrolls once.
function nudgeViewport() {
  for (const t of [50, 300, 900]) setTimeout(() => { const y = scrollY; scrollTo(0, y + 2); requestAnimationFrame(() => scrollTo(0, y)); }, t);
}
function setTab() { for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.view === view); }
function showView(name) {
  if (name === view) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  view = name; conn = connBy[name] || 'all'; month = null; open.clear(); setTab(); window.scrollTo(0, 0); render('fade');
}
// Long swipe that starts at the screen edge moves between connections.
let touch = null;
$('view').addEventListener('touchstart', (e) => {
  const x = e.touches[0].clientX, edge = x < 24 ? 'l' : x > innerWidth - 24 ? 'r' : null;
  touch = !edge || e.target.closest('.agrid-wrap.editing, .editing') ? null : { x, y: e.touches[0].clientY, edge };
}, { passive: true });
$('view').addEventListener('touchend', (e) => {
  if (!touch || cardConns().length < 2) return;
  const touch0 = touch, dx = e.changedTouches[0].clientX - touch.x, dy = e.changedTouches[0].clientY - touch.y; touch = null;
  if (Math.abs(dx) < innerWidth * 0.4 || Math.abs(dx) < Math.abs(dy) * 1.5 || (touch0.edge === 'l') !== dx > 0) return;
  const ids = ['all'].concat(cardConns().map((c) => c.item_id)), i = ids.indexOf(conn) + (dx < 0 ? 1 : -1);
  if (i >= 0 && i < ids.length) pickConn(ids[i], dx < 0 ? 'l' : 'r');
}, { passive: true });

// ---------- login ----------
function logout() { store.del('pass'); store.del('data'); data = null; showLogin(); }
function showLogin() { $('main').hidden = true; $('tabbar').hidden = true; $('login').hidden = false; $('login-url').value = store.get('server', DEFAULT_SERVER); }
function showApp() { $('login').hidden = true; $('main').hidden = false; $('tabbar').hidden = false; view = 'overview'; conn = connBy.overview || 'all'; setTab(); render('fade'); nudgeViewport(); }
$('login-btn').addEventListener('click', async () => {
  store.set('server', $('login-url').value.trim()); store.set('pass', $('login-pass').value);
  $('login-err').textContent = '';
  try { await api('/login', {}); $('login-pass').value = ''; showApp(); refresh(false); pullSettings(); }
  catch (e) { store.del('pass'); $('login-err').textContent = e.message === 'Wrong password' ? 'Wrong password.' : 'Couldn’t reach the server.'; showLogin(); }
});
$('login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login-btn').click(); });
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showView(t.dataset.view));
$('sync-btn').addEventListener('click', () => refresh(true));
$('gear-btn').addEventListener('click', () => openPanel('settings'));
// Every open (or return to the app) pulls fresh data.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !store.get('pass', '')) return;
  if (Date.now() - lastSync > 30000) { refresh(false); pullSettings(); }
  if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) navigator.serviceWorker.getRegistration().then((r) => r && r.update());
});

if (store.get('pass', '')) {
  showApp();
  // Back from a bank's OAuth page: finish the same Link session.
  const pending = store.get('linkToken', null);
  if (pending && location.search.includes('oauth_state_id')) openLink(pending, location.href);
  refresh(false); pullSettings();
} else showLogin();
if ('serviceWorker' in navigator) {
  // A new version takes over as soon as it's downloaded, so opening the app always shows the latest.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !panel && $('overlay').hidden) location.reload(); });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
}

// Swipe from the left edge to go back, like iOS.
{
  const P = $('panel'); let sw = null;
  const reset = () => { P.style.transition = ''; P.style.transform = ''; P.style.boxShadow = ''; };
  P.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    sw = panel && t.clientX < 28 ? { x: t.clientX, y: t.clientY, t: Date.now(), dx: 0, on: false } : null;
  }, { passive: true });
  P.addEventListener('touchmove', (e) => {
    if (!sw) return;
    const t = e.touches[0], dx = t.clientX - sw.x, dy = t.clientY - sw.y;
    if (!sw.on) { if (Math.abs(dy) > 10 && Math.abs(dy) > dx) { sw = null; return; } if (dx < 8) return; sw.on = true; P.style.transition = 'none'; P.style.boxShadow = '-12px 0 30px rgba(0,0,0,.5)'; }
    e.preventDefault(); sw.dx = Math.max(0, dx); P.style.transform = `translateX(${sw.dx}px)`;
  }, { passive: false });
  const end = () => {
    if (!sw || !sw.on) { sw = null; return; }
    const go = sw.dx > innerWidth * 0.4;
    P.style.transition = 'transform .2s cubic-bezier(.2,.8,.2,1)'; P.style.transform = go ? 'translateX(100%)' : '';
    sw = null;
    setTimeout(() => { if (!go) return reset(); if (panel === 'loans') { reset(); openPanel('settings'); } else { closePanel(true); reset(); } }, 200);
  };
  P.addEventListener('touchend', end); P.addEventListener('touchcancel', end);
}
