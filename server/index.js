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

const PORT = Number(process.env.AGG_PORT || process.env.MODELHUB_PORT || 9090);
const APP_ROOT = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const DIR = process.env.AGG_DIR || process.env.MODELHUB_DIR || APP_ROOT;
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
let latency = {};
let costTotal = 0;
let tokensTotal = 0;
let requestsTotal = 0;
let startTime = Date.now();

function logFn(msg) {
  try { fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + msg + '\n'); } catch (e) {}
}

function authKeyFor(name) {
  const e = (authStore.entries || []).find((x) => x.name === name);
  if (!e) return null;
  try {
    return cryptoLib.decryptAuth(e.key);
  } catch (err) {
    return e.key;
  }
}

function rebuildRegistry() {
  models = {};
  providers = {};
  (config.providers || []).forEach((p) => {
    if (p.enabled === false) return;
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
        embeddings: !!m.embeddings || !!p.embeddings,
      };
    });
  });
  if (!prefs || !prefs.profiles || !prefs.profiles.auto) buildDefaultProfiles();
  logFn('registry rebuilt: ' + Object.keys(models).length + ' models, ' + Object.keys(providers).length + ' providers');
}

function buildDefaultProfiles() {
  const all = Object.keys(models);
  const free = all.filter((id) => models[id].free);
  prefs = prefs || { strategy: {}, enhancer: { enabled: true, maxChars: 4000, timeoutMs: 12000 }, features: { cache: true, autoProbe: true }, profiles: {}, enabled: {}, enhance: {} };
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

function autorouteScore(id, meta, intent) {
  const c = modelsLib.classify(id);
  let s = 0;
  if (meta.code && c.code) s += 3;
  if (meta.reasoning && c.reasoning) s += 3;
  if (meta.fast && c.fast) s += 2;
  if (models[id].free) s += 1;
  if (intent === 'code' && c.code) s += 4;
  if (intent === 'reasoning' && c.reasoning) s += 4;
  if (intent === 'fast' && c.fast) s += 4;
  s -= (usage[id] || 0) * 0.0001;
  return s;
}

function estimateTokens(text) {
  return Math.max(1, Math.round(String(text || '').length / 4));
}

function tallyUsage(modelId, promptTokens, completionTokens) {
  if (!modelId || !models[modelId]) return;
  usage[modelId] = (usage[modelId] || 0) + 1;
  const pr = pricingLib.priceFor(pricing, models[modelId].provider, modelId);
  costTotal += pricingLib.computeCost(pr, promptTokens, completionTokens);
  tokensTotal += promptTokens + completionTokens;
  requestsTotal += 1;
}

function selectModel(profile, body) {
  if (prefs.experiments && prefs.experiments[profile]) {
    const exp = prefs.experiments[profile];
    const variants = exp.variants || [];
    const weights = exp.weight || variants.map(() => 1);
    if (variants.length) {
      let total = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;
      for (let i = 0; i < variants.length; i++) {
        r -= weights[i];
        if (r <= 0) return variants[i];
      }
      return variants[variants.length - 1];
    }
  }
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
  if (strategy === 'fastest') {
    return valid.slice().sort((a, b) => {
      const fa = modelsLib.classify(a).fast ? 0 : 1;
      const fb = modelsLib.classify(b).fast ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return (latency[b] || 1e9) - (latency[a] || 1e9);
    })[0];
  }
  if (strategy === 'least-used') {
    return valid.slice().sort((a, b) => (usage[a] || 0) - (usage[b] || 0))[0];
  }
  const last = body.messages[body.messages.length - 1];
  const meta = modelsLib.classifyPrompt(last ? last.content : '');
  return valid.slice().sort((a, b) => autorouteScore(b, meta, body.intent) - autorouteScore(a, meta, body.intent))[0];
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

function streamUpstream(up, res, kind, modelId, onError, ctx) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  if (kind === 'openai') {
    up.pipe(res);
    up.on('end', () => res.end());
    up.on('error', onError);
    return;
  }
  let buf = '';
  let seenText = '';
  const conv = kind === 'anthropic' ? protocols.anthropicStreamChunkToOpenAI : protocols.geminiStreamChunkToOpenAI;
  up.setEncoding('utf8');
  up.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch (e) { continue; }
      const chunkObj = conv(obj, modelId);
      if (chunkObj) {
        res.write('data: ' + JSON.stringify(chunkObj) + '\n\n');
        const d = chunkObj.choices && chunkObj.choices[0] && chunkObj.choices[0].delta;
        if (d && d.content) seenText += d.content;
      }
    }
  });
  up.on('end', () => {
    res.write('data: [DONE]\n\n');
    res.end();
    if (ctx) {
      tallyUsage(modelId, ctx.promptTokens, estimateTokens(seenText));
      if (ctx.start) latency[modelId] = Date.now() - ctx.start;
    }
  });
  up.on('error', onError);
}

