import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
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
