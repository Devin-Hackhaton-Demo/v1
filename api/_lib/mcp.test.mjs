import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleMcpMessage, handleMcpHttp } from './mcp.mjs';

const ENV = { ANTHROPIC_API_KEY: 'test-key' };

function fakeFetchOk() {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'Hello from test' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  });
}

function fakeFetch500() {
  return async () => ({ ok: false, status: 500, json: async () => ({}) });
}

function assertNoSecret(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes('test-key'), false, 'response must never contain the API key');
}

// --- initialize -----------------------------------------------------------

test('initialize echoes a supported requested protocol version', async () => {
  const { status, body } = await handleMcpMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { env: ENV, fetchImpl: fakeFetchOk() },
  );
  assert.equal(status, 200);
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.id, 1);
  assert.equal(body.result.protocolVersion, '2024-11-05');
  assert.deepEqual(body.result.capabilities, { tools: { listChanged: false } });
  assert.equal(body.result.serverInfo.name, 'context-mcp-server');
  assert.equal(body.result.serverInfo.version, '0.1.0');
  assert.equal(typeof body.result.instructions, 'string');
});

test('initialize falls back to the default protocol version when unsupported/missing', async () => {
  const { body: withUnsupported } = await handleMcpMessage(
    { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    { env: ENV, fetchImpl: fakeFetchOk() },
  );
  assert.equal(withUnsupported.result.protocolVersion, '2025-06-18');

  const { body: withMissing } = await handleMcpMessage(
    { jsonrpc: '2.0', id: 3, method: 'initialize', params: {} },
    { env: ENV, fetchImpl: fakeFetchOk() },
  );
  assert.equal(withMissing.result.protocolVersion, '2025-06-18');
});

// --- notifications ----------------------------------------------------------

test('a notification (no id) returns 202 with no body', async () => {
  const result = await handleMcpMessage(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { env: ENV, fetchImpl: fakeFetchOk() },
  );
  assert.deepEqual(result, { status: 202, body: null });
});

test('any other notification also returns 202 with no body', async () => {
  const result = await handleMcpMessage(
    { jsonrpc: '2.0', method: 'something/unknown' },
    { env: ENV, fetchImpl: fakeFetchOk() },
  );
  assert.deepEqual(result, { status: 202, body: null });
});

// --- ping -------------------------------------------------------------------

test('ping returns an empty result object', async () => {
  const { status, body } = await handleMcpMessage(
    { jsonrpc: '2.0', id: 4, method: 'ping' },
    { env: ENV, fetchImpl: fakeFetchOk() },
  );
  assert.equal(status, 200);
  assert.deepEqual(body.result, {});
});

// --- tools/list ---------------------------------------------------------------

test('tools/list returns exactly the two tools with schemas and annotations', async () => {
  const { status, body } = await handleMcpMessage(
    { jsonrpc: '2.0', id: 5, method: 'tools/list' },
    { env: ENV, fetchImpl: fakeFetchOk() },
  );
  assert.equal(status, 200);
  assert.equal(body.result.tools.length, 2);
  const names = body.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['chat', 'server_info']);
  for (const tool of body.result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.annotations, `${tool.name} must declare annotations`);
    assert.equal(tool.annotations.readOnlyHint, true);
  }
  const chatTool = body.result.tools.find((tool) => tool.name === 'chat');
  assert.equal(chatTool.annotations.openWorldHint, true);
  assert.deepEqual(chatTool.inputSchema.required, ['message']);
});

// --- tools/call: server_info ---------------------------------------------------

test('tools/call server_info returns content and structuredContent', async () => {
  const { status, body } = await handleMcpMessage(
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'server_info', arguments: {} } },
    { env: ENV, fetchImpl: fakeFetchOk() },
  );
  assert.equal(status, 200);
  assert.equal(body.result.isError, undefined);
  assert.equal(body.result.content[0].type, 'text');
  assert.deepEqual(body.result.structuredContent, {
    name: 'context-mcp-server',
    version: '0.1.0',
    deployment: 'vercel',
    tools: ['server_info', 'chat'],
  });
});

// --- tools/call: chat ------------------------------------------------------------

test('tools/call chat succeeds and never leaks the API key', async () => {
  const { status, body } = await handleMcpMessage(
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'chat', arguments: { message: 'Hi there' } } },
    { env: ENV, fetchImpl: fakeFetchOk() },
  );
  assert.equal(status, 200);
  assert.equal(body.result.isError, undefined);
  assert.equal(body.result.content[0].type, 'text');
  assert.equal(body.result.content[0].text, 'Hello from test');
  assertNoSecret(body);
});

test('tools/call chat with invalid arguments returns isError, not a JSON-RPC error', async () => {
  const { status, body } = await handleMcpMessage(
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'chat', arguments: { message: '' } } },
    { env: ENV, fetchImpl: fakeFetchOk() },
  );
  assert.equal(status, 200);
  assert.equal(body.error, undefined);
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /message/i);
});

