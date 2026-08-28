'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PassThrough } = require('node:stream');

const pricingLib = require('./helpers/pricing');
const cryptoLib = require('./helpers/crypto');
const protocols = require('./helpers/protocols');
const modelsLib = require('./helpers/models');
const logging = require('./helpers/logging');
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
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const UPSTREAM_TIMEOUT_MS = 15000;
const UPSTREAM_TIMEOUT_NONSTREAM_MS = 30000;
const STRATEGIES = ['order', 'autoroute', 'cheapest', 'fastest', 'least-used', 'random', 'cascade'];
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

function autorouteScore(id, promptMeta) {
  const c = modelsLib.classify(id);
  let s = 0;
  if (promptMeta.code && c.code) s += 3;
  if (promptMeta.reasoning && c.reasoning) s += 3;
  if (promptMeta.fast && c.fast) s += 2;
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

function proxyRequest(provider, modelId, data, res, onError) {
  const prov = providers[provider];
  const baseURL = (models[modelId] && models[modelId].baseURL) || prov.baseURL;
  const endpoint = routing.deriveEndpoint(baseURL, prov.name);
  const key = models[modelId].needsKey ? authKeyFor(models[modelId].authId) : null;
  const payload = data;
  const headers = { 'content-type': 'application/json', 'accept': 'application/json' };
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
  const profile = body.model && models[body.model] ? body.model : (typeof body.model === 'string' && prefs.profiles[body.model] ? body.model : 'auto');
  const modelId = selectModel(profile, body);
  if (!modelId) return sendError(res, 400, 'no model available for profile ' + profile);
  const prov = models[modelId] ? models[modelId].provider : 'openai';
  const data = Object.assign({}, body, { model: modelId });
  const key = cacheLib.cacheKey(data);
  if (CACHE_ENABLED && !body.stream && responseCache.has(key)) {
    cacheHits++;
    return res.end(JSON.stringify(responseCache.get(key).value));
  }
  proxyRequest(prov, modelId, data, res, (err) => {
    logFn('chat error ' + profile + '/' + modelId + ': ' + err.message);
    sendError(res, 502, 'upstream error: ' + err.message);
  });
}

function sendError(res, code, msg) {
  if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: msg, type: 'gateway_error' } }));
}

function requireToken(req, res) {
  const h = req.headers['authorization'] || '';
  const token = h.replace(/^Bearer\s+/i, '');
  return token === (process.env.AGG_TOKEN || process.env.MODELHUB_TOKEN || '');
}

function servePanel(req, res, urlPath) {
  const rel = urlPath === '/' ? '/panel/index.html' : urlPath;
  const file = path.join(__dirname, '..', rel);
  if (!file.startsWith(path.join(__dirname, '..'))) return sendError(res, 403, 'forbidden');
  fs.readFile(file, (e, buf) => {
    if (e) return sendError(res, 404, 'not found');
    const ext = path.extname(file);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
    res.end(buf);
  });
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
    req.on('end', () => {
      try { handleChat(JSON.parse(buf), req, res); }
      catch (e) { sendError(res, 400, 'bad request: ' + e.message); }
    });
    return;
  }
  if (p.startsWith('/hub/')) {
    if (!requireToken(req, res)) return sendError(res, 401, 'unauthorized');
    return handleHub(req, res, p, u);
  }
  sendError(res, 404, 'not found');
});

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
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
    const list = Object.values(models).filter((m) => !prov || m.provider === prov);
    return json(res, 200, list);
  }
  if (p === '/hub/profile' && req.method === 'POST') {
    let buf = '';
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      const { name, ids, strategy } = JSON.parse(buf || '{}');
      if (!name) return sendError(res, 400, 'name required');
      prefs.profiles = prefs.profiles || {};
      prefs.profiles[name] = ids || profileIds(name);
      if (strategy) { prefs.strategy = prefs.strategy || {}; prefs.strategy[name] = strategy; }
      storage.writeJSON(PREFS_FILE, prefs, logFn);
      json(res, 200, { ok: true });
    });
    return;
  }
  if (p === '/hub/features' && req.method === 'POST') {
    let buf = '';
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      prefs.features = Object.assign(prefs.features || {}, JSON.parse(buf || '{}'));
      storage.writeJSON(PREFS_FILE, prefs, logFn);
      json(res, 200, { ok: true });
    });
    return;
  }
  if (p === '/hub/key' && req.method === 'POST') {
    let buf = '';
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      const { name, key } = JSON.parse(buf || '{}');
      if (!name || !key) return sendError(res, 400, 'name and key required');
      authStore.entries = authStore.entries || [];
      const ex = authStore.entries.find((x) => x.name === name);
      if (ex) ex.key = key; else authStore.entries.push({ name, key });
      storage.writeJSON(AUTH_FILE, authStore, logFn);
      json(res, 200, { ok: true });
    });
    return;
  }
  if (p === '/hub/export' && req.method === 'GET') {
    return json(res, 200, { config, prefs, pricing, auth: { entries: (authStore.entries || []).map((e) => ({ name: e.name })) } });
  }
  sendError(res, 404, 'unknown hub endpoint');
}

function start() {
  authStore = storage.readJSON(AUTH_FILE, { entries: [] });
  rebuildRegistry();
  server.listen(PORT, () => logFn('LLM-Aggregator gateway listening on :' + PORT));
}

if (require.main === module) start();

module.exports = { start, server, selectModel };
