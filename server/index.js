'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const pricingLib = require('./helpers/pricing');
const cryptoLib = require('./helpers/crypto');
const protocols = require('./helpers/protocols');
const modelsLib = require('./helpers/models');
const storage = require('./helpers/storage');
const routing = require('./helpers/routing');
const cacheLib = require('./helpers/cache');
const metricsLib = require('./helpers/metrics');

const PORT = Number(process.env.AGG_PORT || process.env.MODELHUB_PORT || 8787);
const DIR = process.env.AGG_DIR || process.env.MODELHUB_DIR || __dirname;
const CONFIG_FILE = path.join(DIR, 'config.json');
const AUTH_FILE = path.join(DIR, 'auth.json');
const PREFS_FILE = path.join(DIR, 'prefs.json');
const PRICING_FILE = path.join(DIR, 'pricing.json');
const LOG_FILE = path.join(os.tmpdir(), 'llm-aggregator.log');
const CACHE_ENABLED = (process.env.AGG_CACHE || '1') !== '0';
const UPSTREAM_TIMEOUT_MS = 15000;
const UPSTREAM_TIMEOUT_NONSTREAM_MS = 30000;
const DEFAULT_PROFILES = ['auto', 'auto-code', 'auto-reasoning', 'auto-fast', 'free-pool'];

let models = {};
let providers = {};
let authStore = { entries: [] };
let prefs = storage.readJSON(PREFS_FILE, null);
let pricing = storage.readJSON(PRICING_FILE, { currency: 'USD', providers: {}, models: {} });
let config = storage.readJSON(CONFIG_FILE, { port: PORT, providers: [] });
let responseCache = new Map();
let cacheHits = 0;
let usage = {};
let startTime = Date.now();

function logFn(msg) {
  try { fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + msg + '\n'); } catch (e) {}
}

function authKeyFor(name) {
  const e = (authStore.entries || []).find((x) => x.name === name);
  return e ? e.key : null;
}

function rebuildRegistry() {
  models = {};
  providers = {};
  (config.providers || []).forEach((p) => {
    providers[p.name] = p;
    (p.models || []).forEach((m) => {
      const id = typeof m === 'string' ? m : m.id;
      models[id] = {
        id,
        provider: p.name,
        label: (m && m.label) || id,
        free: !!(m && m.free),
        baseURL: p.baseURL,
        needsKey: !!p.needsKey,
        authId: p.authId,
      };
    });
  });
  if (!prefs || !prefs.profiles || !prefs.profiles.auto) buildDefaultProfiles();
  logFn('registry rebuilt: ' + Object.keys(models).length + ' models, ' + Object.keys(providers).length + ' providers');
}

function buildDefaultProfiles() {
  const all = Object.keys(models);
  const free = all.filter((id) => models[id].free);
  prefs = prefs || { strategy: {}, enhancer: { enabled: true, maxChars: 4000, timeoutMs: 12000 }, features: { cache: true, autoProbe: true }, profiles: {}, enabled: {} };
  prefs.profiles = prefs.profiles || {};
  prefs.profiles.auto = all;
  prefs.profiles['auto-code'] = modelsLib.catFirst(all, (c) => c.code);
  prefs.profiles['auto-reasoning'] = modelsLib.catFirst(all, (c) => c.reasoning);
  prefs.profiles['auto-fast'] = modelsLib.catFirst(all, (c) => c.fast);
  prefs.profiles['free-pool'] = free.length ? free : all;
  DEFAULT_PROFILES.forEach((p) => { prefs.profiles[p] = prefs.profiles[p] || all; });
  storage.writeJSON(PREFS_FILE, prefs, logFn);
}

function profileIds(name) {
  return (prefs.profiles && prefs.profiles[name]) || Object.keys(models);
}

function autorouteScore(id, meta) {
  const c = modelsLib.classify(id);
  let s = 0;
  if (meta.code && c.code) s += 3;
  if (meta.reasoning && c.reasoning) s += 3;
  if (meta.fast && c.fast) s += 2;
  if (models[id].free) s += 1;
  s -= (usage[id] || 0) * 0.0001;
  return s;
}

