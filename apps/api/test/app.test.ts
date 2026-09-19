import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SERVER_INFO, serverInfoResponseSchema } from '@demo/contracts';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const rpcHeaders = {
  host: 'localhost',
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
};
const infoCall = {
  jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name: 'server_info', arguments: {} },
};

function rpcBody(response: { body: string; headers: Record<string, unknown> }) {
  if (!String(response.headers['content-type']).startsWith('text/event-stream')) {
    return JSON.parse(response.body);
  }
  const messages = response.body.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()));
  assert.equal(messages.length, 1);
  return messages[0];
}

function createApp(t: TestContext, logStream?: Writable) {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: logStream ? 'info' : 'silent' });
  const app = buildApp(config, logStream ? { logStream } : {});
  t.after(() => app.close());
  return app;
}

test('health reports process liveness without claiming backend readiness', async (t) => {
  const response = await createApp(t).inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(rpcBody(response), { status: 'ok', mode: 'local' });
  assert.match(String(response.headers['x-request-id']), /^[0-9a-f-]{36}$/);
});

for (const mode of ['legacy', 'auto'] as const) {
  test(`a real HTTP MCP client can discover and call server_info (${mode})`, async (t) => {
    const app = createApp(t);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new Client(
      { name: 'scaffold-test', version: '1.0.0' },
      { versionNegotiation: { mode } },
    );
    t.after(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address)));
    assert.equal(client.getProtocolEra(), mode === 'auto' ? 'modern' : 'legacy');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['server_info']);
    const tool = tools[0]!;
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.annotations?.openWorldHint, false);
    assert.ok(tool.inputSchema);
    assert.ok(tool.outputSchema);
    const first = await client.callTool({ name: 'server_info', arguments: {} });
    const second = await client.callTool({ name: 'server_info', arguments: {} });
    const envelope = serverInfoResponseSchema.parse(first.structuredContent);
    assert.equal(envelope.ok, true);
    if (envelope.ok) assert.deepEqual(envelope.data, SERVER_INFO);
    assert.notEqual(first.isError, true);
    assert.notEqual(envelope.request_id, serverInfoResponseSchema.parse(second.structuredContent).request_id);
    assert.ok(first.content.some((item) => item.type === 'text' && item.text.includes('local')));
  });
}

test('MCP responses use a server-generated request ID, not a client-supplied one', async (t) => {
  const response = await createApp(t).inject({
    method: 'POST', url: '/mcp', payload: infoCall,
    headers: { ...rpcHeaders, 'x-request-id': 'd5ee3662-26fb-4a7d-bcdd-bfc85517a6f7' },
  });
  assert.equal(response.statusCode, 200);
  const envelope = serverInfoResponseSchema.parse(rpcBody(response).result.structuredContent);
  assert.equal(envelope.request_id, response.headers['x-request-id']);
  assert.notEqual(envelope.request_id, 'd5ee3662-26fb-4a7d-bcdd-bfc85517a6f7');
});

test('Host guard rejects non-local hosts before MCP dispatch', async (t) => {
  const app = createApp(t);
  for (const host of ['external.invalid', 'localhost.external.invalid', '127.0.0.1.external.invalid']) {
    const response = await app.inject({
      method: 'POST', url: '/mcp', payload: infoCall,
      headers: { ...rpcHeaders, host },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(rpcBody(response).result, undefined);
  }
});

test('Origin guard rejects foreign, opaque and malformed origins', async (t) => {
  const app = createApp(t);
  for (const origin of ['https://external.invalid', 'https://localhost.external.invalid', 'null', 'invalid-origin']) {
    const response = await app.inject({
      method: 'POST', url: '/mcp', payload: infoCall,
      headers: { ...rpcHeaders, origin },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(rpcBody(response).result, undefined);
  }
});

test('allows a local Origin and a non-browser client without Origin', async (t) => {
  const app = createApp(t);
  for (const headers of [rpcHeaders, { ...rpcHeaders, origin: 'http://localhost:3000' }]) {
    const response = await app.inject({ method: 'POST', url: '/mcp', payload: infoCall, headers });
    assert.equal(response.statusCode, 200);
    assert.equal(serverInfoResponseSchema.parse(rpcBody(response).result.structuredContent).ok, true);
  }
});

test('server rejects unknown tools and diagnostic arguments without claiming success', async (t) => {
  const app = createApp(t);
  for (const params of [
    { name: 'context_save', arguments: {} },
    { name: 'server_info', arguments: { approved: true } },
  ]) {
    const response = await app.inject({
      method: 'POST', url: '/mcp', headers: rpcHeaders,
      payload: { ...infoCall, params },
    });
    const body = rpcBody(response);
    assert.ok(typeof body.error?.code === 'number' || body.result?.isError === true);
    assert.notEqual(body.result?.structuredContent?.ok, true);
  }
});

test('the stateless MCP endpoint rejects unsupported HTTP methods', async (t) => {
  const app = createApp(t);
  for (const method of ['GET', 'DELETE'] as const) {
    const response = await app.inject({ method, url: '/mcp', headers: { accept: rpcHeaders.accept } });
    assert.equal(response.statusCode, 405);
  }
});

test('request body limits apply before MCP dispatch', async (t) => {
  const app = createApp(t);
  const bodyLimit = app.initialConfig.bodyLimit;
  assert.ok(bodyLimit !== undefined);
  const response = await app.inject({
    method: 'POST', url: '/mcp', headers: rpcHeaders,
    payload: JSON.stringify({ value: 'x'.repeat(bodyLimit + 1) }),
  });
  assert.equal(response.statusCode, 413);
  assert.equal(rpcBody(response).result, undefined);
});

test('logs and errors omit headers, payloads, URLs and raw failure details', async (t) => {
  const messages: string[] = [];
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      messages.push(chunk.toString());
      callback();
    },
  });
  const app = createApp(t, logStream);
  app.get('/error-probe', async () => { throw new Error('ERROR_SENTINEL'); });
  const response = await app.inject({
    method: 'POST', url: '/mcp?download_url=QUERY_SENTINEL',
    headers: {
      ...rpcHeaders,
      authorization: 'Bearer AUTH_SENTINEL',
      cookie: 'session=COOKIE_SENTINEL',
      'x-request-id': 'HEADER_SENTINEL',
    },
    payload: '{"payload":"BODY_SENTINEL", broken',
  });
  assert.equal(response.statusCode, 400);
  await app.inject({ method: 'GET', url: '/UNKNOWN_PATH_SENTINEL?token=OTHER_QUERY_SENTINEL' });
  const errorResponse = await app.inject({ method: 'GET', url: '/error-probe' });
  assert.equal(errorResponse.statusCode, 500);
  assert.equal(errorResponse.body.includes('ERROR_SENTINEL'), false);
  const logs = messages.join('');
  assert.match(logs, /request_id/);
  assert.match(logs, /Request completed/);
  for (const sentinel of ['QUERY', 'AUTH', 'COOKIE', 'HEADER', 'BODY', 'UNKNOWN_PATH', 'OTHER_QUERY', 'ERROR']) {
    assert.equal(logs.includes(`${sentinel}_SENTINEL`), false);
  }
  assert.equal(response.body.includes('BODY_SENTINEL'), false);
});
