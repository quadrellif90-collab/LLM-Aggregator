'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const pricingLib = require('./helpers/pricing');
const cryptoLib = require('./helpers/crypto');
const protocols = require('./helpers/protocols');
const modelsLib = require('./helpers/models');
const storage = require('./helpers/storage');
const routing = require('./helpers/routing');
const cacheLib = require('./helpers/cache');
const metricsLib = require('./helpers/metrics');
const catalog = require('./helpers/catalog');
const healthLib = require('./helpers/health');
const securityLib = require('./helpers/security');

const PORT = Number(process.env.AGG_PORT || process.env.MODELHUB_PORT || 9090);
const APP_ROOT = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const DIR = process.env.AGG_DIR || process.env.MODELHUB_DIR || APP_ROOT;
const CONFIG_FILE = path.join(DIR, 'config.json');
const AUTH_FILE = path.join(DIR, 'auth.json');
const PREFS_FILE = path.join(DIR, 'prefs.json');
const PRICING_FILE = path.join(DIR, 'pricing.json');
const HEALTH_FILE = path.join(DIR, 'health-state.json');
const LOG_FILE = path.join(os.tmpdir(), 'llm-aggregator.log');
const CACHE_ENABLED = (process.env.AGG_CACHE || '1') !== '0';
const UPSTREAM_TIMEOUT_MS = 15000;
const UPSTREAM_TIMEOUT_NONSTREAM_MS = 30000;
const DEFAULT_PROFILES = ['auto', 'auto-code', 'auto-reasoning', 'auto-fast', 'free-pool'];
const STRATEGIES = ['order', 'autoroute', 'cheapest', 'fastest', 'least-used', 'random', 'cascade'];
const RATE_WINDOW_MS = 60000;
const RATE_MAX = 120;
const rateBuckets = new Map();
const REQ_LOG_MAX = 200;
const reqLog = [];
const ENHANCE_PLUGINS = {
  concise: { label: 'Concise', text: 'Be concise and direct.' },
  english: { label: 'English', text: 'Respond in English.' },
  codepro: { label: 'Code pro', text: 'You are an expert software engineer. Prefer correct, minimal code.' }
};

let models = {};
let providers = {};

// Circuit Breaker + Health Score
const health = {}; // { providerName: { status: 'ok'|'degraded'|'down', fails: 0, lastFail: 0, cooldownUntil: 0, latencyAvg: 0, success: 0 } }
const UPSTREAM_MAX_FAILURES = 3;
const CIRCUIT_OPEN_COOLDOWN_BASE_MS = 60000; // 1 minute
const CIRCUIT_OPEN_COOLDOWN_CAP_MS = 600000; // 10 minutes
const CIRCUIT_OPEN_COOLDOWN_INC_FACTOR = 2; // Exponential backoff

function markFail(providerName, modelId, retryAfterMs = 0) {
  const key = modelId || providerName;
  const now = Date.now();
  health[key] = health[key] || { status: 'ok', fails: 0, lastFail: 0, cooldownUntil: 0, latencyAvg: 0, success: 0 };
  health[key].fails++;
  health[key].lastFail = now;
  health[key].status = health[key].fails >= UPSTREAM_MAX_FAILURES ? 'down' : 'degraded';
  let cooldown = (retryAfterMs || (CIRCUIT_OPEN_COOLDOWN_BASE_MS * Math.pow(CIRCUIT_OPEN_COOLDOWN_INC_FACTOR, Math.min(health[key].fails - 1, 5))));
  health[key].cooldownUntil = now + Math.min(cooldown, CIRCUIT_OPEN_COOLDOWN_CAP_MS);
  logFn(`Provider '${key}' marked as ${health[key].status} (fails: ${health[key].fails}, cooldown: ${health[key].cooldownUntil})`);
  persistHealthState();
}

function markOk(providerName, modelId, latencyMs) {
  const key = modelId || providerName;
  health[key] = health[key] || { status: 'ok', fails: 0, lastFail: 0, cooldownUntil: 0, latencyAvg: 0, success: 0 };
  health[key].status = 'ok';
  health[key].fails = 0;
  health[key].cooldownUntil = 0;
  const alpha = 0.2;
  health[key].latencyAvg = alpha * latencyMs + (1 - alpha) * health[key].latencyAvg;
  health[key].success++;
  persistHealthState();
}

function isCircuitOpen(providerName, modelId) {
  const key = modelId || providerName;
  const h = health[key];
  if (!h) return false;
  return h.status === 'down' && h.cooldownUntil > Date.now();
}

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
let retryCount = 0;
let circuitOpenCount = 0;
let startTime = Date.now();

function logFn(msg) {
  try { fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + msg + '\n'); } catch (e) {}
}

