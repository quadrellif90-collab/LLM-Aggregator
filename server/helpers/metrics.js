'use strict';

/** Render a minimal Prometheus exposition for the gateway. */
function promMetrics(state) {
  const up = Math.floor((Date.now() - (state.startTime || Date.now())) / 1000);
  const models = state.models || {};
  let out = '';
  out += '# HELP aggregator_uptime_seconds Seconds since the gateway started.\n';
  out += '# TYPE aggregator_uptime_seconds gauge\n';
  out += 'aggregator_uptime_seconds ' + up + '\n';
  out += '# HELP aggregator_cache_hits_total Total cached responses served.\n';
  out += '# TYPE aggregator_cache_hits_total counter\n';
  out += 'aggregator_cache_hits_total ' + (state.cacheHits || 0) + '\n';
  out += '# HELP aggregator_models_total Number of known models.\n';
  out += '# TYPE aggregator_models_total gauge\n';
  out += 'aggregator_models_total ' + Object.keys(models).length + '\n';
  return out;
}

module.exports = { promMetrics };
