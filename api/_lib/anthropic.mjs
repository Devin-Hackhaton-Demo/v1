import { randomUUID } from 'node:crypto';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_MESSAGES = 40;
const MAX_CONTENT_CHARS = 65536;
const MAX_SYSTEM_CHARS = 8192;
const MAX_OUTPUT_TOKENS = 1024;
const UPSTREAM_TIMEOUT_MS = 60000;

export const MAX_BODY_BYTES = 262144;
// /api/chat alone accepts larger bodies so base64 screenshots fit
// (Vercel's platform cap is ~4.5 MB, so 4 MiB keeps headroom).
export const MAX_CHAT_BODY_BYTES = 4194304;

const MAX_BLOCKS_PER_MESSAGE = 8;
const MAX_IMAGES_PER_REQUEST = 4;
const MAX_IMAGE_BASE64_CHARS = 2800000;
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
// Shape check only (charset + padding position + length % 4) — never decoded here.
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export const DEFAULT_SYSTEM_PROMPT = [
  "You are Coffeenator's assistant. Coffeenator is a personal AI home:",
  'it has a Chat screen (this conversation), a Connectors screen for linking',
  'services like Google, GitHub or Notion, and a Memory screen where the user',
  'imports and stores personal context for their AI tools.',
  'Reply in plain conversational text.',
  'Do not use markdown formatting: no asterisks, no bold or italics, no headings, no bullet characters.',
  "If a list is genuinely needed, write short numbered lines like '1.' and '2.'.",
  'Be brief and to the point: short sentences, short paragraphs, no filler.',
  'Explain clearly so a non-technical reader understands.',
  'Always answer in the same language the user writes in.',
  'Only include code when the user explicitly asks for code.',
].join(' ');

export const RATE_LIMIT_DEFAULTS = { limit: 10, windowMs: 60000 };

export function createRateLimiter({ limit = RATE_LIMIT_DEFAULTS.limit, windowMs = RATE_LIMIT_DEFAULTS.windowMs, now = Date.now } = {}) {
  const hits = new Map();
  return {
    check(ip) {
      const key = typeof ip === 'string' && ip.length > 0 ? ip : 'unknown';
      const current = now();
      const cutoff = current - windowMs;
      for (const [entryKey, timestamps] of hits) {
        while (timestamps.length > 0 && timestamps[0] <= cutoff) timestamps.shift();
        if (timestamps.length === 0) hits.delete(entryKey);
      }
      const timestamps = hits.get(key) ?? [];
      if (timestamps.length >= limit) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((timestamps[0] + windowMs - current) / 1000)) };
      }
      timestamps.push(current);
      hits.set(key, timestamps);
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function validateContentBlocks(blocks, index, errors, imageCounter) {
  if (blocks.length === 0 || blocks.length > MAX_BLOCKS_PER_MESSAGE) {
    errors.push(`messages[${index}].content must contain between 1 and ${MAX_BLOCKS_PER_MESSAGE} blocks.`);
    return;
  }
  let textTotal = 0;
  blocks.forEach((block, blockIndex) => {
    const label = `messages[${index}].content[${blockIndex}]`;
    if (!isPlainObject(block)) {
      errors.push(`${label} must be an object with a "type" of "text" or "image".`);
      return;
    }
    if (block.type === 'text') {
      if (Object.keys(block).some((key) => !['type', 'text'].includes(key))) {
        errors.push(`${label} may only contain "type" and "text".`);
        return;
      }
      if (typeof block.text !== 'string' || block.text.length === 0) {
        errors.push(`${label}.text must be a non-empty string.`);
      } else {
        textTotal += block.text.length;
        if (block.text.length > MAX_CONTENT_CHARS) errors.push(`${label}.text may be at most ${MAX_CONTENT_CHARS} characters.`);
      }
    } else if (block.type === 'image') {
      if (Object.keys(block).some((key) => !['type', 'media_type', 'data'].includes(key))) {
        errors.push(`${label} may only contain "type", "media_type" and "data".`);
        return;
      }
      imageCounter.count += 1;
      if (!IMAGE_MEDIA_TYPES.includes(block.media_type)) {
        errors.push(`${label}.media_type must be one of ${IMAGE_MEDIA_TYPES.join(', ')}.`);
      }
      if (typeof block.data !== 'string' || block.data.length === 0 || block.data.length % 4 !== 0 || !BASE64_PATTERN.test(block.data)) {
        errors.push(`${label}.data must be a base64 string.`);
      } else if (block.data.length > MAX_IMAGE_BASE64_CHARS) {
        errors.push(`${label}.data may be at most ${MAX_IMAGE_BASE64_CHARS} base64 characters.`);
      }
    } else {
      errors.push(`${label}.type must be "text" or "image".`);
    }
  });
  if (textTotal > MAX_CONTENT_CHARS) errors.push(`messages[${index}] may contain at most ${MAX_CONTENT_CHARS} text characters across its blocks.`);
}