function persistHealthState() {
  try {
    const snapshot = {};
    for (const [k, v] of Object.entries(health)) {
      snapshot[k] = { status: v.status, fails: v.fails, lastFail: v.lastFail, cooldownUntil: v.cooldownUntil, latencyAvg: v.latencyAvg, success: v.success };
    }
    fs.writeFile(HEALTH_FILE, JSON.stringify(snapshot), () => {});
  } catch (e) {}
}

function restoreHealthState() {
  try {
    const raw = fs.readFileSync(HEALTH_FILE, 'utf8');
    const snap = JSON.parse(raw);
    const now = Date.now();
    for (const [k, v] of Object.entries(snap)) {
      if (v.cooldownUntil && v.cooldownUntil > now) continue;
      health[k] = { status: 'ok', fails: 0, lastFail: 0, cooldownUntil: 0, latencyAvg: v.latencyAvg || 0, success: v.success || 0 };
    }
  } catch (e) {}
}

function normalizePrefs() {
  prefs = prefs || {};
  if (!Array.isArray(prefs.gatewayKeys)) prefs.gatewayKeys = [];
  if (!prefs.keylimits || typeof prefs.keylimits !== 'object') prefs.keylimits = {};
  if (!prefs.strategy || typeof prefs.strategy !== 'object') prefs.strategy = {};
  if (!prefs.enhancer || typeof prefs.enhancer !== 'object') prefs.enhancer = {};
  if (!prefs.features || typeof prefs.features !== 'object') prefs.features = {};
  if (!prefs.profiles || typeof prefs.profiles !== 'object') prefs.profiles = {};
  if (!prefs.enabled || typeof prefs.enabled !== 'object') prefs.enabled = {};
  if (!prefs.freeMode || !['free-only', 'free-preferred', 'all'].includes(prefs.freeMode)) prefs.freeMode = 'free-preferred';
  const added = catalog.mergeCatalog(config);
  if (added > 0) storage.writeJSON(CONFIG_FILE, config, logFn);
}

function recordRequest(entry) {
  entry.ts = Date.now();
  reqLog.push(entry);
  if (reqLog.length > REQ_LOG_MAX) reqLog.shift();
}

function settingsCfg() {
  const s = prefs.settings || {};
  const num = (k, d) => (Number.isFinite(s[k]) ? s[k] : d);
  return {
    port: config.port,
    verifyMs: num('verifyMs', 900000),
    verifyTopK: num('verifyTopK', 6),
    failoverMs: num('failoverMs', 45000),
    cacheTtlMs: num('cacheTtlMs', 600000),
    tokenSet: !!(process.env.AGG_TOKEN || process.env.MODELHUB_TOKEN || prefs.controlToken)
  };
}

function retryAttempts() {
  const s = prefs.settings || {};
  const num = (k, d) => (Number.isFinite(s[k]) ? s[k] : d);
  // retryAttempts setting, default 2
  return num('retryAttempts', 2);
}

