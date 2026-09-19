import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';

test('defaults to a local development server', () => {
  assert.deepEqual(loadConfig({}), {
    host: '127.0.0.1', port: 3000, environment: 'development', logLevel: 'info',
  });
});

test('accepts explicit local test configuration and ignores unrelated variables', () => {
  assert.deepEqual(loadConfig({
    HOST: '127.0.0.1', PORT: '4317', NODE_ENV: 'test', LOG_LEVEL: 'silent',
    UNRELATED_VALUE: 'must-not-be-returned',
  }), { host: '127.0.0.1', port: 4317, environment: 'test', logLevel: 'silent' });
});

test('rejects non-local binds before listening', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'remote.invalid', '']) {
    assert.throws(() => loadConfig({ HOST: host }), /Invalid server configuration: HOST/);
  }
});

test('rejects production and unknown runtime modes', () => {
  for (const environment of ['production', 'staging', '']) {
    assert.throws(() => loadConfig({ NODE_ENV: environment }), /Invalid server configuration: NODE_ENV/);
  }
});

test('rejects invalid ports instead of coercing them', () => {
  for (const port of ['', '0', '-1', '65536', '3e3', '3000.5', ' 3000', '3000x']) {
    assert.throws(() => loadConfig({ PORT: port }), /Invalid server configuration: PORT/);
  }
});

test('configuration errors name fields, never their supplied values', () => {
  assert.throws(
    () => loadConfig({ LOG_LEVEL: 'CONFIG_SENTINEL' }),
    (error: unknown) => error instanceof Error
      && error.message === 'Invalid server configuration: LOG_LEVEL',
  );
});
