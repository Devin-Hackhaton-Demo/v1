import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));

for (const environment of [{ NODE_ENV: 'production' }, { HOST: '0.0.0.0' }]) {
  test(`the entry point refuses unsafe configuration: ${JSON.stringify(environment)}`, { timeout: 10_000 }, async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    });
    const output: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 1);
    assert.match(output.join(''), /Invalid server configuration/);
    assert.doesNotMatch(output.join(''), /Server listening/);
  });
}
