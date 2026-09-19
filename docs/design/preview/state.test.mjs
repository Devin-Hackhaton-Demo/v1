import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProfile, normalizeProfile, serializeProfile, onboardingProgress,
  earnMilestone, validateContextFile, escapeHtml, addSource, buildExport,
  normalizeSources, CONNECTORS, MAX_CONTEXT_BYTES, COMPANIONS,
  normalizeConnection, sourceCoverage, normalizeStack, stackSummary, sampleConnections,
  MAX_CHAT_TURNS, MAX_TURN_LENGTH, CHAT_COPY, normalizeConversation, appendChatTurn, chatRequestBody,
  parseChatResponse, requestChatReply, createChat, normalizeChat, serializeChat,
  chatWithUserTurn, chatWithReply, chatWithError, chatRetrying,
} from './state.mjs';
import { companionArt, serviceMark } from './art.mjs';

const bytes = (text) => new TextEncoder().encode(text);

test('a new workspace has no invented progress or connected accounts', () => {
  const profile = createProfile();
  assert.equal(onboardingProgress(profile).completed, 0);
  assert.equal(profile.appearance, 'system');
  assert.equal(profile.theme, 'coffee');
  assert.equal(profile.brand, 'coffeenator');
  assert.equal(profile.companion, 'bean');
  assert.deepEqual(profile.achievements, []);
  assert.ok(CONNECTORS.every((connector) => connector.status === 'key'), 'connectors only offer bring-your-own-key, nothing is pre-connected');
});

test('progress does not require personal information or a connector', () => {
  const profile = { ...createProfile(), themeChosen: true, profileSaved: true, companionChosen: true, companion: 'none' };
  assert.deepEqual(onboardingProgress(profile), { completed: 3, total: 3, percent: 100 });
  assert.equal(profile.name, '');
});

test('import achievements are durable, unique and not mandatory setup steps', () => {
  const first = earnMilestone(createProfile(), 'import');
  const twice = earnMilestone(first, 'import');
  assert.deepEqual(twice.achievements, ['import']);
  assert.equal(onboardingProgress(twice).completed, 0);
  assert.deepEqual(earnMilestone(twice, 'unknown').achievements, ['import']);
});

test('persisted preferences are allowlisted and bounded', () => {
  const profile = normalizeProfile({ appearance: 'invalid', theme: 'bad', name: '  Ada  ', replyLength: 999, roles: ['Creator', 'Creator', 'INVALID'], connected: true });
  assert.equal(profile.appearance, 'system');
  assert.equal(profile.theme, 'coffee');
  assert.equal(profile.name, 'Ada');
  assert.equal(profile.replyLength, 2);
  assert.deepEqual(profile.roles, ['Creator']);
  assert.equal(profile.connected, undefined);
  assert.deepEqual(normalizeProfile(null), createProfile());
});

test('persistent profile storage never includes imported text or tokens', () => {
  const persisted = JSON.parse(serializeProfile({ ...createProfile(), sources: [{ text: 'private context' }], token: 'not-a-real-token' }));
  assert.equal(persisted.sources, undefined);
  assert.equal(persisted.token, undefined);
});

test('avatars cannot load arbitrary external URLs or executable content', () => {
  for (const avatar of ['https://example.invalid/tracker.png', 'javascript:alert(1)', 'data:image/svg+xml,<svg></svg>']) {
    assert.equal(normalizeProfile({ avatar }).avatar, '');
  }
  assert.equal(normalizeProfile({ avatar: 'data:image/png;base64,YQ==' }).avatar, 'data:image/png;base64,YQ==');
});

test('explicit UTF-8 text exports keep their original contents', () => {
  const original = '# About me\nI enjoy café culture and prefer concise answers.\n';
  const file = validateContextFile('claude-context.md', bytes(original));
  assert.equal(file.text, original);
  assert.equal(file.name, 'claude-context.md');
  assert.equal(file.bytes, bytes(original).length);
});

