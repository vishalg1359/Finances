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
let lastSync = 0, syncing = null, pollTimer = null, pollCount = 0;

const $ = (id) => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
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
const todayISO = () => new Date().toISOString().slice(0, 10);
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
const allAccounts = () => shownConns().flatMap((c) => (c.accounts || []).map((a) => ({ ...a, institution: c.institution })));
const NOT_SPENDING = new Set(['INCOME', 'TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS']);
const allTxns = () => (data ? data.transactions : []);
const txns = () => { if (conn === 'all') return allTxns(); const ids = new Set(allAccounts().map((a) => a.account_id)); return allTxns().filter((t) => ids.has(t.account_id)); };
const spending = () => txns().filter((t) => t.amount > 0 && !NOT_SPENDING.has(t.category));
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
function byMonth(list) {
  const m = {};
  for (const t of list) m[monthKey(t.date)] = (m[monthKey(t.date)] || 0) + Math.abs(t.amount);
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
  for (const t of spending()) (groups[t.name] = groups[t.name] || []).push(t);
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
function lineChart(points) {
  if (points.length < 2) return null;
  const W = 320, H = 110, vals = points.map((p) => p.v), lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * W, H - 8 - ((p.v - lo) / span) * (H - 16)]);
  const d = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const up = vals[vals.length - 1] >= vals[0], col = up ? 'var(--good)' : 'var(--bad)';
  return h('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, html:
    `<path d="${d} L ${W} ${H} L 0 ${H} Z" fill="${col}" opacity=".12"/><path d="${d}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round"/>` });
}
function barChart(months, values, onPick, selected) {
  const W = 320, H = 120, max = Math.max(1, ...values), bw = W / months.length;
  const svg = h('svg', { class: 'chart', viewBox: `0 0 ${W} ${H + 16}` });
  svg.innerHTML = months.map((m, i) => {
    const bh = (values[i] / max) * (H - 4), on = m === selected;
    return `<g data-m="${m}"><rect x="${i * bw}" y="0" width="${bw}" height="${H + 16}" fill="transparent"/>` +
      `<rect x="${i * bw + bw * 0.18}" y="${H - bh}" width="${bw * 0.64}" height="${Math.max(bh, 1)}" rx="3" fill="${on ? 'var(--accent)' : '#3a3c44'}"/>` +
      `<text x="${i * bw + bw / 2}" y="${H + 13}" font-size="10" text-anchor="middle" fill="${on ? 'var(--fg)' : 'var(--muted)'}">${monthName(m)[0]}</text></g>`;
  }).join('');
  svg.addEventListener('click', (e) => { const g = e.target.closest('g'); if (g) onPick(g.dataset.m); });
  return svg;
}
const logo = (t) => h('div', { class: 'logo' }, t.logo ? h('img', { src: t.logo, alt: '' }) : (t.name || '?')[0].toUpperCase());

// ---------- shared pieces ----------
const TITLES = { overview: 'Overview', categories: 'Categories', merchants: 'Merchants', paidwith: 'Paid with', cashflow: 'Cash flow' };
const isDebt = (a) => a.type === 'credit' || a.type === 'loan';
const accLabel = (a) => a.name + (a.mask ? ' ••' + a.mask : '');
const txnRow = (t, accName) => h('div', { class: 'row' }, logo(t), h('div', { class: 'grow' }, h('div', { class: 'name' }, t.name),
  h('div', { class: 'sub' }, dayName(t.date) + (accName && accName[t.account_id] ? ' · ' + accName[t.account_id] : '') + (t.pending ? ' · pending' : ''))),
  h('div', { class: 'amt' + (t.amount < 0 ? ' pos' : '') }, (t.amount < 0 ? '+' : '') + money(Math.abs(t.amount), true)));
const accRow = (a) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, accLabel(a)),
  h('div', { class: 'sub' }, (conn === 'all' && a.institution ? a.institution + ' · ' : '') + nice(a.subtype || a.type))),
  h('div', { class: 'amt' }, money(a.balances.current || 0, true)));