function completeNonStream(res, rawText, modelId, ctx) {
  try {
    const v = JSON.parse(rawText);
    const text = (v.choices && v.choices[0] && v.choices[0].message && v.choices[0].message.content) || '';
    tallyUsage(modelId, ctx.promptTokens, estimateTokens(text));
    if (ctx.start) latency[modelId] = Date.now() - ctx.start;
    if (ctx.cacheIt) {
      if (responseCache.size >= 200) responseCache.delete(responseCache.keys().next().value);
      responseCache.set(ctx.cacheKey, { value: v, ts: Date.now() });
    }
  } catch (e) {}
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(rawText);
}

function proxyRequest(prov, modelId, data, res, onError, ctx) {
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
      if (data.stream) {
        streamUpstream(up, res, kind, modelId, onError, ctx);
        return;
      }
      if (kind !== 'openai') {
        let raw = '';
        up.on('data', (d) => (raw += d));
        up.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            const out = kind === 'anthropic'
              ? { id: 'chatcmpl-' + modelId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, message: { role: 'assistant', content: protocols.textOf(parsed.content) }, finish_reason: 'stop' }] }
              : { id: 'chatcmpl-' + modelId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, message: { role: 'assistant', content: parsed.candidates[0].content.parts[0].text }, finish_reason: 'stop' }] };
            completeNonStream(res, JSON.stringify(out), modelId, ctx);
          } catch (e) {
            onError(e);
          }
        });
        return;
      }
      let raw = '';
      up.on('data', (d) => (raw += d));
      up.on('end', () => completeNonStream(res, raw, modelId, ctx));
    }
  );
  req.on('timeout', () => req.destroy(new Error('upstream timeout')));
  req.on('error', onError);
  req.write(JSON.stringify(payload));
  req.end();
}

function applyEnhancer(body, profile) {
  if (!prefs.enhancer || !prefs.enhancer.enabled) return body;
  if (prefs.enhance && prefs.enhance[profile] === false) return body;
  const msgs = body.messages || [];
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  if (!lastUser) return body;
  const meta = modelsLib.classifyPrompt(lastUser.content);
  let guidance;
  if (meta.code) guidance = 'Respond with clear, runnable code and minimal prose.';
  else if (meta.reasoning) guidance = 'Think step by step and show your reasoning.';
  else if (meta.fast) guidance = 'Be concise and direct.';
  else guidance = 'Be helpful and concise.';
  const max = prefs.enhancer.maxChars || 4000;
  guidance = guidance.slice(0, max);
  const out = JSON.parse(JSON.stringify(body));
  out.messages = out.messages || [];
  const sys = out.messages.find((m) => m.role === 'system');
  if (sys) {
    sys.content = (typeof sys.content === 'string' ? sys.content + '\n' : '') + guidance;
  } else {
    out.messages.unshift({ role: 'system', content: guidance });
  }
  return out;
}

function fireWebhook(message) {
  if (!prefs.webhook) return;
  try {
    const u = new URL(prefs.webhook);
    const body = JSON.stringify({ event: 'chat_error', message, at: new Date().toISOString() });
    const r = https.request(
      { method: 'POST', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: { 'content-type': 'application/json' } },
      () => {}
    );
    r.on('error', () => {});
    r.write(body);
    r.end();
  } catch (e) {}
}

function handleChat(body, req, res) {
  const profile = body.model && prefs.profiles && prefs.profiles[body.model] ? body.model : 'auto';
  let data = Object.assign({}, body);
  if (prefs.enhancer && prefs.enhancer.enabled && !(prefs.enhance && prefs.enhance[profile] === false)) {
    data = applyEnhancer(data, profile);
  }
  const cascade = Array.isArray(body.cascade) && body.cascade.length ? body.cascade : null;
  const firstId = cascade ? cascade[0] : selectModel(profile, data);
  if (!firstId) return sendError(res, 400, 'no model available for profile ' + profile);
  const key = cacheLib.cacheKey(data);
  if (CACHE_ENABLED && !body.stream && responseCache.has(key)) {
    cacheHits++;
    return res.end(JSON.stringify(responseCache.get(key).value));
  }
  const promptTokens = estimateTokens(JSON.stringify(data.messages || []));

  const doRequest = (modelId, done) => {
    const prov = providers[models[modelId].provider];
    if (!prov) return done(new Error('unknown provider for ' + modelId));
    const ctx = { promptTokens, cacheKey: key, cacheIt: CACHE_ENABLED && !body.stream, start: Date.now() };
    proxyRequest(prov, modelId, Object.assign({}, data, { model: modelId }), res, done, ctx);
  };

  if (cascade) {
    let i = 0;
    const finishError = (e) => {
      logFn('chat error ' + profile + ': ' + e.message);
      sendError(res, 502, 'upstream error: ' + e.message);
      fireWebhook('chat failed for profile ' + profile + ': ' + e.message);
    };
    const tryNext = (err) => {
      if (err) logFn('cascade candidate failed: ' + err.message);
      i++;
      if (i < cascade.length) {
        const mid = cascade[i];
        if (!models[mid]) return tryNext(new Error('unknown model ' + mid));
        doRequest(mid, tryNext);
      } else {
        finishError(new Error('all cascade candidates failed'));
      }
    };
    doRequest(firstId, tryNext);
    return;
  }

  const wrapped = (err) => {
    logFn('chat error ' + profile + '/' + firstId + ': ' + err.message);
    sendError(res, 502, 'upstream error: ' + err.message);
    fireWebhook('chat failed for profile ' + profile + ': ' + err.message);
  };
  doRequest(firstId, wrapped);
}

