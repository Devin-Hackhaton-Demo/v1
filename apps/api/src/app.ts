import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import Fastify, { LogController } from 'fastify';
import { localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/fastify';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { requireAiConsent } from '../../../api/_lib/auth.mjs';
import type { Config } from './config.js';
import { buildMcpServer } from './mcp.js';
import { registerChatRoute } from './chat.js';

export function buildApp(config: Config, options: {
  logStream?: Writable;
  chatFetch?: typeof fetch;
  authFetch?: typeof fetch;
} = {}) {
  const app = Fastify({
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'request_id', disableRequestLogging: true }),
    logger: {
      level: config.logLevel,
      serializers: {
        req: (request) => ({ method: request.method }),
        res: (reply) => ({ statusCode: reply.statusCode }),
        err: () => ({ type: 'Error', message: 'Details omitted.', stack: '' }),
      },
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
  });
  const reportMcpError = () => app.log.error('MCP request rejected.');
  const handler = createMcpHandler(
    ({ requestInfo }) => buildMcpServer(requestInfo?.headers.get('x-request-id') ?? randomUUID()),
    { legacy: 'stateless', onerror: reportMcpError },
  );
  const nodeHandler = toNodeHandler(handler, { onerror: reportMcpError });

  app.addHook('onRequest', async (request, reply) => {
    request.raw.headers['x-request-id'] = request.id;
    reply.raw.setHeader('x-request-id', request.id);
  });
  app.addHook('onRequest', localhostHostValidation());
  app.addHook('onRequest', localhostOriginValidation());
  app.addHook('onResponse', async (request, reply) => {
    request.log.info({
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      status_code: reply.statusCode,
    }, 'Request completed');
  });
  app.addHook('preClose', async () => handler.close());
  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
      ? error.statusCode : 500;
    const statusCode = status >= 400 && status < 600 ? status : 500;
    request.log.error({ status_code: statusCode }, 'Request rejected.');
    return reply.code(statusCode).send({
      request_id: request.id,
      error: statusCode >= 500 ? 'Internal server error.' : 'Invalid request.',
    });
  });
  app.get('/health', async () => ({ status: 'ok', mode: 'local' }));
  app.register(async (chatApp) => {
    chatApp.addHook('onRequest', async (request, reply) => {
      const user = await requireAiConsent(request.raw, reply.raw, {
        env: {
          APP_ORIGIN: config.appOrigin ?? `http://${config.host}:${config.port}`,
          SUPABASE_URL: config.supabaseUrl,
          SUPABASE_ANON_KEY: config.supabaseAnonKey,
          NODE_ENV: config.environment,
        },
        fetchImpl: options.authFetch ?? fetch,
      });
      if (!user || reply.raw.writableEnded) return reply.hijack();
    });
    registerChatRoute(chatApp, config, options.chatFetch ?? fetch);
  });
  app.all('/mcp', async (request, reply) => {
    reply.hijack();
    const rawRequest = Object.assign(request.raw, { method: request.method, url: request.url });
    await nodeHandler(rawRequest, reply.raw, request.body);
  });
  return app;
}
