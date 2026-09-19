// Dependency-free, stateless MCP (Model Context Protocol) message handler.
// No @modelcontextprotocol/* or other npm packages: Node built-ins and this
// repo's own api/_lib/*.mjs helpers only, per the Vercel deployment (no
// npm install step).
//
// Two tools are exposed: `server_info` (read-only diagnostics) and `chat`
// (delegates to the existing Anthropic-backed chat handler). This mirrors
// the local scaffold in apps/api/src/mcp.ts, adding the `chat` tool.

import { handleChatRequest } from './anthropic.mjs';

// Copied literal values from packages/contracts/src/index.ts SERVER_INFO
// (that file is TypeScript and cannot be imported here).
const SERVER_NAME = 'context-mcp-server';
const SERVER_VERSION = '0.1.0';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

const INSTRUCTIONS = 'Stateless MCP server running on Vercel. Exposes two read-only tools: '
  + '"server_info" (identity/diagnostics) and "chat" (an Anthropic-backed conversational '
  + 'assistant). No context storage, approvals, or external actions are available here.';

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function successResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function validRequestShape(message) {
  return isPlainObject(message)
    && message.jsonrpc === '2.0'
    && typeof message.method === 'string'
    && message.method.length > 0;
}

// --- tools/list definitions ---------------------------------------------

const SERVER_INFO_TOOL = {
  name: 'server_info',
  description: 'Report this MCP server\'s identity and available tools. Read-only, no side effects.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  annotations: {
    title: 'Server info',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const CHAT_TOOL = {
  name: 'chat',
  description: 'Send a message to the Anthropic-backed chat assistant and return its reply.',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        minLength: 1,
        maxLength: 8000,
        description: 'The user message to send to the assistant (1-8000 characters).',
      },
      system: {
        type: 'string',
        maxLength: 4000,
        description: 'Optional system prompt override (at most 4000 characters).',
      },
    },
    required: ['message'],
    additionalProperties: false,
  },
  annotations: {
    title: 'Chat',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

function buildServerInfoResult() {
  return {
    content: [{
      type: 'text',
      text: `${SERVER_NAME} v${SERVER_VERSION} is running on Vercel.`,
    }],
    structuredContent: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      deployment: 'vercel',
      tools: ['server_info', 'chat'],
    },
  };
}

function validateChatArgs(args) {
  const errors = [];
  if (!isPlainObject(args)) {
    errors.push('Arguments must be an object.');
    return errors;
  }
  for (const key of Object.keys(args)) {
    if (key !== 'message' && key !== 'system') errors.push(`Unexpected property "${key}".`);
  }
  if (typeof args.message !== 'string' || args.message.length < 1 || args.message.length > 8000) {
    errors.push('"message" must be a string between 1 and 8000 characters.');
  }
  if (args.system !== undefined && (typeof args.system !== 'string' || args.system.length > 4000)) {
    errors.push('"system" must be a string of at most 4000 characters.');
  }
  return errors;
}

async function callChatTool(args, { env, fetchImpl }) {
  const validationErrors = validateChatArgs(args);
  if (validationErrors.length > 0) {
    return { content: [{ type: 'text', text: `Invalid arguments: ${validationErrors.join(' ')}` }], isError: true };
  }
  const body = { messages: [{ role: 'user', content: args.message }] };
  if (typeof args.system === 'string' && args.system.length > 0) body.system = args.system;
  const { payload } = await handleChatRequest(body, env, fetchImpl);
  if (payload.ok) {
    return { content: [{ type: 'text', text: payload.data.reply }] };
  }
  // handleChatRequest already returns sanitized, generic error messages
  // (never upstream response bodies, status text, or env values).
  return { content: [{ type: 'text', text: payload.error.message }], isError: true };
}

