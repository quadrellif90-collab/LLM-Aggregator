const BASE = '';
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const auth = TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {};

async function api(path, opts) {
  return fetch(BASE + path, Object.assign({ headers: { 'content-type': 'application/json', ...auth } }, opts));
}
function el(id) { return document.getElementById(id); }

async function loadState() {
  const s = await api('/hub/state').then((r) => r.json());
  el('status').textContent =
    s.models + ' models · ' + s.providers + ' providers · cache ' + (s.cache ? 'on' : 'off');
  const sel = el('profileSel');
  sel.innerHTML = Object.keys(s.profiles).map((p) => '<option>' + p + '</option>').join('');
  const profs = el('profilesList');
  profs.innerHTML = Object.keys(s.profiles)
    .map((p) => '<li><strong>' + p + '</strong> — ' + s.profiles[p].length + ' models</li>')
    .join('');
}

async function loadModels() {
  const models = await api('/hub/models').then((r) => r.json());
  const byProv = {};
  models.forEach((m) => { (byProv[m.provider] = byProv[m.provider] || []).push(m.id + (m.free ? ' (free)' : '')); });
  el('modelsList').innerHTML = Object.keys(byProv)
    .map((p) => '<li><strong>' + p + '</strong><br>' + byProv[p].join(', ') + '</li>')
    .join('');
}

async function loadProviders() {
  const { providers } = await api('/hub/providers').then((r) => r.json());
  el('providersList').innerHTML = providers
    .map((p) => '<li><strong>' + p.label + '</strong> (' + p.name + ') — ' +
      (p.enabled ? 'enabled' : 'disabled') + ' · ' + p.modelCount + ' models · ' +
      (p.needsKey ? 'needs key' : 'no key') +
      ' <button data-toggle="' + p.name + '" data-enabled="' + !p.enabled + '">' +
      (p.enabled ? 'Disable' : 'Enable') + '</button></li>')
    .join('');
  document.querySelectorAll('[data-toggle]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api('/hub/provider/toggle', { method: 'POST', body: JSON.stringify({ name: b.dataset.toggle, enabled: b.dataset.enabled === 'true' }) });
      loadProviders(); loadState();
    });
  });
}

async function loadKeys() {
  const a = await api('/hub/export').then((r) => r.json());
  el('keyList').innerHTML = (a.auth.entries || []).map((e) => '<li>' + e.name + '</li>').join('') || '<li>no keys</li>';
}

async function loadExperiments() {
  const { experiments } = await api('/hub/experiments').then((r) => r.json());
  el('expList').innerHTML = Object.keys(experiments)
    .map((n) => '<li><strong>' + n + '</strong>: ' + experiments[n].variants.join(', ') + '</li>')
    .join('') || '<li>no experiments</li>';
}

async function loadUsage() {
  const u = await api('/hub/usage').then((r) => r.json());
  const rows = Object.keys(u.usage).map((m) => '<li>' + m + ': ' + u.usage[m] + ' req</li>').join('');
  el('usageView').innerHTML =
    '<li>Total requests: ' + u.requests + '</li>' +
    '<li>Total tokens: ' + u.tokens + '</li>' +
    '<li>Total cost: ' + u.cost.toFixed(6) + '</li>' +
    '<li>Cache hits: ' + u.cacheHits + '</li><hr>' + (rows || '<li>no per-model usage yet</li>');
}

async function loadFeatures() {
  const f = await api('/hub/features').then((r) => r.json());
  el('featCache').checked = !!f.cache;
  el('featEnhancer').checked = !!(f.enhancer !== false);
}

el('sendBtn').addEventListener('click', async () => {
  const profile = el('profileSel').value;
  const prompt = el('prompt').value;
  const stream = el('streamChk').checked;
  const out = el('out');
  out.textContent = '…';
  try {
    const r = await api('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: profile, stream, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json();
    out.textContent = (j.choices && j.choices[0].message.content) || JSON.stringify(j, null, 2);
  } catch (e) {
    out.textContent = 'error: ' + e.message;
  }
  loadUsage();
});

el('keyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = el('keyName').value;
  const key = el('keyValue').value;
  if (!name || !key) return;
  await api('/hub/key', { method: 'POST', body: JSON.stringify({ name, key }) });
  el('keyValue').value = '';
  loadKeys();
});

el('provAdd').addEventListener('click', async () => {
  const name = el('provName').value.trim();
  const baseURL = el('provUrl').value.trim();
  const models = el('provModels').value.split(',').map((s) => s.trim()).filter(Boolean).map((id) => ({ id }));
  if (!name || !baseURL) return;
  const res = await api('/hub/provider/add', { method: 'POST', body: JSON.stringify({ name, label: name, baseURL, needsKey: el('provKey').checked, authId: name, models }) });
  if (!res.ok) el('providersList').insertAdjacentHTML('afterbegin', '<li>add failed: ' + (await res.json()).error.message + '</li>');
  el('provName').value = ''; el('provUrl').value = ''; el('provModels').value = '';
  loadProviders(); loadState();
});

el('provReorder').addEventListener('click', async () => {
  const names = el('provOrder').value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.length) return;
  await api('/hub/provider/reorder', { method: 'POST', body: JSON.stringify({ names }) });
  loadProviders();
});

el('featSave').addEventListener('click', async () => {
  await api('/hub/features', { method: 'POST', body: JSON.stringify({ cache: el('featCache').checked, enhancer: el('featEnhancer').checked }) });
  el('featStatus').textContent = 'saved';
});

el('cacheClear').addEventListener('click', async () => {
  await api('/hub/cache/clear', { method: 'POST' });
  el('featStatus').textContent = 'cache cleared';
});

el('expAdd').addEventListener('click', async () => {
  const name = el('expName').value.trim();
  const variants = el('expVariants').value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!name || !variants.length) return;
  await api('/hub/experiment', { method: 'POST', body: JSON.stringify({ name, variants }) });
  el('expName').value = ''; el('expVariants').value = '';
  loadExperiments();
});

el('hookSave').addEventListener('click', async () => {
  const url = el('hookUrl').value.trim();
  await api('/hub/webhook', { method: 'POST', body: JSON.stringify({ url: url || null }) });
  el('hookStatus').textContent = 'webhook set to: ' + (url || 'none');
});

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    el('tab-' + t.dataset.tab).classList.add('active');
    if (t.dataset.tab === 'usage') loadUsage();
    if (t.dataset.tab === 'experiments') loadExperiments();
    if (t.dataset.tab === 'keys') loadKeys();
  });
});

loadState();
loadModels();
loadProviders();
loadFeatures();
