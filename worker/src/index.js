// Plaid relay for the Finances app. Holds the Plaid keys and bank access tokens (as Worker
// secrets / KV), and only answers requests carrying the app password.

const PLAID_HOSTS = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' };
const ITEMS_KEY = 'items';
const HISTORY_KEY = 'history';
const SNAPSHOT_KEY = 'snapshot';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    try {
      if (!(await authorized(request, env))) return reply({ error: 'bad_password' }, 401);
      const path = new URL(request.url).pathname;
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      if (path === '/login') return reply({ ok: true, env: env.PLAID_ENV });
      if (path === '/link-token') return reply(await linkToken(env, body));
      if (path === '/exchange') return reply(await exchange(env, body));
      if (path === '/sync') return reply(await syncAll(env));
      if (path === '/data') return reply(await loadData(env));
      if (path === '/remove') return reply(await removeItem(env, body));
      return reply({ error: 'not_found' }, 404);
    } catch (e) {
      return reply({ error: e.code || 'server_error', message: e.message }, e.status || 500);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(syncAll(env));
  },
};

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(buf);
}

// Compare hashes so the check takes the same time whatever the guess.
async function authorized(request, env) {
  if (!env.APP_PASSWORD) return false;
  const given = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
  const [a, b] = await Promise.all([sha256(given), sha256(env.APP_PASSWORD)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function plaid(env, endpoint, payload) {
  const host = env.PLAID_BASE_URL || PLAID_HOSTS[env.PLAID_ENV] || PLAID_HOSTS.sandbox;
  const res = await fetch(host + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...payload }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error_message || 'Plaid error');
    err.code = data.error_code || 'plaid_error';
    err.status = 502;
    throw err;
  }
  return data;
}

const getJSON = async (env, key, fallback) => (await env.FIN.get(key, 'json')) ?? fallback;
const putJSON = (env, key, value) => env.FIN.put(key, JSON.stringify(value));

async function linkToken(env, { item_id }) {
  const payload = {
    client_name: 'Finances',
    language: 'en',
    country_codes: ['US'],
    user: { client_user_id: 'owner' },
  };
  if (env.REDIRECT_URI) payload.redirect_uri = env.REDIRECT_URI;
  if (item_id) {
    // Update mode: re-login for a connection whose bank session expired.
    const item = (await getJSON(env, ITEMS_KEY, [])).find((i) => i.item_id === item_id);
    if (!item) throw Object.assign(new Error('Unknown connection'), { code: 'unknown_item', status: 404 });
    payload.access_token = item.access_token;
  } else {
    payload.products = ['transactions'];
    payload.optional_products = ['liabilities', 'investments'];
    payload.transactions = { days_requested: 730 };
  }
  const data = await plaid(env, '/link/token/create', payload);
  return { link_token: data.link_token };
}

async function exchange(env, { public_token, institution }) {
  const data = await plaid(env, '/item/public_token/exchange', { public_token });
  const items = await getJSON(env, ITEMS_KEY, []);
  items.push({
    item_id: data.item_id,
    access_token: data.access_token,
    institution: institution || null,
    cursor: null,
    added: new Date().toISOString(),
  });
  await putJSON(env, ITEMS_KEY, items);
  return { ...(await syncAll(env, data.item_id)), added_item: data.item_id };
}

const pickTxn = (t) => ({
  id: t.transaction_id,
  account_id: t.account_id,
  amount: t.amount,
  date: t.date,
  name: t.merchant_name || t.name,
  raw: t.name,
  category: t.personal_finance_category ? t.personal_finance_category.primary : null,
  detail: t.personal_finance_category ? t.personal_finance_category.detailed : null,
  pending: t.pending,
  logo: t.logo_url || null,
});

async function syncTransactions(env, item) {
  const key = `txns:${item.item_id}`;
  const stored = new Map((await getJSON(env, key, [])).map((t) => [t.id, t]));
  // Plaid requires restarting the whole page loop from the first cursor if data changes mid-loop.
  for (let attempt = 0; attempt < 3; attempt++) {
    let cursor = item.cursor, status = null;
    const added = [], modified = [], removed = [];
    try {
      let more = true;
      while (more) {
        const page = await plaid(env, '/transactions/sync', {
          access_token: item.access_token, cursor: cursor || undefined, count: 500,
        });
        added.push(...page.added);
        modified.push(...page.modified);
        removed.push(...page.removed);
        cursor = page.next_cursor;
        status = page.transactions_update_status || status;
        more = page.has_more;
      }
    } catch (e) {
      if (e.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') continue;
      throw e;
    }
    for (const t of [...added, ...modified]) stored.set(t.transaction_id, pickTxn(t));
    for (const r of removed) stored.delete(r.transaction_id);
    // Until Plaid's first pull finishes there's nothing to page through, so start over next time.
    if (!(status === 'NOT_READY' && !added.length)) item.cursor = cursor;
    await putJSON(env, key, [...stored.values()]);
    return status;
  }
}

async function syncItem(env, item) {
  const result = { item_id: item.item_id, institution: item.institution, error: null };
  try {
    result.tx_status = await syncTransactions(env, item);
    if (!item.brand) {
      try {
        const it = await plaid(env, '/item/get', { access_token: item.access_token });
        const inst = await plaid(env, '/institutions/get_by_id', { institution_id: it.item.institution_id, country_codes: ['US'], options: { include_optional_metadata: true } });
        item.brand = { logo: inst.institution.logo || null, color: inst.institution.primary_color || null };
      } catch (_) { item.brand = { logo: null, color: null }; }
    }
    result.brand = item.brand;
    const acc = await plaid(env, '/accounts/get', { access_token: item.access_token });
    result.accounts = acc.accounts;
    try {
      const li = await plaid(env, '/liabilities/get', { access_token: item.access_token });
      result.liabilities = li.liabilities;
    } catch (_) { result.liabilities = null; }
    try {
      const inv = await plaid(env, '/investments/holdings/get', { access_token: item.access_token });
      result.holdings = inv.holdings;
      result.securities = inv.securities;
    } catch (_) { result.holdings = null; }
  } catch (e) {
    result.error = e.code || 'sync_failed';
  }
  return result;
}

// With onlyId, just that connection is fetched (a new one); the rest keep their last snapshot.
async function syncAll(env, onlyId) {
  const items = await getJSON(env, ITEMS_KEY, []);
  const previous = await getJSON(env, SNAPSHOT_KEY, { items: [] });
  const results = [];
  for (const item of items) {
    const old = previous.items.find((p) => p.item_id === item.item_id);
    if (onlyId && item.item_id !== onlyId && old) { results.push(old); continue; }
    const r = await syncItem(env, item);
    // Keep the last good data for a connection that failed this time.
    results.push(r.error && old ? { ...old, error: r.error } : r);
  }
  await putJSON(env, ITEMS_KEY, items);
  const snapshot = { synced: new Date().toISOString(), items: results };
  await putJSON(env, SNAPSHOT_KEY, snapshot);
  await recordNetWorth(env, results);
  return loadData(env);
}

function netWorth(results) {
  let assets = 0, debts = 0;
  for (const r of results) for (const a of r.accounts || []) {
    const bal = a.balances.current || 0;
    if (a.type === 'credit' || a.type === 'loan') debts += bal;
    else assets += bal;
  }
  return { assets, debts };
}

async function recordNetWorth(env, results) {
  const history = await getJSON(env, HISTORY_KEY, []);
  const day = new Date().toISOString().slice(0, 10);
  const point = { date: day, ...netWorth(results) };
  const last = history[history.length - 1];
  if (last && last.date === day) history[history.length - 1] = point;
  else history.push(point);
  await putJSON(env, HISTORY_KEY, history);
}

async function loadData(env) {
  const items = await getJSON(env, ITEMS_KEY, []);
  const snapshot = await getJSON(env, SNAPSHOT_KEY, { synced: null, items: [] });
  const history = await getJSON(env, HISTORY_KEY, []);
  const transactions = [];
  for (const item of items) transactions.push(...(await getJSON(env, `txns:${item.item_id}`, [])));
  transactions.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { env: env.PLAID_ENV, synced: snapshot.synced, connections: snapshot.items, transactions, history, added_item: null };
}

async function removeItem(env, { item_id }) {
  const items = await getJSON(env, ITEMS_KEY, []);
  const item = items.find((i) => i.item_id === item_id);
  if (item) {
    await plaid(env, '/item/remove', { access_token: item.access_token }).catch(() => {});
    await putJSON(env, ITEMS_KEY, items.filter((i) => i !== item));
    await env.FIN.delete(`txns:${item_id}`);
  }
  return syncAll(env);
}