function selectModel(profile, body) {
  const ids = profileIds(profile);
  const valid = ids.filter((id) => models[id] && !modelsLib.CHAT_BLOCK.test(id));
  const strategy = (prefs.strategy && prefs.strategy[profile]) || 'autoroute';
  if (strategy === 'order' || valid.length === 0) return valid[0] || ids[0];
  if (strategy === 'random') return valid[Math.floor(Math.random() * valid.length)];
  if (strategy === 'cheapest') {
    return valid.slice().sort((a, b) => {
      const pa = pricingLib.priceFor(pricing, models[a].provider, a);
      const pb = pricingLib.priceFor(pricing, models[b].provider, b);
      return (pa ? pa.input : 1e9) - (pb ? pb.input : 1e9);
    })[0];
  }
  const last = body.messages[body.messages.length - 1];
  const meta = modelsLib.classifyPrompt(last ? last.content : '');
  return valid.slice().sort((a, b) => autorouteScore(b, meta) - autorouteScore(a, meta))[0];
}

function buildRequest(prov, modelId, data) {
  const baseURL = (models[modelId] && models[modelId].baseURL) || prov.baseURL;
  const name = prov.name;
  if (name === 'anthropic') {
    return { endpoint: baseURL.replace(/\/+$/, '') + '/v1/messages', payload: protocols.anthropicToOpenAI(data), kind: 'anthropic' };
  }
  if (name === 'gemini') {
    const contents = (data.messages || []).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : '' }],
    }));
    const suffix = data.stream ? ':streamGenerateContent?alt=sse' : ':generateContent';
    return { endpoint: baseURL.replace(/\/+$/, '') + '/v1beta/models/' + encodeURIComponent(modelId) + suffix, payload: { contents }, kind: 'gemini' };
  }
  return { endpoint: routing.deriveEndpoint(baseURL, name), payload: data, kind: 'openai' };
}

function proxyRequest(prov, modelId, data, res, onError) {
  const { endpoint, payload, kind } = buildRequest(prov, modelId, data);
  const key = models[modelId].needsKey ? authKeyFor(models[modelId].authId) : null;
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (key) {
    if (prov.name === 'anthropic') headers['x-api-key'] = key;
    else headers['authorization'] = 'Bearer ' + key;
  }
  const u = new URL(endpoint);
  const req = https.request(
    {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers,
      timeout: data.stream ? UPSTREAM_TIMEOUT_MS : UPSTREAM_TIMEOUT_NONSTREAM_MS,
    },
    (up) => {
      if (up.statusCode >= 400) {
        let buf = '';
        up.on('data', (d) => (buf += d));
        up.on('end', () => onError(new Error('upstream ' + up.statusCode + ': ' + buf.slice(0, 200))));
        return;
      }
      if (!data.stream && kind !== 'openai') {
        let raw = '';
        up.on('data', (d) => (raw += d));
        up.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            const out = kind === 'anthropic'
              ? { id: 'chatcmpl-' + modelId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, message: { role: 'assistant', content: protocols.textOf(parsed.content) }, finish_reason: 'stop' }] }
              : { id: 'chatcmpl-' + modelId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, message: { role: 'assistant', content: (parsed.candidates[0].content.parts[0].text) }, finish_reason: 'stop' }] };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(out));
          } catch (e) {
            onError(e);
          }
        });
        return;
      }
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
      up.on('end', () => res.end());
    }
  );
  req.on('timeout', () => req.destroy(new Error('upstream timeout')));
  req.on('error', onError);
  req.write(JSON.stringify(payload));
  req.end();
}

function handleChat(body, req, res) {
  const profile = body.model && prefs.profiles && prefs.profiles[body.model] ? body.model : 'auto';
  const modelId = selectModel(profile, body);
  if (!modelId) return sendError(res, 400, 'no model available for profile ' + profile);
  const prov = providers[models[modelId].provider];
  if (!prov) return sendError(res, 400, 'unknown provider for ' + modelId);
  const data = Object.assign({}, body, { model: modelId });
  const key = cacheLib.cacheKey(data);
  if (CACHE_ENABLED && !body.stream && responseCache.has(key)) {
    cacheHits++;
    return res.end(JSON.stringify(responseCache.get(key).value));
  }
  const wrapped = (err) => {
    logFn('chat error ' + profile + '/' + modelId + ': ' + err.message);
    sendError(res, 502, 'upstream error: ' + err.message);
  };
  if (CACHE_ENABLED && !body.stream) {
    const origEnd = res.end.bind(res);
    res.end = function (chunk) {
      res.end = origEnd;
      try {
        const v = JSON.parse(chunk.toString());
        if (responseCache.size >= 200) responseCache.delete(responseCache.keys().next().value);
        responseCache.set(key, { value: v, ts: Date.now() });
      } catch (e) {}
      return origEnd(chunk);
    };
  }
  proxyRequest(prov, modelId, data, res, wrapped);
}

function sendError(res, code, msg) {
  if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: msg, type: 'gateway_error' } }));
}

