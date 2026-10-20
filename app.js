'use strict';
// Finances: talks only to the password-protected Worker; Plaid keys never reach the phone.

const DEFAULT_SERVER = 'https://finances.vishalg.workers.dev';
const store = {
  get: (k, d) => { try { const v = localStorage.getItem('fin.' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set: (k, v) => { try { localStorage.setItem('fin.' + k, JSON.stringify(v)); } catch (_) {} },
  del: (k) => localStorage.removeItem('fin.' + k),
};

let data = store.get('data', null);
let loans = store.get('loans', []);
let view = 'overview';
let conn = store.get('conn', 'all');
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
function gotData(d) {
  data = d; store.set('data', d);
  if (conn !== 'all' && !d.connections.some((c) => c.item_id === conn)) conn = 'all';
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
        closePanel(true); conn = d.added_item || 'all'; store.set('conn', conn); view = 'overview';
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
const shownConns = () => (data ? data.connections.filter((c) => conn === 'all' || c.item_id === conn) : []);
const allAccounts = () => shownConns().flatMap((c) => (c.accounts || []).map((a) => ({ ...a, institution: c.institution, brand: c.brand })));
const NOT_SPENDING = new Set(['INCOME', 'TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS']);
const allTxns = () => (data ? data.transactions : []);
const txns = () => { if (conn === 'all') return allTxns(); const ids = new Set(allAccounts().map((a) => a.account_id)); return allTxns().filter((t) => ids.has(t.account_id)); };
// Finalized charges only; a refund cancels its matching charge, and partial refunds net against the merchant.
let spendCache = { key: null, list: [] };
function spending() {
  const all = txns(), key = (data && data.synced) + '|' + conn + '|' + all.length;
  if (spendCache.key === key) return spendCache.list;
  const list = all.filter((t) => !t.pending && !NOT_SPENDING.has(t.category) && t.category !== 'INCOME');
  const charges = list.filter((t) => t.amount > 0), refunds = list.filter((t) => t.amount < 0), drop = new Set();
  const names = new Set(charges.map((t) => t.name));
  for (const r of refunds.sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const c = charges.find((x) => !drop.has(x.id) && x.name === r.name && Math.abs(x.amount + r.amount) < 0.01 && x.date <= r.date && daysBetween(x.date, r.date) <= 120);
    if (c) { drop.add(c.id); drop.add(r.id); }
  }
  spendCache = { key, list: list.filter((t) => !drop.has(t.id) && (t.amount > 0 || names.has(t.name))) };
  return spendCache.list;
}
const income = () => txns().filter((t) => t.amount < 0 && t.category === 'INCOME');

function totals() {
  let cash = 0, invest = 0, credit = 0, loan = 0;
  for (const a of allAccounts()) {
    const b = a.balances.current || 0;
    if (a.type === 'depository') cash += b; else if (a.type === 'investment' || a.type === 'brokerage') invest += b;
    else if (a.type === 'credit') credit += b; else if (a.type === 'loan') loan += b; else cash += b;
  }
  const manual = conn === 'all' ? loans.reduce((s, l) => s + loanStatus(l).balance, 0) : 0;
  return { cash, invest, credit, loan: loan + manual, net: cash + invest - credit - loan - manual };
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
  for (const t of spending().filter((x) => x.amount > 0)) (groups[t.name] = groups[t.name] || []).push(t);
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

// ---------- manual loans (e.g. Aidvantage) ----------
const loanPayments = (l) => {
  const words = l.match.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  return allTxns().filter((t) => t.amount > 0 && t.date > l.asOf && words.some((w) => (t.raw + ' ' + t.name).toLowerCase().includes(w)))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
};
const daysBetween = (a, b) => Math.max(0, Math.round((new Date(b + 'T12:00') - new Date(a + 'T12:00')) / 864e5));
// Federal loans accrue simple daily interest; payments go to interest first, then principal.
function loanStatus(l) {
  let bal = l.balance, interest = 0, last = l.asOf, paid = 0;
  const pays = loanPayments(l);
  for (const p of pays) {
    interest += bal * (l.rate / 100 / 365) * daysBetween(last, p.date);
    const toInterest = Math.min(interest, p.amount);
    interest -= toInterest; bal = Math.max(0, bal - (p.amount - toInterest));
    paid += p.amount; last = p.date;
  }
  interest += bal * (l.rate / 100 / 365) * daysBetween(last, todayISO());
  return { balance: bal + interest, pays, paid };
}
function payoff(balance, rate, payment) {
  const r = rate / 100 / 12;
  if (payment <= balance * r) return null;
  let months = 0, totalInterest = 0;
  while (balance > 0 && months < 600) { const i = balance * r; totalInterest += i; balance = balance + i - payment; months++; }
  const d = new Date(); d.setMonth(d.getMonth() + months);
  return { months, date: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }), interest: totalInterest };
}

// ---------- charts ----------
const avgLine = (y, W, c) => `<line class="avg" x1="0" x2="${W}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${c}" stroke-width="1.3" stroke-dasharray="3 4" stroke-opacity=".8"/>`;
const PALETTE = ['#1fd286', '#4f8cff', '#ffb547', '#ff6b8b', '#a37bff', '#2fd0d6', '#ff8a4c', '#c3d84a', '#6b7280'];
function lineChart(points, onScrub, avg) {
  if (points.length < 2) return null;
  const W = 340, H = 140, vals = points.map((p) => p.v), lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const X = (i) => (i / (points.length - 1)) * W, Y = (v) => H - 12 - ((v - lo) / span) * (H - 24);
  const d = points.map((p, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.v).toFixed(1)).join(' ');
  const up = vals[vals.length - 1] >= vals[0], col = up ? '#1fd286' : '#ff5a5f', id = 'g' + Math.random().toString(36).slice(2, 7);
  const svg = h('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, html:
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".3"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>` +
    `<path class="area" d="${d} L ${W} ${H} L 0 ${H} Z" fill="url(#${id})"/>` +
    `<path class="stroke" pathLength="1" d="${d}" fill="none" stroke="${col}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>` +
    (avg ? avgLine(Y(vals.reduce((t, v) => t + v, 0) / vals.length), W, '#9aa0a6') : '') });
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
  wrap.addEventListener('pointerdown', move); wrap.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') move(e); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) wrap.addEventListener(ev, end);
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
const TITLES = { overview: 'Overview', categories: 'Categories', merchants: 'Merchants', paidwith: 'Paid with', graphs: 'Graphs' };
let mainIds = store.get('main', null);
const isMain = (a) => (mainIds ? mainIds.includes(a.account_id) : a.subtype === 'checking');
const isDebt = (a) => a.type === 'credit' || a.type === 'loan';
const accLabel = (a) => a.name + (a.mask ? ' ••' + a.mask : '');
const shortDay = (d) => new Date(d + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const txnRow = (t) => h('div', { class: 'row' }, logo(t), h('div', { class: 'grow' }, h('div', { class: 'name' }, t.name),
  h('div', { class: 'sub' }, shortDay(t.date) + (t.pending ? ' · pending' : '') + (t.amount < 0 && t.category !== 'INCOME' && !NOT_SPENDING.has(t.category) ? ' · refund' : ''))),
  h('div', { class: 'amt ' + (t.amount < 0 ? 'pos' : 'neg') }, (t.amount < 0 ? '+' : '−') + money(Math.abs(t.amount), true)));
const toggle = (k) => { open.has(k) ? open.delete(k) : open.add(k); render(); };
function loadingBanner() {
  const l = loadingConns().filter((c) => conn === 'all' || c.item_id === conn);
  return l.length ? h('div', { class: 'syncpill' }, h('div', { class: 'spinner' }), 'Syncing ' + l.map((c) => c.institution || 'bank').join(', ')) : null;
}
function noData(el) {
  el.append(h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, '$'),
    h('button', { class: 'btn primary', onclick: () => connect() }, 'Connect an account')));
}

// ---------- Overview ----------
const PERIODS = [['1W', 7], ['1M', 30], ['3M', 90], ['1Y', 365], ['All', 0]];
let histDays = store.get('histDays', 30);
function viewOverview(el) {
  if (!data || !data.connections.length) { noData(el); if (!loans.length) return; }
  { const lb = loadingBanner(); if (lb) el.append(lb); }
  const accs = allAccounts(), have = accs.filter((a) => !isDebt(a)), owe = accs.filter(isDebt);
  const sum = (l) => l.reduce((s, a) => s + (a.balances.current || 0), 0);
  const manual = conn === 'all' ? loans.map((l) => ({ l, bal: loanStatus(l).balance })) : [];
  const oweTotal = sum(owe) + manual.reduce((s, m) => s + m.bal, 0), net = sum(have) - oweTotal;
  const full = conn === 'all' && data ? data.history.map((p) => ({ v: p.assets - p.debts, date: p.date })) : [];
  if (full.length) full[full.length - 1] = { ...full[full.length - 1], v: net };
  const cut = histDays ? shiftDays(todayISO(), -histDays) : '';
  const hist = full.filter((p) => p.date >= cut);
  const delta = hist.length > 1 ? net - hist[0].v : null;
  setGlow(delta == null ? 0 : delta);
  const heroNum = num('hero-num', 'net' + conn, net, true);
  const change = h('div', { class: 'change' });
  const showChange = () => {
    change.className = 'change ' + (delta == null ? 'muted' : delta >= 0 ? 'pos' : 'neg');
    change.textContent = delta == null ? (conn === 'all' ? 'Net worth' : (shownConns()[0] || {}).institution || '') :
      `${delta >= 0 ? '▲' : '▼'} ${money(Math.abs(delta), true)} · ${PERIODS.find((p) => p[1] === histDays)[0]}`;
  };
  showChange();
  const chart = lineChart(hist, (p) => {
    if (p) { paint(heroNum, p.v, true); change.className = 'change muted'; change.textContent = dayName(p.date); }
    else { paint(heroNum, net, true); showChange(); }
  });
  el.append(h('section', { class: 'hero-block' }, heroNum, change, chart,
    full.length > 2 ? h('div', { class: 'periods' }, PERIODS.map(([label, n]) => h('button', { class: 'period' + (n === histDays ? ' on' : ''),
      onclick: () => { histDays = n; store.set('histDays', n); render(); } }, label))) : null));
  const pendingFor = (a) => allTxns().filter((t) => t.pending && t.account_id === a.account_id).sort((x, y) => (x.date < y.date ? 1 : -1));
  const pendSum = (a) => pendingFor(a).reduce((s, t) => s + t.amount, 0);
  const owePend = owe.filter((a) => a.type === 'credit').reduce((s, a) => s + pendSum(a), 0);
  el.append(h('div', { class: 'tiles' },
    h('div', { class: 'tile tap', onclick: () => { const ids = have.filter(isMain).map((a) => a.account_id); openSheet({ title: have.filter(isMain).every((a) => a.subtype === 'checking') ? 'Checking' : 'Main accounts', graph: { type: 'balance', accts: ids, period: '6M', by: 'week' }, list: () => allTxns().filter((t) => ids.includes(t.account_id)), head: () => h('button', { class: 'btn small', onclick: () => openPanel('settings') }, 'Choose accounts') }); } }, h('div', { class: 'label' }, h('span', { class: 'dot', style: 'background:var(--good)' }),
        have.filter(isMain).every((a) => a.subtype === 'checking') ? 'Checking' : 'Main'),
      num('tile-num', 'chk' + conn, sum(have.filter(isMain)))),
    h('div', { class: 'tile tap', onclick: () => { const cards = owe.filter((a) => a.type === 'credit'), ids = cards.map((a) => a.account_id); openSheet({ title: 'Credit cards', graph: { type: 'balance', accts: ids, period: '6M', by: 'week', title: 'Credit card balance' }, list: () => allTxns().filter((t) => ids.includes(t.account_id)), head: () => split(sum(cards), owePend) }); } }, h('div', { class: 'label' }, h('span', { class: 'dot', style: 'background:var(--bad)' }), 'You owe'),
      num('tile-num', 'owe' + conn, sum(owe.filter((a) => a.type === 'credit'))), owePend ? h('div', { class: 'tile-pend' }, '+' + money(owePend, true) + ' pending') : null)));
  const m = monthKey(todayISO()), spent = byMonth(spending())[m] || 0;
  const lastM = lastMonths(2)[0], lastSpent = byMonth(spending())[lastM] || 0;
  const pace = paceChart();
  el.append(h('div', { class: 'card tap spendcard', onclick: () => openSheet({ title: 'Spent this month', graph: { type: 'spend', period: '1Y', by: 'month' }, list: () => spending().filter((t) => monthKey(t.date) === m), head: () => h('button', { class: 'btn small', onclick: () => { closePanel(true); showView('categories'); } }, 'By category') }) },
    h('div', { class: 'label' }, 'Spent this month'), num('big', 'spent' + conn, spent, true),
    pace ? h('div', { class: 'linewrap' }, pace.svg) : null,
    pace ? h('div', { class: 'pace-foot' },
      h('span', { class: pace.diff > 0 ? 'neg' : 'pos' }, `${money(Math.abs(pace.diff))} ${pace.diff > 0 ? 'more' : 'less'} than this time last month`),
      h('span', { class: 'pace-key' }, h('i', { class: 'k1' }), 'Now', h('i', { class: 'k2' }), 'Last')) : null));
  const split = (posted, p) => h('div', { class: 'split' },
    h('div', { class: 'splitbar' }, h('i', { class: 'posted', style: `flex:${Math.max(posted, 0.01)}` }), h('i', { class: 'pending', style: `flex:${Math.max(p, 0.01)}` })),
    h('div', { class: 'splitlegend' },
      h('div', {}, h('span', { class: 'sw posted' }), h('div', {}, h('b', {}, money(posted, true)), h('small', {}, 'Owed'))),
      h('div', {}, h('span', { class: 'sw pending' }), h('div', {}, h('b', {}, money(p, true)), h('small', {}, 'Pending'))),
      h('div', {}, h('div', {}, h('b', {}, money(posted + p, true)), h('small', {}, 'With pending')))));
  // Vaults (e.g. SoFi) come through as "cash management" accounts next to an empty parent savings account.
  const vaultBanks = new Set(accs.filter((a) => a.subtype === 'savings').map((a) => a.institution));
  const isVault = (a) => a.subtype === 'cash management' && vaultBanks.has(a.institution);
  const hasVaults = new Set(accs.filter(isVault).map((a) => a.institution));
  const emptyParent = (a) => a.subtype === 'savings' && hasVaults.has(a.institution) && !a.balances.current;
  const alloc = [['Checking', (a) => a.subtype === 'checking', 'var(--good)'], ['Savings', (a) => a.subtype === 'savings' || isVault(a), '#4f8cff'],
    ['Investments', (a) => a.type === 'investment' || a.type === 'brokerage', '#a37bff']]
    .map(([l, f, c]) => ({ l, c, v: sum(have.filter(f)) })).filter((x) => x.v > 0);
  const allocTotal = alloc.reduce((s, x) => s + x.v, 0);
  if (alloc.length > 1) el.append(h('div', { class: 'card alloc tap', onclick: () => { const ids = have.map((a) => a.account_id); openSheet({ title: 'Money you have', graph: { type: 'balance', accts: ids, period: '1Y', by: 'week' }, list: () => allTxns().filter((t) => ids.includes(t.account_id)) }); } },
    h('div', { class: 'allocbar' }, alloc.map((x) => h('i', { style: `flex:${x.v};background:${x.c}` }))),
    h('div', { class: 'allockey' }, alloc.map((x) => h('span', {}, h('i', { style: `background:${x.c}` }), x.l, h('b', {}, Math.round((x.v / allocTotal) * 100) + '%'))))));
  if (accs.length || manual.length) el.append(accountGrid(accs.filter((a) => !emptyParent(a)), manual, pendingFor, split));
}


// ---------- account boxes (Overview) ----------
let layout = store.get('layout', { order: [], size: {}, groups: {} });
let editing = false, picked = new Set(), dragId = null;
const saveLayout = () => store.set('layout', layout);
const SIZES = [[1, 1], [2, 1], [1, 2], [2, 2]];
const typeRank = (a) => (a.subtype === 'checking' ? 0 : ['savings', 'cash management'].includes(a.subtype) ? 1 : ['investment', 'brokerage'].includes(a.type) ? 2 : a.type === 'credit' ? 3 : a.type === 'loan' ? 4 : 5);
function accountGrid(accs, manual, pendingFor, split) {
  const items = {};
  for (const a of accs) items[a.account_id] = { id: a.account_id, a, name: a.name, value: a.balances.current || 0, debt: isDebt(a), rank: typeRank(a),
    pend: a.type === 'credit' ? pendingFor(a).reduce((s, t) => s + t.amount, 0) : 0, mark: mark(a.brand, a.institution), sub: (a.mask ? '••' + a.mask : '') };
  for (const { l, bal } of manual) items['loan:' + l.id] = { id: 'loan:' + l.id, loan: l, name: l.name, value: bal, debt: true, rank: 4, pend: 0, mark: mark(null, l.name), sub: 'estimated' };
  const subs = subscriptions();
  if (subs.length) items.recurring = { id: 'recurring', special: true, name: 'Recurring', value: subs.reduce((t, x) => t + x.monthly, 0), pend: 0, rank: 6, perMo: true,
    mark: h('div', { class: 'bank', style: 'background:#a37bff' }, h('svg', { viewBox: '0 0 24 24', html: '<path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' })), sub: subs.length + ' subscriptions', subs };
  const inGroup = new Set(Object.values(layout.groups).flatMap((g) => g.members));
  for (const id of Object.keys(items).sort((x, y) => items[x].rank - items[y].rank)) if (!layout.order.includes(id)) layout.order.push(id);
  for (const [gid, g] of Object.entries(layout.groups)) {
    const ms = g.members.map((m) => items[m]).filter(Boolean);
    if (!ms.length) continue;
    const net = ms.reduce((s, m) => s + (m.debt ? -m.value : m.value), 0);
    items['g:' + gid] = { id: 'g:' + gid, gid, group: g, members: ms, name: g.name, value: Math.abs(net), debt: net < 0, pend: ms.reduce((s, m) => s + m.pend, 0),
      mark: h('div', { class: 'stack' }, ms.slice(0, 3).map((m) => m.mark.cloneNode(true))), sub: ms.length + ' accounts' };
  }
  saveLayout();
  const tiles = () => layout.order.filter((id) => items[id] && !inGroup.has(id));
  const wrap = h('div', { class: 'agrid-wrap' });
  const recent = (ids, n) => allTxns().filter((t) => ids.includes(t.account_id)).sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, n);
  const idsOf = (t) => (t.members ? t.members.map((m) => m.id) : [t.id]);
  const extra = (t) => t.members
    ? h('div', { class: 'mini' }, t.members.slice(0, 4).map((m) => h('div', {}, h('span', {}, m.name), h('b', { class: m.debt ? 'neg' : '' }, money(m.value)))))
    : t.subs ? h('div', { class: 'mini' }, t.subs.slice(0, 4).map((x) => h('div', {}, h('span', {}, x.name), h('b', {}, money(x.amount)))))
    : t.loan ? null : h('div', { class: 'mini' }, recent([t.id], 3).map((x) => h('div', {}, h('span', {}, x.name), h('b', { class: x.amount < 0 ? 'pos' : 'neg' }, (x.amount < 0 ? '+' : '−') + money(Math.abs(x.amount))))));
  const tileEl = (t) => {
    const [w, hh] = layout.size[t.id] || [1, 1];
    const onclick = () => {
      if (editing) { picked.has(t.id) ? picked.delete(t.id) : picked.add(t.id); draw(); return; }
      if (t.loan) return openPanel('loans');
      if (t.subs) return openRecurring();
      openSheet({ title: t.name, graph: { type: 'balance', accts: idsOf(t), period: '6M', by: 'week', title: t.name }, list: () => recent(idsOf(t), 1e9),
        head: () => t.members ? h('div', { class: 'card list' }, t.members.map((m) => h('div', { class: 'row' }, m.mark.cloneNode(true), h('div', { class: 'grow' }, h('div', { class: 'name' }, m.name)), h('div', { class: 'amt' + (m.debt ? ' neg' : '') }, money(m.value, true)))))
          : t.a && t.a.type === 'credit' && t.pend ? split(t.value, t.pend) : null });
    };
    return h('div', { class: 'atile' + (editing ? ' editing' : '') + (picked.has(t.id) ? ' picked' : '') + (dragId === t.id ? ' dragging' : '') + (t.members ? ' group' : ''),
      'data-id': t.id, style: `grid-column:span ${w};grid-row:span ${hh}`, onclick },
      h('div', { class: 'atile-top' }, t.mark, h('div', { class: 'atile-name' }, t.name)),
      h('div', { class: 'atile-amt fit' + (t.debt ? ' neg' : '') + (w === 2 ? ' wide' : '') }, money(t.value, w === 2 && !t.perMo), t.perMo ? h('small', { class: 'permo' }, '/mo') : null),
      t.pend ? h('div', { class: 'pend-amt' }, '+' + money(t.pend, true) + ' pending') : h('div', { class: 'atile-sub' }, t.sub),
      hh === 2 ? extra(t) : null,
      editing ? h('button', { class: 'tbtn size', 'aria-label': 'Resize', onclick: (e) => { e.stopPropagation(); const i = SIZES.findIndex(([a, b]) => a === w && b === hh); layout.size[t.id] = SIZES[(i + 1) % SIZES.length]; saveLayout(); draw(); } },
        h('svg', { viewBox: '0 0 24 24', html: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' })) : null,
      editing ? h('div', { class: 'tbtn handle', 'aria-label': 'Move', onpointerdown: (e) => startDrag(e, t.id) }, h('svg', { viewBox: '0 0 24 24', html: '<g fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></g>' })) : null);
  };
  const startDrag = (e, id) => {
    e.preventDefault(); e.stopPropagation(); dragId = id;
    const tile = e.currentTarget.closest('.atile'), grid = tile.parentNode;
    tile.classList.add('dragging');
    const move = (ev) => {
      if (ev.clientY < 110) scrollBy(0, -12); else if (ev.clientY > innerHeight - 140) scrollBy(0, 12);
      const under = document.elementFromPoint(ev.clientX, ev.clientY), tgt = under && under.closest('.atile');
      if (!tgt || tgt === tile || tgt.parentNode !== grid) return;
      const kids = [...grid.children], after = kids.indexOf(tile) < kids.indexOf(tgt);
      grid.insertBefore(tile, after ? tgt.nextSibling : tgt);
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      const shown = [...grid.children].map((n) => n.dataset.id), slots = layout.order.map((x, i) => (shown.includes(x) ? i : -1)).filter((i) => i >= 0);
      slots.forEach((slot, k) => { layout.order[slot] = shown[k]; });
      dragId = null; saveLayout(); draw();
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  };
  const groupPicked = () => {
    const sel = [...picked].map((id) => items[id]).filter((t) => t && !t.special), name = prompt('Name this group', sel.find((t) => t.group)?.name || 'Group');
    if (name == null) return;
    const members = [...new Set(sel.flatMap((t) => (t.members ? t.members.map((m) => m.id) : [t.id])))];
    for (const t of sel) if (t.gid) delete layout.groups[t.gid];
    const gid = Date.now().toString(36), at = Math.min(...sel.map((t) => layout.order.indexOf(t.id)).filter((i) => i >= 0));
    layout.groups[gid] = { name: name.trim() || 'Group', members }; layout.order.splice(at, 0, 'g:' + gid); layout.size['g:' + gid] = [2, 1];
    picked.clear(); saveLayout(); render();
  };
  const ungroup = () => { for (const id of picked) if (items[id] && items[id].gid) delete layout.groups[items[id].gid]; picked.clear(); saveLayout(); render(); };
  const rename = () => { const t = items[[...picked][0]], n = prompt('Rename group', t.name); if (n) { layout.groups[t.gid].name = n.trim() || t.name; saveLayout(); render(); } };
  const draw = () => {
    const sel = [...picked].map((id) => items[id]).filter((t) => t && !t.special), groupsSel = sel.filter((t) => t.gid);
    wrap.replaceChildren(...[
      h('div', { class: 'sechead' }, h('h2', {}, 'Accounts'), h('button', { class: 'edit-btn' + (editing ? ' on' : ''), onclick: () => { editing = !editing; picked.clear(); render(); } }, editing ? 'Done' : 'Edit')),
      editing ? h('div', { class: 'edit-hint' }, 'Drag ⠿ to move · ⤢ to resize · tap boxes to select') : null,
      h('div', { class: 'agrid' }, tiles().map((id) => tileEl(items[id]))),
      editing ? h('div', { class: 'editbar' },
        h('button', { class: 'btn', disabled: sel.length < 2 ? true : null, onclick: groupPicked }, sel.length >= 2 ? `Group ${sel.length}` : 'Group'),
        groupsSel.length ? h('button', { class: 'btn', onclick: ungroup }, 'Ungroup') : null,
        groupsSel.length === 1 && sel.length === 1 ? h('button', { class: 'btn', onclick: rename }, 'Rename') : null,
        h('button', { class: 'btn primary', onclick: () => { editing = false; picked.clear(); render(); } }, 'Done')) : null].filter(Boolean));
    fitText();
  };
  draw();
  return wrap;
}

// ---------- date range (spending tabs) ----------
const thisMonthRange = () => ({ from: todayISO().slice(0, 8) + '01', to: todayISO() });
function rangePresets() {
  const t = todayISO(), d = new Date(t + 'T12:00');
  const lastStart = isoOf(new Date(d.getFullYear(), d.getMonth() - 1, 1)), lastEnd = isoOf(new Date(d.getFullYear(), d.getMonth(), 0));
  const first = allTxns().reduce((m, x) => (x.date < m ? x.date : m), t);
  return [['This month', thisMonthRange()], ['Last month', { from: lastStart, to: lastEnd }],
    ['30D', { from: shiftDays(t, -29), to: t }], ['3M', { from: shiftDays(t, -89), to: t }],
    ['YTD', { from: t.slice(0, 4) + '-01-01', to: t }], ['All', { from: first, to: t }]];
}
const fmtShort = (iso) => new Date(iso + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: iso.slice(0, 4) === todayISO().slice(0, 4) ? undefined : 'numeric' });
const presetOf = (r) => rangePresets().find(([, x]) => x.from === r.from && x.to === r.to);
const rangeLabel = (r) => { const p = presetOf(r); return p ? p[0] : fmtShort(r.from) + ' – ' + fmtShort(r.to); };
function rangeBar(rerender) {
  const set = (r) => { if (r.from > r.to) r = { from: r.to, to: r.from }; range = r; open.clear(); rerender(); };
  const date = (key) => h('label', { class: 'dfield' }, h('span', {}, key === 'from' ? 'From' : 'To'),
    h('input', { type: 'date', value: range[key], max: todayISO(), onchange: (e) => e.target.value && set({ ...range, [key]: e.target.value }) }));
  return h('div', { class: 'rangebar' },
    h('div', { class: 'presets' }, rangePresets().map(([label, r]) =>
      h('button', { class: 'chip' + (r.from === range.from && r.to === range.to ? ' on' : ''), onclick: () => set(r) }, label))),
    h('div', { class: 'range' }, date('from'), date('to')));
}

// ---------- Breakdowns (categories / merchants / paid with) ----------
function breakdown(el, keyOf, labelOf, layout, icon, graphOf) {
  if (!data || !data.connections.length) return noData(el);
  { const lb = loadingBanner(); if (lb) el.append(lb); }
  range = range || thisMonthRange();
  const list = spending(), inR = (t, r) => t.date >= r.from && t.date <= r.to;
  const inRange = list.filter((t) => inR(t, range)), total = inRange.reduce((s, t) => s + t.amount, 0);
  const days = daysBetween(range.from, range.to) + 1;
  const prevTotal = list.filter((t) => inR(t, { from: shiftDays(range.from, -days), to: shiftDays(range.from, -1) })).reduce((s, t) => s + t.amount, 0);
  const diff = prevTotal ? ((total - prevTotal) / prevTotal) * 100 : null;
  setGlow(diff == null ? 0 : -diff);
  el.append(rangeBar(render));
  const groups = {};
  for (const t of inRange) (groups[keyOf(t)] = groups[keyOf(t)] || []).push(t);
  const sorted = Object.entries(groups).map(([k, l]) => ({ k, l, v: l.reduce((s, t) => s + t.amount, 0) })).filter((g) => Math.abs(g.v) > 0.005).sort((a, b) => b.v - a.v);
  sorted.forEach((g, i) => (g.color = PALETTE[Math.min(i, PALETTE.length - 1)]));
  const diffEl = diff == null ? null : h('div', { class: 'change ' + (diff > 0 ? 'neg' : 'pos') }, `${diff > 0 ? '▲' : '▼'} ${Math.abs(diff).toFixed(0)}%`);
  if (layout === 'donut') {
    const top = sorted.slice(0, 7), rest = sorted.slice(7);
    const segs = top.map((g) => ({ v: g.v, color: g.color, on: open.has(g.k) }));
    if (rest.length) segs.push({ v: rest.reduce((s, g) => s + g.v, 0), color: PALETTE[8] });
    el.append(h('div', { class: 'card hero-card' }, donut(segs, [h('div', { class: 'label' }, 'Spent'), num('donut-num', 'tot' + view + conn, total), diffEl],
      (i) => top[i] && toggle(top[i].k))));
  } else {
    el.append(h('section', { class: 'hero-block' }, h('div', { class: 'label' }, 'Spent'), num('hero-num', 'tot' + view + conn, total, true), diffEl));
  }
  if (!sorted.length) { el.append(h('div', { class: 'empty small' }, 'Nothing spent in this range')); return; }
  const max = sorted[0].v || 1;
  if (layout === 'cards') {
    const grid = h('div', { class: 'cardgrid' });
    sorted.forEach((g, i) => grid.append(h('div', { class: 'ccard' + (open.has(g.k) ? ' on' : ''), style: `--c1:${g.color};--c2:${PALETTE[(i + 3) % 8]}`, onclick: () => toggle(g.k) },
      h('div', { class: 'ccard-name' }, labelOf(g.k)), h('div', { class: 'ccard-amt' }, money(g.v)))));
    el.append(grid);
    const opened = sorted.filter((g) => open.has(g.k));
    for (const g of opened) el.append(h('div', { class: 'card' }, h('h2', {}, labelOf(g.k)), graphOf ? graphCard(graphOf(g.k), { flat: true, save: true }) : null, sortBar(render), sortTx(g.l).map(txnRow)));
    return;
  }
  const card = h('div', { class: 'card list' });
  for (const g of sorted) {
    const isOpen = open.has(g.k);
    card.append(h('div', { class: 'row tap' + (isOpen ? ' open' : ''), onclick: () => toggle(g.k) },
      icon(g), h('div', { class: 'grow' }, h('div', { class: 'name' }, labelOf(g.k)),
        h('div', { class: 'bar' }, h('i', { style: `width:${Math.max(2, (g.v / max) * 100)}%;background:${g.color}` }))),
      h('div', { class: 'amt' }, money(g.v, true))));
    if (isOpen) card.append(h('div', { class: 'drill' }, graphOf ? graphCard(graphOf(g.k), { flat: true, save: true }) : null, sortBar(render), sortTx(g.l).map(txnRow)));
  }
  el.append(card);
}
const catBadge = (g) => h('div', { class: 'cat', style: `background:${g.color}22;color:${g.color}` }, nice(g.k)[0]);
function viewCategories(el) { breakdown(el, (t) => t.category || 'OTHER', (k) => nice(k), 'donut', catBadge, (k) => ({ type: 'spend', cat: k, period: '1Y', by: 'month' })); }
function viewMerchants(el) {
  breakdown(el, (t) => t.name || 'Unknown', (k) => k, 'rows', (g) => logo(g.l[0]), (k) => ({ type: 'spend', merchant: k, period: '1Y', by: 'month' }));
  const subs = data && data.connections.length ? subscriptions() : [];
  if (subs.length) el.append(h('div', { class: 'card list tap', onclick: openRecurring }, h('h2', {}, 'Recurring', h('span', {}, money(subs.reduce((t, x) => t + x.monthly, 0), true) + '/mo')),
    subs.slice(0, 5).map((x) => h('div', { class: 'row' }, logo(x), h('div', { class: 'grow' }, h('div', { class: 'name' }, x.name), h('div', { class: 'sub' }, x.every)), h('div', { class: 'amt' }, money(x.amount, true))))));
}
function viewPaidWith(el) {
  const accs = Object.fromEntries(allAccounts().map((a) => [a.account_id, a]));
  breakdown(el, (t) => t.account_id, (k) => (accs[k] ? accLabel(accs[k]) : 'Other'), 'cards', null, (k) => ({ type: 'spend', accts: [k], period: '1Y', by: 'month' }));
}

// ---------- graphs ----------
const GTYPES = [['spend', 'Spending'], ['income', 'Money in'], ['inout', 'In vs out'], ['balance', 'Balance'], ['networth', 'Net worth']];
const GPERIODS = [['3M', 92], ['6M', 183], ['1Y', 365], ['2Y', 730]];
const GBY = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];
const DEFAULT_GRAPHS = [{ type: 'spend' }, { type: 'inout' }, { type: 'spend', cat: 'FOOD_AND_DRINK' }, { type: 'spend', cat: 'RENT_AND_UTILITIES' }, { type: 'networth' }];
let graphs = store.get('graphs', null) || DEFAULT_GRAPHS.map((g, i) => ({ id: 'd' + i, period: '1Y', by: 'month', ...g }));
const saveGraphs = () => store.set('graphs', graphs);
const everyAccount = () => (data ? data.connections : []).flatMap((c) => (c.accounts || []).map((a) => ({ ...a, institution: c.institution, brand: c.brand })));
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
  if (g.period === 'Custom' && g.from) return { from: g.from, to: g.to && g.to < todayISO() ? g.to : todayISO() };
  return { from: shiftDays(todayISO(), -(GPERIODS.find((p) => p[0] === g.period) || GPERIODS[2])[1] + 1), to: todayISO() };
}
const periodLabel = (g) => (g.period === 'Custom' && g.from ? `${shortDay(gRange(g).from)} – ${shortDay(gRange(g).to)}` : g.period);
function bucketKeys(g) {
  const { from, to } = gRange(g), keys = [];
  const by = g.by === 'day' && daysBetween(from, to) > 183 ? 'week' : g.by || 'month';
  for (let d = from; d <= to; d = shiftDays(d, 1)) { const k = bucketOf(by, d); if (keys[keys.length - 1] !== k) keys.push(k); }
  return { keys, by, from, to };
}
// Past balances: saved daily snapshots when we have them, otherwise worked backwards from today's balance through posted transactions.
function balanceAt(ids) {
  const accs = everyAccount().filter((a) => ids.includes(a.account_id)), allDebt = accs.every(isDebt);
  const snaps = new Map((data.history || []).filter((p) => p.accounts).map((p) => [p.date, p.accounts]));
  const posted = allTxns().filter((t) => !t.pending);
  const per = accs.map((a) => {
    const list = posted.filter((t) => t.account_id === a.account_id), firstSnap = [...snaps.keys()].find((d) => snaps.get(d)[a.account_id] != null);
    const oldest = [list.length ? list[list.length - 1].date : null, firstSnap].filter(Boolean).sort()[0] || todayISO();
    return { a, list, oldest, sign: isDebt(a) ? -1 : 1 };
  });
  return (day) => {
    let total = 0, any = false;
    for (const { a, list, oldest, sign } of per) {
      if (day < oldest) continue;
      const snap = snaps.get(day);
      let v = snap && snap[a.account_id] != null ? snap[a.account_id] : (a.balances.current || 0) + sign * list.reduce((s, t) => s + (t.date > day ? t.amount : 0), 0);
      any = true; total += allDebt ? v : isDebt(a) ? -v : v;
    }
    return any ? total : null;
  };
}
function series(g) {
  const { keys, by, from, to } = bucketKeys(g), idx = new Map(keys.map((k, i) => [k, i]));
  const ids = g.accts && g.accts.length ? new Set(g.accts) : null;
  const sumBy = (list, sign) => {
    const v = keys.map(() => 0);
    for (const t of list) { if ((ids && !ids.has(t.account_id)) || t.date < from || t.date > to) continue; const i = idx.get(bucketOf(by, t.date)); if (i != null) v[i] += sign * t.amount; }
    return v;
  };
  const base = { keys, by, from, to, kind: 'bars' };
  if (g.type === 'spend') return { ...base, sets: [{ c: g.cat ? catColor(g.cat) : '#ff5a5f', v: sumBy(spending().filter((t) => (!g.cat || t.category === g.cat) && (!g.merchant || t.name === g.merchant)), 1) }] };
  if (g.type === 'income') return { ...base, sets: [{ c: '#1fd286', v: sumBy(income(), -1) }] };
  if (g.type === 'inout') return { ...base, sets: [{ c: '#1fd286', l: 'In', v: sumBy(income(), -1) }, { c: '#ff5a5f', l: 'Out', v: sumBy(spending(), 1) }] };
  if (g.type === 'networth') {
    const hist = (data.history || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    return { ...base, kind: 'line', sets: [{ v: keys.map((k) => { const e = bucketEnd(by, k, to); let last = null; for (const p of hist) if (p.date <= e) last = p.assets - p.debts; return last; }) }] };
  }
  const at = balanceAt(ids ? [...ids] : allAccounts().filter((a) => !isDebt(a)).map((a) => a.account_id));
  return { ...base, kind: 'line', sets: [{ v: keys.map((k) => at(bucketEnd(by, k, to))) }] };
}
function gTitle(g) {
  if (g.title) return g.title;
  const accs = (g.accts || []).map((id) => everyAccount().find((a) => a.account_id === id)).filter(Boolean);
  const an = accs.length === 1 ? accs[0].name : accs.length ? accs.length + ' accounts' : '';
  const base = g.type === 'spend' ? g.merchant || (g.cat ? nice(g.cat) : 'Spending') : (GTYPES.find((t) => t[0] === g.type) || [, ''])[1];
  if (g.type === 'balance') return an || 'Money you have';
  return an && g.type !== 'networth' ? base + ' · ' + an : base;
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
    s.sets.map((x, j) => { const d = curve(x.v); return `<path class="area" d="${d} L ${W} ${H} L 0 ${H} Z" fill="url(#${id}${j})"/><path class="stroke" pathLength="1" d="${d}" fill="none" stroke="${x.c}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`; }).join('') +
    s.sets.map((x) => avgLine(Y(meanOf(x.v)), W, x.c)).join('') + ticks });
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
  wrap.addEventListener('pointerdown', move); wrap.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') move(e); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) wrap.addEventListener(ev, end);
  return wrap;
}
function graphCard(g, opts = {}) {
  const s = series(g), first = s.sets[0].v, big = h('div', { class: 'big fit' }), sub = h('div', { class: 'gsub' });
  const per = { month: 'mo', week: 'wk', day: 'day' }[s.by];
  const show = (sc) => {
    if (s.kind === 'line') {
      const pts = first.filter((v) => v != null), cur = sc ? sc.v : pts[pts.length - 1];
      big.textContent = cur == null ? '—' : money(cur, true);
      const ch = pts.length > 1 ? pts[pts.length - 1] - pts[0] : null;
      sub.className = 'gsub ' + (sc ? 'muted' : ch == null ? 'muted' : ch >= 0 ? 'pos' : 'neg');
      sub.textContent = sc ? sc.label : ch == null ? 'Not enough history yet' : `${ch >= 0 ? '▲' : '▼'} ${money(Math.abs(ch))} over ${periodLabel(g)}`;
    } else if (s.sets.length > 1) {
      const [a, b] = s.sets.map((x) => (sc ? x.v[sc.i] : x.v.reduce((t, y) => t + y, 0))), net = a - b;
      big.textContent = (net >= 0 ? '+' : '−') + money(Math.abs(net)); big.className = 'big fit ' + (net >= 0 ? 'pos' : 'neg');
      sub.className = 'gsub muted'; sub.textContent = `${sc ? sc.label : periodLabel(g)}: ${money(a)} in · ${money(b)} out`;
    } else {
      const tot = first.reduce((t, y) => t + y, 0), avg = tot / first.length;
      big.textContent = money(sc ? first[sc.i] : avg, !!sc);
      sub.className = 'gsub muted'; sub.textContent = sc ? sc.label : `avg per ${per} · ${money(tot)} total`;
    }
  };
  show(null);
  const chart = s.kind === 'line'
    ? lineChart(s.keys.map((k, i) => ({ v: first[i], date: bucketEnd(s.by, k, s.to) })).filter((p) => p.v != null), (p) => show(p ? { v: p.v, label: dayName(p.date) } : null), true)
    : linesChart(s, show);
  return h('div', { class: 'card graph' + (opts.flat ? ' flat' : '') },
    h('div', { class: 'ghead' }, h('div', { class: 'gtitle' }, gTitle(g)),
      opts.edit ? h('button', { class: 'gbtn', 'aria-label': 'Edit graph', onclick: opts.edit }, '•••') : null,
      opts.save ? h('button', { class: 'gbtn', onclick: (e) => { graphs.push({ ...g, id: Date.now().toString(36) }); saveGraphs(); e.target.textContent = 'Added'; e.target.disabled = true; } }, '+ Graphs') : null),
    big, sub, chart || h('div', { class: 'empty small' }, 'Not enough history yet'),
    s.sets.length > 1 ? h('div', { class: 'legend' }, s.sets.map((x) => h('span', {}, h('i', { style: `background:${x.c}` }), `${x.l} · avg ${money(meanOf(x.v))}`))) : null,
    opts.edit ? h('div', { class: 'gper' }, [...GPERIODS.map(([p]) => p), 'Custom'].map((p) => h('button', { class: 'chip' + (g.period === p ? ' on' : ''),
      onclick: () => { if (p === 'Custom') return opts.edit('Custom'); g.period = p; saveGraphs(); render(); } }, p === 'Custom' && g.period === 'Custom' ? periodLabel(g) : p))) : null);
}
function viewGraphs(el) {
  if (!data || !data.connections.length) return noData(el);
  { const lb = loadingBanner(); if (lb) el.append(lb); }
  for (const g of graphs) el.append(graphCard(g, { edit: (p) => openGraphEditor(g, p) }));
  el.append(h('button', { class: 'btn', onclick: () => openGraphEditor(null) }, '+ Add graph'));
}
function openGraphEditor(orig, preset) {
  const f = orig ? { ...orig, accts: [...(orig.accts || [])] } : { type: 'spend', period: '1Y', by: 'month', accts: [] };
  if (preset === 'Custom') { f.period = 'Custom'; if (!f.from) { f.from = shiftDays(todayISO(), -364); f.to = todayISO(); } }
  const chips = (opts, key, cond) => h('div', { class: 'presets wrap' }, opts.filter(cond || (() => true)).map(([v, l]) =>
    h('button', { class: 'chip' + (f[key] === v ? ' on' : ''), onclick: () => { f[key] = v; if (v === 'Custom' && !f.from) { f.from = shiftDays(todayISO(), -364); f.to = todayISO(); } renderPanel(); } }, l)));
  const pick = (label, key, options) => h('div', { class: 'field' }, h('label', {}, label),
    h('select', { onchange: (e) => { f[key] = e.target.value || null; renderPanel(); } },
      h('option', { value: '' }, 'All'), options.map(([v, l]) => h('option', { value: v, selected: f[key] === v ? true : null }, l))));
  openSheet({ title: orig ? 'Edit graph' : 'New graph', render: (el) => {
    el.append(graphCard(f, { flat: true }));
    el.append(h('div', { class: 'card' }, h('div', { class: 'label' }, 'Show'), chips(GTYPES, 'type')));
    if (f.type === 'spend') {
      const tot = {}; for (const t of spending()) if (t.amount > 0) { tot['c' + t.category] = (tot['c' + t.category] || 0) + t.amount; tot['m' + t.name] = (tot['m' + t.name] || 0) + t.amount; }
      const top = (p) => Object.keys(tot).filter((k) => k[0] === p).sort((a, b) => tot[b] - tot[a]).map((k) => k.slice(1));
      el.append(h('div', { class: 'card' }, pick('Category', 'cat', top('c').map((c) => [c, nice(c)])), pick('Merchant', 'merchant', top('m').slice(0, 60).map((m) => [m, m]))));
    }
    if (f.type !== 'networth') {
      const accs = everyAccount().filter((a) => (f.type === 'balance' ? true : f.type === 'income' ? !isDebt(a) : true));
      el.append(h('div', { class: 'card' }, h('div', { class: 'label' }, f.accts.length ? 'Accounts' : 'Accounts · all'),
        accs.map((a) => h('label', { class: 'row tap' }, mark(a.brand, a.institution), h('div', { class: 'grow' }, h('div', { class: 'name' }, a.name, h('span', { class: 'mask' }, ' ' + (a.mask || ''))), h('div', { class: 'sub' }, a.institution || '')),
          h('input', { type: 'checkbox', class: 'switch', checked: f.accts.includes(a.account_id) ? true : null,
            onchange: (e) => { f.accts = e.target.checked ? [...f.accts, a.account_id] : f.accts.filter((x) => x !== a.account_id); renderPanel(); } })))));
    }
    el.append(h('div', { class: 'card' }, h('div', { class: 'label' }, 'Period'), chips([...GPERIODS.map(([p]) => [p, p]), ['Custom', 'Custom']], 'period'),
      f.period === 'Custom' ? h('div', { class: 'gdates' }, ['from', 'to'].map((key) => h('div', { class: 'field' }, h('label', {}, key === 'from' ? 'From' : 'To'),
        h('input', { type: 'date', value: f[key], max: todayISO(), onchange: (e) => { if (e.target.value) { f[key] = e.target.value; if (f.from > f.to) [f.from, f.to] = [f.to, f.from]; renderPanel(); } } })))) : null,
      h('div', { class: 'label', style: 'margin-top:12px' }, 'Group by'), chips(GBY, 'by', ([v]) => v !== 'day' || daysBetween(gRange(f).from, gRange(f).to) <= 183)));
    const i = orig ? graphs.indexOf(orig) : -1;
    const done = () => { if (f.type !== 'spend') { delete f.cat; delete f.merchant; } if (i >= 0) graphs[i] = f; else graphs.push({ ...f, id: Date.now().toString(36) }); saveGraphs(); closePanel(); render(); };
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

// ---------- panels: settings + loans ----------
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
  $('panel-title').textContent = panel === 'txns' ? sheet.title : panel === 'loans' ? 'Loans' : 'Settings';
  $('panel-back').onclick = () => (panel === 'loans' ? openPanel('settings') : closePanel());
  (panel === 'txns' ? viewSheet : panel === 'loans' ? viewLoans : viewSettings)(el);
}
function loanForm(el, existing) {
  const l = existing || { id: Date.now().toString(36), name: 'Aidvantage', balance: '', rate: '', payment: '', asOf: todayISO(), match: 'aidvantage, dept education, dept of ed' };
  const f = (label, key, type) => h('div', { class: 'field' }, h('label', {}, label),
    h('input', { type, step: 'any', value: l[key], 'data-k': key, inputmode: type === 'number' ? 'decimal' : null }));
  const card = h('div', { class: 'card' }, h('h2', {}, existing ? 'Edit loan' : 'Add a loan'),
    f('Name', 'name', 'text'), f('Balance on that date', 'balance', 'number'), f('As of', 'asOf', 'date'),
    f('Interest rate (%)', 'rate', 'number'), f('Monthly payment', 'payment', 'number'),
    f('Payment names to look for (comma separated)', 'match', 'text'),
    h('button', { class: 'btn primary', onclick: () => {
      for (const i of card.querySelectorAll('input')) l[i.dataset.k] = i.type === 'number' ? parseFloat(i.value) || 0 : i.value;
      loans = loans.filter((x) => x.id !== l.id).concat(l); store.set('loans', loans); renderPanel(); render();
    } }, 'Save'),
    existing ? h('button', { class: 'btn danger', onclick: () => { loans = loans.filter((x) => x.id !== l.id); store.set('loans', loans); renderPanel(); render(); } }, 'Delete') : null,
    h('button', { class: 'btn', onclick: renderPanel }, 'Cancel'));
  el.replaceChildren(card);
}
function viewLoans(el) {
  const plaidLoans = data ? data.connections.flatMap((c) => ((c.liabilities && c.liabilities.student) || []).map((s) => ({ s, acc: (c.accounts || []).find((a) => a.account_id === s.account_id) }))) : [];
  for (const { s, acc } of plaidLoans) {
    const bal = (acc && acc.balances.current) || 0, p = payoff(bal, s.interest_rate_percentage || 0, s.minimum_payment_amount || 0);
    el.append(h('div', { class: 'card' }, h('h2', {}, (acc && acc.name) || s.loan_name || 'Student loan'), h('div', { class: 'big' }, money(bal, true)),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, 'Rate'), h('div', {}, (s.interest_rate_percentage || 0) + '%')),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, 'Payment'), h('div', {}, money(s.minimum_payment_amount || 0, true))),
      s.next_payment_due_date ? h('div', { class: 'row' }, h('div', { class: 'grow' }, 'Next due'), h('div', {}, dayName(s.next_payment_due_date))) : null,
      p ? h('div', { class: 'row' }, h('div', { class: 'grow' }, 'Paid off'), h('div', {}, p.date)) : null));
  }
  for (const l of loans) {
    const st = loanStatus(l), p = payoff(st.balance, l.rate, l.payment);
    el.append(h('div', { class: 'card tap', onclick: () => loanForm(el, l) }, h('h2', {}, l.name), h('div', { class: 'big' }, money(st.balance, true)),
      h('div', { class: 'sub muted' }, `Estimated from ${money(l.balance, true)} on ${dayName(l.asOf)}`),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, 'Rate'), h('div', {}, l.rate + '%')),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, 'Payments found since'), h('div', {}, `${st.pays.length} · ${money(st.paid, true)}`)),
      p ? h('div', { class: 'row' }, h('div', { class: 'grow' }, 'Paid off'), h('div', {}, `${p.date} · ${money(p.interest)} interest left`))
        : h('div', { class: 'warn' }, 'Payment doesn’t cover the interest, so this never pays off.'),
      daysBetween(l.asOf, todayISO()) > 180 ? h('div', { class: 'warn' }, 'Over 6 months old: tap to update the balance from your Aidvantage account.') : null));
  }
  if (!plaidLoans.length && !loans.length) el.append(h('div', { class: 'empty' }, 'Aidvantage can’t connect through Plaid, so add each loan once. Payments to it in your bank are picked up automatically.'));
  el.append(h('button', { class: 'btn primary', onclick: () => loanForm(el) }, '+ Add a loan'));
}
function viewSettings(el) {
  el.append(h('button', { class: 'btn primary', onclick: () => connect() }, '+ Connect an account'));
  const conns = data ? data.connections : [];
  if (conns.length) el.append(h('div', { class: 'card' }, h('h2', {}, `Connections · ${conns.length} of 10`), conns.map((c) =>
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, c.institution || 'Bank'),
      h('div', { class: 'sub' }, (c.accounts || []).length + ' accounts'), c.error ? h('div', { class: 'warn' }, nice(c.error)) : null),
      c.error ? h('button', { class: 'btn small', onclick: () => connect(c.item_id) }, 'Fix') : null,
      h('button', { class: 'btn small danger', onclick: async () => {
        if (!confirm(`Disconnect ${c.institution || 'this bank'}? This doesn’t free up one of your 10 Plaid slots.`)) return;
        busy('Removing…');
        try { gotData(await api('/remove', { item_id: c.item_id })); renderPanel(); } catch (e) { toast(e.message); } finally { busy(null); }
      } }, 'Remove')))));
  const cash = conns.flatMap((c) => (c.accounts || []).filter((a) => !isDebt(a)).map((a) => ({ ...a, institution: c.institution })));
  if (cash.length) el.append(h('div', { class: 'card' }, h('h2', {}, 'Main accounts', h('span', {}, 'top of Overview')), cash.map((a) =>
    h('label', { class: 'row tap' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, a.name, h('span', { class: 'mask' }, ' ' + (a.mask || ''))),
      h('div', { class: 'sub' }, a.institution || '')),
      h('input', { type: 'checkbox', class: 'switch', checked: isMain(a), onchange: (e) => {
        const ids = new Set(cash.filter(isMain).map((x) => x.account_id));
        e.target.checked ? ids.add(a.account_id) : ids.delete(a.account_id);
        mainIds = [...ids]; store.set('main', mainIds); render();
      } })))));
  el.append(h('button', { class: 'btn', onclick: () => openPanel('loans') }, 'Loans (Aidvantage) ›'));
  el.append(h('p', { class: 'muted', style: 'font-size:13px' }, 'Pulls the latest every time you open the app. Banks themselves update about 1–4 times a day.'));
  el.append(h('button', { class: 'btn danger', onclick: () => { closePanel(true); logout(); } }, 'Lock'));
}