async function handleToolsCall(params, ctx) {
  if (!isPlainObject(params) || typeof params.name !== 'string' || params.name.length === 0) {
    return { error: { code: -32602, message: 'Invalid params: "name" (string) is required.' } };
  }
  const { name } = params;
  const args = params.arguments === undefined ? {} : params.arguments;

  if (name === 'server_info') {
    const validationErrors = isPlainObject(args) && Object.keys(args).length === 0
      ? []
      : ['"server_info" does not accept any arguments.'];
    if (validationErrors.length > 0) {
      return { result: { content: [{ type: 'text', text: `Invalid arguments: ${validationErrors.join(' ')}` }], isError: true } };
    }
    return { result: buildServerInfoResult() };
  }

  if (name === 'chat') {
    return { result: await callChatTool(args, ctx) };
  }

  return { error: { code: -32602, message: `Unknown tool: "${name}".` } };
}

function buildInitializeResult(params) {
  const requested = isPlainObject(params) ? params.protocolVersion : undefined;
  const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions: INSTRUCTIONS,
  };
}

/**
 * Handle exactly one parsed JSON-RPC 2.0 message (request or notification).
 * Returns { status, body } — body is the JSON-RPC response object, or
 * { status: 202, body: null } for notifications (messages without "id").
 */
export async function handleMcpMessage(message, { env, fetchImpl } = {}) {
  if (Array.isArray(message) || !validRequestShape(message)) {
    return { status: 400, body: errorResponse(null, -32600, 'Invalid Request: expected a single JSON-RPC 2.0 object with jsonrpc "2.0" and a method (batches are not supported).') };
  }

  const isNotification = !('id' in message);
  if (isNotification) {
    // notifications/initialized and any other notification: acknowledge
    // with no body, per the Streamable HTTP stateless transport.
    return { status: 202, body: null };
  }

  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      return { status: 200, body: successResponse(id, buildInitializeResult(params)) };
    case 'ping':
      return { status: 200, body: successResponse(id, {}) };
    case 'tools/list':
      return { status: 200, body: successResponse(id, { tools: [SERVER_INFO_TOOL, CHAT_TOOL] }) };
    case 'tools/call': {
      const outcome = await handleToolsCall(params, { env, fetchImpl });
      if (outcome.error) return { status: 200, body: errorResponse(id, outcome.error.code, outcome.error.message) };
      return { status: 200, body: successResponse(id, outcome.result) };
    }
    default:
      return { status: 200, body: errorResponse(id, -32601, `Method not found: "${method}".`) };
  }
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

/**
 * Streamable HTTP (stateless mode) entry point.
 * Never logs request bodies.
 */
export async function handleMcpHttp({ method, headers, body }, { env, fetchImpl } = {}) {
  const jsonHeaders = { 'content-type': 'application/json' };

  if (method !== 'POST') {
    return { status: 405, headers: { ...jsonHeaders, Allow: 'POST' }, body: errorResponse(null, -32600, 'Method not allowed: this endpoint only accepts POST.') };
  }

  const origin = getHeader(headers, 'origin');
  if (origin !== undefined) {
    const host = getHeader(headers, 'host');
    const expectedOrigin = (env && typeof env.APP_ORIGIN === 'string' && env.APP_ORIGIN.length > 0)
      ? env.APP_ORIGIN
      : `https://${host}`;
    if (origin !== expectedOrigin) {
      return { status: 403, headers: jsonHeaders, body: errorResponse(null, -32600, 'Origin not allowed.') };
    }
  }

  // Spec 2025-06-18 (Streamable HTTP, Protocol Version Header): a missing header
  // is accepted; an unsupported value MUST be answered with 400 Bad Request.
  const versionHeader = getHeader(headers, 'mcp-protocol-version');
  if (versionHeader !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(versionHeader)) {
    return { status: 400, headers: jsonHeaders, body: errorResponse(null, -32600, `Unsupported MCP-Protocol-Version. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.`) };
  }

  if (body === undefined) {
    return { status: 400, headers: jsonHeaders, body: errorResponse(null, -32700, 'Parse error: request body must be valid JSON.') };
  }

  const { status, body: responseBody } = await handleMcpMessage(body, { env, fetchImpl });
  return { status, headers: jsonHeaders, body: responseBody };
}
