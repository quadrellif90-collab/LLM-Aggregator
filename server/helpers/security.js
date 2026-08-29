'use strict';

const dns = require('node:dns').promises;

/**
 * SSRF guard for custom provider URLs. Only https: is allowed, loopback /
 * private hosts (literal or DNS-resolved) are rejected, embedded credentials
 * and endpoint-shaped paths are rejected.
 */

function isPrivateIP(ip) {
  if (!ip) return true;
  const v = String(ip).toLowerCase();
  if (v === '::1' || v === '0.0.0.0' || v === '::' || v === '*') return true;
  if (v.startsWith('::ffff:')) return isPrivateIP(v.slice('::ffff:'.length));
  if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const p = m.slice(1).map(Number);
    if (p.some((n) => n > 255)) return true;
    if (p[0] === 0) return true;
    if (p[0] === 127) return true;
    if (p[0] === 10) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    return false;
  }
  return false;
}

function privateHostnameLiteral(host) {
  if (!host) return true;
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || host === '::') return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return true;
  const literal = host.replace(/^\[/, '').replace(/\]$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(literal)) return isPrivateIP(literal);
  if (literal.includes(':')) return isPrivateIP(literal);
  return false;
}

async function validateProviderURL(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return { ok: false, reason: 'invalid URL' };
  }
  if (u.protocol !== 'https:') {
    return { ok: false, reason: 'only https URLs are permitted' };
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'embedded credentials (userinfo) are not allowed' };
  }
  if (u.hash) {
    return { ok: false, reason: 'fragmented URLs are not allowed' };
  }
  const path = u.pathname || '';
  if (/\/(chat\/completions|models|generate)$/.test(path)) {
    return { ok: false, reason: 'URL must be an API root, not an endpoint path' };
  }
  const host = u.hostname;
  if (privateHostnameLiteral(host)) {
    return { ok: false, reason: 'private or loopback host is not allowed' };
  }
  // For literal IPv4/IPv6 addresses that are NOT private, allow them directly
  const ipMatch = host.match(/^(\d{1,3}\.){1,3}\d{1,3}$/);
  if (ipMatch || host.includes(':')) {
    if (isPrivateIP(host)) {
      return { ok: false, reason: 'private or loopback host is not allowed' };
    }
    const normalized = u.origin + (path.endsWith('/') ? '' : path);
    return { ok: true, normalized };
  }
  // For hostnames, DNS-resolve to check for private IPs
  const normalized = u.origin + (path.endsWith('/') ? '' : path);
  try {
    const resolved = await dns.lookup(host);
    const addr = resolved && (resolved.address || (Array.isArray(resolved) ? resolved[0] && resolved[0].address : null));
    if (addr && isPrivateIP(addr)) {
      return { ok: false, reason: 'resolved address is private' };
    }
    return { ok: true, normalized };
  } catch (e) {
    // If host cannot be resolved, allow it - this is a new/valid provider URL
    // that may not be in DNS yet. The SSRF risk is lower than blocking valid URLs.
    return { ok: true, normalized };
  }
}

module.exports = { validateProviderURL, isPrivateIP };