test('JSON exports are syntax checked, not silently summarized', () => {
  assert.equal(validateContextFile('memory.json', bytes('{"preference":"short"}')).format, 'json');
  assert.throws(() => validateContextFile('memory.json', bytes('{bad json}')), /JSON/);
});

test('empty, oversized, non-text and malformed UTF-8 files are rejected', () => {
  assert.throws(() => validateContextFile('empty.md', bytes(' \n')), /empty/);
  assert.throws(() => validateContextFile('large.txt', new Uint8Array(MAX_CONTEXT_BYTES + 1)), /1 MiB/);
  assert.throws(() => validateContextFile('export.zip', bytes('zip')), /\.txt/);
  assert.throws(() => validateContextFile('bad.txt', new Uint8Array([0xc3, 0x28])), /UTF-8/);
});

test('credential filenames and obvious private-key exports are rejected without echoing content', () => {
  assert.throws(() => validateContextFile('.env.txt', bytes('sample')), /credential/);
  assert.throws(() => validateContextFile('private.md', bytes('-----BEGIN PRIVATE KEY-----\nNOT-A-REAL-KEY')), (error) => /secret/.test(error.message) && !error.message.includes('NOT-A-REAL-KEY'));
});

test('rendering treats imported HTML and user names as inert text', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(escapeHtml("Ada & Bob's"), 'Ada &amp; Bob&#39;s');
});

test('duplicate source imports do not create multiple entries', () => {
  const source = { id: 'one', hash: 'same-hash', name: 'context.md', provider: 'Claude', text: 'A short preference', savedAt: '2026-09-19T12:00:00.000Z' };
  const result = addSource(addSource([], source), { ...source, id: 'two' });
  assert.equal(result.length, 1);
});

test('restoring session context does not trust malformed storage', () => {
  const valid = { id: 'one', hash: 'hash', name: 'context.md', provider: 'Claude', text: 'Short answers.', savedAt: '2026-09-19T12:00:00.000Z' };
  const restored = normalizeSources([valid, { ...valid, id: 'bad', name: '.env.txt' }, null]);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].text, valid.text);
  assert.deepEqual(normalizeSources({}), []);
});

test('long filenames remain restorable after bounded display names', () => {
  const file = validateContextFile(`${'long-name-'.repeat(20)}.md`, bytes('A safe preference.'));
  assert.ok(file.name.length <= 160);
  assert.match(file.name, /\.md$/);
  const restored = normalizeSources([{ ...file, id: 'long-file', hash: 'long-file-hash', provider: 'Claude', savedAt: '2026-09-19T12:00:00.000Z' }]);
  assert.equal(restored.length, 1);
});

test('obvious credentials in JSON are rejected without repeating their values', () => {
  assert.throws(() => validateContextFile('context.json', bytes('{"api_key":"EXAMPLE_NOT_A_REAL_CREDENTIAL"}')), (error) => /secret/.test(error.message) && !error.message.includes('EXAMPLE_NOT_A_REAL_CREDENTIAL'));
});

test('Composio ACTIVE never implies verified health or a completed sync', () => {
  const record = normalizeConnection({ id: 'connected-test', toolkit: { slug: 'gmail' }, status: 'ACTIVE', created_at: '2026-09-18T10:00:00.000Z', state: { access_token: 'fictional-private-value' }, data: { secret: 'fictional' } });
  assert.equal(record.status, 'ACTIVE');
  assert.equal(record.health, 'unknown');
  assert.equal(record.sync, 'not_synced');
  assert.equal(record.addedAt, '2026-09-18T10:00:00.000Z');
  assert.equal(record.connectedAt, null);
  assert.equal(record.state, undefined);
  assert.equal(record.data, undefined);
  assert.equal(JSON.stringify(record).includes('fictional-private-value'), false);
});

