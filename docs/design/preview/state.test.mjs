import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProfile, normalizeProfile, serializeProfile, onboardingProgress,
  earnMilestone, validateContextFile, escapeHtml, addSource, buildExport,
  normalizeSources, CONNECTORS, MAX_CONTEXT_BYTES, COMPANIONS,
  normalizeConnection, sourceCoverage, normalizeStack, stackSummary, sampleConnections,
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
  assert.ok(CONNECTORS.every((connector) => connector.status === 'soon'));
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

test('provider marks use local assets with correct Composio variants', () => {
  for (const name of ['gmail', 'calendar', 'drive', 'github', 'supabase', 'claude', 'chatgpt', 'composio']) {
    assert.match(serviceMark(name), /src="\/icons\//);
    assert.doesNotMatch(serviceMark(name), /https?:/);
  }
  assert.match(serviceMark('composio', true), /composio-white.svg/);
  assert.match(serviceMark('composio', false), /composio-black.svg/);
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
