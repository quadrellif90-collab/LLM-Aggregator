'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-test-'));
process.env.AGG_PORT = '8799';
process.env.AGG_DIR = tmp;
process.env.AGG_CACHE = '1';

const gateway = require('../server/index');
const PORT = 8799;

function request(method, p, headers, body) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ 'content-type': 'application/json' }, headers || {});
    if (data !== null) h['content-length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: h }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    if (data !== null) req.write(data);
    req.end();
  });
}
const get = (p, h) => request('GET', p, h);
const post = (p, body, h) => request('POST', p, h, body);

const chatBody = { model: 'auto', messages: [{ role: 'user', content: 'hi' }] };

let started = false;
before(async () => {
  const probe = await get('/v1/health');
  if (!probe.error) throw new Error('port 8799 already in use; cannot run the test suite');
  await new Promise((resolve) => {
    gateway.start();
    gateway.server.once('listening', resolve);
  });
  started = true;
});

after(async () => {
  if (started) await new Promise((resolve) => gateway.server.close(resolve));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
});

test('v1/health returns 200 with a model count', async () => {
  const r = await get('/v1/health');
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.body);
  assert.ok(Number.isInteger(j.models) && j.models >= 0);
});

test('v1/models returns 200 with a data array', async () => {
  const r = await get('/v1/models');
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.body);
  assert.ok(Array.isArray(j.data));
});

test('root serves the panel', async () => {
  const r = await get('/');
  assert.strictEqual(r.status, 200);
  assert.ok(/text\/html/.test(String(r.headers['content-type'])));
});

test('/metrics exposes gateway counters', async () => {
  const r = await get('/metrics');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.startsWith('# HELP'));
  assert.ok(r.body.includes('aggregator_gateway_keys_total'));
  assert.ok(r.body.includes('aggregator_gateway_key_tokens_total'));
});

test('hub/state returns 200 with gatewayKeys', async () => {
  const r = await get('/hub/state');
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.body);
  assert.ok(Array.isArray(j.gatewayKeys));
  assert.ok(j.profiles && j.profiles.auto);
});

test('hub/usage returns 200', async () => {
  const r = await get('/hub/usage');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(JSON.parse(r.body).keyUsage));
});

test('hub/settings GET returns defaults without a token set', async () => {
  const r = await get('/hub/settings');
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.body);
  assert.strictEqual(j.tokenSet, false);
  assert.strictEqual(j.verifyMs, 900000);
});

test('hub/logs returns 200 with a log array', async () => {
  const r = await get('/hub/logs');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(JSON.parse(r.body).logs));
});

test('hub/export returns an attachment with metadata', async () => {
  const r = await get('/hub/export');
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers['content-disposition'].includes('attachment'));
  const j = JSON.parse(r.body);
  assert.ok(j.exportedAt);
  assert.ok(/LLM-Aggregator/.test(j.version));
  assert.ok(Array.isArray(j.keys.entries));
});

test('unknown path returns 404', async () => {
  const r = await get('/nope');
  assert.strictEqual(r.status, 404);
});

test('embeddings returns 501 when no embeddings provider exists', async () => {
  const r = await post('/v1/embeddings', { model: 'text-embedding-3-small', input: 'hi' });
  assert.strictEqual(r.status, 501);
});

test('hub/strategy validates strategy values', async () => {
  const ok = await post('/hub/strategy', { profile: 'auto', strategy: 'cheapest' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(JSON.parse(ok.body).strategies.auto, 'cheapest');
  const bad = await post('/hub/strategy', { profile: 'auto', strategy: 'bogus' });
  assert.strictEqual(bad.status, 400);
});

test('hub/enhancer clamps maxChars and timeoutMs', async () => {
  const r = await post('/hub/enhancer', { maxChars: 100, timeoutMs: 500, plugins: ['concise', 'english'] });
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.body);
  assert.strictEqual(j.enhancer.maxChars, 200);
  assert.strictEqual(j.enhancer.timeoutMs, 1000);
  assert.deepStrictEqual(j.enhancer.plugins, ['concise', 'english']);
});

test('hub/pricing POST updates provider pricing', async () => {
  const r = await post('/hub/pricing', { provider: 'demo', input: 1, output: 2 });
  assert.strictEqual(r.status, 200);
  const g = await get('/hub/pricing');
  assert.deepStrictEqual(JSON.parse(g.body).providers.demo, { input: 1, output: 2 });
});

test('hub/cache POST clears without error', async () => {
  const r = await post('/hub/cache');
  assert.strictEqual(r.status, 200);
});

test('hub/profile/delete protects default profiles', async () => {
  const d = await post('/hub/profile/delete', { name: 'auto' });
  assert.strictEqual(d.status, 400);
  const c = await post('/hub/profile/delete', { name: 'custom-x' });
  assert.strictEqual(c.status, 200);
});

test('hub/reorder accepts an order list', async () => {
  const r = await post('/hub/reorder', { profile: 'auto', order: [] });
  assert.strictEqual(r.status, 200);
});

test('hub/alerts stores the webhook', async () => {
  const r = await post('/hub/alerts', { webhook: '' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.body).alerts.webhook, '');
});

test('hub/experiments accepts the single-candidate shape', async () => {
  const r = await post('/hub/experiments', { enabled: false, profile: 'auto', candidate: 'gpt-4o-mini', splitPct: 50 });
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.body);
  assert.strictEqual(j.experiments.enabled, false);
  assert.strictEqual(j.experiments.candidate, 'gpt-4o-mini');
});

