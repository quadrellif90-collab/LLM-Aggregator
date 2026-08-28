'use strict';

/** Look up a per-1M-token price for a (provider, model) pair. */
function priceFor(pricing, provider, modelName) {
  if (!pricing) return null;
  const m = pricing.models && pricing.models[modelName];
  if (m) return m;
  const p = pricing.providers && pricing.providers[provider];
  if (p) return { input: p.input, output: p.output };
  return null;
}

/** Cost in currency units for the given token counts. */
function computeCost(price, promptTok, completionTok) {
  if (!price) return 0;
  const inRate = (price.input || 0) / 1e6;
  const outRate = (price.output || 0) / 1e6;
  return promptTok * inRate + completionTok * outRate;
}

module.exports = { priceFor, computeCost };