function enhancerCfg() {
  const e = prefs.enhancer || {};
  return {
    enabled: typeof e.enabled === 'boolean' ? e.enabled : true,
    model: e.model || null,
    maxChars: e.maxChars || 4000,
    timeoutMs: e.timeoutMs || 12000,
    plugins: Array.isArray(e.plugins) ? e.plugins : []
  };
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

const keyUsage = new Map();
function keyIdFor(req) {
  const a = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'].replace(/^Bearer\s+/i, '') : '';
  return a || req.headers['x-api-key'] || null;
}
function keyLimit(key) {
  if (!key) return null;
  const lim = (prefs.keylimits && prefs.keylimits[key]) || {};
  return { tokens: lim.tokens || 0, spend: lim.spend || 0 };
}
function keyUsed(key) { return keyUsage.get(key) || { tokens: 0, spent: 0 }; }
function recordKeyUsage(key, tokens, cost) {
  if (!key) return;
  const u = keyUsage.get(key) || { tokens: 0, spent: 0 };
  u.tokens += tokens || 0;
  u.spent += cost || 0;
  keyUsage.set(key, u);
}
function keyOverLimit(key) {
  const lim = keyLimit(key);
  if (!lim) return false;
  const u = keyUsage.get(key) || { tokens: 0, spent: 0 };
  if (lim.tokens && u.tokens >= lim.tokens) return true;
  if (lim.spend && u.spent >= lim.spend) return true;
  return false;
}
function gatewayAuthorized(req) {
  const a = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'].replace(/^Bearer\s+/i, '') : '';
  const alt = req.headers['x-api-key'] || '';
  const key = a || alt || null;
  if (!prefs.gatewayKeys || !prefs.gatewayKeys.length) return true;
  const ok = prefs.gatewayKeys.includes(a) || prefs.gatewayKeys.includes(alt);
  if (!ok) return false;
  if (key && keyOverLimit(key)) return false;
  return true;
}
function controlRateLimited(req) {
  if (!prefs.controlToken && !process.env.AGG_TOKEN && !process.env.MODELHUB_TOKEN) return false;
  const key = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const b = rateBuckets.get(key) || { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (now > b.resetAt) { b.count = 0; b.resetAt = now + RATE_WINDOW_MS; }
  b.count++;
  rateBuckets.set(key, b);
  return b.count > RATE_MAX;
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
  if (prefs.freeMode === 'free-preferred' && models[id].free) s += 5;
  s -= (usage[id] || 0) * 0.0001;
  return s;
}

function estimateTokens(text) {
  return Math.max(1, Math.round(String(text || '').length / 4));
}

function tallyUsage(modelId, promptTokens, completionTokens) {
  if (!modelId || !models[modelId]) return 0;
  usage[modelId] = (usage[modelId] || 0) + 1;
  const pr = pricingLib.priceFor(pricing, models[modelId].provider, modelId);
  const cost = pricingLib.computeCost(pr, promptTokens, completionTokens);
  costTotal += cost;
  tokensTotal += promptTokens + completionTokens;
  requestsTotal += 1;
  return cost;
}

function resolveProfile(requested, messages) {
  if (requested && requested !== 'auto' && String(requested).startsWith('auto-intent') === false) return requested;
  const last = [...(messages || [])].reverse().find((m) => m && m.role === 'user');
  const txt = last ? (typeof last.content === 'string' ? last.content : JSON.stringify(last.content || '')) : '';
  const it = modelsLib.classifyPrompt(txt);
  if (it.code) return 'auto-code';
  if (it.reasoning) return 'auto-reasoning';
  if (it.fast) return 'auto-fast';
  return 'auto';
}

function maybeExperiment(profile, order) {
  const e = prefs.experiments;
  if (!e || !e.enabled || !e.candidate) return order;
  if (e.profile && e.profile !== profile) return order;
  if (order[0] === e.candidate || !models[e.candidate]) return order;
  const pct = Math.max(0, Math.min(100, e.splitPct || 0));
  if (Math.floor(Math.random() * 100) < pct) return [e.candidate, ...order.filter((id) => id !== e.candidate)];
  return order;
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
  const ids = maybeExperiment(profile, profileIds(profile));
  let valid = ids.filter((id) => models[id] && !modelsLib.CHAT_BLOCK.test(id) && prefs.enabled[id] !== false);
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
  // Circuit breaker: drop models whose provider circuit is OPEN before scoring.
  const openCount = valid.filter((id) => healthLib.isCircuitOpen(models[id].provider, id)).length;
  if (openCount < valid.length) {
    const filtered = valid.filter((id) => !healthLib.isCircuitOpen(models[id].provider, id));
    circuitOpenCount += valid.length - filtered.length;
    valid = filtered;
  }
  // Free mode.
  if (prefs.freeMode === 'free-only') {
    const free = valid.filter((id) => models[id].free);
    if (free.length) valid = free;
  }
  const last = body.messages[body.messages.length - 1];
  const meta = modelsLib.classifyPrompt(last ? last.content : '');
  if (prefs.freeMode === 'free-preferred') {
    valid = valid.slice().sort((a, b) => {
      const fa = models[a].free ? 0 : 1;
      const fb = models[b].free ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return autorouteScore(b, meta, body.intent) - autorouteScore(a, meta, body.intent);
    });
    return valid[0];
  }
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
    up.on('end', () => {
      res.end();
      if (ctx && ctx.start && ctx.provider) healthLib.markOk(ctx.provider, modelId, Date.now() - ctx.start);
    });
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
      const cost = tallyUsage(modelId, ctx.promptTokens, estimateTokens(seenText));
      recordKeyUsage(ctx.gkey, ctx.promptTokens + estimateTokens(seenText), cost);
      if (ctx.start) latency[modelId] = Date.now() - ctx.start;
    }
  });
  up.on('error', onError);
}

