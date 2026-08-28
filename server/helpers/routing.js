'use strict';

/** Map a provider name + base URL to its chat endpoint. */
function deriveEndpoint(baseURL, name) {
  baseURL = String(baseURL || '').replace(/\/+$/, '');
  if (name === 'anthropic') return baseURL + '/v1/messages';
  if (name === 'gemini') return baseURL + '/v1beta/models';
  return baseURL + '/v1/chat/completions';
}

/** A non-content-filtered, parseable response is valid for failover purposes. */
function cascadeValid(data) {
  if (!data || typeof data !== 'object') return false;
  const c = data.choices && data.choices[0];
  if (c && c.finish_reason === 'content_filter') return false;
  return true;
}

module.exports = { deriveEndpoint, cascadeValid };
