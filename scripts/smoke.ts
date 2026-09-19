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
  getUserConnectionSecret,
  listUserConnections,
  prepareRun,
  revokeUserConnection,
  saveContext,
  storeUserConnection,
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

console.log('\n7. save_context / prepare_run RPC gates');

// Atomicity gate: one valid + one invalid decision (value = JSON object,
// which violates the decisions table CHECK) in a single save_context call.
// The old non-RPC path would have left an orphan entry and bumped the
// revision; the RPC must roll back the whole batch.
const { data: projBefore } = await owner
  .from('projects')
  .select('context_revision')
  .eq('id', project.id)
  .single();
const { count: entriesBefore } = await owner
  .from('context_entries')
  .select('*', { count: 'exact', head: true })
  .eq('project_id', project.id);

const { error: atomicError } = await owner.rpc('save_context', {
  p_project_id: project.id,
  p_source: { kind: 'chatgpt', label: 'Atomicity gate chat' },
  p_coverage: 'summary_only',
  p_summary: 'Batch with one valid and one invalid decision.',
  p_content_hash: 'a'.repeat(64),
  p_decisions: [
    { key: 'gate.valid', value: 'ok' },
    { key: 'gate.invalid', value: { nested: true } }, // object → violates CHECK
  ],
});
check('save_context: batch with invalid decision is rejected', atomicError !== null,
  atomicError ? undefined : 'the RPC succeeded!');

const { data: projAfter } = await owner
  .from('projects')
  .select('context_revision')
  .eq('id', project.id)
  .single();
check('save_context: context_revision unchanged after rollback',
  projAfter?.context_revision === projBefore?.context_revision,
  `before: ${projBefore?.context_revision}, after: ${projAfter?.context_revision}`);

const { count: entriesAfter } = await owner
  .from('context_entries')
  .select('*', { count: 'exact', head: true })
  .eq('project_id', project.id);
check('save_context: no orphan context entry after rollback',
  entriesAfter === entriesBefore,
  `before: ${entriesBefore}, after: ${entriesAfter}`);

// Decision-conflict gate: two conflicting non-superseded decisions for the
// same key across two entries; a task requiring that key must not get a run.
const conflictSave1 = await saveContext(owner, {
  projectId: project.id,
  source: { kind: 'chatgpt', label: 'Conflict gate chat A' },
  coverage: 'summary_only',
  summary: 'Decision gate.color = red.',
  decisions: [{ key: 'gate.color', value: 'red' }],
  tasks: [{ title: 'Conflict gate task', requiredDecisionKeys: ['gate.color'] }],
});
const conflictSave2 = await saveContext(owner, {
  projectId: project.id,
  source: { kind: 'chatgpt', label: 'Conflict gate chat B' },
  coverage: 'summary_only',
  summary: 'Decision gate.color = blue (not superseding).',
  decisions: [{ key: 'gate.color', value: 'blue' }],
});
const conflictTask = conflictSave1.tasks[0]!;

let conflictError: Error | null = null;
try {
  await prepareRun(owner, {
    projectId: project.id,
    taskId: conflictTask.id,
    contextRevision: conflictSave2.contextRevision,
    contextEntryIds: [conflictSave1.entry.id, conflictSave2.entry.id],
  });
} catch (e) {
  conflictError = e as Error;
}
check('prepare_run: DECISION_CONFLICT on conflicting non-superseded values',
  conflictError !== null && conflictError.message.includes('DECISION_CONFLICT'),
  conflictError ? conflictError.message : 'the RPC succeeded!');

const { count: conflictRuns } = await owner
  .from('runs')
  .select('*', { count: 'exact', head: true })
  .eq('task_id', conflictTask.id);
check('prepare_run: zero runs created for the conflicted task', conflictRuns === 0,
  `run count: ${conflictRuns}`);

// Foreign-project gate: member@demo.test is not a member of this disposable
// project → NOT_FOUND (no existence leak), and still zero runs for the task.
let foreignPrepareError: Error | null = null;
try {
  await prepareRun(member, {
    projectId: project.id,
    taskId: conflictTask.id,
    contextRevision: conflictSave1.contextRevision,
    contextEntryIds: [conflictSave1.entry.id],
  });
} catch (e) {
  foreignPrepareError = e as Error;
}
check('prepare_run: NOT_FOUND for a non-member caller',
  foreignPrepareError !== null && foreignPrepareError.message.includes('NOT_FOUND'),
  foreignPrepareError ? foreignPrepareError.message : 'the RPC succeeded!');

const { count: foreignRuns } = await owner
  .from('runs')
  .select('*', { count: 'exact', head: true })
  .eq('task_id', conflictTask.id);
check('prepare_run: still zero runs after the foreign attempt', foreignRuns === 0,
  `run count: ${foreignRuns}`);

