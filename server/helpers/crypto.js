'use strict';

const crypto = require('node:crypto');
const os = require('node:os');

function deriveAuthKey() {
  const env = process.env.MODELHUB_AUTH_KEY || process.env.AGG_AUTH_KEY;
  if (env) return crypto.createHash('sha256').update(String(env)).digest();
  const raw = os.hostname() + ':' + os.userInfo().username + ':llm-aggregator-v1';
  return crypto.createHash('sha256').update(raw).digest();
}

const KEY = deriveAuthKey();
const ALGO = 'aes-256-gcm';

/** Encrypt a JSON-serializable object into an iv:tag:ciphertext hex string. */
function encryptAuth(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const json = JSON.stringify(obj);
  const enc = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}

/** Decrypt a string produced by encryptAuth. */
function decryptAuth(w) {
  const parts = String(w || '').split(':');
  if (parts.length < 3) throw new Error('malformed auth blob');
  const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(parts[0], 'hex'));
  decipher.setAuthTag(Buffer.from(parts[1], 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(parts[2], 'hex')), decipher.final()]);
  return JSON.parse(dec.toString('utf8'));
}

/** Best-effort check that an object is an auth store. */
function looksLikeAuth(obj) {
  return obj && typeof obj === 'object' && Array.isArray(obj.entries);
}

module.exports = { deriveAuthKey, encryptAuth, decryptAuth, looksLikeAuth };