function loadingBanner() {
  const l = loadingConns().filter((c) => conn === 'all' || c.item_id === conn);
  return l.length ? h('div', { class: 'banner' }, h('div', { class: 'spinner' }),
    'Pulling transactions from ' + l.map((c) => c.institution || 'your bank').join(', ') + '. This can take a few minutes.') : null;
}
function noData(el) {
  el.append(h('div', { class: 'empty' }, h('p', {}, 'No accounts connected yet.'),
    h('button', { class: 'btn primary', onclick: () => connect() }, '+ Connect an account')));
}
function monthPicker(months, values, rerender) {
  month = month && months.includes(month) ? month : months[months.length - 1];
  return barChart(months, values, (m) => { month = m; open.clear(); rerender(); }, month);
}

// ---------- Overview ----------
function viewOverview(el) {
  if (!data || !data.connections.length) { noData(el); if (!loans.length) return; }
  el.append(loadingBanner());
  const accs = allAccounts(), have = accs.filter((a) => !isDebt(a)), owe = accs.filter(isDebt);
  const sum = (l) => l.reduce((s, a) => s + (a.balances.current || 0), 0);
  const manual = conn === 'all' ? loans.map((l) => ({ l, bal: loanStatus(l).balance })) : [];
  const haveTotal = sum(have), oweTotal = sum(owe) + manual.reduce((s, m) => s + m.bal, 0);
  el.append(h('div', { class: 'split' },
    h('div', { class: 'card' }, h('h2', {}, 'You have'), h('div', { class: 'amt hero pos' }, money(haveTotal))),
    h('div', { class: 'card' }, h('h2', {}, 'You owe'), h('div', { class: 'amt hero neg' }, money(oweTotal)))));
  const byKind = (list, kinds) => kinds.map(([label, test]) => [label, list.filter(test)]).filter(([, l]) => l.length);
  const haveGroups = byKind(have, [['Checking', (a) => a.subtype === 'checking'], ['Savings', (a) => a.subtype === 'savings'],
    ['Investments', (a) => a.type === 'investment' || a.type === 'brokerage'],
    ['Other cash', (a) => a.subtype !== 'checking' && a.subtype !== 'savings' && a.type !== 'investment' && a.type !== 'brokerage']]);
  const oweGroups = byKind(owe, [['Credit cards', (a) => a.type === 'credit'], ['Loans', (a) => a.type === 'loan']]);
  const groupCard = (title, groups, extra) => h('div', { class: 'card' }, h('h2', {}, title),
    groups.map(([label, list]) => [h('div', { class: 'row grp' }, h('div', { class: 'grow' }, label), h('div', { class: 'amt' }, money(sum(list), true))),
      list.sort((a, b) => (b.balances.current || 0) - (a.balances.current || 0)).map(accRow)]), extra);
  if (haveGroups.length) el.append(groupCard('Money you have', haveGroups));
  if (oweGroups.length || manual.length) el.append(groupCard('Money you owe', oweGroups, manual.length ? [
    h('div', { class: 'row grp' }, h('div', { class: 'grow' }, 'Tracked loans'), h('div', { class: 'amt' }, money(manual.reduce((s, m) => s + m.bal, 0), true))),
    manual.map(({ l, bal }) => h('div', { class: 'row tap', onclick: () => openPanel('loans') }, h('div', { class: 'grow' }, h('div', { class: 'name' }, l.name),
      h('div', { class: 'sub' }, 'Estimated · tap for details')), h('div', { class: 'amt' }, money(bal, true))))] : null));
  const t = totals();
  const hist = conn === 'all' && data ? data.history.map((p) => ({ v: p.assets - p.debts })) : [];
  if (hist.length) hist[hist.length - 1] = { v: t.net };
  el.append(h('div', { class: 'card' }, h('h2', {}, 'Net worth'), h('div', { class: 'big' }, money(t.net)), lineChart(hist)));
  const m = monthKey(todayISO()), spent = byMonth(spending())[m] || 0, earned = byMonth(income())[m] || 0;
  el.append(h('div', { class: 'card' }, h('h2', {}, monthName(m, true)),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, 'Spent'), h('div', { class: 'amt' }, money(spent))),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, 'Came in'), h('div', { class: 'amt pos' }, money(earned)))));
  if (data && data.synced) el.append(h('p', { class: 'muted', style: 'text-align:center;font-size:13px' }, 'Updated ' + new Date(data.synced).toLocaleString()));
}

