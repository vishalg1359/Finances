'use strict';
// Finances: talks only to the password-protected Worker; Plaid keys never reach the phone.

const DEFAULT_SERVER = '';
const store = {
  get: (k, d) => { try { const v = localStorage.getItem('fin.' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set: (k, v) => { try { localStorage.setItem('fin.' + k, JSON.stringify(v)); } catch (_) {} },
  del: (k) => localStorage.removeItem('fin.' + k),
};

let data = store.get('data', null);
let loans = store.get('loans', []);
let view = 'overview';
let spendMonth = null;
let actQuery = '';

const $ = (id) => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
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
function gotData(d) { data = d; store.set('data', d); render(); }
async function refresh(full) {
  const b = $('sync-btn'); b.classList.add('spin');
  try { gotData(await api(full ? '/sync' : '/data', full ? {} : undefined)); if (full) toast('Synced'); }
  catch (e) { toast(e.message); }
  finally { b.classList.remove('spin'); }
}

// ---------- Plaid Link ----------
function openLink(token, received) {
  const handler = Plaid.create({
    token, receivedRedirectUri: received,
    onSuccess: async (public_token, meta) => {
      store.del('linkToken');
      if (received) history.replaceState(null, '', location.pathname);
      toast('Connecting ' + ((meta.institution && meta.institution.name) || 'account') + '…');
      try { gotData(await api('/exchange', { public_token, institution: meta.institution && meta.institution.name })); toast('Connected'); }
      catch (e) { toast(e.message); }
    },
    onExit: (err) => { store.del('linkToken'); if (err) toast(err.display_message || err.error_message || 'Cancelled'); },
  });
  handler.open();
}
async function connect(item_id) {
  try {
    const { link_token } = await api('/link-token', { item_id });
    store.set('linkToken', link_token);
    openLink(link_token);
  } catch (e) { toast(e.message); }
}

// ---------- derived data ----------
const allAccounts = () => (data ? data.connections.flatMap((c) => (c.accounts || []).map((a) => ({ ...a, institution: c.institution }))) : []);
const NOT_SPENDING = new Set(['INCOME', 'TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS']);
const txns = () => (data ? data.transactions : []);
const spending = () => txns().filter((t) => t.amount > 0 && !NOT_SPENDING.has(t.category));
const income = () => txns().filter((t) => t.amount < 0 && t.category === 'INCOME');

function totals() {
  let cash = 0, invest = 0, credit = 0, loan = 0;
  for (const a of allAccounts()) {
    const b = a.balances.current || 0;
    if (a.type === 'depository') cash += b; else if (a.type === 'investment' || a.type === 'brokerage') invest += b;
    else if (a.type === 'credit') credit += b; else if (a.type === 'loan') loan += b; else cash += b;
  }
  const manual = loans.reduce((s, l) => s + loanStatus(l).balance, 0);
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
  return txns().filter((t) => t.amount > 0 && t.date > l.asOf && words.some((w) => (t.raw + ' ' + t.name).toLowerCase().includes(w)))
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
  if (points.length < 2) return h('p', { class: 'muted' }, 'The trend line fills in as the app syncs each day.');
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

// ---------- views ----------
function viewOverview() {
  const el = $('view-overview'); el.replaceChildren();
  if (!data || !data.connections.length) {
    el.append(h('div', { class: 'empty' }, h('p', {}, 'No accounts connected yet.'),
      h('button', { class: 'btn primary', onclick: () => connect() }, '+ Connect an account')));
    if (!loans.length) return;
  }
  const t = totals();
  const hist = (data ? data.history : []).map((p) => ({ v: p.assets - p.debts }));
  if (hist.length) hist[hist.length - 1] = { v: t.net };
  el.append(h('div', { class: 'card' }, h('h2', {}, 'Net worth'), h('div', { class: 'big' }, money(t.net)), lineChart(hist)));
  el.append(h('div', { class: 'split' },
    h('div', { class: 'card' }, h('h2', {}, 'Cash'), h('div', { class: 'amt' }, money(t.cash))),
    h('div', { class: 'card' }, h('h2', {}, 'Invested'), h('div', { class: 'amt' }, money(t.invest)))));
  el.append(h('div', { class: 'split', style: 'margin-top:10px' },
    h('div', { class: 'card' }, h('h2', {}, 'Cards'), h('div', { class: 'amt neg' }, money(t.credit))),
    h('div', { class: 'card' }, h('h2', {}, 'Loans'), h('div', { class: 'amt neg' }, money(t.loan)))));
  const m = monthKey(todayISO()), spent = byMonth(spending())[m] || 0, earned = byMonth(income())[m] || 0;
  el.append(h('div', { class: 'card' }, h('h2', {}, monthName(m, true)),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, 'Spent'), h('div', { class: 'amt' }, money(spent))),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, 'Income'), h('div', { class: 'amt pos' }, money(earned)))));
  const groups = {};
  for (const a of allAccounts()) (groups[a.institution || 'Accounts'] = groups[a.institution || 'Accounts'] || []).push(a);
  for (const [inst, accs] of Object.entries(groups)) {
    el.append(h('div', { class: 'card' }, h('h2', {}, inst), accs.map((a) => {
      const debt = a.type === 'credit' || a.type === 'loan';
      return h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, a.name),
        h('div', { class: 'sub' }, nice(a.subtype || a.type) + (a.mask ? ' ••' + a.mask : ''))),
        h('div', { class: 'amt' + (debt ? ' neg' : '') }, money(a.balances.current || 0, true)));
    })));
  }
  if (data && data.synced) el.append(h('p', { class: 'muted', style: 'text-align:center;font-size:13px' }, 'Updated ' + new Date(data.synced).toLocaleString()));
}

