import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPreviewServer } from './server.mjs';

async function serve(t) {
  const server = createPreviewServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('the preview serves a complete English application without external assets', async (t) => {
  const base = await serve(t);
  const response = await fetch(base);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /lang="en"/);
  assert.match(html, /Coffeenator/);
  assert.doesNotMatch(html, /https?:\/\//);
  for (const asset of ['/app.mjs', '/state.mjs', '/art.mjs', '/styles.css', '/tokens.css', '/favicon.svg', '/icons/gmail.png', '/icons/calendar.png', '/icons/drive.png', '/icons/github.svg', '/icons/supabase.svg', '/icons/claude.svg', '/icons/chatgpt.svg', '/icons/composio-black.svg', '/icons/composio-white.svg']) {
    const result = await fetch(base + asset);
    assert.equal(result.status, 200, asset);
    assert.ok(Number(result.headers.get('content-length')) > 0, asset);
  }
});

test('only preview assets are exposed, never source tests or repository files', async (t) => {
  const base = await serve(t);
  for (const path of ['/.env', '/server.mjs', '/state.test.mjs', '/AGENTS.md', '/PROJECT_CONTEXT.md', '/%2e%2e/.git/config']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
});

test('the server cannot receive uploaded context or trigger an API operation', async (t) => {
  const base = await serve(t);
  const response = await fetch(base, { method: 'POST', body: 'fictional test content' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
  assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.match(response.headers.get('content-security-policy'), /form-action 'none'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('HEAD responses include asset metadata without response bodies', async (t) => {
  const base = await serve(t);
  const response = await fetch(base + '/styles.css', { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/css/);
  assert.ok(Number(response.headers.get('content-length')) > 0);
  assert.equal(await response.text(), '');
});
