'use strict';

const REASON = /(o[1-9]|reason|think|deepseek-r1|qwq|r1|qwen3?-?think)/i;
const CODE = /(code|codestral|coder|devstral|qwen3?-?coder|copilot|cursor)/i;
const FAST = /(mini|haiku|flash|small|lite|nano|turbo|instant|4o-mini|free)/i;
// Models that should never be auto-selected for a real task.
const CHAT_BLOCK = /(guard|moderat|safety|block|filter|content)/i;

/** Classify a model id by capability flags. */
function classify(id) {
  return {
    reasoning: REASON.test(id),
    code: CODE.test(id),
    fast: FAST.test(id),
  };
}

/** Classify a prompt by the kind of task it implies. */
function classifyPrompt(text) {
  const t = String(text || '').toLowerCase();
  return {
    code: /\b(code|function|javascript|python|typescript|sql|regex|bug|compile|stack ?trace|def |class |import |```)/.test(t),
    reasoning: /\b(why|explain|reason|prove|step by step|math|calculate|logic|analyze|compare|derive)\b/.test(t),
    vision: /\b(image|picture|photo|ocr|screenshot|see|chart|diagram)\b/.test(t),
    fast: t.length < 120,
    general: true,
  };
}

/** Move ids whose classification matches pred to the front. */
function catFirst(ids, pred) {
  return [...(ids || [])].sort(
    (a, b) => (pred(classify(b)) ? 1 : 0) - (pred(classify(a)) ? 1 : 0)
  );
}

module.exports = { classify, classifyPrompt, catFirst, CHAT_BLOCK };
