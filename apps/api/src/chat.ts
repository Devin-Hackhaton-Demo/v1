import type { FastifyInstance } from 'fastify';
import * as z from 'zod';
import {
  SCHEMA_VERSION,
  chatRequestSchema,
  chatResponseSchema,
  type ServiceError,
} from '@demo/contracts';
import type { Config } from './config.js';

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const UPSTREAM_TIMEOUT_MS = 60_000;
const UPSTREAM_MAX_TOKENS = 1024;

const upstreamMessageSchema = z.looseObject({
  model: z.string().min(1),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  usage: z.looseObject({
    input_tokens: z.int().nonnegative(),
    output_tokens: z.int().nonnegative(),
  }),
});

export function registerChatRoute(app: FastifyInstance, config: Config, fetchImpl: typeof fetch = fetch) {
  app.post('/api/chat', async (request, reply) => {
    const sendError = (statusCode: number, error: ServiceError) => reply.code(statusCode).send(
      chatResponseSchema.parse({
        schema_version: SCHEMA_VERSION,
        request_id: request.id,
        ok: false,
        error,
      }),
    );

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
          messages: parsed.data.messages,
          ...(parsed.data.system === undefined ? {} : { system: parsed.data.system }),
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