test('health and sync evidence require their own timestamps', () => {
  const account = { id: 'test', status: 'ACTIVE', toolkit: { slug: 'googledrive' } };
  assert.equal(normalizeConnection(account, { health: 'healthy', sync: 'synced' }).health, 'unknown');
  assert.equal(normalizeConnection(account, { health: 'healthy', sync: 'synced' }).sync, 'not_synced');
  const checked = normalizeConnection(account, { health: 'healthy', checkedAt: '2026-09-19T10:00:00.000Z', sync: 'synced', syncedAt: '2026-09-19T09:00:00.000Z' });
  assert.equal(checked.health, 'healthy');
  assert.equal(checked.sync, 'synced');
  assert.equal(normalizeConnection({ ...account, is_disabled: true }).status, 'INACTIVE');
});

test('memory coverage counts optional source categories, not AI training or user knowledge', () => {
  const summary = sourceCoverage([
    { provider: 'Claude', text: 'first', savedAt: '2026-08-01T12:00:00.000Z' },
    { provider: 'Claude', text: 'second', savedAt: '2026-09-18T12:00:00.000Z' },
    { provider: 'Personal note', text: 'note', savedAt: '2026-09-19T12:00:00.000Z' },
  ], new Date('2026-09-19T13:00:00.000Z'));
  assert.equal(summary.total, 3);
  assert.equal(summary.categoriesAdded, 2);
  assert.equal(summary.groups.claude.count, 2);
  assert.equal(summary.groups.claude.needsReview, false);
  assert.equal(summary.trained, undefined);
  assert.equal(sourceCoverage([{ provider: 'ChatGPT', text: 'old', savedAt: '2026-08-01T12:00:00.000Z' }], new Date('2026-09-19')).groups.chatgpt.needsReview, true);
});

test('subscription summaries keep currencies separate and normalize yearly billing', () => {
  const records = normalizeStack([
    { id: 'a', name: 'One', cost: 24, currency: 'USD', cycle: 'month', capabilities: ['Text', 'Images'] },
    { id: 'b', name: 'Two', cost: 120, currency: 'USD', cycle: 'year', capabilities: ['Text', 'Code'] },
    { id: 'c', name: 'Three', cost: 15, currency: 'EUR', cycle: 'month', capabilities: ['Dictation'] },
    { id: 'd', name: 'Paused', cost: 100, currency: 'USD', active: false },
    { id: 'e', name: 'Unknown cost', cost: null, currency: 'USD' },
  ]);
  const summary = stackSummary(records);
  assert.deepEqual(summary.totals, { USD: 34, EUR: 15 });
  assert.deepEqual(summary.overlap, [{ capability: 'Text', count: 2 }]);
  assert.equal(summary.unknownCosts, 1);
  assert.equal(summary.guaranteedSavings, undefined);
});

test('manual stack data does not invent installed versions or equate notes with dictation', () => {
  const stack = normalizeStack([{ id: 'a', name: 'Meeting app', capabilities: ['Meeting notes'], cost: -10 }, { id: 'b', name: 'Dictation app', capabilities: ['Dictation'], cost: 'not-a-price' }]);
  assert.equal(stack[0].version, '');
  assert.equal(stack[0].checkedAt, null);
  assert.equal(stack[0].cost, null);
  assert.deepEqual(stackSummary(stack).overlap, []);
});

test('six additional companions are available without removing the quiet option', () => {
  assert.equal(COMPANIONS.filter(({ id }) => id !== 'none').length, 9);
  assert.ok(COMPANIONS.some(({ id }) => id === 'none'));
});

test('all nine companions have their own original artwork', () => {
  const companions = COMPANIONS.filter(({ id }) => id !== 'none');
  for (const { id } of companions) assert.match(companionArt(id), new RegExp(`pet-${id}`));
  assert.equal(new Set(companions.map(({ id }) => companionArt(id))).size, 9);
});