function viewSpending() {
  const el = $('view-spending'); el.replaceChildren();
  const list = spending();
  if (!list.length) { el.append(h('div', { class: 'empty' }, 'No spending yet.')); return; }
  const months = lastMonths(12), per = byMonth(list);
  spendMonth = spendMonth || months[months.length - 1];
  const inMonth = list.filter((t) => monthKey(t.date) === spendMonth);
  const total = inMonth.reduce((s, t) => s + t.amount, 0);
  const prev = months[months.indexOf(spendMonth) - 1], prevTotal = prev ? per[prev] || 0 : 0;
  const diff = prevTotal ? ((total - prevTotal) / prevTotal) * 100 : null;
  el.append(h('div', { class: 'card' }, h('h2', {}, monthName(spendMonth, true)), h('div', { class: 'big' }, money(total)),
    diff == null ? null : h('div', { class: 'sub ' + (diff > 0 ? 'neg' : 'pos') }, `${diff > 0 ? '▲' : '▼'} ${Math.abs(diff).toFixed(0)}% vs ${monthName(prev)}`),
    barChart(months, months.map((m) => per[m] || 0), (m) => { spendMonth = m; viewSpending(); }, spendMonth)));
  const cats = {};
  for (const t of inMonth) cats[t.category] = (cats[t.category] || 0) + t.amount;
  const catList = Object.entries(cats).sort((a, b) => b[1] - a[1]), top = catList.length ? catList[0][1] : 1;
  el.append(h('div', { class: 'card' }, h('h2', {}, 'By category'), catList.map(([c, v]) =>
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, nice(c)),
      h('div', { class: 'bar' }, h('i', { style: `width:${(v / top) * 100}%` }))), h('div', { class: 'amt' }, money(v))))));
  const merch = {};
  for (const t of inMonth) { const m = (merch[t.name] = merch[t.name] || { v: 0, n: 0, t }); m.v += t.amount; m.n++; }
  el.append(h('div', { class: 'card' }, h('h2', {}, 'Top merchants'), Object.entries(merch).sort((a, b) => b[1].v - a[1].v).slice(0, 8)
    .map(([name, m]) => h('div', { class: 'row' }, logo(m.t), h('div', { class: 'grow' }, h('div', { class: 'name' }, name),
      h('div', { class: 'sub' }, m.n + (m.n === 1 ? ' purchase' : ' purchases'))), h('div', { class: 'amt' }, money(m.v, true))))));
  const subs = subscriptions();
  if (subs.length) el.append(h('div', { class: 'card' }, h('h2', {}, `Recurring · ${money(subs.reduce((s, x) => s + x.amount, 0), true)}/mo`),
    subs.map((s) => h('div', { class: 'row' }, logo(s), h('div', { class: 'grow' }, h('div', { class: 'name' }, s.name),
      h('div', { class: 'sub' }, 'Last ' + dayName(s.last))), h('div', { class: 'amt' }, money(s.amount, true))))));
}