function requireToken(req, res) {
  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  return token === (process.env.AGG_TOKEN || process.env.MODELHUB_TOKEN || '');
}

function servePanel(req, res, urlPath) {
  const rel = urlPath === '/' ? '/panel/index.html' : urlPath;
  const file = path.join(__dirname, '..', rel);
  const root = path.join(__dirname, '..');
  if (!file.startsWith(root)) return sendError(res, 403, 'forbidden');
  fs.readFile(file, (e, buf) => {
    if (e) return sendError(res, 404, 'not found');
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req, cb) {
  let buf = '';
  req.on('data', (d) => (buf += d));
  req.on('end', () => { try { cb(JSON.parse(buf || '{}')); } catch (e) { sendError(res, 400, 'bad json'); } });
}

function handleHub(req, res, p, u) {
  if (p === '/hub/state' && req.method === 'GET') {
    return json(res, 200, { models: Object.keys(models).length, providers: Object.keys(providers).length, profiles: prefs.profiles, cacheHits, cache: CACHE_ENABLED });
  }
  if (p === '/hub/config' && req.method === 'GET') return json(res, 200, config);
  if (p === '/hub/prefs' && req.method === 'GET') return json(res, 200, prefs);
  if (p === '/hub/pricing' && req.method === 'GET') return json(res, 200, pricing);
  if (p === '/hub/features' && req.method === 'GET') return json(res, 200, prefs.features || {});
  if (p === '/hub/cache' && req.method === 'GET') return json(res, 200, { entries: responseCache.size, enabled: CACHE_ENABLED });
  if (p === '/hub/models' && req.method === 'GET') {
    const prov = u.searchParams.get('provider');
    return json(res, 200, Object.values(models).filter((m) => !prov || m.provider === prov));
  }
  if (p === '/hub/profile' && req.method === 'POST') {
    return readJsonBody(req, ({ name, ids, strategy }) => {
      if (!name) return sendError(res, 400, 'name required');
      prefs.profiles = prefs.profiles || {};
      prefs.profiles[name] = ids || profileIds(name);
      if (strategy) { prefs.strategy = prefs.strategy || {}; prefs.strategy[name] = strategy; }
      storage.writeJSON(PREFS_FILE, prefs, logFn);
      json(res, 200, { ok: true });
    });
  }
  if (p === '/hub/features' && req.method === 'POST') {
    return readJsonBody(req, (obj) => {
      prefs.features = Object.assign(prefs.features || {}, obj);
      storage.writeJSON(PREFS_FILE, prefs, logFn);
      json(res, 200, { ok: true });
    });
  }
  if (p === '/hub/key' && req.method === 'POST') {
    return readJsonBody(req, ({ name, key }) => {
      if (!name || !key) return sendError(res, 400, 'name and key required');
      authStore.entries = authStore.entries || [];
      const ex = authStore.entries.find((x) => x.name === name);
      if (ex) ex.key = key; else authStore.entries.push({ name, key });
      storage.writeJSON(AUTH_FILE, authStore, logFn);
      json(res, 200, { ok: true });
    });
  }
  if (p === '/hub/export' && req.method === 'GET') {
    return json(res, 200, { config, prefs, pricing, auth: { entries: (authStore.entries || []).map((e) => ({ name: e.name })) } });
  }
  sendError(res, 404, 'unknown hub endpoint');
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  if (req.method === 'GET' && (p === '/' || p.startsWith('/panel'))) return servePanel(req, res, p);
  if (req.method === 'GET' && p === '/v1/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, models: Object.keys(models).length })); }
  if (req.method === 'GET' && p === '/metrics') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(metricsLib.promMetrics({ startTime, cacheHits, models })); }
  if (req.method === 'GET' && p === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: Object.keys(models).map((id) => ({ id, object: 'model', provider: models[id].provider })) }));
  }
  if (p === '/v1/chat/completions' && req.method === 'POST') {
    let buf = '';
    req.on('data', (d) => (buf += d));
    req.on('end', () => { try { handleChat(JSON.parse(buf), req, res); } catch (e) { sendError(res, 400, 'bad request: ' + e.message); } });
    return;
  }
  if (p.startsWith('/hub/')) {
    if (!requireToken(req, res)) return sendError(res, 401, 'unauthorized');
    return handleHub(req, res, p, u);
  }
  sendError(res, 404, 'not found');
});

function start() {
  authStore = storage.readJSON(AUTH_FILE, { entries: [] });
  rebuildRegistry();
  server.listen(PORT, () => logFn('LLM-Aggregator gateway listening on :' + PORT));
}

if (require.main === module) start();

module.exports = { start, server, selectModel };
