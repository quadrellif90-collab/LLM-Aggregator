'use strict';

const fs = require('node:fs');

/** BOM-safe JSON read with a fallback value. */
function readJSON(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const cleaned = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return JSON.parse(cleaned);
  } catch (e) {
    return fallback;
  }
}

/** Async JSON write; failures are reported through the optional logFn. */
function writeJSON(file, obj, logFn) {
  fs.writeFile(file, JSON.stringify(obj, null, 2), (e) => {
    if (e && typeof logFn === 'function') logFn('write error ' + file + ': ' + e.message);
  });
}

module.exports = { readJSON, writeJSON };