function viewActivity() {
  const el = $('view-activity');
  const q = actQuery.toLowerCase();
  const list = txns().filter((t) => !q || (t.name + ' ' + t.raw + ' ' + nice(t.category)).toLowerCase().includes(q)).slice(0, 300);
  const input = h('input', { class: 'search', type: 'search', placeholder: 'Search transactions', value: actQuery });
  input.addEventListener('input', () => { actQuery = input.value; const pos = input.selectionStart; viewActivity(); const n = $('view-activity').querySelector('input'); n.focus(); n.setSelectionRange(pos, pos); });
  el.replaceChildren(input);
  if (!list.length) { el.append(h('div', { class: 'empty' }, q ? 'No matches.' : 'No transactions yet.')); return; }
  const accName = Object.fromEntries(allAccounts().map((a) => [a.account_id, a.name]));
  let day = null, card = null;
  for (const t of list) {
    if (t.date !== day) { day = t.date; el.append(h('div', { class: 'day' }, dayName(day))); card = h('div', { class: 'card', style: 'margin-top:4px' }); el.append(card); }
    card.append(h('div', { class: 'row' }, logo(t), h('div', { class: 'grow' }, h('div', { class: 'name' }, t.name),
      h('div', { class: 'sub' }, nice(t.category) + ' · ' + (accName[t.account_id] || '') + (t.pending ? ' · pending' : ''))),
      h('div', { class: 'amt' + (t.amount < 0 ? ' pos' : '') }, (t.amount < 0 ? '+' : '') + money(Math.abs(t.amount), true))));
  }
}

function loanForm(existing) {
  const l = existing || { id: Date.now().toString(36), name: 'Aidvantage', balance: '', rate: '', payment: '', asOf: todayISO(), match: 'aidvantage, dept education, dept of ed' };
  const f = (label, key, type) => h('div', { class: 'field' }, h('label', {}, label),
    h('input', { type, step: 'any', value: l[key], 'data-k': key, inputmode: type === 'number' ? 'decimal' : null }));
  const card = h('div', { class: 'card' }, h('h2', {}, existing ? 'Edit loan' : 'Add a loan'),
    f('Name', 'name', 'text'), f('Balance on that date', 'balance', 'number'), f('As of', 'asOf', 'date'),
    f('Interest rate (%)', 'rate', 'number'), f('Monthly payment', 'payment', 'number'),
    f('Payment names to look for (comma separated)', 'match', 'text'),
    h('button', { class: 'btn primary', onclick: () => {
      for (const i of card.querySelectorAll('input')) l[i.dataset.k] = i.type === 'number' ? parseFloat(i.value) || 0 : i.value;
      loans = loans.filter((x) => x.id !== l.id).concat(l); store.set('loans', loans); viewLoans();
    } }, 'Save'),
    existing ? h('button', { class: 'btn danger', onclick: () => { loans = loans.filter((x) => x.id !== l.id); store.set('loans', loans); viewLoans(); } }, 'Delete') : null,
    h('button', { class: 'btn', onclick: viewLoans }, 'Cancel'));
  $('view-loans').replaceChildren(card);
}

