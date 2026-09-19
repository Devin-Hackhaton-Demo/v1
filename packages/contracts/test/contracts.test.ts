import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chatRequestSchema,
  chatResponseSchema,
  errorCodeSchema,
  SCHEMA_VERSION,
  SERVER_INFO,
  serverInfoInputSchema,
  serverInfoResponseSchema,
} from '../src/index.js';

const requestId = '9b01f209-7614-4e75-bc85-8fa6d5d07125';
const success = {
  schema_version: 1,
  request_id: requestId,
  ok: true,
  data: { name: 'context-mcp-server', version: '0.1.0', mode: 'local' },
};
const failure = {
  schema_version: 1,
  request_id: requestId,
  ok: false,
  error: { code: 'VALIDATION_ERROR', message: 'Invalid input.', retryable: false },
};

test('accepts the documented v1 success envelope', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual(SERVER_INFO, success.data);
  assert.deepEqual(serverInfoResponseSchema.parse(success), success);
});

test('accepts the documented v1 error envelope', () => {
  assert.deepEqual(serverInfoResponseSchema.parse(failure), failure);
});

test('accepts only an empty diagnostic input', () => {
  assert.deepEqual(serverInfoInputSchema.parse({}), {});
  for (const input of [undefined, null, [], { approved: true }, { project_id: requestId }]) {
    assert.equal(serverInfoInputSchema.safeParse(input).success, false);
  }
});

test('rejects inconsistent, incomplete and extra envelope fields', () => {
  const { data: _data, ...withoutData } = success;
  const { error: _error, ...withoutError } = failure;
  for (const input of [
    withoutData,
    withoutError,
    { ...success, schema_version: 2 },
    { ...success, request_id: 'not-a-uuid' },
    { ...success, ok: false },
    { ...failure, ok: true },
    { ...success, error: failure.error },
    { ...failure, data: success.data },
    { ...success, unexpected: true },
    { ...success, data: { ...success.data, mode: 'production' } },
    { ...failure, error: { ...failure.error, code: 'UNDOCUMENTED_ERROR' } },
    { ...failure, error: { ...failure.error, message: '' } },
    { ...failure, error: { ...failure.error, retryable: 'false' } },
  ]) {
    assert.equal(serverInfoResponseSchema.safeParse(input).success, false);
  }
});

test('retains the shared error vocabulary without inventing new codes', () => {
  assert.deepEqual(errorCodeSchema.options, [
    'UNAUTHENTICATED', 'NOT_FOUND', 'FORBIDDEN', 'VALIDATION_ERROR',
    'REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'CONTEXT_INCOMPLETE',
    'DECISION_CONFLICT', 'APPROVAL_REQUIRED', 'APPROVAL_EXPIRED',
    'INVALID_STATE', 'LEASE_EXPIRED', 'FILE_UNAVAILABLE', 'LIMIT_EXCEEDED',
    'SECRET_DETECTED', 'PROVIDER_ERROR', 'OUTCOME_UNKNOWN',
  ]);
});

const chatRequest = {
  messages: [
    { role: 'user', content: 'Hello?' },
    { role: 'assistant', content: 'Yes?' },
    { role: 'user', content: 'Summarize the plan.' },
  ],
  system: 'Answer briefly.',
};
const chatSuccess = {
  schema_version: 1,
  request_id: requestId,
  ok: true,
  data: { reply: 'Done.', model: 'claude-sonnet-5', usage: { input_tokens: 12, output_tokens: 3 } },
};
const chatFailure = {
  schema_version: 1,
  request_id: requestId,
  ok: false,
  error: { code: 'PROVIDER_ERROR', message: 'Upstream provider error.', retryable: true },
};

test('accepts documented chat requests up to their limits', () => {
  assert.deepEqual(chatRequestSchema.parse(chatRequest), chatRequest);
  const { system: _system, ...withoutSystem } = chatRequest;
  assert.deepEqual(chatRequestSchema.parse(withoutSystem), withoutSystem);
  const atLimits = {
    messages: Array.from({ length: 40 }, () => ({ role: 'user', content: 'x'.repeat(65_536) })),
    system: 'y'.repeat(8_192),
  };
  assert.deepEqual(chatRequestSchema.parse(atLimits), atLimits);
});

test('rejects malformed chat requests', () => {
  for (const input of [
    undefined,
    null,
    [],
    {},
    { messages: [] },
    { messages: 'user: hi' },
    { messages: [{ role: 'system', content: 'hi' }] },
    { messages: [{ role: 'user', content: '' }] },
    { messages: [{ role: 'user', content: 'x'.repeat(65_537) }] },
    { messages: [{ role: 'user' }] },
    { messages: [{ role: 'user', content: 'hi', name: 'extra' }] },
    { messages: Array.from({ length: 41 }, () => ({ role: 'user', content: 'hi' })) },
    { messages: [{ role: 'user', content: 'hi' }], system: 'y'.repeat(8_193) },
    { messages: [{ role: 'user', content: 'hi' }], system: 42 },
    { messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 },
  ]) {
    assert.equal(chatRequestSchema.safeParse(input).success, false);
  }
});

test('accepts the documented chat envelopes', () => {
  assert.deepEqual(chatResponseSchema.parse(chatSuccess), chatSuccess);
  assert.deepEqual(chatResponseSchema.parse(chatFailure), chatFailure);
});

test('rejects malformed chat replies and usage counters', () => {
  const data = chatSuccess.data;
  for (const input of [
    { ...chatSuccess, data: { ...data, reply: 42 } },
    { ...chatSuccess, data: { ...data, model: 42 } },
    { ...chatSuccess, data: { ...data, usage: { ...data.usage, input_tokens: -1 } } },
    { ...chatSuccess, data: { ...data, usage: { ...data.usage, output_tokens: 1.5 } } },
    { ...chatSuccess, data: { ...data, usage: { ...data.usage, input_tokens: '12' } } },
    { ...chatSuccess, data: { ...data, usage: { ...data.usage, total_tokens: 15 } } },
    { ...chatSuccess, data: { ...data, stop_reason: 'end_turn' } },
    { ...chatSuccess, data: { reply: 'Done.' } },
    { ...chatSuccess, data: { ...data, usage: { input_tokens: 12 } } },
  ]) {
    assert.equal(chatResponseSchema.safeParse(input).success, false);
  }
});