// ---------- Breakdowns (categories / merchants / paid with) ----------
function breakdown(el, keyOf, labelOf, icon, rerender) {
  if (!data || !data.connections.length) return noData(el);
  el.append(loadingBanner());
  const list = spending();
  if (!list.length) { el.append(h('div', { class: 'empty' }, 'No spending yet.')); return; }
  const months = lastMonths(12), per = byMonth(list);
  const picker = monthPicker(months, months.map((x) => per[x] || 0), rerender);
  const inMonth = list.filter((t) => monthKey(t.date) === month);
  const total = inMonth.reduce((s, t) => s + t.amount, 0);
  const prev = months[months.indexOf(month) - 1], prevTotal = prev ? per[prev] || 0 : 0;
  const diff = prevTotal ? ((total - prevTotal) / prevTotal) * 100 : null;
  el.append(h('div', { class: 'card' }, h('h2', {}, 'Spent in ' + monthName(month, true)), h('div', { class: 'big' }, money(total)),
    diff == null ? null : h('div', { class: 'sub ' + (diff > 0 ? 'neg' : 'pos') }, `${diff > 0 ? '▲' : '▼'} ${Math.abs(diff).toFixed(0)}% vs ${monthName(prev)}`), picker));
  const groups = {};
  for (const t of inMonth) (groups[keyOf(t)] = groups[keyOf(t)] || []).push(t);
  const sorted = Object.entries(groups).map(([k, l]) => [k, l, l.reduce((s, t) => s + t.amount, 0)]).sort((a, b) => b[2] - a[2]);
  const top = sorted.length ? sorted[0][2] : 1;
  const accName = Object.fromEntries(allAccounts().map((a) => [a.account_id, accLabel(a)]));
  const card = h('div', { class: 'card' });
  for (const [k, l, v] of sorted) {
    const isOpen = open.has(k);
    card.append(h('div', { class: 'row tap' + (isOpen ? ' open' : ''), onclick: () => { isOpen ? open.delete(k) : open.add(k); rerender(); } },
      icon ? icon(l[0]) : null,
      h('div', { class: 'grow' }, h('div', { class: 'name' }, labelOf(k, l[0])),
        h('div', { class: 'sub' }, `${l.length} ${l.length === 1 ? 'purchase' : 'purchases'} · ${Math.round((v / total) * 100)}%`),
        h('div', { class: 'bar' }, h('i', { style: `width:${(v / top) * 100}%` }))),
      h('div', { class: 'amt' }, money(v, true)), h('span', { class: 'chev' }, '›')));
    if (isOpen) card.append(h('div', { class: 'drill' }, l.sort((a, b) => (a.date < b.date ? 1 : -1)).map((t) => txnRow(t, accName))));
  }
  el.append(card);
}
function viewCategories(el) { breakdown(el, (t) => t.category || 'OTHER', (k) => nice(k), null, render); }
function viewMerchants(el) {
  breakdown(el, (t) => t.name || 'Unknown', (k) => k, logo, render);
  const subs = data && data.connections.length ? subscriptions() : [];
  if (subs.length) el.append(h('div', { class: 'card' }, h('h2', {}, `Recurring · ${money(subs.reduce((s, x) => s + x.amount, 0), true)}/mo`),
    subs.map((s) => h('div', { class: 'row' }, logo(s), h('div', { class: 'grow' }, h('div', { class: 'name' }, s.name),
      h('div', { class: 'sub' }, 'Last ' + dayName(s.last))), h('div', { class: 'amt' }, money(s.amount, true))))));
}
function viewPaidWith(el) {
  const accs = Object.fromEntries(allAccounts().map((a) => [a.account_id, a]));
  breakdown(el, (t) => t.account_id, (k) => (accs[k] ? accLabel(accs[k]) : 'Other account'), null, render);
}

