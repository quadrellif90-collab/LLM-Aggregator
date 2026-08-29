'use strict';

/**
 * Per-provider / per-model health tracking with an escalating circuit breaker
 * and an exponential-backoff + full-jitter retry helper.
 *
 * health keyed by `providerName` (and `providerName/modelId` for model-level).
 * Shape per entry: { status, fails, lastFail, cooldownUntil, latencyAvg, success }
 */

const health = {};

function key(providerName, modelId) {
  return modelId ? providerName + '/' + modelId : providerName;
}

function getEntry(providerName, modelId) {
  const k = key(providerName, modelId);
  if (!health[k]) {
    health[k] = { status: 'ok', fails: 0, lastFail: 0, cooldownUntil: 0, latencyAvg: 0, success: 0 };
  }
  return health[k];
}

function applyFail(h, retryAfterMs) {
  const now = Date.now();
  h.fails++;
  h.lastFail = now;
  if (retryAfterMs && retryAfterMs > 0) {
    h.cooldownUntil = now + Math.max(retryAfterMs, 1000);
  } else {
    h.cooldownUntil = now + Math.min(60000 * Math.pow(2, h.fails), 600000);
  }
  h.status = h.fails >= 3 ? 'down' : 'degraded';
  return h;
}

/**
 * Record an upstream failure. Updates both the model-level and provider-level
 * entries so the circuit can open at provider granularity (used by selectModel).
 */
function markFail(providerName, modelId, retryAfterMs) {
  const provider = applyFail(getEntry(providerName), retryAfterMs);
  let model = null;
  if (modelId) model = applyFail(getEntry(providerName, modelId), retryAfterMs);
  return { provider, model };
}

/**
 * Record a successful upstream response and update the EWMA latency.
 */
function markOk(providerName, modelId, latencyMs) {
  const touch = (h) => {
    h.fails = 0;
    h.status = 'ok';
    h.success++;
    if (typeof latencyMs === 'number' && latencyMs >= 0) {
      h.latencyAvg = h.latencyAvg === 0 ? latencyMs : h.latencyAvg * 0.8 + latencyMs * 0.2;
    }
    return h;
  };
  const provider = touch(getEntry(providerName));
  let model = null;
  if (modelId) model = touch(getEntry(providerName, modelId));
  return { provider, model };
}

/** True if the circuit is currently open (cooldown not elapsed). */
function isCircuitOpen(providerName, modelId) {
  const now = Date.now();
  if (getEntry(providerName).cooldownUntil > now) return true;
  if (modelId && getEntry(providerName, modelId).cooldownUntil > now) return true;
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run fn() (sync or Promise-returning). On error, if attempts remain, sleep a
 * random duration in [0, base*2^retry] (full jitter) capped at `cap` ms, then
 * recurse. opts.onRetry() fires on each retry. Total attempts kept small (<=2).
 */
function withRetry(fn, attempts, opts) {
  opts = opts || {};
  const base = opts.base || 300;
  const cap = opts.cap || 4000;

  function run(attempt) {
    try {
      const r = fn();
      if (r && typeof r.then === 'function') {
        return r.catch((err) => attempt >= attempts ? Promise.reject(err) : retry(err, attempt));
      }
      return r;
    } catch (err) {
      if (attempt >= attempts) return Promise.reject(err);
      return retry(err, attempt);
    }
  }

  function retry(err, attempt) {
    const backoff = base * Math.pow(2, attempt - 1);
    const ms = Math.min(Math.random() * backoff, cap);
    if (typeof opts.onRetry === 'function') opts.onRetry();
    return sleep(ms).then(() => run(attempt + 1));
  }

  return run(1);
}

module.exports = { health, getEntry, markFail, markOk, isCircuitOpen, withRetry };
