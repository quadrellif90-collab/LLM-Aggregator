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
  out += '# HELP llm_aggregator_requests_total Total chat/embedding requests handled.\n';
  out += '# TYPE llm_aggregator_requests_total counter\n';
  out += 'llm_aggregator_requests_total ' + (state.requests || 0) + '\n';
  out += '# HELP llm_aggregator_tokens_total Estimated total tokens processed.\n';
  out += '# TYPE llm_aggregator_tokens_total counter\n';
  out += 'llm_aggregator_tokens_total ' + (state.tokens || 0) + '\n';
  out += '# HELP llm_aggregator_cost_total Estimated total cost in currency units.\n';
  out += '# TYPE llm_aggregator_cost_total counter\n';
  out += 'llm_aggregator_cost_total ' + (state.cost || 0).toFixed(6) + '\n';
  return out;
}

module.exports = { promMetrics };