test('tools/call chat surfaces an upstream failure as isError with no upstream text and no secrets', async () => {
  const { status, body } = await handleMcpMessage(
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'chat', arguments: { message: 'Hi there' } } },
    { env: ENV, fetchImpl: fakeFetch500() },
  );
  assert.equal(status, 200);
  assert.equal(body.result.isError, true);
  const text = body.result.content[0].text;
  assert.equal(text.includes('500'), false);
  assert.equal(text.toLowerCase().includes('anthropic'), false);
  assertNoSecret(body);
});

// --- tools/call: unknown tool -----------------------------------------------------

test('tools/call with an unknown tool name returns JSON-RPC error -32602', async () => {
  const { status, body } = await handleMcpMessage(
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'does_not_exist', arguments: {} } },
    { env: ENV, fetchImpl: fakeFetchOk() },
  );
  assert.equal(status, 200);
  assert.equal(body.result, undefined);
  assert.equal(body.error.code, -32602);
});

// --- unknown method / invalid shape / batch --------------------------------------

test('an unknown method returns JSON-RPC error -32601', async () => {
  const { body } = await handleMcpMessage(
    { jsonrpc: '2.0', id: 11, method: 'not/a/real/method' },
    { env: ENV, fetchImpl: fakeFetchOk() },
  );
  assert.equal(body.error.code, -32601);
});

test('an invalid JSON-RPC shape returns -32600 with id null', async () => {
  const cases = [
    'not an object',
    { jsonrpc: '1.0', id: 1, method: 'ping' },
    { id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: 1 },
    null,
  ];
  for (const message of cases) {
    const { status, body } = await handleMcpMessage(message, { env: ENV, fetchImpl: fakeFetchOk() });
    assert.equal(status, 400);
    assert.equal(body.error.code, -32600);
    assert.equal(body.id, null);
  }
});

test('a JSON-RPC batch array is not supported and returns -32600', async () => {
  const { status, body } = await handleMcpMessage(
    [{ jsonrpc: '2.0', id: 1, method: 'ping' }],
    { env: ENV, fetchImpl: fakeFetchOk() },
  );
  assert.equal(status, 400);
  assert.equal(body.error.code, -32600);
  assert.equal(body.id, null);
});

// --- HTTP layer ---------------------------------------------------------------------

test('handleMcpHttp rejects non-POST methods with 405 and Allow: POST', async () => {
  const { status, headers, body } = await handleMcpHttp(
    { method: 'GET', headers: {}, body: undefined },
    { env: ENV, fetchImpl: fakeFetchOk() },
  );
  assert.equal(status, 405);
  assert.equal(headers.Allow, 'POST');
  assert.equal(body.error.code, -32600);
});

test('handleMcpHttp rejects a foreign Origin with 403', async () => {
  const { status, body } = await handleMcpHttp(
    {
      method: 'POST',
      headers: { origin: 'https://evil.example', host: 'my-app.vercel.app' },
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
    },
    { env: ENV, fetchImpl: fakeFetchOk() },
  );
  assert.equal(status, 403);
  assert.equal(body.error.code, -32600);
});

test('handleMcpHttp accepts a matching Origin derived from the Host header', async () => {
  const { status, body } = await handleMcpHttp(
    {
      method: 'POST',
      headers: { origin: 'https://my-app.vercel.app', host: 'my-app.vercel.app' },
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
    },
    { env: ENV, fetchImpl: fakeFetchOk() },
  );
  assert.equal(status, 200);
  assert.deepEqual(body.result, {});
});

test('handleMcpHttp accepts a matching Origin against env.APP_ORIGIN when set', async () => {
  const { status } = await handleMcpHttp(
    {
      method: 'POST',
      headers: { origin: 'https://configured.example', host: 'my-app.vercel.app' },
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
    },
    { env: { ...ENV, APP_ORIGIN: 'https://configured.example' }, fetchImpl: fakeFetchOk() },
  );
  assert.equal(status, 200);
});

test('handleMcpHttp returns 400/-32700 on an unparsable body', async () => {
  const { status, body } = await handleMcpHttp(
    { method: 'POST', headers: {}, body: undefined },
    { env: ENV, fetchImpl: fakeFetchOk() },
  );
  assert.equal(status, 400);
  assert.equal(body.error.code, -32700);
});

test('HTTP: MCP-Protocol-Version header is optional, supported values pass, unsupported values get 400', async () => {
  const { handleMcpHttp } = await import('./mcp.mjs');
  const ping = { jsonrpc: '2.0', id: 9, method: 'ping' };
  assert.equal((await handleMcpHttp({ method: 'POST', headers: {}, body: ping }, { env: {} })).status, 200);
  assert.equal((await handleMcpHttp({ method: 'POST', headers: { 'mcp-protocol-version': '2025-11-25' }, body: ping }, { env: {} })).status, 200);
  const bad = await handleMcpHttp({ method: 'POST', headers: { 'mcp-protocol-version': '1999-01-01' }, body: ping }, { env: {} });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /Unsupported MCP-Protocol-Version/);
});