function handleEmbeddings(body, req, res) {
  let prov = null;
  let modelId = body.model;
  if (modelId && models[modelId] && providers[models[modelId].provider] && (providers[models[modelId].provider].embeddings || models[modelId].embeddings)) {
    prov = providers[models[modelId].provider];
  }
  if (!prov) {
    prov = (config.providers || []).find((p) => p.enabled !== false && p.embeddings === true) ||
      (config.providers || []).find((p) => p.enabled !== false && /openai|embed/i.test(p.name)) ||
      null;
  }
  if (!prov) return sendError(res, 501, 'no embeddings-capable provider configured');
  const baseURL = prov.baseURL.replace(/\/+$/, '');
  const endpoint = baseURL + (baseURL.endsWith('/embeddings') ? '' : '/embeddings');
  const key = prov.needsKey ? authKeyFor(prov.authId) : null;
  const headers = { 'content-type': 'application/json' };
  if (key) headers['authorization'] = 'Bearer ' + key;
  const payload = { model: modelId || prov.embedModel || 'text-embedding-3-small', input: body.input };
  const u = new URL(endpoint);
  const r = https.request(
    { method: 'POST', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers, timeout: UPSTREAM_TIMEOUT_NONSTREAM_MS },
    (up) => {
      let raw = '';
      up.on('data', (d) => (raw += d));
      up.on('end', () => {
        if (up.statusCode >= 400) return sendError(res, up.statusCode, 'embeddings upstream error: ' + raw.slice(0, 200));
        try {
          const parsed = JSON.parse(raw);
          let data;
          if (parsed.data && Array.isArray(parsed.data)) {
            data = parsed.data.map((e, i) => ({ object: 'embedding', index: i, embedding: e.embedding != null ? e.embedding : (e.vector || []) }));
          } else {
            data = [];
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data, model: payload.model }));
          tokensTotal += estimateTokens(JSON.stringify(body.input));
          requestsTotal += 1;
        } catch (e) {
          sendError(res, 502, 'embeddings parse error: ' + e.message);
        }
      });
    }
  );
  r.on('error', (e) => sendError(res, 502, 'embeddings error: ' + e.message));
  r.write(JSON.stringify(payload));
  r.end();
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
  const file = path.join(APP_ROOT, rel);
  const root = APP_ROOT;
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

