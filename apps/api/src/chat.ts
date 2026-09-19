import type { FastifyInstance } from 'fastify';
import * as z from 'zod';
import {
  SCHEMA_VERSION,
  chatRequestSchema,
  chatResponseSchema,
  type ChatMessage,
  type ServiceError,
} from '@demo/contracts';
import type { Config } from './config.js';

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const CHAT_BODY_LIMIT_BYTES = 4_194_304;
const UPSTREAM_TIMEOUT_MS = 60_000;
const UPSTREAM_MAX_TOKENS = 1024;
const RATE_LIMIT_MAX_REQUESTS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

export const DEFAULT_SYSTEM_PROMPT = 'You are Coffeenator\'s assistant. Coffeenator is a personal AI home: it has a Chat screen (this conversation), a Connectors screen for linking services like Google, GitHub or Notion, and a Memory screen where the user imports and stores personal context for their AI tools. Reply in plain conversational text. Do not use markdown formatting: no asterisks, no bold or italics, no headings, no bullet characters. If a list is genuinely needed, write short numbered lines like \'1.\' and \'2.\'. Be brief and to the point: short sentences, short paragraphs, no filler. Explain clearly so a non-technical reader understands. Always answer in the same language the user writes in. Only include code when the user explicitly asks for code.';

type RateLimit = { limit: number; windowMs: number };

function createRateLimiter({ limit, windowMs }: RateLimit) {
  const requestTimes = new Map<string, number[]>();
  return (ip: string, now: number): { retryAfterSeconds: number } | undefined => {
    for (const [key, timestamps] of requestTimes) {
      const recent = timestamps.filter((timestamp) => now - timestamp < windowMs);
      if (recent.length === 0) requestTimes.delete(key);
      else requestTimes.set(key, recent);
    }
    const recent = requestTimes.get(ip) ?? [];
    const oldest = recent[0];
    if (recent.length >= limit && oldest !== undefined) {
      return { retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) };
    }
    requestTimes.set(ip, [...recent, now]);
    return undefined;
  };
}

function toUpstreamContent(content: ChatMessage['content']) {
  if (typeof content === 'string') return content;
  return content.map((block) => (block.type === 'text'
    ? { type: 'text', text: block.text }
    : { type: 'image', source: { type: 'base64', media_type: block.media_type, data: block.data } }));
}

const upstreamMessageSchema = z.looseObject({
  model: z.string().min(1),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  usage: z.looseObject({
    input_tokens: z.int().nonnegative(),
    output_tokens: z.int().nonnegative(),
  }),
});

export function registerChatRoute(
  app: FastifyInstance,
  config: Config,
  fetchImpl: typeof fetch = fetch,
  options: { rateLimit?: RateLimit } = {},
) {
  const checkRateLimit = createRateLimiter(
    options.rateLimit ?? { limit: RATE_LIMIT_MAX_REQUESTS, windowMs: RATE_LIMIT_WINDOW_MS },
  );
  app.post('/api/chat', { bodyLimit: CHAT_BODY_LIMIT_BYTES }, async (request, reply) => {
    const sendError = (statusCode: number, error: ServiceError) => reply.code(statusCode).send(
      chatResponseSchema.parse({
        schema_version: SCHEMA_VERSION,
        request_id: request.id,
        ok: false,
        error,
      }),
    );

    const limited = checkRateLimit(request.ip, Date.now());
    if (limited) {
      reply.header('retry-after', String(limited.retryAfterSeconds));
      return sendError(429, {
        code: 'LIMIT_EXCEEDED',
        message: 'Too many requests. Please wait a moment and try again.',
        retryable: true,
      });
    }
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success
      || parsed.data.messages[0]?.role !== 'user'
      || parsed.data.messages.at(-1)?.role !== 'user') {
      return sendError(400, { code: 'VALIDATION_ERROR', message: 'Invalid chat request.', retryable: false });
    }
    const { anthropicApiKey, anthropicModel } = config;
    if (anthropicApiKey === undefined || anthropicModel === undefined) {
      return sendError(503, { code: 'PROVIDER_ERROR', message: 'Chat backend is not configured.', retryable: false });
    }
    const providerError = () => sendError(502, { code: 'PROVIDER_ERROR', message: 'Upstream provider error.', retryable: true });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'x-api-key': anthropicApiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: anthropicModel,
          max_tokens: UPSTREAM_MAX_TOKENS,
          messages: parsed.data.messages.map((message) => ({
            role: message.role,
            content: toUpstreamContent(message.content),
          })),
          system: parsed.data.system && parsed.data.system.length > 0 ? parsed.data.system : DEFAULT_SYSTEM_PROMPT,
        }),
        signal: controller.signal,
      });
    } catch {
      request.log.error('Chat upstream request failed.');
      return providerError();
    } finally {
      clearTimeout(timeout);
    }
    if (!upstream.ok) {
      request.log.error({ upstream_status: upstream.status }, 'Chat upstream rejected the request.');
      return providerError();
    }
    let payload: unknown;
    try {
      payload = await upstream.json();
    } catch {
      payload = undefined;
    }
    const message = upstreamMessageSchema.safeParse(payload);
    if (!message.success) {
      request.log.error({ upstream_status: upstream.status }, 'Chat upstream returned an unexpected response.');
      return providerError();
    }
    const replyText = message.data.content
      .flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
      .join('');
    return reply.code(200).send(chatResponseSchema.parse({
      schema_version: SCHEMA_VERSION,
      request_id: request.id,
      ok: true,
      data: {
        reply: replyText,
        model: message.data.model,
        usage: {
          input_tokens: message.data.usage.input_tokens,
          output_tokens: message.data.usage.output_tokens,
        },
      },
    }));
  });
}
