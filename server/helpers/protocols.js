'use strict';

/** Normalize a message content into a plain string for the Anthropic format. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p.text != null ? p.text : '')).join('');
  if (content && typeof content === 'object') return content.text || '';
  return '';
}

/** Convert an OpenAI-style chat body to an Anthropic /v1/messages body. */
function anthropicToOpenAI(body) {
  const b = JSON.parse(JSON.stringify(body || {}));
  let system = '';
  const messages = (b.messages || []).filter((m) => {
    if (m.role === 'system') {
      system += textOf(m.content) + '\n';
      return false;
    }
    return true;
  });
  const out = {
    model: b.model,
    max_tokens: b.max_tokens || 1024,
    stream: !!b.stream,
    messages: messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: textOf(m.content),
    })),
  };
  if (system) out.system = system.trim();
  if (b.temperature != null) out.temperature = b.temperature;
  if (b.top_p != null) out.top_p = b.top_p;
  return out;
}

/** Convert a streamed Anthropic SSE chunk into an OpenAI SSE data object. */
function openAIToAnthropic(data, model) {
  const text = (data.delta && data.delta.text) || '';
  return {
    id: 'chatcmpl-' + (data.id || Date.now()),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        delta: text ? { role: 'assistant', content: text } : {},
        finish_reason: data.type === 'message_stop' ? 'stop' : null,
      },
    ],
  };
}

/** Convert a Gemini generateContent body into an OpenAI chat body. */
function geminiGenerateToOpenAI(model, body) {
  const contents = (body && body.contents) || [];
  const messages = contents.map((c) => ({
    role: (c.role || 'user') === 'model' ? 'assistant' : 'user',
    content: (c.parts || []).map((p) => p.text || '').join(''),
  }));
  return { model: model, stream: !!(body && body.stream), messages };
}

/** Convert an OpenAI streaming chunk into a Gemini streaming chunk. */
function openAIToGemini(data, finishReason) {
  const text = data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content;
  const cand = {
    content: { parts: [{ text: text || '' }], role: 'model' },
    finishReason: finishReason || 'STOP',
  };
  return { candidates: [cand] };
}

module.exports = {
  textOf,
  anthropicToOpenAI,
  openAIToAnthropic,
  geminiGenerateToOpenAI,
  openAIToGemini,
};