test('hub/toggle returns 404 for unknown ids', async () => {
  const r = await post('/hub/toggle', { id: 'does-not-exist', enabled: true });
  assert.strictEqual(r.status, 404);
});

test('hub/keys bulk-imports provider keys and sets limits', async () => {
  const imp = await post('/hub/keys', { openai: 'sk-op-test', tokens: 5 });
  assert.strictEqual(imp.status, 200);
  assert.strictEqual(JSON.parse(imp.body).count, 1);
  const lim = await post('/hub/keys', { key: 'sk-test', tokens: 100, spend: 10 });
  assert.strictEqual(lim.status, 200);
  assert.deepStrictEqual(JSON.parse(lim.body).limit, { tokens: 100, spend: 10 });
});

test('hub/freemode GET returns mode + free models', async () => {
  const r = await get('/hub/freemode');
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.body);
  assert.ok(['free-only', 'free-preferred', 'all'].includes(j.mode));
  assert.ok(Number.isInteger(j.freeModels));
  assert.ok(Number.isInteger(j.totalModels));
  assert.ok(Array.isArray(j.free));
});

test('hub/freemode POST stores and persists the mode', async () => {
  const set = await post('/hub/freemode', { mode: 'free-only' });
  assert.strictEqual(set.status, 200);
  assert.strictEqual(JSON.parse(set.body).freeMode, 'free-only');

  const get2 = await get('/hub/freemode');
  assert.strictEqual(JSON.parse(get2.body).mode, 'free-only');

  const restore = await post('/hub/freemode', { mode: 'free-preferred' });
  assert.strictEqual(restore.status, 200);
  assert.strictEqual(JSON.parse(restore.body).freeMode, 'free-preferred');
});

test('hub/sync GET returns gateway keys + auth store names', async () => {
  const r = await get('/hub/sync');
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.body);
  assert.ok(Array.isArray(j.gatewayKeys));
  assert.ok(Array.isArray(j.auth));
});

test('hub/sync POST stores gateway keys and returns count', async () => {
  const set = await post('/hub/sync', { keys: ['sync-1', 'sync-2'] });
  assert.strictEqual(set.status, 200);
  assert.strictEqual(JSON.parse(set.body).count, 2);

  const get2 = await get('/hub/sync');
  assert.deepStrictEqual(JSON.parse(get2.body).gatewayKeys, ['sync-1', 'sync-2']);

  const clear = await post('/hub/sync', { keys: [] });
  assert.strictEqual(clear.status, 400);
  const after = await get('/hub/sync');
  assert.deepStrictEqual(JSON.parse(after.body).gatewayKeys, ['sync-1', 'sync-2']);
});

test('gateway keys gate chat completions', async () => {
  const set = await post('/hub/gateway-keys', { keys: ['sk-test'] });
  assert.strictEqual(set.status, 200);
  assert.strictEqual(JSON.parse(set.body).count, 1);
  const keys = await get('/hub/keys');
  assert.strictEqual(JSON.parse(keys.body).keys[0].key, 'sk-test');

  const noKey = await post('/v1/chat/completions', chatBody);
  assert.strictEqual(noKey.status, 401);
  const badKey = await post('/v1/chat/completions', chatBody, { Authorization: 'Bearer nope' });
  assert.strictEqual(badKey.status, 401);
  const goodKey = await post('/v1/chat/completions', chatBody, { Authorization: 'Bearer sk-test' });
  assert.notStrictEqual(goodKey.status, 401);
  assert.strictEqual(goodKey.status, 400);

  const clear = await post('/hub/gateway-keys', { keys: [] });
  assert.strictEqual(clear.status, 200);
  const open = await post('/v1/chat/completions', chatBody);
  assert.strictEqual(open.status, 400);
});

test('resolveProfile classifies intent', () => {
  const user = (content) => [{ role: 'user', content }];
  assert.strictEqual(gateway.resolveProfile('auto', user('write a python function using async/await')), 'auto-code');
  assert.strictEqual(gateway.resolveProfile('auto', user('why does the sky look blue, explain step by step')), 'auto-reasoning');
  assert.strictEqual(gateway.resolveProfile('auto', user('hi')), 'auto-fast');
  assert.strictEqual(gateway.resolveProfile('auto-code', user('hi')), 'auto-code');
  assert.strictEqual(gateway.resolveProfile('auto-intent', user('def hello():\n  return 1')), 'auto-code');
});

test('control token regeneration locks /hub/* behind the new token', async () => {
  const regen = await post('/hub/settings', { regenerateToken: true });
  assert.strictEqual(regen.status, 200);
  const token = JSON.parse(regen.body).regeneratedToken;
  assert.ok(typeof token === 'string' && token.length >= 40);
  assert.ok(JSON.parse(regen.body).settings.tokenSet);

  const denied = await get('/hub/state');
  assert.strictEqual(denied.status, 401);
  const viaQuery = await get('/hub/state?token=' + token);
  assert.strictEqual(viaQuery.status, 200);
  const viaHeader = await get('/hub/state', { Authorization: 'Bearer ' + token });
  assert.strictEqual(viaHeader.status, 200);
});