function completeNonStream(res, rawText, modelId, ctx) {
  try {
    const v = JSON.parse(rawText);
    const text = (v.choices && v.choices[0] && v.choices[0].message && v.choices[0].message.content) || '';
    const cost = tallyUsage(modelId, ctx.promptTokens, estimateTokens(text));
    recordKeyUsage(ctx.gkey, ctx.promptTokens + estimateTokens(text), cost);
    if (ctx.start) latency[modelId] = Date.now() - ctx.start;
    if (ctx.start && ctx.provider) healthLib.markOk(ctx.provider, modelId, Date.now() - ctx.start);
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
  // Transparent headers: forward client-supplied request metadata to upstream.
  const forward = ['x-request-id', 'x-session-id', 'x-user-id', 'x-trace-id', 'x-correlation-id'];
  for (const h of forward) {
    const v = (ctx && ctx.headers && ctx.headers[h]) || (data && data.headers && data.headers[h]);
    if (v) headers[h] = v;
  }
  const session = ctx && ctx.headers && ctx.headers['x-session-id'];
  if (session && !payload.session_id) payload.session_id = session;
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
        const retryAfter = up.headers && up.headers['retry-after'];
        let retryAfterMs = 0;
        if (retryAfter) {
          const secs = Number(retryAfter);
          retryAfterMs = Number.isFinite(secs) ? secs * 1000 : 0;
        }
        healthLib.markFail(prov.name, modelId, retryAfterMs);
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
  req.on('timeout', () => { healthLib.markFail(prov.name, modelId); req.destroy(new Error('upstream timeout')); });
  req.on('error', (e) => { healthLib.markFail(prov.name, modelId); onError(e); });
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
  const pluginText = (prefs.enhancer.plugins || []).filter((id) => ENHANCE_PLUGINS[id]).map((id) => ENHANCE_PLUGINS[id].text).join('\n');
  if (pluginText) guidance = guidance + '\n' + pluginText;
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

function fetchJSON(targetURL, apiKey) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(targetURL); } catch (e) { return reject(new Error('bad url')); }
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request({
      method: 'GET',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      headers: { Authorization: apiKey ? 'Bearer ' + apiKey : '', Accept: 'application/json' },
      timeout: 15000
    }, (up) => {
      let b = '';
      up.on('data', (d) => (b += d));
      up.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json')); }
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function modelsEndpoint(baseURL, name) {
  baseURL = String(baseURL || '').replace(/\/+$/, '');
  if (name === 'gemini') return baseURL + '/v1beta/models';
  return baseURL + '/models';
}

function probeModel(modelId) {
  const m = models[modelId];
  if (!m) return Promise.resolve({ model: modelId, ok: false, error: 'unknown model' });
  const prov = providers[m.provider];
  if (!prov) return Promise.resolve({ model: modelId, ok: false, error: 'unknown provider' });
  const { endpoint, payload, kind } = buildRequest(prov, modelId, {
    model: modelId,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    stream: false
  });
  return new Promise((resolve) => {
    const t0 = Date.now();
    const key = m.needsKey ? authKeyFor(m.authId) : null;
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (key) {
      if (prov.name === 'anthropic') headers['x-api-key'] = key;
      else headers['authorization'] = 'Bearer ' + key;
    }
    const u = new URL(endpoint);
    const transport = u.protocol === 'https:' ? https : http;
    const r = transport.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers,
      timeout: 15000
    }, (up) => {
      let b = '';
      up.on('data', (d) => (b += d));
      up.on('end', () => {
        const ms = Date.now() - t0;
        if (up.statusCode && up.statusCode >= 200 && up.statusCode < 300) {
          latency[modelId] = ms;
          resolve({ model: modelId, ok: true, latencyMs: ms });
        } else {
          resolve({ model: modelId, ok: false, latencyMs: ms, error: 'HTTP ' + up.statusCode });
        }
      });
    });
    r.on('error', (e) => resolve({ model: modelId, ok: false, latencyMs: Date.now() - t0, error: (e && e.message) || String(e) }));
    r.on('timeout', () => { r.destroy(new Error('timeout')); resolve({ model: modelId, ok: false, latencyMs: Date.now() - t0, error: 'timeout' }); });
    r.write(JSON.stringify(payload));
    r.end();
  });
}

function handleChat(body, req, res) {
  const gkey = keyIdFor(req);
  const requested = body.model;
  let profile = (requested && prefs.profiles && prefs.profiles[requested]) ? requested : null;
  let data = Object.assign({}, body);
  if (body.intent || requested === 'auto-intent' || !profile) {
    profile = resolveProfile(body.intent || requested, data.messages || []);
  }
  if (!prefs.profiles[profile]) profile = 'auto';
  if (prefs.enhancer && prefs.enhancer.enabled && !(prefs.enhance && prefs.enhance[profile] === false)) {
    data = applyEnhancer(data, profile);
  }
  const cascade = Array.isArray(body.cascade) && body.cascade.length ? body.cascade : null;
  const firstId = cascade ? cascade[0] : selectModel(profile, data);
  if (!firstId) return sendError(res, 400, 'no model available for profile ' + profile);
  const key = cacheLib.cacheKey(data);
  if (CACHE_ENABLED && !body.stream && responseCache.has(key)) {
    cacheHits++;
    recordKeyUsage(gkey, 0, 0);
    return res.end(JSON.stringify(responseCache.get(key).value));
  }
  const promptTokens = estimateTokens(JSON.stringify(data.messages || []));

const doRequest = (modelId, done) => {
  const prov = providers[models[modelId].provider];
  if (!prov) return done(new Error('unknown provider for ' + modelId));
  const ctx = { promptTokens, cacheKey: key, cacheIt: CACHE_ENABLED && !body.stream, start: Date.now(), gkey, provider: prov.name, headers: req.headers };
  const attemptNum = retryAttempts();
  healthLib.withRetry(
    (callback) => {
      proxyRequest(prov, modelId, Object.assign({}, data, { model: modelId }), res, callback, ctx);
    },
    attemptNum,
    { base: 300, cap: 5000, onRetry: () => logFn(`Retrying model ${modelId}`) }
  ).then((result) => done(null, result)).catch(done);
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
  const gkey = keyIdFor(req);
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
          const pt = estimateTokens(JSON.stringify(body.input));
          const pr = pricingLib.priceFor(pricing, prov.name, payload.model);
          const cost = pricingLib.computeCost(pr, pt, 0);
          tokensTotal += pt;
          requestsTotal += 1;
          recordKeyUsage(gkey, pt, cost);
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
  const expected = process.env.AGG_TOKEN || process.env.MODELHUB_TOKEN || (prefs && prefs.controlToken) || '';
  const h = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'].replace(/^Bearer\s+/i, '') : '';
  if (h === expected) return true;
  if ((req.headers['x-modelhub-token'] || '') === expected) return true;
  let q = '';
  try { q = new URL(req.url, 'http://localhost').searchParams.get('token') || ''; } catch (e) {}
  return q === expected;
}

function servePanel(req, res, urlPath) {
  let rel = urlPath;
  if (urlPath === '/') rel = '/panel/index.html';
  if (urlPath === '/widget') rel = '/panel/widget.html';
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
    return json(res, 200, { models: Object.keys(models).length, providers: Object.keys(providers).length, profiles: prefs.profiles, cacheHits, cache: CACHE_ENABLED, gatewayKeys: prefs.gatewayKeys || [], freeMode: prefs.freeMode, health: Object.keys(healthLib.health).map((k) => ({ key: k, status: healthLib.health[k].status, fails: healthLib.health[k].fails })) });
  }
  if (p === '/hub/freemode' && req.method === 'GET') {
    const free = Object.values(models).filter((m) => m.free);
    return json(res, 200, { mode: prefs.freeMode, freeModels: free.length, totalModels: Object.keys(models).length, free: free.map((m) => ({ id: m.id, provider: m.provider })) });
  }
  if (p === '/hub/freemode' && req.method === 'POST') {
    return readJsonBody(req, res, (body) => {
      const modes = ['free-only', 'free-preferred', 'all'];
      const mode = String(body && body.mode || '').trim();
      if (!modes.includes(mode)) return sendError(res, 400, 'invalid mode: ' + mode);
      prefs.freeMode = mode;
      storage.writeJSON(PREFS_FILE, prefs, logFn);
      json(res, 200, { ok: true, freeMode: prefs.freeMode });
    });
  }
  if (p === '/hub/sync' && req.method === 'POST') {
    // Sync gateway keys from auth store (named entries) — useful for bulk import.
    return readJsonBody(req, res, (body) => {
      const keys = Array.isArray(body && body.keys) ? body.keys.map((k) => String(k).trim()).filter(Boolean) : [];
      if (!keys.length) return sendError(res, 400, 'keys required');
      prefs.gatewayKeys = keys;
      storage.writeJSON(PREFS_FILE, prefs, logFn);
      json(res, 200, { ok: true, count: keys.length });
    });
  }
  if (p === '/hub/sync' && req.method === 'GET') {
    return json(res, 200, { gatewayKeys: prefs.gatewayKeys || [], auth: (authStore.entries || []).map((e) => e.name) });
  }
  if (p === '/hub/config' && req.method === 'GET') return json(res, 200, config);
  if (p === '/hub/prefs' && req.method === 'GET') return json(res, 200, prefs);
  if (p === '/hub/pricing' && req.method === 'GET') return json(res, 200, pricing);
  if (p === '/hub/pricing' && req.method === 'POST') {
    return readJsonBody(req, res, (body) => {
      if (!body || !body.provider) return sendError(res, 400, 'provider required');
      pricing.providers = pricing.providers || {};
      pricing.providers[body.provider] = { input: Number(body.input) || 0, output: Number(body.output) || 0 };
      storage.writeJSON(PRICING_FILE, pricing, logFn);
      json(res, 200, { ok: true });
    });
  }
  if (p === '/hub/features' && req.method === 'GET') return json(res, 200, prefs.features || {});
  if (p === '/hub/cache' && req.method === 'GET') return json(res, 200, { entries: responseCache.size, enabled: CACHE_ENABLED });
  if (p === '/hub/cache' && req.method === 'POST') {
    responseCache.clear();
    cacheHits = 0;
    return json(res, 200, { ok: true });
  }
  if (p === '/hub/settings' && req.method === 'GET') return json(res, 200, settingsCfg());
  if (p === '/hub/settings' && req.method === 'POST') {
    return readJsonBody(req, res, (body) => {
      const s = prefs.settings || (prefs.settings = {});
      const bounds = { verifyMs: [30000, 86400000], verifyTopK: [3, 50], failoverMs: [5000, 600000], cacheTtlMs: [10000, 86400000] };
      for (const [k, [min, max]] of Object.entries(bounds)) {
        const v = Number(body[k]);
        if (Number.isFinite(v)) s[k] = Math.min(max, Math.max(min, Math.round(v)));
      }
      let newToken = null;
      if (body.regenerateToken === true) {
        newToken = crypto.randomBytes(24).toString('hex');
        prefs.controlToken = newToken;
      }
      storage.writeJSON(PREFS_FILE, prefs, logFn);
      json(res, 200, { ok: true, settings: settingsCfg(), regeneratedToken: newToken });
    });
  }
  if (p === '/hub/logs' && req.method === 'GET') return json(res, 200, { logs: reqLog.slice().reverse() });
  if (p === '/hub/models' && req.method === 'GET') {
    const prov = u.searchParams.get('provider');
    return json(res, 200, Object.values(models).filter((m) => !prov || m.provider === prov));
  }
  if (p === '/hub/usage' && req.method === 'GET') {
    return json(res, 200, { usage, cost: costTotal, cacheHits, requests: requestsTotal, tokens: tokensTotal, gatewayKeys: (prefs.gatewayKeys || []).length, keyUsage: (prefs.gatewayKeys || []).map((k) => ({ key: k, limit: keyLimit(k), used: keyUsed(k) })) });
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
  if (p === '/hub/strategy' && req.method === 'POST') {
    return readJsonBody(req, res, (body) => {
      if (!body || !body.profile) return sendError(res, 400, 'profile required');
      if (!STRATEGIES.includes(body.strategy)) return sendError(res, 400, 'invalid strategy');
      prefs.strategy = prefs.strategy || {};
      prefs.strategy[body.profile] = body.strategy;
      storage.writeJSON(PREFS_FILE, prefs, logFn);
      json(res, 200, { ok: true, strategies: prefs.strategy });
    });
  }
  if (p === '/hub/enhancer' && req.method === 'POST') {
    return readJsonBody(req, res, (body) => {
      const e = prefs.enhancer || (prefs.enhancer = {});
      if (typeof body.enabled === 'boolean') e.enabled = body.enabled;
      if (Array.isArray(body.plugins)) e.plugins = body.plugins.map(String);
      if (body.model !== undefined) e.model = body.model || '';
      if (Number.isFinite(body.maxChars)) e.maxChars = Math.max(200, body.maxChars);
      if (Number.isFinite(body.timeoutMs)) e.timeoutMs = Math.max(1000, body.timeoutMs);
      storage.writeJSON(PREFS_FILE, prefs, logFn);
      json(res, 200, { ok: true, enhancer: enhancerCfg() });
    });
  }
  if (p === '/hub/alerts' && req.method === 'POST') {
    return readJsonBody(req, res, (body) => {
      prefs.alerts = { webhook: (body.webhook || '') };
      if (typeof body.webhook === 'string') prefs.webhook = body.webhook || null;
      storage.writeJSON(PREFS_FILE, prefs, logFn);
      json(res, 200, { ok: true, alerts: prefs.alerts });
    });
  }
  if (p === '/hub/profile/delete' && req.method === 'POST') {
    return readJsonBody(req, res, (body) => {
      if (!body.name) return sendError(res, 400, 'name required');
      if (DEFAULT_PROFILES.includes(body.name)) return sendError(res, 400, 'cannot delete default profile');
      prefs.profiles = prefs.profiles || {};
      delete prefs.profiles[body.name];
      storage.writeJSON(PREFS_FILE, prefs, logFn);
      json(res, 200, { ok: true, profiles: Object.keys(prefs.profiles) });
    });
  }
  if (p === '/hub/toggle' && req.method === 'POST') {
    return readJsonBody(req, res, (body) => {
      if (!body.id) return sendError(res, 400, 'id required');
      const flag = body.enabled !== false;
      const prov = (config.providers || []).find((x) => x.name === body.id);
      if (prov) {
        prov.enabled = flag;
        storage.writeJSON(CONFIG_FILE, config, logFn);
        rebuildRegistry();
      } else if (models[body.id]) {
        prefs.enabled = prefs.enabled || {};
        prefs.enabled[body.id] = flag;
        storage.writeJSON(PREFS_FILE, prefs, logFn);
      } else {
        return sendError(res, 404, 'id not found');
      }
      json(res, 200, { ok: true });
    });
  }
  if (p === '/hub/reorder' && req.method === 'POST') {
    return readJsonBody(req, res, (body) => {
      if (!body || !Array.isArray(body.order)) return sendError(res, 400, 'order required');
      const prof = body.profile || 'auto';
      prefs.profiles = prefs.profiles || {};
      prefs.profiles[prof] = body.order.filter((id) => !!models[id]);
      storage.writeJSON(PREFS_FILE, prefs, logFn);
      json(res, 200, { ok: true });
    });
  }
  if (p === '/hub/gateway-keys' && req.method === 'POST') {
    return readJsonBody(req, res, (body) => {
      if (!body || !Array.isArray(body.keys)) return sendError(res, 400, 'keys array required');
      prefs.gatewayKeys = body.keys.map((k) => String(k).trim()).filter(Boolean);
      storage.writeJSON(PREFS_FILE, prefs, logFn);
      json(res, 200, { ok: true, count: prefs.gatewayKeys.length });
    });
  }
  if (p === '/hub/keys') {
    if (req.method === 'GET') {
      const keys = (prefs.gatewayKeys || []).map((k) => ({ key: k, limit: keyLimit(k), used: keyUsed(k) }));
      return json(res, 200, { keys });
    }
    if (req.method === 'POST') {
      return readJsonBody(req, res, (body) => {
        if (body && typeof body === 'object' && Object.keys(body).some((k) => k !== 'key' && k !== 'tokens' && k !== 'spend')) {
          let count = 0;
          authStore.entries = authStore.entries || [];
          for (const [provider, key] of Object.entries(body)) {
            if (provider === 'key' || provider === 'tokens' || provider === 'spend') continue;
            if (typeof key !== 'string' || !key.trim()) continue;
            const enc = cryptoLib.encryptAuth(key.trim());
            const ex = authStore.entries.find((x) => x.name === provider);
            if (ex) ex.key = enc; else authStore.entries.push({ name: provider, key: enc });
            count++;
          }
          if (count > 0) {
            storage.writeJSON(AUTH_FILE, authStore, logFn);
            return json(res, 200, { ok: true, count, imported: { keys: count } });
          }
        }
        const k = (body && body.key) || (prefs.gatewayKeys && prefs.gatewayKeys[0]) || null;
        if (!k) return sendError(res, 400, 'no gateway key');
        prefs.keylimits = prefs.keylimits || {};
        const lim = prefs.keylimits[k] || (prefs.keylimits[k] = {});
        if (Number.isFinite(body.tokens)) lim.tokens = body.tokens;
        if (Number.isFinite(body.spend)) lim.spend = body.spend;
        storage.writeJSON(PREFS_FILE, prefs, logFn);
        json(res, 200, { ok: true, key: k, limit: keyLimit(k) });
      });
    }
  }
  if (p === '/hub/experiments' && req.method === 'POST') {
    return readJsonBody(req, res, (body) => {
      prefs.experiments = prefs.experiments || {};
      if (body.name && Array.isArray(body.variants)) {
        if (!body.variants.length) return sendError(res, 400, 'variants required');
        prefs.experiments[body.name] = { variants: body.variants, weight: body.weight || body.variants.map(() => 1) };
      } else {
        prefs.experiments = { enabled: !!body.enabled, profile: body.profile || 'auto', candidate: body.candidate || '', splitPct: Number.isFinite(body.splitPct) ? body.splitPct : 0 };
      }
      storage.writeJSON(PREFS_FILE, prefs, logFn);
      json(res, 200, { ok: true, experiments: prefs.experiments });
    });
  }
  if (p === '/hub/import' && req.method === 'POST') {
    return readJsonBody(req, res, (inc) => {
      if (!inc || (!inc.config && !inc.prefs && !inc.keys)) return sendError(res, 400, 'nothing to import');
      const imported = { providers: 0, keys: 0, profiles: 0 };
      if (inc.config && Array.isArray(inc.config.providers)) {
        config = Object.assign({}, inc.config, { port: config.port });
        imported.providers = config.providers.length;
        storage.writeJSON(CONFIG_FILE, config, logFn);
      }
      if (inc.keys && typeof inc.keys === 'object') {
        authStore.entries = authStore.entries || [];
        if (Array.isArray(inc.keys.entries)) {
          for (const e of inc.keys.entries) {
            if (!e || !e.name) continue;
            const val = typeof e.key === 'string' ? e.key : null;
            if (!val) continue;
            const ex = authStore.entries.find((x) => x.name === e.name);
            if (ex) ex.key = val; else authStore.entries.push({ name: e.name, key: val });
            imported.keys++;
          }
        } else {
          for (const [k, v] of Object.entries(inc.keys)) {
            if (typeof v !== 'string' || !v) continue;
            authStore.entries.push({ name: k, key: v });
            imported.keys++;
          }
        }
        storage.writeJSON(AUTH_FILE, authStore, logFn);
      }
      if (inc.prefs && typeof inc.prefs === 'object') {
        for (const k of ['enabled', 'profiles', 'strategy', 'gatewayKeys', 'enhancer', 'features']) {
          if (inc.prefs[k] !== undefined) prefs[k] = inc.prefs[k];
        }
        normalizePrefs();
        imported.profiles = Object.keys(prefs.profiles || {}).length;
        storage.writeJSON(PREFS_FILE, prefs, logFn);
      }
      if (inc.pricing && typeof inc.pricing === 'object' && inc.pricing.providers) {
        pricing = inc.pricing;
        storage.writeJSON(PRICING_FILE, pricing, logFn);
      }
      rebuildRegistry();
      json(res, 200, { ok: true, imported });
    });
  }
  if (p === '/hub/discover' && req.method === 'POST') {
    return readJsonBody(req, res, async (body) => {
      const runProvider = async (pr) => {
        try {
          const key = pr.needsKey ? authKeyFor(pr.authId) : null;
          const list = await fetchJSON(modelsEndpoint(pr.baseURL, pr.name), key);
          const known = new Set((pr.models || []).map((m) => m.name));
          pr.models = pr.models || [];
          let added = 0;
          for (const it of (list.data || [])) {
            const name = typeof it === 'string' ? it : it.id;
            if (!name || known.has(name)) continue;
            pr.models.push({ name, label: name, free: false });
            known.add(name);
            added++;
          }
          return { provider: pr.name, added, total: pr.models.length, error: '' };
        } catch (e) {
          return { provider: pr.name, added: 0, total: (pr.models || []).length, error: String((e && e.message) || e).slice(0, 120) };
        }
      };
      if (body.provider) {
        const pr = (config.providers || []).find((x) => x.name === body.provider);
        if (!pr) return sendError(res, 404, 'provider not found');
        const results = [await runProvider(pr)];
        storage.writeJSON(CONFIG_FILE, config, logFn);
        rebuildRegistry();
        return json(res, 200, { ok: true, results });
      }
      const targets = (config.providers || []).filter((pr) => /^https?:/i.test(pr.baseURL || ''));
      const results = [];
      for (const pr of targets) results.push(await runProvider(pr));
      storage.writeJSON(CONFIG_FILE, config, logFn);
      rebuildRegistry();
      json(res, 200, { ok: true, scanned: targets.length, results });
    });
  }
  if (p === '/hub/probe' && req.method === 'POST') {
    return readJsonBody(req, res, async (body) => {
      const targets = body.id ? [body.id].filter((id) => models[id]) : Object.keys(models).filter((id) => models[id].enabled !== false);
      const results = [];
      for (const id of targets) {
        const r = await Promise.race([probeModel(id), new Promise((res2) => setTimeout(() => res2({ model: id, ok: false, error: 'probe timeout', latencyMs: 15000 }), 15000))]);
        results.push(r);
      }
      json(res, 200, { ok: true, models: results });
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
      const urlValidation = securityLib.validateProviderURL(provider.baseURL);
      if (!urlValidation.ok) return sendError(res, 400, urlValidation.reason);
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
    const payload = {
      exportedAt: new Date().toISOString(),
      version: 'LLM-Aggregator 0.1.0',
      config,
      pricing,
      prefs,
      keys: authStore
    };
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="llm-aggregator-export-' + new Date().toISOString().slice(0, 10) + '.json"'
    });
    return res.end(JSON.stringify(payload, null, 2));
  }
  sendError(res, 404, 'unknown hub endpoint');
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const t0 = Date.now();
  res.on('finish', () => recordRequest({ method: req.method, path: p, status: res.statusCode, ms: Date.now() - t0 }));
  if (req.method === 'GET' && (p === '/' || p === '/widget' || p.startsWith('/panel'))) return servePanel(req, res, p);
  if (req.method === 'GET' && p === '/v1/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, models: Object.keys(models).length })); }
  if (req.method === 'GET' && p === '/metrics') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(metricsLib.promMetrics({ startTime, cacheHits, models, cost: costTotal, tokens: tokensTotal, requests: requestsTotal, gatewayKeys: prefs.gatewayKeys || [], keyUsage })); }
  if (req.method === 'GET' && p === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: Object.keys(models).map((id) => ({ id, object: 'model', provider: models[id].provider })) }));
  }
  if (p === '/v1/chat/completions' && req.method === 'POST') {
    if (!gatewayAuthorized(req)) return sendError(res, 401, 'invalid or missing gateway key');
    let buf = '';
    req.on('data', (d) => (buf += d));
    req.on('end', () => { try { handleChat(JSON.parse(buf), req, res); } catch (e) { sendError(res, 400, 'bad request: ' + e.message); } });
    return;
  }
  if (p === '/v1/embeddings' && req.method === 'POST') {
    if (!gatewayAuthorized(req)) return sendError(res, 401, 'invalid or missing gateway key');
    let buf = '';
    req.on('data', (d) => (buf += d));
    req.on('end', () => { try { handleEmbeddings(JSON.parse(buf), req, res); } catch (e) { sendError(res, 400, 'bad request: ' + e.message); } });
    return;
  }
  if (p.startsWith('/hub/')) {
    if (controlRateLimited(req)) return sendError(res, 429, 'rate limited');
    if (!requireToken(req, res)) return sendError(res, 401, 'unauthorized');
    return handleHub(req, res, p, u);
  }
  sendError(res, 404, 'not found');
});

function start() {
  authStore = storage.readJSON(AUTH_FILE, { entries: [] });
  restoreHealthState();
  normalizePrefs();
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

module.exports = { start, server, selectModel, resolveProfile };