// ---------- layout ----------
const VIEWS = { overview: viewOverview, categories: viewCategories, merchants: viewMerchants, paidwith: viewPaidWith, graphs: viewGraphs };
function renderChips() {
  const box = $('conns'), conns = data ? data.connections : [];
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
  const ids = ['all'].concat((data ? data.connections : []).map((c) => c.item_id));
  dir = dir || (ids.indexOf(id) > ids.indexOf(conn) ? 'l' : 'r');
  conn = id; store.set('conn', id); open.clear(); render('slide-' + dir);
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
  view = name; month = null; open.clear(); setTab(); window.scrollTo(0, 0); render('fade');
}
// Swipe sideways on the page to move between connections.
let touch = null;
$('view').addEventListener('touchstart', (e) => { touch = e.target.closest('svg, .chips, .agrid-wrap.editing, .editing') ? null : { x: e.touches[0].clientX, y: e.touches[0].clientY }; }, { passive: true });
$('view').addEventListener('touchend', (e) => {
  if (!touch || !data || data.connections.length < 2) return;
  const dx = e.changedTouches[0].clientX - touch.x, dy = e.changedTouches[0].clientY - touch.y; touch = null;
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  const ids = ['all'].concat(data.connections.map((c) => c.item_id)), i = ids.indexOf(conn) + (dx < 0 ? 1 : -1);
  if (i >= 0 && i < ids.length) pickConn(ids[i], dx < 0 ? 'l' : 'r');
}, { passive: true });