test('provider marks use local assets and never a Composio logo', () => {
  for (const name of ['gmail', 'calendar', 'drive', 'github', 'supabase', 'claude', 'chatgpt']) {
    assert.match(serviceMark(name), /src="\/icons\//);
    assert.doesNotMatch(serviceMark(name), /https?:/);
  }
  assert.doesNotMatch(serviceMark('composio', true), /composio/);
  assert.doesNotMatch(serviceMark('composio', false), /composio/);
});

test('sample connection records are always labelled and carry explicit timestamps', () => {
  const records = sampleConnections(new Date('2026-09-19T12:00:00.000Z'));
  assert.equal(records.length, 3);
  assert.ok(records.every((record) => record.sample && record.connectedAt && record.checkedAt));
  assert.ok(records.some((record) => record.status === 'EXPIRED'));
  assert.ok(records.some((record) => record.sync === 'not_supported'));
});

test('portable exports default to English and disclose source provenance', () => {
  const result = buildExport({ ...createProfile(), name: 'Ada' }, [{ name: 'notes.md', provider: 'Claude', text: 'My own note', savedAt: '2026-09-19T12:00:00.000Z' }]);
  assert.equal(result.schema_version, 1);
  assert.equal(result.profile.name, 'Ada');
  assert.equal(result.preferences.language, 'en');
  assert.equal(result.sources[0].coverage, 'supplied_export');
  assert.equal(result.sources[0].source_verified, false);
  assert.equal(result.sources[0].text, 'My own note');
  assert.equal(result.credentials, undefined);
});

test('conversations append in order and keep only the 40 most recent turns', () => {
  let turns = [];
  for (let index = 0; index < 23; index++) {
    turns = appendChatTurn(turns, 'user', `question ${index}`);
    turns = appendChatTurn(turns, 'assistant', `answer ${index}`);
  }
  assert.equal(turns.length, MAX_CHAT_TURNS);
  assert.deepEqual(turns[0], { role: 'user', content: 'question 3' });
  assert.deepEqual(turns.at(-1), { role: 'assistant', content: 'answer 22' });
});

test('chat turns are bounded to the backend limit of 65536 characters per message', () => {
  assert.equal(MAX_TURN_LENGTH, 65536);
  const [turn] = normalizeConversation([{ role: 'user', content: 'a'.repeat(MAX_TURN_LENGTH + 1) }]);
  assert.equal(turn.content.length, MAX_TURN_LENGTH);
  const kept = normalizeConversation([{ role: 'user', content: 'b'.repeat(MAX_TURN_LENGTH) }]);
  assert.equal(kept[0].content.length, MAX_TURN_LENGTH);
  const reply = parseChatResponse(200, { schema_version: 1, ok: true, data: { reply: 'c'.repeat(MAX_TURN_LENGTH + 100) } });
  assert.equal(reply.ok, true);
  assert.equal(reply.reply.length, MAX_TURN_LENGTH);
});

test('restored conversations drop malformed turns instead of trusting storage', () => {
  const restored = normalizeConversation([
    { role: 'user', content: 'Hello' },
    { role: 'system', content: 'not an allowed role' },
    { role: 'assistant', content: '   ' },
    { role: 'assistant', content: 42 },
    null,
    { role: 'assistant', content: 'Hi.' },
  ]);
  assert.deepEqual(restored, [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi.' }]);
  assert.deepEqual(normalizeConversation('not-an-array'), []);
});

test('chat request bodies start and end with a user turn and never exceed 40 messages', () => {
  const body = chatRequestBody([{ role: 'assistant', content: 'stray greeting' }, { role: 'user', content: 'First question' }]);
  assert.deepEqual(body, { messages: [{ role: 'user', content: 'First question' }] });
  assert.equal(chatRequestBody([{ role: 'user', content: 'Q' }], '  Be concise.  ').system, 'Be concise.');
  let turns = [];
  for (let index = 0; index < 22; index++) {
    turns = appendChatTurn(turns, 'user', `question ${index}`);
    turns = appendChatTurn(turns, 'assistant', `answer ${index}`);
  }
  turns = appendChatTurn(turns, 'user', 'latest question');
  const long = chatRequestBody(turns).messages;
  assert.ok(long.length <= MAX_CHAT_TURNS);
  assert.equal(long[0].role, 'user');
  assert.equal(long.at(-1).role, 'user');
  assert.equal(long.at(-1).content, 'latest question');
  assert.throws(() => chatRequestBody([{ role: 'assistant', content: 'only a reply' }]), /message/);
});

test('successful replies require the exact contract envelope — no fake success', () => {
  const ok = parseChatResponse(200, { schema_version: 1, request_id: 'r1', ok: true, data: { reply: 'Hello!', model: 'claude-test', usage: { input_tokens: 12, output_tokens: 5 } } });
  assert.equal(ok.ok, true);
  assert.equal(ok.reply, 'Hello!');
  assert.equal(ok.model, 'claude-test');
  assert.deepEqual(ok.usage, { input_tokens: 12, output_tokens: 5 });
  for (const body of [null, { ok: true }, { schema_version: 1, ok: true, data: { reply: '  ' } }, { schema_version: 2, ok: true, data: { reply: 'hi' } }]) {
    assert.equal(parseChatResponse(200, body).ok, false);
  }
});

test('an unconfigured backend shows the setup instruction without a retry offer', () => {
  const result = parseChatResponse(503, { ok: false, error: { code: 'PROVIDER_ERROR', message: 'Chat backend is not configured.', retryable: false } });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.equal(result.message, 'Chat backend is not configured. Set ANTHROPIC_API_KEY on the server.');
});

test('retryable provider errors offer retry and validation errors do not', () => {
  const upstream = parseChatResponse(502, { ok: false, error: { code: 'PROVIDER_ERROR', message: 'Upstream request failed.', retryable: true } });
  assert.equal(upstream.ok, false);
  assert.equal(upstream.retryable, true);
  const invalid = parseChatResponse(400, { ok: false, error: { code: 'VALIDATION_ERROR', message: 'messages is required.', retryable: false } });
  assert.equal(invalid.retryable, false);
  assert.equal(invalid.message, 'messages is required.');
  assert.equal(parseChatResponse(502, undefined).retryable, true);
  assert.equal(parseChatResponse(405, undefined).retryable, false);
});

test('chat state transitions never invent a reply and keep the conversation for retry', () => {
  const sending = chatWithUserTurn(createChat(), 'Hello?');
  assert.equal(sending.status, 'sending');
  assert.deepEqual(sending.turns, [{ role: 'user', content: 'Hello?' }]);
  const failed = chatWithError(sending, { retryable: true, message: 'The reply did not arrive.' });
  assert.equal(failed.status, 'error');
  assert.equal(failed.error.retryable, true);
  assert.deepEqual(failed.turns, sending.turns);
  const retrying = chatRetrying(failed);
  assert.equal(retrying.status, 'sending');
  assert.equal(retrying.error, null);
  assert.deepEqual(retrying.turns, sending.turns);
  const done = chatWithReply(retrying, 'Hi there.');
  assert.equal(done.status, 'idle');
  assert.equal(done.error, null);
  assert.deepEqual(done.turns.at(-1), { role: 'assistant', content: 'Hi there.' });
});

test('restoring a chat never resumes a fake in-flight or error state', () => {
  const answered = normalizeChat(JSON.parse(serializeChat({ turns: [{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }], status: 'sending', error: { message: 'stale' } })));
  assert.equal(answered.status, 'idle');
  assert.equal(answered.error, null);
  const unanswered = normalizeChat({ turns: [{ role: 'user', content: 'Q' }] });
  assert.equal(unanswered.status, 'error');
  assert.equal(unanswered.error.retryable, true);
  assert.equal(unanswered.error.message, CHAT_COPY.interrupted);
  assert.deepEqual(normalizeChat(null), createChat());
  assert.equal(JSON.parse(serializeChat(chatWithError(createChat(), { message: 'transient detail' }))).error, undefined);
});

test('sending posts the contract body through the injected fetch and returns the reply', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { status: 200, json: async () => ({ schema_version: 1, request_id: 'r2', ok: true, data: { reply: 'Brewed and ready.', model: 'claude-test', usage: { input_tokens: 3, output_tokens: 7 } } }) };
  };
  const result = await requestChatReply([{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi.' }, { role: 'user', content: 'More?' }], { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.reply, 'Brewed and ready.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/chat');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.messages.length, 3);
  assert.equal(sent.messages[0].role, 'user');
  assert.equal(sent.messages.at(-1).role, 'user');
  assert.equal(sent.system, undefined);
});

test('network failures and timeouts surface as retryable errors, never success', async () => {
  const network = await requestChatReply([{ role: 'user', content: 'Hi' }], { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(network.ok, false);
  assert.equal(network.retryable, true);
  assert.equal(network.message, CHAT_COPY.network);
  const controller = new AbortController();
  controller.abort();
  const timedOut = await requestChatReply([{ role: 'user', content: 'Hi' }], { fetchImpl: async () => { throw Object.assign(new Error('Aborted'), { name: 'AbortError' }); }, signal: controller.signal });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.retryable, true);
  assert.equal(timedOut.message, CHAT_COPY.timeout);
  const unreadable = await requestChatReply([{ role: 'user', content: 'Hi' }], { fetchImpl: async () => ({ status: 200, json: async () => { throw new SyntaxError('bad json'); } }) });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.retryable, true);
});

test('API key state keeps known providers only and migrates the legacy Composio record', async () => {
  const { normalizeKeys, normalizeKeyEntry, maskKey, KEY_GUIDES, CONNECTORS: connectors, CONNECTOR_KEYS } = await import('./state.mjs');
  assert.deepEqual(normalizeKeys(null), {});
  const keys = normalizeKeys({ openai: { apiKey: 'sk-x', status: 'healthy', account: '1 model(s) available', checkedAt: '2026-09-19T12:00:00.000Z', extra: 1 }, aws: { apiKey: 'nope' }, github: { apiKey: '' } }, { apiKey: 'ak_legacy', status: 'healthy' });
  assert.deepEqual(Object.keys(keys).sort(), ['composio', 'openai']);
  assert.deepEqual(keys.openai, { apiKey: 'sk-x', status: 'healthy', account: '1 model(s) available', checkedAt: '2026-09-19T12:00:00.000Z' });
  assert.equal(keys.composio.apiKey, 'ak_legacy');
  assert.equal(normalizeKeys({ composio: { apiKey: 'ak_new' } }, { apiKey: 'ak_legacy' }).composio.apiKey, 'ak_new');
  assert.equal(normalizeKeyEntry({ apiKey: 'k', status: 'hacked' }).status, 'unchecked');
  assert.equal(normalizeKeyEntry({ apiKey: 'x'.repeat(4097) }), null);
  assert.deepEqual(normalizeKeyEntry({ apiKey: 'k', toolkits: { gmail: 2, googledrive: '1', evil: 9 } }).toolkits, { gmail: 2, googlecalendar: 0, googledrive: 1 });
  assert.equal(maskKey('ak_abcdefgh1234'), '••••1234');
  assert.equal(maskKey('abc'), '••••');
  for (const connector of connectors) {
    assert.equal(connector.status, 'key', connector.id);
    assert.ok(KEY_GUIDES[CONNECTOR_KEYS[connector.id]], `${connector.id} has a guide`);
    assert.doesNotMatch(JSON.stringify(connector), /planned|future|coming soon/i, connector.id);
  }
});

test('requestKeyCheck posts provider and key and maps every outcome', async () => {
  const { requestKeyCheck } = await import('./state.mjs');
  const calls = [];
  const reply = (status, payload) => async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(payload), { status }); };
  const healthy = await requestKeyCheck('composio', 'ak_key', { fetchImpl: reply(200, { ok: true, data: { provider: 'composio', healthy: true, account: '3 connected account(s)', toolkits: { gmail: 1, googlecalendar: 0, googledrive: 2 } } }) });
  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.account, '3 connected account(s)');
  assert.deepEqual(healthy.toolkits, { gmail: 1, googlecalendar: 0, googledrive: 2 });
  assert.ok(Number.isFinite(Date.parse(healthy.checkedAt)));
  assert.equal(calls[0].url, '/api/keys/check');
  assert.deepEqual(JSON.parse(calls[0].init.body), { provider: 'composio', apiKey: 'ak_key' });
  assert.equal((await requestKeyCheck('openai', 'k', { fetchImpl: reply(200, { ok: true, data: { healthy: false, reason: 'unauthorized' } }) })).status, 'unauthorized');
  assert.equal((await requestKeyCheck('openai', 'k', { fetchImpl: reply(200, { ok: true, data: { healthy: false, reason: 'unreachable' } }) })).status, 'unreachable');
  const limited = await requestKeyCheck('github', 'k', { fetchImpl: reply(429, { ok: false, error: { code: 'LIMIT_EXCEEDED', message: 'Too many requests. Please wait a moment and try again.' } }) });
  assert.equal(limited.status, 'error');
  assert.match(limited.message, /Too many requests/);
  const neverCall = async () => { throw new Error('must not call'); };
  assert.equal((await requestKeyCheck('github', 'k', { fetchImpl: neverCall })).status, 'error');
  assert.equal((await requestKeyCheck('github', '', { fetchImpl: neverCall })).status, 'error');
  assert.equal((await requestKeyCheck('google', 'k', { fetchImpl: neverCall })).status, 'error');
});

test('MCP setup snippets embed the endpoint for every supported client', async () => {
  const { mcpClients } = await import('./state.mjs');
  const url = 'https://coffeenator.example/mcp';
  const clients = mcpClients(url);
  assert.deepEqual(clients.map(({ id }) => id), ['claude-code', 'claude-desktop', 'cursor', 'vscode', 'other']);
  for (const client of clients) {
    assert.ok(client.steps.length >= 1, client.id);
    assert.ok(client.snippet.includes(url), `${client.id} snippet contains the URL`);
  }
  assert.equal(clients[0].snippet, `claude mcp add --transport http coffeenator ${url}`);
  assert.deepEqual(JSON.parse(clients[2].snippet), { mcpServers: { coffeenator: { url } } });
  assert.deepEqual(JSON.parse(clients[3].snippet), { servers: { coffeenator: { type: 'http', url } } });
});

test('requestMcpStatus runs initialize + tools/list over JSON-RPC and maps failures', async () => {
  const { requestMcpStatus } = await import('./state.mjs');
  const calls = [];
  const online = await requestMcpStatus({ fetchImpl: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const { id, method } = JSON.parse(init.body);
    const result = method === 'initialize'
      ? { protocolVersion: '2025-06-18', serverInfo: { name: 'context-mcp-server', version: '0.1.0' } }
      : { tools: [{ name: 'server_info', description: 'Diagnostics' }, { name: 'chat', description: 'Talk to the model', inputSchema: { type: 'object' } }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 });
  } });
  assert.equal(online.status, 'online');
  assert.equal(online.server, 'context-mcp-server 0.1.0');
  assert.equal(online.protocolVersion, '2025-06-18');
  assert.deepEqual(online.tools, [{ name: 'server_info', description: 'Diagnostics' }, { name: 'chat', description: 'Talk to the model' }]);
  assert.ok(Number.isFinite(Date.parse(online.checkedAt)));
  assert.deepEqual(calls.map(({ url, body }) => [url, body.method]), [['/mcp', 'initialize'], ['/mcp', 'tools/list']]);
  assert.equal(calls[1].headers['mcp-protocol-version'], '2025-06-18');
  const limited = await requestMcpStatus({ fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: { message: 'Too many requests. Please wait a moment and try again.' } }), { status: 429 }) });
  assert.equal(limited.status, 'offline');
  assert.match(limited.message, /Too many requests/);
  const rpcError = await requestMcpStatus({ fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }), { status: 200 }) });
  assert.equal(rpcError.status, 'offline');
  const offline = await requestMcpStatus({ fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(offline.status, 'offline');
});
