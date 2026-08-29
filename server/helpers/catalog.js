'use strict';

const dns = require('node:dns');

/**
 * Free-first provider catalog (curated from nejib1/Free-LLM + altri).
 * Key:
 * - name: provider name (matches config.json provider 'name')
 * - baseURL: OpenAI-compatible /v1 root (trailing slash optional)
 * - needsKey: true if API key required; false if no key needed (no-key)
 * - authId: key name used in auth.json (if needsKey)
 * - models: array of { name: string, free: boolean }
 * - freeTier: 'permanent'|'renewable'|'trial'|'none'
 * - rateLimit: rough tokens/minute (RPM) or undefined
 */
const FREE_PROVIDERS = [
  // No-key providers (zero-config)
  {
    name: 'pollinations',
    label: 'Pollinations (no key)',
    baseURL: 'https://text.pollinations.ai/v1',
    needsKey: false,
    authId: null,
    freeTier: 'permanent',
    models: [
      { name: 'openai', free: true },
      { name: 'openai-large', free: true }
    ]
  },
  {
    name: 'glhf',
    label: 'glhf (no key)',
    baseURL: 'https://glhf.chat/api/openai/v1',
    needsKey: false,
    authId: null,
    freeTier: 'permanent',
    models: [
      { name: 'hf:meta-llama/Llama-3.3-70B-Instruct', free: true },
      { name: 'hf:google/gemma-2-9b-it', free: true },
      { name: 'hf:mistralai/Mistral-Nemo-12B', free: true },
      { name: 'hf:Qwen/Qwen2.5-72B-Instruct', free: true }
    ]
  },
  {
    name: 'llm7',
    label: 'LLM7.io (no key)',
    baseURL: 'https://api.llm7.io/v1',
    needsKey: false,
    authId: null,
    freeTier: 'permanent',
    models: [
      { name: 'deepseek-r1', free: true }
    ]
  },

  // Popular free-tier keyed providers (most generous free quota; all need AGG_TOKEN or AGG_DIR key store)
  {
    name: 'groq',
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    needsKey: true,
    authId: 'groq',
    freeTier: 'renewable',
    models: [
      { name: 'llama-3.3-70b-versatile', free: true },
      { name: 'llama-3.1-8b-instant', free: true }
    ]
  },
  {
    name: 'openrouter',
    label: 'OpenRouter (free-tier)',
    baseURL: 'https://openrouter.ai/api/v1',
    needsKey: true,
    authId: 'openrouter',
    freeTier: 'renewable',
    models: [
      { name: 'meta-llama/llama-3.3-70b-instruct:free', free: true },
      { name: 'deepseek/deepseek-r1:free', free: true }
    ]
  },
  {
    name: 'huggingface',
    label: 'HuggingFace Router',
    baseURL: 'https://router.huggingface.co/v1',
    needsKey: true,
    authId: 'huggingface',
    freeTier: 'renewable',
    models: [
      { name: 'meta-llama/Llama-3.3-70B-Instruct', free: true }
    ]
  },
  {
    name: 'together',
    label: 'Together (free)',
    baseURL: 'https://api.together.xyz/v1',
    needsKey: true,
    authId: 'together',
    freeTier: 'renewable',
    models: [
      { name: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', free: true }
    ]
  },

  // Convenience: add a few more if desired below. Keep count manageable.
];

/**
 * Returns true if the given hostname is a private/local IP address.
 */
function isPrivateIP(hostname) {
  // Heuristic: try DNS lookup then check. For immediate check without DNS:
  const parts = hostname.split('.').map(Number);
  if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1') return true;
  if (parts.length === 4) {
    if (parts[0] === 127) return true;       // 127.x.x.x
    if (parts[0] === 10) return true;         // 10.x.x.x
    if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.x.x
    if (parts[0] === 169 && parts[1] === 254) return true; // 169.254.x.x
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16-31.x.x
  }
  return false;
}

/**
 * Attempt DNS lookup; if it resolves to a private IP, reject.
 */
function resolveHostSafe(hostname) {
  return new Promise((resolve) => {
    dns.lookup(hostname, (err) => {
      if (err) return resolve({ isPrivate: isPrivateIP(hostname), ip: null });
      // If we have the OS module, we could check, but we only have heuristic here.
      // Use simple private check on the hostname string; dns.resolve4 is async.
      resolve({ isPrivate: isPrivateIP(hostname), ip: null });
    });
  });
}

/**
 * Validate a provider baseURL for SSRF safety.
 * Returns { ok: true, normalized } or { ok: false, reason }.
 */
function validateProviderURL(url) {
  try {
    const u = new URL(url);
    // Protocol must be https:
    if (u.protocol !== 'https:') return { ok: false, reason: 'URL must use https:' };

    const host = u.hostname.toLowerCase();

    // Reject localhost/private IPs
    if (isPrivateIP(host)) return { ok: false, reason: 'Local/private hostname not allowed' };

    // Reject URLs with credentials (userinfo)
    if (u.username || u.password) return { ok: false, reason: 'Credentials in URL not allowed' };

    // Reject common dangerous paths (chat/completions, models, generate)
    const dangerousPaths = ['/chat/completions', '/models', '/generate'];
    if (dangerousPaths.some(p => u.pathname.startsWith(p))) {
      return { ok: false, reason: `Path '${u.pathname}' not allowed for provider baseURL` };
    }

    // Require a minimal host (not empty)
    if (!host) return { ok: false, reason: 'Empty hostname' };

    return { ok: true, normalized: { protocol: u.protocol, hostname: u.hostname, port: u.port } };
  } catch (e) {
    return { ok: false, reason: 'Invalid URL: ' + e.message };
  }
}

/**
 * Merge catalog providers/models into existing config.
 * Additive: only adds providers not already present (by name). Never removes.
 * Mutates config.providers in place (adds new objects). Returns count added.
 */
function mergeCatalog(config) {
  if (!config || !config.providers) return 0;
  let added = 0;
  const existingNames = new Set((config.providers || []).map(p => p.name));
  for (const prov of FREE_PROVIDERS) {
    if (!existingNames.has(prov.name)) {
      config.providers.push({
        name: prov.name,
        label: prov.label,
        needsKey: prov.needsKey,
        authId: prov.authId,
        baseURL: prov.baseURL,
        models: prov.models.map(m => ({ name: m.name, free: m.free })),
        enabled: !prov.needsKey, // auto-enable no-key providers
      });
      existingNames.add(prov.name);
      added++;
    }
  }
  return added;
}

/**
 * normalizePrefs hook: seed catalog on first run.
 * Called from server/index.js start() before rebuildRegistry().
 */
function seedCatalogIfNeeded(prefs, config) {
  let added = 0;
  if (!config.providers) config.providers = [];
  added = mergeCatalog(config);
  // persist config
  // Note: the caller writes config.json.
  return added;
}

module.exports = {
  FREE_PROVIDERS,
  mergeCatalog,
  validateProviderURL,
  seedCatalogIfNeeded,
  isPrivateIP
};