// ---------- Cash flow ----------
function viewCashflow(el) {
  if (!data || !data.connections.length) return noData(el);
  el.append(loadingBanner());
  const months = lastMonths(12), out = byMonth(spending()), inc = byMonth(income());
  if (!months.some((m) => out[m] || inc[m])) { el.append(h('div', { class: 'empty' }, 'No activity yet.')); return; }
  const W = 320, H = 120, max = Math.max(1, ...months.flatMap((m) => [out[m] || 0, inc[m] || 0])), bw = W / months.length;
  const svg = h('svg', { class: 'chart', viewBox: `0 0 ${W} ${H + 16}` });
  svg.innerHTML = months.map((m, i) => {
    const a = ((inc[m] || 0) / max) * (H - 4), b = ((out[m] || 0) / max) * (H - 4), x = i * bw;
    return `<rect x="${x + bw * 0.12}" y="${H - a}" width="${bw * 0.36}" height="${Math.max(a, 1)}" rx="2" fill="var(--good)"/>` +
      `<rect x="${x + bw * 0.52}" y="${H - b}" width="${bw * 0.36}" height="${Math.max(b, 1)}" rx="2" fill="var(--bad)"/>` +
      `<text x="${x + bw / 2}" y="${H + 13}" font-size="10" text-anchor="middle" fill="var(--muted)">${monthName(m)[0]}</text>`;
  }).join('');
  const sumIn = months.reduce((s, m) => s + (inc[m] || 0), 0), sumOut = months.reduce((s, m) => s + (out[m] || 0), 0);
  el.append(h('div', { class: 'card' }, h('h2', {}, 'Last 12 months'), h('div', { class: 'big ' + (sumIn - sumOut >= 0 ? 'pos' : 'neg') }, (sumIn - sumOut >= 0 ? '+' : '') + money(sumIn - sumOut)),
    h('div', { class: 'sub muted' }, `${money(sumIn)} in · ${money(sumOut)} spent`), svg,
    h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'background:var(--good)' }), 'In'), h('span', {}, h('i', { style: 'background:var(--bad)' }), 'Spent'))));
  el.append(h('div', { class: 'card' }, h('h2', {}, 'By month'), months.slice().reverse().filter((m) => out[m] || inc[m]).map((m) => {
    const net = (inc[m] || 0) - (out[m] || 0);
    return h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, monthName(m, true)),
      h('div', { class: 'sub' }, `${money(inc[m] || 0)} in · ${money(out[m] || 0)} spent`)),
      h('div', { class: 'amt ' + (net >= 0 ? 'pos' : 'neg') }, (net >= 0 ? '+' : '') + money(net)));
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
  const key = opts.map((o) => o.join(':')).join('|') + '#' + conn;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(...opts.map(([id, label]) => h('button', { class: 'chip' + (id === conn ? ' on' : ''), onclick: () => pickConn(id) }, label)));
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
  $('title').textContent = TITLES[view];
  const el = $('view'); el.replaceChildren();
  VIEWS[view](el);
  if (anim) { el.classList.remove('slide-l', 'slide-r', 'fade'); void el.offsetWidth; el.classList.add(anim); }
  renderPanel();
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
function showApp() { $('login').hidden = true; $('main').hidden = false; $('tabbar').hidden = false; view = 'overview'; setTab(); render(); }
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
