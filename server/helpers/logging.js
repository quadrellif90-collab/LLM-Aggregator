'use strict';

const CTRL = /[\u0000-\u001F\u007F]/g;

/** Escape control/clearing characters so a string is safe to embed in JSON or SSE. */
function escCh(s) {
  return String(s == null ? '' : s).replace(CTRL, (m) => '\\u' + m.charCodeAt(0).toString(16).padStart(4, '0'));
}

module.exports = { escCh };
