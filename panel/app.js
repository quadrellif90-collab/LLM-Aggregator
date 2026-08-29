class FreeHubUI {
  constructor() {
    this.state = {
      config: null, prefs: null, providers: [], models: [], profiles: [],
      pricing: {}, strategies: [], usage: {}, state: {}, leaderboard: [], logs: [],
      freemode: false, syncMode: 'auto'
    };
    this.dragProfile = null;
    this.init();
  }

  async init() {
    this.bindEvents();
    setInterval(() => this.refresh(), 15000);
    this.loadTheme();
    this.loadThemeFromPrefs();
    try { await this.refresh(); } catch (e) { console.error(e); }
    this.updateStatus();
  }

  async refresh() {
    this.state.config = await this.tryFetch('/hub/config');
    this.state.prefs = await this.tryFetch('/hub/prefs');
    this.state.providers = await this.tryFetch('/hub/providers');
    this.state.models = await this.tryFetch('/hub/models');
    this.state.pricing = await this.tryFetch('/hub/pricing');
    this.state.usage = await this.tryFetch('/hub/usage');
    this.state.state = await this.tryFetch('/hub/state');
    this.state.logs = await this.tryFetch('/hub/logs');
    this.state.cache = await this.tryFetch('/hub/cache');
    this.state.freemode = await this.tryFetch('/hub/freemode');
    this.state.sync = await this.tryFetch('/hub/sync');
    this.renderAll();
  }

  bindEvents() {
    document.getElementById('refresh').addEventListener('click', () => this.refresh());
    document.getElementById('themeBtn').addEventListener('click', () => this.toggleTheme());
    document.getElementById('exportBtn').addEventListener('click', () => this.exportConfig());
    document.getElementById('probeAll').addEventListener('click', () => this.probeAll());
    document.getElementById('cacheClear').addEventListener('click', () => this.clearCache());
    document.getElementById('gwSave').addEventListener('click', () => this.saveGatewayKeys());
    document.getElementById('bulkImport').addEventListener('click', () => this.bulkImport());
    document.getElementById('settingsSave').addEventListener('click', () => this.saveSettings());
    document.getElementById('plugSave').addEventListener('click', () => this.savePlugins());
    document.getElementById('saveOrder').addEventListener('click', () => this.saveOrder());
    document.getElementById('profileDel').addEventListener('click', () => this.deleteProfile());
    document.getElementById('profileNew').addEventListener('click', () => this.newProfile());
    document.getElementById('np_add').addEventListener('click', () => this.addProvider());
    document.getElementById('scanBtn').addEventListener('click', () => this.scanCatalogs());
    document.getElementById('sendBtn').addEventListener('click', () => this.sendChat());
    document.getElementById('freeModeSel').addEventListener('change', () => this.renderFreeModeStatus());
    document.getElementById('freeModeSave').addEventListener('click', () => this.saveFreeMode());
    document.getElementById('syncModeSel').addEventListener('change', () => this.renderSyncStatus());
    document.getElementById('syncKeys').addEventListener('click', () => this.syncKeys());
    document.getElementById('klSave').addEventListener('click', () => this.saveKeyLimit());
    document.getElementById('expSave').addEventListener('click', () => this.saveExperiment());
    document.getElementById('alertSave').addEventListener('click', () => this.saveWebhook());
    document.getElementById('klKey').addEventListener('change', () => this.renderKeyLimit());
    document.getElementById('pSearch').addEventListener('input', () => this.renderProviders());
    document.getElementById('pFilter').addEventListener('change', () => this.renderProviders());
    document.getElementById('pSort').addEventListener('change', () => this.renderProviders());
    document.getElementById('pCompact').addEventListener('change', () => this.renderProviders());
    this.setupProfileList();
  }

  setupProfileList() {
    const list = document.getElementById('profileList');
    ['dragstart', 'dragend'].forEach((ev) => {
      list.addEventListener(ev, (e) => {
        const li = e.target.closest('li');
        if (!li) return;
        if (ev === 'dragstart') { this.dragProfile = li.dataset.id; li.classList.add('drag'); }
        else { this.dragProfile = null; li.classList.remove('drag'); }
      });
    });
    ['dragover', 'dragleave', 'drop'].forEach((ev) => {
      list.addEventListener(ev, (e) => {
        if (ev === 'dragover' || ev === 'dragleave') { e.preventDefault(); return; }
        e.preventDefault();
        const after = e.clientY < e.target.closest('li').getBoundingClientRect().top + 0.5 * e.target.closest('li').offsetHeight ? -1 : 1;
        const li = e.target.closest('li');
        const targetId = li && li.dataset.id;
        if (!targetId) return;
        const order = this.state.profileOrder || [];
        const idx = order.indexOf(this.dragProfile);
        if (idx > -1) {
          order.splice(idx, 1);
          const tIdx = order.indexOf(targetId);
          order.splice(tIdx + after, 0, this.dragProfile);
          this.state.profileOrder = order;
          this.renderProfiles();
        }
      });
    });
  }

  async tryFetch(url) {
    try { const r = await fetch(url); return r.ok ? r.json() : null; } catch { return null; }
  }

  async loadTheme() {
    const theme = localStorage.getItem('theme') || 'light';
    if (theme === 'dark') document.body.classList.add('dark');
    else document.body.classList.remove('dark');
  }

  async loadThemeFromPrefs() {
    const features = await this.tryFetch('/hub/features');
    if (features) {
      document.getElementById('featEnhancer').checked = features.enhancer ?? false;
      document.getElementById('featCache').checked = features.cache ?? false;
      document.getElementById('featProbe').checked = features.probe ?? false;
    }
  }

  toggleTheme() {
    const isDark = document.body.classList.toggle('dark');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  }

  async exportConfig() {
    const blob = await (await fetch('/hub/export')).blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'freehub-config.json';
    a.click(); URL.revokeObjectURL(url);
  }

  async probeAll() {
    const r = await fetch('/hub/probe', { method: 'POST' });
    const msg = r.ok ? 'Probe avviato' : 'Errore probe';
    alert(msg);
  }

  async clearCache() {
    await fetch('/hub/cache/clear', { method: 'POST' });
    this.refresh();
  }

  async saveGatewayKeys() {
    const keys = document.getElementById('gwKeys').value.trim();
    await fetch('/hub/gateway-keys', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({ keys: keys.split('\n').map(k => k.trim()).filter(Boolean) })
    });
  }

  async bulkImport() {
    const msg = document.getElementById('bulkMsg');
    const raw = document.getElementById('bulkKeys').value.trim();
    msg.textContent = 'Importazione…';
    try {
      const parsed = JSON.parse(raw);
      const r = await fetch('/hub/keys', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({ keys: parsed })
      });
      if (r.ok) { msg.textContent = 'Chiavi importate'; msg.className = 'msg ok'; }
      else { msg.textContent = 'Errore importazione'; msg.className = 'msg err'; }
    } catch (e) { msg.textContent = 'JSON non valido'; msg.className = 'msg err'; }
  }

  async saveSettings() {
    const cfg = {
      verifyEveryMin: +document.getElementById('setVerifyMin').value || 5,
      topK: +document.getElementById('setTopK').value || 6,
      failoverMs: +document.getElementById('setFailoverSec').value * 1000 || 8000,
      cacheMin: +document.getElementById('setCacheMin').value || 60
    };
    await fetch('/hub/settings', {
      method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({ settings: cfg })
    });
  }

  async savePlugins() {
    const plugins = [];
    if (document.getElementById('plugConcise').checked) plugins.push('concise');
    if (document.getElementById('plugEnglish').checked) plugins.push('english');
    if (document.getElementById('plugCode').checked) plugins.push('code-pro');
    await fetch('/hub/enhancer', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({ enhancer: { enabled: true, plugins } })
    });
  }

  async saveOrder() {
    if (this.state.profileOrder) {
      await fetch('/hub/reorder', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({ order: this.state.profileOrder })
      });
    }
  }

  async deleteProfile() {
    const sel = document.getElementById('profileSelect');
    const id = sel.value;
    await fetch('/hub/profile/delete', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({ id })
    });
  }

  async newProfile() {
    const name = prompt('Nome profilo (es. coder):');
    if (!name) return;
    await fetch('/hub/profile', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({ id: name, strategy: 'order' })
    });
  }

  async addProvider() {
    const prov = {
      name: document.getElementById('np_name').value.trim(),
      label: document.getElementById('np_label').value.trim(),
      base: document.getElementById('np_base').value.trim(),
      needsKey: document.getElementById('np_key').checked,
      models: document.getElementById('np_models').value.trim().split('\n').map(m => {
        const parts = m.split('|');
        return { id: parts[0].trim(), free: parts[1]?.trim() === 'free' ?? false };
      }).filter(m => m.id)
    };
    await fetch('/hub/provider/add', {
      method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({ provider: prov })
    });
  }

  async scanCatalogs() {
    const out = document.getElementById('scanOut');
    out.textContent = 'Scansione…';
    const r = await fetch('/hub/discover', { method: 'POST' });
    const data = await r.json();
    out.textContent = `Trovati ${data.added || 0} nuovi modelli`;
  }

  renderFreeModeStatus() {
    const sel = document.getElementById('freeModeSel');
    const st = document.getElementById('freeModeStatus');
    if (!this.state.freemode) { st.textContent = '–'; return; }
    sel.value = this.state.freemode.mode || 'free-preferred';
    st.textContent = `${this.state.freemode.freeModels}/${this.state.freemode.totalModels} modelli free · ${this.state.freemode.mode || '–'}`;
  }

  async renderKeyLimit() {
    const data = await this.tryFetch('/hub/keys');
    const sel = document.getElementById('klKey');
    if (!data) return;
    const prev = sel.value;
    sel.innerHTML = data.keys.map(k => `<option value="${k.key}">${k.key}</option>`).join('');
    if (prev) sel.value = prev;
    const cur = data.keys.find(k => k.key === sel.value);
    if (cur) {
      document.getElementById('klTokens').value = cur.limit?.tokens || 0;
      document.getElementById('klSpend').value = cur.limit?.spend || 0;
      document.getElementById('klInfo').textContent = `usato: ${cur.used?.tokens || 0} tok / $${(cur.used?.spend || 0).toFixed(2)}`;
    }
  }

  async renderExperiment() {
    const data = await this.tryFetch('/hub/experiments');
    if (!data || !data.experiments) return;
    const exp = data.experiments;
    if (typeof exp === 'object' && !Array.isArray(exp.variants)) {
      document.getElementById('expOn').checked = !!exp.enabled;
      document.getElementById('expProfile').value = exp.candidate || '';
      document.getElementById('expSplit').value = exp.splitPct || 0;
    }
  }

  async renderWebhook() {
    const data = await this.tryFetch('/hub/prefs');
    if (data?.webhook) document.getElementById('alertUrl').value = data.webhook;
  }

  async saveFreeMode() {
    const sel = document.getElementById('freeModeSel');
    await fetch('/hub/freemode', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({ mode: sel.value })
    });
    this.refresh();
  }

  renderSyncStatus() {
    const sel = document.getElementById('syncModeSel');
    const st = document.getElementById('syncStatus');
    if (!this.state.sync) { st.textContent = '–'; return; }
    sel.value = (this.state.sync.gatewayKeys && this.state.sync.gatewayKeys.length) ? 'manual' : 'auto';
    st.textContent = `${(this.state.sync.gatewayKeys || []).length} chiavi · auth store: ${(this.state.sync.auth || []).length} nomi`;
  }

  async syncKeys() {
    const r = await fetch('/hub/sync', { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({ keys: (this.state.sync?.gatewayKeys || []) }) });
    if (r.ok) this.refresh();
  }

  async saveKeyLimit() {
    const key = document.getElementById('klKey').value;
    if (!key) return;
    await fetch('/hub/keys', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({ key, tokens: +document.getElementById('klTokens').value || 0, spend: +document.getElementById('klSpend').value || 0 })
    });
  }

  async saveExperiment() {
    await fetch('/hub/experiments', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        enabled: document.getElementById('expOn').checked,
        profile: document.getElementById('expProfile').value || 'auto',
        candidate: document.getElementById('expProfile').value || 'auto',
        splitPct: +document.getElementById('expSplit').value || 0
      })
    });
  }

  async saveWebhook() {
    await fetch('/hub/alerts', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({ webhook: document.getElementById('alertUrl').value.trim() })
    });
  }

  async renderFreeModeStatus() {
    const sel = document.getElementById('freeModeSel');
    const st = document.getElementById('freeModeStatus');
    if (!this.state.freemode) { st.textContent = '–'; return; }
    sel.value = this.state.freemode.mode || 'free-preferred';
    st.textContent = `${this.state.freemode.freeModels}/${this.state.freemode.totalModels} modelli free · ${this.state.freemode.mode || '–'}`;
  }

  async sendChat() {
    const promptEl = document.getElementById('prompt');
    const out = document.getElementById('out');
    const profile = document.getElementById('profileSel').value;
    const stream = document.getElementById('streamChk').checked;
    const body = { model: profile, messages: [{ role: 'user', content: promptEl.value }], stream };
    out.textContent = '…';
    if (stream) {
      const ev = new EventSource(`/v1/chat/completions?model=${encodeURIComponent(profile)}&stream=true`);
      let text = '';
      ev.onmessage = (e) => { text += e.data; out.textContent = text; };
      ev.onerror = () => { ev.close(); out.textContent = text || 'errore'; };
    } else {
      const r = await fetch('/v1/chat/completions', {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)
      });
      const data = await r.json();
      out.textContent = data.choices?.[0]?.message?.content || JSON.stringify(data);
    }
  }

  renderAll() {
    this.renderProviders();
    this.renderProfiles();
    this.renderPricing();
    this.renderUsage();
    this.renderLogs();
    this.renderLeaderboard();
    this.renderStatus();
    this.updateBadge();
    this.renderFreeModeStatus();
    this.renderSyncStatus();
    this.renderKeyLimit();
    this.renderExperiment();
    this.renderWebhook();
  }

  renderProviders() {
    const filter = document.getElementById('pFilter').value;
    const sort = document.getElementById('pSort').value;
    const search = document.getElementById('pSearch').value.toLowerCase();
    const compact = document.getElementById('pCompact').checked;
    document.getElementById('providers').classList.toggle('compact', compact);

    let models = this.state.models || [];
    if (search) models = models.filter(m =>
      (m.provider || '').toLowerCase().includes(search) || m.id.toLowerCase().includes(search));
    if (filter === 'enabled') models = models.filter(m => m.enabled);
    else if (filter === 'disabled') models = models.filter(m => !m.enabled);
    else if (filter === 'free') models = models.filter(m => m.free);

    if (sort === 'name') models = [...models].sort((a, b) => a.id.localeCompare(b.id));
    else if (sort === 'health') models = [...models].sort((a, b) => (b.health || 0) - (a.health || 0));
    else if (sort === 'usage') models = [...models].sort((a, b) => (b.calls || 0) - (a.calls || 0));

    document.getElementById('modelCount').textContent = models.length;

    const byProv = {};
    (this.state.providers || []).forEach(p => { byProv[p.name] = p; });
    this.renderProviderList(models, byProv, compact);
  }

  renderProviderList(models, byProv, compact) {
    const providers = Array.from(new Set(['groq', 'openai', 'anthropic', 'openrouter', ...models.map(m => m.provider)].filter(Boolean)));
    const html = providers.map(pname => {
      const prov = byProv[pname];
      const provModels = models.filter(m => m.provider === pname);
      return this.renderProviderCard(pname, prov, provModels);
    }).join('');
    document.getElementById('providers').innerHTML = html;
  }

  renderProviderCard(pname, prov, provModels) {
    const health = provModels.length ? Math.round(100 * provModels.filter(m => m.health > 0).length / provModels.length) : 0;
    const hl = health > 70 ? 'ok' : health > 30 ? 'warn' : 'down';
    const healthBadge = `<span class="badge ${hl}">${health}%</span>`;
    const chev = '<span class="chev">›</span>';
    const modelRows = provModels.map(m => {
      const dot = m.health > 0 ? '<span class="ok">●</span>' : '<span class="down">●</span>';
      const freeBadge = m.free ? '<span class="badge free">free</span>' : '<span class="badge paid">paid</span>';
      const cost = m.cost ? `$${m.cost.toFixed(2)}` : '';
      return `<div class="model"><input type="checkbox" ${m.enabled ? 'checked' : ''} onchange="app.toggleModel('${m.id}', this.checked)" />
        <div class="mname">${m.id}</div><div class="minfo"><span class="mstat">${freeBadge} ${m.context}</span> ${dot}</div>
        <div class="mstat">${cost}</div></div>`;
    }).join('');
    return `<div class="provider">
      <div class="phead" onclick="app.toggleProvider(this)">${chev}
        <span class="pname">${pname}</span>
        <span class="pmeta">${provModels.length} modelli</span>
        ${healthBadge}
      </div>
      <div class="models">${modelRows}</div>
      <div class="pkey"><button class="btn small" onclick="app.testProvider('${pname}')">Test</button></div>
    </div>`;
  }

  toggleProvider(head) {
    const prov = head.parentElement;
    prov.classList.toggle('closed');
  }

  async toggleModel(id, enabled) {
    await fetch(`/hub/toggle`, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({ id, enabled })
    });
  }

  async testProvider(name) {
    alert(`Test ${name}…`);
    await fetch('/hub/probe', { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({ provider: name }) });
  }

  renderProfiles() {
    const opts = (this.state.config || {}).profiles || ['deep-research', 'fast-task', 'code-completion'];
    const select = document.getElementById('profileSelect');
    select.innerHTML = opts.map(p => `<option value="${p}">${p}</option>`).join('');
    document.getElementById('profileSel').innerHTML = opts.map(p => `<option value="${p}">${p}</option>`).join('');

    const strategies = ['order', 'cheapest', 'fastest', 'least-used', 'random', 'cascade'];
    document.getElementById('strategySelect').innerHTML = strategies.map(s =>
      `<option value="${s}" ${this.state.prefs?.strategy === s ? 'selected' : ''}>${s}</option>`).join('');

    const order = this.state.prefs?.order || opts;
    this.state.profileOrder = order;
    document.getElementById('profileList').innerHTML = order.map((p) =>
      `<li data-id="${p}" draggable="true"><span class="handle">≡</span>
      <span class="pid">${p}</span><span class="pstr">strategy: ${this.state.prefs?.strategy || 'order'}</span></li>`).join('');
  }

  renderPricing() {
    const list = document.getElementById('pricingList');
    const provs = this.state.providers || [];
    list.innerHTML = provs.map(p => `
      <div class="prow">
        <div class="pname-sm">${p.name}</div>
        <input type="number" min="0" step="0.01" value="${p.pricing?.prompt || ''}" placeholder="prompt" onchange="app.setPricing('${p.name}','prompt',this.value)" />
        <input type="number" min="0" step="0.01" value="${p.pricing?.completion || ''}" placeholder="completion" onchange="app.setPricing('${p.name}','completion',this.value)" />
        <span class="badge ${p.free ? 'free' : 'paid'}">${p.pricing?.prompt ? '$$' : 'free'}</span>
      </div>`).join('');
  }

  async setPricing(provider, field, val) {
    const pricing = { ...(this.state.prefs || {}).pricing, [provider]: { ...(this.state.prefs?.pricing?.[provider] || {}), [field]: +val || 0 } };
    await this.savePrefs({ pricing });
  }

  async savePrefs(extra) {
    const prefs = { ...this.state.prefs, ...extra };
    await fetch('/hub/prefs', {
      method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(prefs)
    });
  }

  renderUsage() {
    const cacheEntries = this.state.cache?.entries;
    const cacheHitPct = this.state.cache?.enabled ? Math.round((this.state.state.cacheHits / Math.max((this.state.state.requests||1),1)) * 100) : 0;
    document.getElementById('cacheInfo').textContent =
      cacheEntries != null
        ? `Cache: ${cacheEntries} voci · ${cacheHitPct}% hit`
        : '–';
    const cost = this.state.usage?.cost ? `$${this.state.usage.cost.toFixed(2)}` : '–';
    document.getElementById('costBadge').textContent = cost;
    const lastModel = document.getElementById('lastModel');
    lastModel.textContent = this.state.state?.lastModel || '–';
    lastModel.title = this.state.state?.lastModel || 'Ultimo modello risolto';
  }

  renderLogs() {
    const tbody = document.getElementById('logRows');
    const logs = this.state.logs?.logs || [];
    if (!logs.length) { tbody.innerHTML = '<tr><td colspan="9" class="hint">nessuna richiesta</td></tr>'; return; }
    tbody.innerHTML = logs.slice(0, 50).map(l => {
      const status = (l.status || (l.error ? 500 : 200)) >= 400 ? '<span class="down">✕</span>' : '<span class="ok">✓</span>';
      const proto = l.protocol || (l.stream ? 'sse' : 'chat');
      return `<tr>
        <td>${new Date(l.ts).toLocaleTimeString()}</td>
        <td>${l.model || '–'}</td>
        <td>${l.used || '–'}</td>
        <td>${proto}</td>
        <td>${l.duration || '–'}</td>
        <td>${l.ttft || '–'}</td>
        <td>${l.tokens || 0}</td>
        <td>${l.cost ? `$${l.cost.toFixed(2)}` : 0}</td>
        <td>${status}</td></tr>`;
    }).join('');
    this.renderChart();
  }

  renderChart() {
    const chart = document.getElementById('chart24');
    const logs = this.state.logs?.logs || [];
    const buckets = Array.from({ length: 24 }, () => ({ ok: 0, err: 0 }));
    logs.forEach(l => {
      const h = new Date(l.ts).getHours();
      const ok = (l.status || (l.error ? 500 : 200)) < 400;
      if (ok) buckets[h].ok += 1; else buckets[h].err += 1;
    });
    const max = Math.max(...buckets.flatMap(b => [b.ok, b.err]), 1);
    chart.innerHTML = buckets.map(b =>
      `<div style="display:flex;flex-direction:column;flex:1;justify-content:flex-end;height:44px">
        <div class="bar" style="height:${b.ok/max*100}%;opacity:${b.ok ? .55 : .2}"></div>
        ${b.err ? `<div class="errbar" style="height:${b.err/max*100}%"></div>` : ''}
      </div>`).join('');
  }

  renderLeaderboard() {
    const lb = document.getElementById('leaderboard');
    const usage = this.state.usage || {};
    const health = this.state.state?.health || [];
    if (!health.length) { lb.innerHTML = '<li class="hint">nessun dato</li>'; return; }
    const items = health.map(h => ({ id: h.key, status: h.status, score: h.fails > 0 ? 0 : 100 }));
    const max = Math.max(...items.map(i => i.score), 1);
    lb.innerHTML = items.slice(0, 30).map((i, idx) =>
      `<li><span class="rank">${idx + 1}</span>
      <span class="cat">${i.id.split(':')[0] || ''}</span>
      <span class="pid">${i.id}</span>
      <span class="meta">fails ${i.fails}</span>
      <span class="score">${(i.score / max * 100).toFixed(0)}</span></li>`).join('');
  }

  renderStatus() {
    const dot = document.getElementById('serverDot');
    const txt = document.getElementById('serverText');
    if (!this.state.state) {
      dot.className = 'dot warn'; txt.textContent = 'offline';
      return;
    }
    dot.className = 'dot on';
    txt.textContent = `online · ${this.state.state.modelCount || '?'} modelli`;
  }

  updateBadge() {
    document.getElementById('costBadge').classList.toggle('hidden', !this.state.state);
  }

  async updateStatus() {
    const on = document.getElementById('serverDot');
    try {
      const r = await fetch('/v1/health');
      if (r.ok) { on.className = 'dot on'; document.getElementById('serverText').textContent = 'online'; }
      else { on.className = 'dot warn'; document.getElementById('serverText').textContent = 'degraded'; }
    } catch {
      on.className = 'dot off'; document.getElementById('serverText').textContent = 'offline';
    }
  }
}

const app = new FreeHubUI();