// ---------- login ----------
function logout() { store.del('pass'); store.del('data'); data = null; showLogin(); }
function showLogin() { $('main').hidden = true; $('tabbar').hidden = true; $('login').hidden = false; $('login-url').value = store.get('server', DEFAULT_SERVER); }
function showApp() { $('login').hidden = true; $('main').hidden = false; $('tabbar').hidden = false; view = 'overview'; setTab(); render('fade'); nudgeViewport(); }
$('login-btn').addEventListener('click', async () => {
  store.set('server', $('login-url').value.trim()); store.set('pass', $('login-pass').value);
  $('login-err').textContent = '';
  try { await api('/login', {}); $('login-pass').value = ''; showApp(); refresh(false); }
  catch (e) { store.del('pass'); $('login-err').textContent = e.message === 'Wrong password' ? 'Wrong password.' : 'Couldn’t reach the server.'; showLogin(); }
});
$('login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login-btn').click(); });
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showView(t.dataset.view));
$('sync-btn').addEventListener('click', () => refresh(true));
$('gear-btn').addEventListener('click', () => openPanel('settings'));
// Every open (or return to the app) pulls fresh data.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !store.get('pass', '')) return;
  if (Date.now() - lastSync > 30000) refresh(false);
  if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) navigator.serviceWorker.getRegistration().then((r) => r && r.update());
});

if (store.get('pass', '')) {
  showApp();
  // Back from a bank's OAuth page: finish the same Link session.
  const pending = store.get('linkToken', null);
  if (pending && location.search.includes('oauth_state_id')) openLink(pending, location.href);
  refresh(false);
} else showLogin();
if ('serviceWorker' in navigator) {
  // A new version takes over as soon as it's downloaded, so opening the app always shows the latest.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !panel && $('overlay').hidden) location.reload(); });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
}