function viewLoans() {
  const el = $('view-loans'); el.replaceChildren();
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
    el.append(h('div', { class: 'card', onclick: () => loanForm(l) }, h('h2', {}, l.name), h('div', { class: 'big' }, money(st.balance, true)),
      h('div', { class: 'sub muted' }, `Estimated from ${money(l.balance, true)} on ${dayName(l.asOf)}`),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, 'Rate'), h('div', {}, l.rate + '%')),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, 'Payments found since'), h('div', {}, `${st.pays.length} · ${money(st.paid, true)}`)),
      p ? h('div', { class: 'row' }, h('div', { class: 'grow' }, 'Paid off'), h('div', {}, `${p.date} · ${money(p.interest)} interest left`))
        : h('div', { class: 'warn' }, 'Payment doesn’t cover the interest, so this never pays off.'),
      daysBetween(l.asOf, todayISO()) > 180 ? h('div', { class: 'warn' }, 'Over 6 months old: tap to update the balance from your Aidvantage account.') : null));
  }
  if (!plaidLoans.length && !loans.length) el.append(h('div', { class: 'empty' }, 'Aidvantage can’t connect through Plaid, so add each loan once. Payments to it in your bank are picked up automatically.'));
  el.append(h('button', { class: 'btn primary', onclick: () => loanForm() }, '+ Add a loan'));
}

function viewSettings() {
  const el = $('view-settings'); el.replaceChildren();
  el.append(h('button', { class: 'btn primary', onclick: () => connect() }, '+ Connect an account'));
  if (data && data.env === 'sandbox') el.append(h('p', { class: 'warn' }, 'Test mode: using Plaid Sandbox. Log in with user_good / pass_good.'));
  const conns = data ? data.connections : [];
  if (conns.length) el.append(h('div', { class: 'card' }, h('h2', {}, `Connections · ${conns.length} of 10`), conns.map((c) =>
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, c.institution || 'Bank'),
      h('div', { class: 'sub' }, (c.accounts || []).length + ' accounts'), c.error ? h('div', { class: 'warn' }, nice(c.error)) : null),
      c.error ? h('button', { class: 'btn small', onclick: () => connect(c.item_id) }, 'Fix') : null,
      h('button', { class: 'btn small danger', onclick: async () => {
        if (!confirm(`Disconnect ${c.institution || 'this bank'}? This doesn’t free up one of your 10 Plaid slots.`)) return;
        try { gotData(await api('/remove', { item_id: c.item_id })); } catch (e) { toast(e.message); }
      } }, 'Remove')))));
  el.append(h('p', { class: 'muted', style: 'font-size:13px' }, 'Banks update about 1–4 times a day. ↻ pulls the latest, and the server also syncs every morning.'));
  el.append(h('button', { class: 'btn danger', onclick: logout }, 'Lock'));
}

const TITLES = { overview: 'Overview', spending: 'Spending', activity: 'Activity', loans: 'Loans', settings: 'Settings' };
const VIEWS = { overview: viewOverview, spending: viewSpending, activity: viewActivity, loans: viewLoans, settings: viewSettings };
function render() { VIEWS[view](); }
function showView(name) {
  view = name;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.view === name);
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === 'view-' + name);
  $('title').textContent = TITLES[name]; window.scrollTo(0, 0); render();
}

// ---------- login ----------
function logout() { store.del('pass'); store.del('data'); data = null; showLogin(); }
function showLogin() { $('main').hidden = true; $('tabbar').hidden = true; $('login').hidden = false; $('login-url').value = store.get('server', DEFAULT_SERVER); }
function showApp() { $('login').hidden = true; $('main').hidden = false; $('tabbar').hidden = false; render(); }
$('login-btn').addEventListener('click', async () => {
  store.set('server', $('login-url').value.trim()); store.set('pass', $('login-pass').value);
  $('login-err').textContent = '';
  try { await api('/login', {}); $('login-pass').value = ''; showApp(); refresh(false); }
  catch (e) { store.del('pass'); $('login-err').textContent = e.message === 'Wrong password' ? 'Wrong password.' : 'Couldn’t reach the server.'; showLogin(); }
});
$('login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login-btn').click(); });
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showView(t.dataset.view));
$('sync-btn').addEventListener('click', () => refresh(true));

if (store.get('pass', '')) {
  showApp(); refresh(false);
  // Back from a bank's OAuth page: finish the same Link session.
  const pending = store.get('linkToken', null);
  if (pending && location.search.includes('oauth_state_id')) openLink(pending, location.href);
} else showLogin();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