export function validateChatRequest(body) {
  if (!isPlainObject(body)) return { ok: false, errors: ['Request body must be a JSON object with a "messages" array.'] };
  const errors = [];
  if (Object.keys(body).some((key) => !['messages', 'system'].includes(key))) errors.push('Request body may only contain "messages" and "system".');
  const { messages, system } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    errors.push('"messages" must be a non-empty array.');
  } else if (messages.length > MAX_MESSAGES) {
    errors.push(`"messages" may contain at most ${MAX_MESSAGES} entries.`);
  } else {
    const imageCounter = { count: 0 };
    messages.forEach((message, index) => {
      if (!isPlainObject(message) || Object.keys(message).some((key) => !['role', 'content'].includes(key))) {
        errors.push(`messages[${index}] must be an object with only "role" and "content".`);
        return;
      }
      if (message.role !== 'user' && message.role !== 'assistant') errors.push(`messages[${index}].role must be "user" or "assistant".`);
      if (typeof message.content === 'string') {
        if (message.content.length === 0) errors.push(`messages[${index}].content must be a non-empty string.`);
        else if (message.content.length > MAX_CONTENT_CHARS) errors.push(`messages[${index}].content may be at most ${MAX_CONTENT_CHARS} characters.`);
      } else if (Array.isArray(message.content)) {
        validateContentBlocks(message.content, index, errors, imageCounter);
      } else {
        errors.push(`messages[${index}].content must be a non-empty string or an array of content blocks.`);
      }
    });
    if (imageCounter.count > MAX_IMAGES_PER_REQUEST) errors.push(`A request may contain at most ${MAX_IMAGES_PER_REQUEST} image blocks in total.`);
    if (isPlainObject(messages[0]) && messages[0].role !== 'user') errors.push('The first message must use the "user" role.');
    if (isPlainObject(messages.at(-1)) && messages.at(-1).role !== 'user') errors.push('The last message must use the "user" role.');
  }
  if (system !== undefined) {
    if (typeof system !== 'string') errors.push('"system" must be a string.');
    else if (system.length > MAX_SYSTEM_CHARS) errors.push(`"system" may be at most ${MAX_SYSTEM_CHARS} characters.`);
  }
  return { ok: errors.length === 0, errors };
}

// String content passes through unchanged; block arrays map to the Anthropic
// content block shapes (images become base64 sources).
function toUpstreamContent(content) {
  if (typeof content === 'string') return content;
  return content.map((block) => (block.type === 'text'
    ? { type: 'text', text: block.text }
    : { type: 'image', source: { type: 'base64', media_type: block.media_type, data: block.data } }));
}

export async function callAnthropic({ messages, system }, env, fetchImpl = fetch) {
  if (!env || typeof env.ANTHROPIC_API_KEY !== 'string' || env.ANTHROPIC_API_KEY.length === 0) throw new Error('ANTHROPIC_API_KEY is not configured.');
  const model = env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const effectiveSystem = typeof system === 'string' && system.length > 0 ? system : DEFAULT_SYSTEM_PROMPT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: messages.map(({ role, content }) => ({ role, content: toUpstreamContent(content) })),
        system: effectiveSystem,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`The Anthropic API responded with status ${response.status}.`);
  const payload = await response.json();
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  return {
    reply: blocks.filter((block) => isPlainObject(block) && block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join(''),
    model: typeof payload.model === 'string' ? payload.model : model,
    usage: {
      input_tokens: Number(payload.usage?.input_tokens) || 0,
      output_tokens: Number(payload.usage?.output_tokens) || 0,
    },
  };
}

export function successEnvelope(data) {
  return { schema_version: 1, request_id: randomUUID(), ok: true, data };
}

export function errorEnvelope(code, message, retryable) {
  return { schema_version: 1, request_id: randomUUID(), ok: false, error: { code, message, retryable } };
}

export async function handleChatRequest(body, env, fetchImpl = fetch) {
  const validation = validateChatRequest(body);
  if (!validation.ok) return { status: 400, payload: errorEnvelope('VALIDATION_ERROR', validation.errors.join(' '), false) };
  if (!env || typeof env.ANTHROPIC_API_KEY !== 'string' || env.ANTHROPIC_API_KEY.length === 0) {
    return { status: 503, payload: errorEnvelope('PROVIDER_ERROR', 'Chat backend is not configured.', false) };
  }
  try {
    const data = await callAnthropic({ messages: body.messages, system: body.system }, env, fetchImpl);
    return { status: 200, payload: successEnvelope(data) };
  } catch {
    return { status: 502, payload: errorEnvelope('PROVIDER_ERROR', 'The chat provider did not return a response. Please try again.', true) };
  }
}
