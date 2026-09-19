/**
 * Élő smoke teszt a felállított séma + RLS + connector réteg ellen.
 * Eldobható projektben dolgozik, a végén service klienssel takarít.
 * Futtatás: npm run smoke
 *
 * Kapuk (mindegyik arra bukik el, amiért íródott):
 *   1. revízió-trigger: mentésenként pontosan +1
 *   2. RLS: idegen projekt nem olvasható és nem írható
 *   3. immutabilitás: context_entries nem módosítható
 *   4. runs: kliensről csak awaiting_approval szúrható be
 *   5. artifact: Storage feltöltés + SHA-256 bájtazonosság; idegen letöltés tiltva
 *   6. approval: member nem hagyhat jóvá, owner igen
 */
import {
  approveRun,
  createAnonClient,
  createProject,
  createServiceClient,
  downloadArtifact,
  getContext,
  getProject,
  prepareRun,
  saveContext,
  uploadArtifact,
  type DbClient,
} from '../packages/db/src/index.ts';

const password = process.env.DEMO_USER_PASSWORD;
if (!password) throw new Error('DEMO_USER_PASSWORD hiányzik az .env-ből');

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function signIn(email: string): Promise<DbClient> {
  const client = createAnonClient();
  const { error } = await client.auth.signInWithPassword({ email, password: password! });
  if (error) throw new Error(`Bejelentkezés sikertelen (${email}): ${error.message}`);
  return client;
}

const service = createServiceClient();
const owner = await signIn('owner@demo.test');
const member = await signIn('member@demo.test');

console.log('\n1. Projekt + revízió-trigger');
const project = await createProject(owner, `smoke-${Date.now()}`);
check('projekt létrejött, revízió = 0', project.context_revision === 0);

const save1 = await saveContext(owner, {
  projectId: project.id,
  source: { kind: 'chatgpt', label: 'Smoke chat A' },
  coverage: 'partial_text',
  submittedText: 'A brief címe pontosan Smoke Teszt legyen.',
  summary: 'Cím-döntés rögzítve.',
  decisions: [{ key: 'brief.title', value: 'Smoke Teszt' }],
  tasks: [{ title: 'Smoke brief készítése', requiredDecisionKeys: ['brief.title'] }],
});
check('1. mentés revíziója = 1', save1.contextRevision === 1, `kapott: ${save1.contextRevision}`);

const save2 = await saveContext(owner, {
  projectId: project.id,
  source: { kind: 'chatgpt', label: 'Smoke chat B' },
  coverage: 'summary_only',
  summary: 'Második mentés másik chatből.',
  decisions: [{ key: 'brief.bullet_count', value: 3 }],
});
check('2. mentés revíziója = 2', save2.contextRevision === 2, `kapott: ${save2.contextRevision}`);

const reloaded = await getProject(owner, project.id);
check('projects.context_revision = 2', reloaded?.context_revision === 2);

const view = await getContext(owner, project.id);
check('kontextusnézet: 2 bejegyzés, 2 döntés, 1 nyitott task',
  view.entries.length === 2 && view.decisions.length === 2 && view.openTasks.length === 1);
check('nincs döntéskonfliktus', view.unresolvedDecisionKeys.length === 0);

console.log('\n2. RLS — idegen projekt (member nem tagja a smoke projektnek)');
const { data: foreignRead } = await member.from('projects').select('*').eq('id', project.id);
check('idegen projekt olvasása: 0 sor', (foreignRead ?? []).length === 0);

const { error: foreignWrite } = await member.from('context_entries').insert({
  project_id: project.id,
  source_kind: 'manual_import',
  source_label: 'betörési kísérlet',
  coverage: 'summary_only',
  summary: 'nem szabadna sikerülnie',
  content_hash: '0'.repeat(64),
});
check('idegen projektbe írás: RLS-hiba', foreignWrite !== null, foreignWrite ? undefined : 'az insert átment!');

console.log('\n3. Immutabilitás');
const { data: updData, error: updError } = await owner
  .from('context_entries')
  .update({ summary: 'átírt összefoglaló' } as never)
  .eq('id', save1.entry.id)
  .select();
check('context_entry UPDATE nem érvényesül', updError !== null || (updData ?? []).length === 0);
const { data: entryAfter } = await owner.from('context_entries').select('summary').eq('id', save1.entry.id).single();
check('összefoglaló változatlan', entryAfter?.summary === 'Cím-döntés rögzítve.');

const { data: svcUpd, error: svcUpdError } = await service
  .from('context_entries')
  .update({ summary: 'service felülírás' } as never)
  .eq('id', save1.entry.id)
  .select();
check('trigger a service role-t is tiltja', svcUpdError !== null || (svcUpd ?? []).length === 0);

console.log('\n4. Runs — csak awaiting_approval szúrható be kliensről');
const task = save1.tasks[0]!;
const run = await prepareRun(owner, {
  projectId: project.id,
  taskId: task.id,
  contextRevision: save2.contextRevision,
  contextEntryIds: [save1.entry.id, save2.entry.id],
});
check('run_prepare: awaiting_approval', run.state === 'awaiting_approval');

const { error: queuedError } = await owner.from('runs').insert({
  project_id: project.id,
  task_id: task.id,
  context_revision: save2.contextRevision,
  state: 'queued',
});
check('közvetlen queued insert: tiltva', queuedError !== null, queuedError ? undefined : 'az insert átment!');

console.log('\n5. Artifact — Storage + SHA-256');
const artifact = await uploadArtifact(owner, {
  projectId: project.id,
  fileName: 'brief.md',
  mimeType: 'text/markdown',
  content: '# Smoke Teszt\n\n- egy\n- kettő\n- három\n',
});
const downloaded = await downloadArtifact(owner, project.id, artifact.id);
check('letöltött bájtok hash-e egyezik', downloaded.meta.sha256 === artifact.sha256);
check('méret egyezik', downloaded.bytes.byteLength === artifact.size_bytes);

const { data: foreignBlob, error: foreignDl } = await member.storage.from('artifacts').download(artifact.storage_path);
check('idegen storage-letöltés tiltva', foreignDl !== null && foreignBlob === null);

console.log('\n6. Approval — csak owner');
const { error: memberApprove } = await member.from('approvals').insert({
  project_id: project.id,
  subject: 'run',
  run_id: run.id,
  payload_hash: run.payload_hash!,
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
});
check('member jóváhagyása: tiltva', memberApprove !== null, memberApprove ? undefined : 'az insert átment!');

const approval = await approveRun(owner, {
  projectId: project.id,
  runId: run.id,
  payloadHash: run.payload_hash!,
});
check('owner jóváhagyása: sikerült', approval.id.length > 0);

console.log('\nTakarítás (service role)…');
await service.storage.from('artifacts').remove([artifact.storage_path]);
const { error: cleanupError } = await service.from('projects').delete().eq('id', project.id);
check('smoke projekt törölve (cascade)', cleanupError === null, cleanupError?.message);

console.log(`\nEredmény: ${passed} PASS, ${failed} FAIL`);
if (failed > 0) process.exit(1);
