const BASE = '';
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const auth = TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {};

async function api(path, opts) {
  return fetch(BASE + path, Object.assign({ headers: { 'content-type': 'application/json', ...auth } }, opts));
}

async function loadState() {
  const s = await api('/hub/state').then((r) => r.json());
  document.getElementById('status').textContent =
    s.models + ' models · ' + s.providers + ' providers · cache ' + (s.cache ? 'on' : 'off');
  const profs = document.getElementById('profiles');
  profs.innerHTML = '';
  Object.keys(s.profiles).forEach((p) => {
    const li = document.createElement('li');
    li.textContent = p + ' — ' + s.profiles[p].length + ' models';
    profs.appendChild(li);
  });
  const sel = document.getElementById('profileSel');
  sel.innerHTML = Object.keys(s.profiles).map((p) => '<option>' + p + '</option>').join('');
}

async function loadProviders() {
  const models = await api('/hub/models').then((r) => r.json());
  const byProv = {};
  models.forEach((m) => { (byProv[m.provider] = byProv[m.provider] || []).push(m.label + (m.free ? ' (free)' : '')); });
  const ul = document.getElementById('providers');
  ul.innerHTML = '';
  Object.keys(byProv).forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = '<strong>' + p + '</strong><br>' + byProv[p].join(', ');
    ul.appendChild(li);
  });
}

document.getElementById('keyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('keyName').value;
  const key = document.getElementById('keyValue').value;
  if (!name || !key) return;
  await api('/hub/key', { method: 'POST', body: JSON.stringify({ name, key }) });
  document.getElementById('keyValue').value = '';
  loadProviders();
});

document.getElementById('sendBtn').addEventListener('click', async () => {
  const profile = document.getElementById('profileSel').value;
  const prompt = document.getElementById('prompt').value;
  const out = document.getElementById('out');
  out.textContent = '…';
  const r = await api('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: profile, stream: false, messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await r.json();
  out.textContent = (j.choices && j.choices[0].message.content) || JSON.stringify(j, null, 2);
});

loadState();
loadProviders();
