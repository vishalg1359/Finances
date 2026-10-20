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
// A merchant charged in 3+ different months for roughly the same amount looks like a subscription.
function subscriptions() {
  const groups = {};
  for (const t of spending().filter((x) => x.amount > 0)) (groups[t.name] = groups[t.name] || []).push(t);
  const subs = [];
  for (const [name, list] of Object.entries(groups)) {
    const months = new Set(list.map((t) => monthKey(t.date)));
    if (months.size < 3) continue;
    const latest = list.sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const similar = list.filter((t) => Math.abs(t.amount - latest.amount) <= Math.max(1, latest.amount * 0.1));
    if (new Set(similar.map((t) => monthKey(t.date))).size >= 3) subs.push({ name, amount: latest.amount, last: latest.date, logo: latest.logo });
  }
  return subs.sort((a, b) => b.amount - a.amount);
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
const PALETTE = ['#1fd286', '#4f8cff', '#ffb547', '#ff6b8b', '#a37bff', '#2fd0d6', '#ff8a4c', '#c3d84a', '#6b7280'];
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
const TITLES = { overview: 'Overview', categories: 'Categories', merchants: 'Merchants', paidwith: 'Paid with', cashflow: 'Cash flow' };
let mainIds = store.get('main', null);
const isMain = (a) => (mainIds ? mainIds.includes(a.account_id) : a.subtype === 'checking');
const isDebt = (a) => a.type === 'credit' || a.type === 'loan';
const accLabel = (a) => a.name + (a.mask ? ' ••' + a.mask : '');
const shortDay = (d) => new Date(d + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const txnRow = (t) => h('div', { class: 'row' }, logo(t), h('div', { class: 'grow' }, h('div', { class: 'name' }, t.name),
  h('div', { class: 'sub' }, shortDay(t.date) + (t.pending ? ' · pending' : '') + (t.amount < 0 ? ' · refund' : ''))),
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
    h('div', { class: 'tile tap', onclick: () => openPanel('settings') }, h('div', { class: 'label' }, h('span', { class: 'dot', style: 'background:var(--good)' }),
        have.filter(isMain).every((a) => a.subtype === 'checking') ? 'Checking' : 'Main'),
      num('tile-num', 'chk' + conn, sum(have.filter(isMain)))),
    h('div', { class: 'tile' }, h('div', { class: 'label' }, h('span', { class: 'dot', style: 'background:var(--bad)' }), 'You owe'),
      num('tile-num', 'owe' + conn, sum(owe.filter((a) => a.type === 'credit'))), owePend ? h('div', { class: 'tile-pend' }, '+' + money(owePend, true) + ' pending') : null)));
  const m = monthKey(todayISO()), spent = byMonth(spending())[m] || 0;
  const lastM = lastMonths(2)[0], lastSpent = byMonth(spending())[lastM] || 0;
  const pace = paceChart();
  el.append(h('div', { class: 'card tap spendcard', onclick: () => showView('categories') },
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
  const acctRow = (a, label, debt) => {
    const pend = a.type === 'credit' ? pendingFor(a) : [], k = 'p:' + a.account_id, isOpen = open.has(k);
    const posted = a.balances.current || 0, pAmt = pend.reduce((s, t) => s + t.amount, 0);
    const amt = pend.length
      ? h('div', { class: 'amts' }, h('div', { class: 'amt neg' }, money(posted, true)), h('div', { class: 'pend-amt' }, '+' + money(pAmt, true) + ' pending'))
      : h('div', { class: 'amt' + (debt ? ' neg' : '') }, money(posted, true));
    return [h('div', { class: 'row ' + (label ? 'grp' : 'acct') + (pend.length ? ' tap' : '') + (isOpen ? ' open' : ''), onclick: pend.length ? () => toggle(k) : null },
      mark(a.brand, a.institution), h('div', { class: 'grow' }, h('div', { class: 'name' }, label || a.name, a.mask ? h('span', { class: 'mask' }, ' ' + a.mask) : null)),
      amt, pend.length ? h('span', { class: 'chev' }, '›') : null),
      isOpen ? h('div', { class: 'drill' }, split(posted, pAmt), pend.map(txnRow)) : null];
  };
  // Vaults (e.g. SoFi) come through as "cash management" accounts next to an empty parent savings account.
  const vaultBanks = new Set(accs.filter((a) => a.subtype === 'savings').map((a) => a.institution));
  const isVault = (a) => a.subtype === 'cash management' && vaultBanks.has(a.institution);
  const hasVaults = new Set(accs.filter(isVault).map((a) => a.institution));
  const emptyParent = (a) => a.subtype === 'savings' && hasVaults.has(a.institution) && !a.balances.current;
  const groups = [['Checking', (a) => a.subtype === 'checking'], ['Savings', (a) => (a.subtype === 'savings' && !emptyParent(a)) || isVault(a)],
    ['Investments', (a) => a.type === 'investment' || a.type === 'brokerage'], ['Credit cards', (a) => a.type === 'credit'], ['Loans', (a) => a.type === 'loan'],
    ['Other', (a) => !isVault(a) && !['checking', 'savings'].includes(a.subtype) && !['investment', 'brokerage', 'credit', 'loan'].includes(a.type)]];
  const card = h('div', { class: 'card accounts' });
  const alloc = [['Checking', (a) => a.subtype === 'checking', 'var(--good)'], ['Savings', (a) => a.subtype === 'savings' || isVault(a), '#4f8cff'],
    ['Investments', (a) => a.type === 'investment' || a.type === 'brokerage', '#a37bff']]
    .map(([l, f, c]) => ({ l, c, v: sum(have.filter(f)) })).filter((x) => x.v > 0);
  const allocTotal = alloc.reduce((s, x) => s + x.v, 0);
  if (alloc.length > 1) card.append(h('div', { class: 'alloc' },
    h('div', { class: 'allocbar' }, alloc.map((x) => h('i', { style: `flex:${x.v};background:${x.c}` }))),
    h('div', { class: 'allockey' }, alloc.map((x) => h('span', {}, h('i', { style: `background:${x.c}` }), x.l, h('b', {}, Math.round((x.v / allocTotal) * 100) + '%'))))));
  for (const [label, test] of groups) {
    const list = accs.filter(test);
    const extra = label === 'Loans' ? manual : [];
    if (!list.length && !extra.length) continue;
    const debt = label === 'Credit cards' || label === 'Loans';
    if (list.length === 1 && !extra.length) { card.append(...acctRow(list[0], debt ? list[0].name : label, debt).filter(Boolean)); continue; }
    card.append(h('div', { class: 'row grp' }, h('div', { class: 'grow' }, label),
      h('div', { class: 'amt' + (debt ? ' neg' : '') }, money(sum(list) + extra.reduce((s, x) => s + x.bal, 0), true))));
    list.sort((a, b) => (b.balances.current || 0) - (a.balances.current || 0)).forEach((a) => card.append(...acctRow(a).filter(Boolean)));
    for (const { l, bal } of extra) card.append(h('div', { class: 'row acct tap', onclick: () => openPanel('loans') },
      mark(null, l.name), h('div', { class: 'grow' }, h('div', { class: 'name' }, l.name, h('span', { class: 'mask' }, ' est.'))), h('div', { class: 'amt' }, money(bal, true))));
  }
  if (card.childNodes.length) el.append(card);
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
function breakdown(el, keyOf, labelOf, layout, icon) {
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
    for (const g of opened) el.append(h('div', { class: 'card' }, h('h2', {}, labelOf(g.k)), g.l.sort((a, b) => (a.date < b.date ? 1 : -1)).map(txnRow)));
    return;
  }
  const card = h('div', { class: 'card list' });
  for (const g of sorted) {
    const isOpen = open.has(g.k);
    card.append(h('div', { class: 'row tap' + (isOpen ? ' open' : ''), onclick: () => toggle(g.k) },
      icon(g), h('div', { class: 'grow' }, h('div', { class: 'name' }, labelOf(g.k)),
        h('div', { class: 'bar' }, h('i', { style: `width:${Math.max(2, (g.v / max) * 100)}%;background:${g.color}` }))),
      h('div', { class: 'amt' }, money(g.v, true))));
    if (isOpen) card.append(h('div', { class: 'drill' }, g.l.sort((a, b) => (a.date < b.date ? 1 : -1)).map(txnRow)));
  }
  el.append(card);
}
const catBadge = (g) => h('div', { class: 'cat', style: `background:${g.color}22;color:${g.color}` }, nice(g.k)[0]);
function viewCategories(el) { breakdown(el, (t) => t.category || 'OTHER', (k) => nice(k), 'donut', catBadge); }
function viewMerchants(el) {
  breakdown(el, (t) => t.name || 'Unknown', (k) => k, 'rows', (g) => logo(g.l[0]));
  const subs = data && data.connections.length ? subscriptions() : [];
  if (subs.length) el.append(h('div', { class: 'card list' }, h('h2', {}, 'Recurring', h('span', {}, money(subs.reduce((s, x) => s + x.amount, 0), true) + '/mo')),
    subs.map((s) => h('div', { class: 'row' }, logo(s), h('div', { class: 'grow' }, h('div', { class: 'name' }, s.name)), h('div', { class: 'amt' }, money(s.amount, true))))));
}
function viewPaidWith(el) {
  const accs = Object.fromEntries(allAccounts().map((a) => [a.account_id, a]));
  breakdown(el, (t) => t.account_id, (k) => (accs[k] ? accLabel(accs[k]) : 'Other'), 'cards');
}

// ---------- Cash flow ----------
function viewCashflow(el) {
  if (!data || !data.connections.length) return noData(el);
  { const lb = loadingBanner(); if (lb) el.append(lb); }
  const months = lastMonths(12), out = byMonth(spending()), inc = byMonth(income(), -1);
  if (!months.some((m) => out[m] || inc[m])) { el.append(h('div', { class: 'empty small' }, 'No activity yet')); return; }
  const W = 320, H = 120, max = Math.max(1, ...months.flatMap((m) => [out[m] || 0, inc[m] || 0])), bw = W / months.length;
  const svg = h('svg', { class: 'chart bars', viewBox: `0 0 ${W} ${H + 16}` });
  svg.innerHTML = months.map((m, i) => {
    const a = ((inc[m] || 0) / max) * (H - 4), b = (Math.max(0, out[m] || 0) / max) * (H - 4), x = i * bw;
    return `<rect class="b" style="animation-delay:${i * 30}ms" x="${x + bw * 0.14}" y="${H - a}" width="${bw * 0.34}" height="${Math.max(a, 1)}" rx="2" fill="var(--good)"/>` +
      `<rect class="b" style="animation-delay:${i * 30 + 15}ms" x="${x + bw * 0.52}" y="${H - b}" width="${bw * 0.34}" height="${Math.max(b, 1)}" rx="2" fill="var(--bad)"/>` +
      `<text x="${x + bw / 2}" y="${H + 13}" font-size="10" text-anchor="middle" fill="var(--dim)">${monthName(m)[0]}</text>`;
  }).join('');
  const net = months.reduce((s, m) => s + (inc[m] || 0) - (out[m] || 0), 0);
  setGlow(net);
  el.append(h('section', { class: 'hero-block' }, h('div', { class: 'label' }, 'Net · 12 months'),
    num('hero-num ' + (net >= 0 ? 'pos' : 'neg'), 'cf' + conn, net), svg,
    h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'background:var(--good)' }), 'In'), h('span', {}, h('i', { style: 'background:var(--bad)' }), 'Out'))));
  const mx = Math.max(1, ...months.flatMap((m) => [inc[m] || 0, out[m] || 0]));
  el.append(h('div', { class: 'card list' }, months.slice().reverse().filter((m) => out[m] || inc[m]).map((m) => {
    const n = (inc[m] || 0) - (out[m] || 0);
    return h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, monthName(m, true)),
      h('div', { class: 'duo' }, h('i', { class: 'in', style: `width:${((inc[m] || 0) / mx) * 100}%` }), h('i', { class: 'out', style: `width:${(Math.max(0, out[m] || 0) / mx) * 100}%` }))),
      h('div', { class: 'amt ' + (n >= 0 ? 'pos' : 'neg') }, (n >= 0 ? '+' : '') + money(n)));
  })));
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
  $('panel-title').textContent = panel === 'loans' ? 'Loans' : 'Settings';
  $('panel-back').onclick = () => (panel === 'loans' ? openPanel('settings') : closePanel());
  (panel === 'loans' ? viewLoans : viewSettings)(el);
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
const VIEWS = { overview: viewOverview, categories: viewCategories, merchants: viewMerchants, paidwith: viewPaidWith, cashflow: viewCashflow };
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
$('view').addEventListener('touchstart', (e) => { touch = e.target.closest('svg, .chips') ? null : { x: e.touches[0].clientX, y: e.touches[0].clientY }; }, { passive: true });
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