console.log('\n8. user_connections + Vault gates');

// DUMMY secrets only — never a real credential. Everything created here is
// cleaned up at the end of this section (Vault rows via revoke, table rows
// via the service client).
const dummySecret = `dummy-secret-${Date.now()}`;
const connLabel = `smoke-${Date.now()}@example.test`;
const ownerId = (await owner.auth.getUser()).data.user?.id;
if (!ownerId) throw new Error('owner user id unavailable');

// Gate 8.1: store returns the row without any secret material or Vault ref.
const conn = await storeUserConnection(owner, {
  provider: 'google',
  secret: dummySecret,
  label: connLabel,
  scopes: ['email'],
  metadata: { smoke: true },
});
check('store: row has provider/label/scopes',
  conn.provider === 'google' && conn.label === connLabel
  && Array.isArray(conn.scopes) && conn.scopes.includes('email'));
check('store: response contains no secret material',
  !JSON.stringify(conn).includes(dummySecret));
check('store: response has no secret_ref key',
  !('secret_ref' in (conn as Record<string, unknown>)));

// Gate 8.2: user scoping — the member must not see the owner's connection.
const memberConns = await listUserConnections(member);
check('member list excludes the owner connection',
  memberConns.every((c) => c.id !== conn.id));

// Gate 8.3: authenticated callers cannot execute the secret readback RPC.
const { data: memberSecret, error: memberSecretError } = await member.rpc(
  'get_user_connection_secret',
  { p_connection_id: conn.id },
);
check('member secret readback: permission denied',
  memberSecretError !== null && memberSecret === null,
  memberSecretError ? undefined : 'the RPC succeeded!');

// Gate 8.4: the service role reads back exactly the stored secret.
const secretBack = await getUserConnectionSecret(service, conn.id);
check('service secret readback is byte-equal', secretBack === dummySecret);

// Gate 8.5: direct INSERT from an authenticated client → RLS error
// (no insert policy — writes must go through the SECURITY DEFINER RPCs).
const { error: directInsertError } = await owner.from('user_connections').insert({
  user_id: ownerId,
  provider: 'google',
  label: `direct-${connLabel}`,
});
check('authenticated direct insert: RLS error', directInsertError !== null,
  directInsertError ? undefined : 'the insert succeeded!');

// Gate 8.6: upsert — same provider+label with a NEW secret keeps the row id
// and rotates the Vault secret in place.
const dummySecret2 = `${dummySecret}-rotated`;
const connAgain = await storeUserConnection(owner, {
  provider: 'google',
  secret: dummySecret2,
  label: connLabel,
});
check('re-store with same provider+label: same row id', connAgain.id === conn.id,
  `first: ${conn.id}, second: ${connAgain.id}`);
const rotatedBack = await getUserConnectionSecret(service, conn.id);
check('service readback returns the NEW secret', rotatedBack === dummySecret2);

// Gate 8.7: revoke deletes the Vault row → revoked_at set, service readback
// now raises NOT_FOUND (in-script proof that the secret is gone/unreachable).
const revoked = await revokeUserConnection(owner, conn.id);
check('revoke: revoked_at set', revoked.revoked_at !== null);
const revokedAgain = await revokeUserConnection(owner, conn.id);
check('revoke is idempotent (row unchanged)',
  revokedAgain.revoked_at === revoked.revoked_at);
let revokedReadError: Error | null = null;
try {
  await getUserConnectionSecret(service, conn.id);
} catch (e) {
  revokedReadError = e as Error;
}
check('service readback after revoke: NOT_FOUND',
  revokedReadError !== null && revokedReadError.message.includes('NOT_FOUND'),
  revokedReadError ? revokedReadError.message : 'the readback succeeded!');

// Gate 8.8: cleanup — remove the rows this section created and verify.
const { error: connCleanupError } = await service
  .from('user_connections')
  .delete()
  .eq('user_id', ownerId)
  .eq('label', connLabel);
check('user_connections cleanup: delete succeeded', connCleanupError === null,
  connCleanupError?.message);
const { count: leftoverConns } = await service
  .from('user_connections')
  .select('*', { count: 'exact', head: true })
  .eq('user_id', ownerId)
  .eq('label', connLabel);
check('user_connections cleanup: zero leftover rows', leftoverConns === 0,
  `leftover: ${leftoverConns}`);

console.log('\nTakarítás (service role)…');
await service.storage.from('artifacts').remove([artifact.storage_path]);
const { error: cleanupError } = await service.from('projects').delete().eq('id', project.id);
check('smoke projekt törölve (cascade)', cleanupError === null, cleanupError?.message);

console.log(`\nEredmény: ${passed} PASS, ${failed} FAIL`);
if (failed > 0) process.exit(1);
