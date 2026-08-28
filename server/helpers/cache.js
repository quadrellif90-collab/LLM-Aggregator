'use strict';

const crypto = require('node:crypto');

/** Deterministic cache key for an OpenAI-style request body. */
function cacheKey(oaiBody) {
  const messages = (oaiBody && oaiBody.messages) || [];
  const sample = messages
    .slice(-4)
    .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content }));
  const rest = {
    model: oaiBody.model,
    temperature: oaiBody.temperature,
    max_tokens: oaiBody.max_tokens,
    stream: oaiBody.stream,
  };
  return crypto.createHash('sha256').update(JSON.stringify({ sample, rest })).digest('hex');
}

module.exports = { cacheKey };