function readJsonBody(req, res, cb) {
  let buf = '';
  req.on('data', (d) => (buf += d));
  req.on('end', () => {
    try { cb(JSON.parse(buf || '{}')); } catch (e) { sendError(res, 400, 'bad json'); }
  });
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
  if (p === '/hub/usage' && req.method === 'GET') {
    return json(res, 200, { usage, cost: costTotal, cacheHits, requests: requestsTotal, tokens: tokensTotal });
  }
  if (p === '/hub/providers' && req.method === 'GET') {
    const list = (config.providers || []).map((pr) => ({
      name: pr.name,
      enabled: pr.enabled !== false,
      modelCount: (pr.models || []).length,
      needsKey: !!pr.needsKey,
      label: pr.label || pr.name,
      embeddings: !!pr.embeddings,
    }));
    return json(res, 200, { providers: list });
  }
  if (p === '/hub/profile' && req.method === 'POST') {
    return readJsonBody(req, res, ({ name, ids, strategy }) => {
      if (!name) return sendError(res, 400, 'name required');
      prefs.profiles = prefs.profiles || {};
      prefs.profiles[name] = ids || profileIds(name);
      if (strategy) { prefs.strategy = prefs.strategy || {}; prefs.strategy[name] = strategy; }
      storage.writeJSON(PREFS_FILE, prefs, logFn);
      json(res, 200, { ok: true });
    });
  }
  if (p === '/hub/features' && req.method === 'POST') {
    return readJsonBody(req, res, (obj) => {
      prefs.features = Object.assign(prefs.features || {}, obj);
      storage.writeJSON(PREFS_FILE, prefs, logFn);
      json(res, 200, { ok: true });
    });
  }
  if (p === '/hub/key' && req.method === 'POST') {
    return readJsonBody(req, res, ({ name, key }) => {
      if (!name || !key) return sendError(res, 400, 'name and key required');
      authStore.entries = authStore.entries || [];
      const enc = cryptoLib.encryptAuth(key);
      const ex = authStore.entries.find((x) => x.name === name);
      if (ex) ex.key = enc; else authStore.entries.push({ name, key: enc });
      storage.writeJSON(AUTH_FILE, authStore, logFn);
      json(res, 200, { ok: true });
    });
  }
  if (p === '/hub/experiments' && req.method === 'GET') {
    return json(res, 200, { experiments: prefs.experiments || {} });
  }
  if (p === '/hub/experiment' && req.method === 'POST') {
    return readJsonBody(req, res, ({ name, variants, weight }) => {
      if (!name || !Array.isArray(variants) || !variants.length) return sendError(res, 400, 'name and variants required');
      prefs.experiments = prefs.experiments || {};
      prefs.experiments[name] = { variants, weight: weight || variants.map(() => 1) };
      storage.writeJSON(PREFS_FILE, prefs, logFn);
      json(res, 200, { ok: true });
    });
  }
  if (p === '/hub/webhook' && req.method === 'POST') {
    return readJsonBody(req, res, ({ url }) => {
      prefs.webhook = url || null;
      storage.writeJSON(PREFS_FILE, prefs, logFn);
      json(res, 200, { ok: true, webhook: prefs.webhook });
    });
  }
  if (p === '/hub/cache/clear' && req.method === 'POST') {
    responseCache.clear();
    return json(res, 200, { ok: true, entries: 0 });
  }
  if (p === '/hub/provider/toggle' && req.method === 'POST') {
    return readJsonBody(req, res, ({ name, enabled }) => {
      const pr = (config.providers || []).find((x) => x.name === name);
      if (!pr) return sendError(res, 404, 'provider not found');
      pr.enabled = !!enabled;
      storage.writeJSON(CONFIG_FILE, config, logFn);
      rebuildRegistry();
      json(res, 200, { ok: true });
    });
  }
  if (p === '/hub/provider/add' && req.method === 'POST') {
    return readJsonBody(req, res, (provider) => {
      if (!provider || !provider.name || !provider.baseURL) return sendError(res, 400, 'name and baseURL required');
      const exists = (config.providers || []).find((x) => x.name === provider.name);
      if (exists) return sendError(res, 409, 'provider already exists');
      config.providers.push(Object.assign({ enabled: true, models: [] }, provider));
      storage.writeJSON(CONFIG_FILE, config, logFn);
      rebuildRegistry();
      json(res, 200, { ok: true });
    });
  }
  if (p === '/hub/provider/remove' && req.method === 'POST') {
    return readJsonBody(req, res, ({ name }) => {
      config.providers = (config.providers || []).filter((x) => x.name !== name);
      storage.writeJSON(CONFIG_FILE, config, logFn);
      rebuildRegistry();
      json(res, 200, { ok: true });
    });
  }
  if (p === '/hub/provider/reorder' && req.method === 'POST') {
    return readJsonBody(req, res, ({ names }) => {
      if (!Array.isArray(names)) return sendError(res, 400, 'names required');
      const map = {};
      (config.providers || []).forEach((x) => (map[x.name] = x));
      const ordered = names.map((n) => map[n]).filter(Boolean);
      (config.providers || []).forEach((x) => { if (!names.includes(x.name)) ordered.push(x); });
      config.providers = ordered;
      storage.writeJSON(CONFIG_FILE, config, logFn);
      rebuildRegistry();
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
  if (req.method === 'GET' && p === '/metrics') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(metricsLib.promMetrics({ startTime, cacheHits, models, cost: costTotal, tokens: tokensTotal, requests: requestsTotal })); }
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
  if (p === '/v1/embeddings' && req.method === 'POST') {
    let buf = '';
    req.on('data', (d) => (buf += d));
    req.on('end', () => { try { handleEmbeddings(JSON.parse(buf), req, res); } catch (e) { sendError(res, 400, 'bad request: ' + e.message); } });
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
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logFn('Port ' + PORT + ' already in use - another instance may be running. Open http://127.0.0.1:' + PORT + '/ or stop the other instance.');
      process.exit(0);
    } else {
      throw err;
    }
  });
  server.listen(PORT, () => logFn('LLM-Aggregator gateway listening on :' + PORT));
}

if (require.main === module) start();

module.exports = { start, server, selectModel };
