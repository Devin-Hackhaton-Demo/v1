/**
 * Live gate tests for the run state machine
 * (supabase/migrations/20260919131000_run_state_machine.sql).
 * Runs inside a disposable project; the owner client does the setup via
 * saveContext/prepareRun/approveRun, the service client drives the state
 * machine RPCs. Full cleanup at the end; exit code 1 on any failure.
 * Run with: npm run test:statemachine
 *
 * Gates (each one fails for the reason it was written):
 *   1. parallel claim      — two concurrent claim_run calls, exactly one wins
 *   2. double complete     — identical retry returns the identical receipt,
 *                            one artifact row, no second state transition
 *   3. conflicting complete— same result_key, different payload → conflict
 *   4. stale attempt       — after lease expiry + reclaim, the OLD attempt
 *                            cannot close the run; the NEW attempt can
 *   5. attempt cap         — second expired lease → run failed, task blocked
 *   6. expired approval    — activate_due_runs blocks the run
 *
 * Shared-DB safety: claim_run is global by design (the worker claims across
 * projects), so before every claim we verify that no foreign queued runs
 * exist and we abort rather than touch another agent's data.
 */
import {
  activateDueRuns,
  approveRun,
  claimRun,
  completeRun,
  createAnonClient,
  createProject,
  createServiceClient,
  heartbeatRun,
  prepareRun,
  saveContext,
  sha256Hex,
  type ClaimedRun,
  type CompleteRunArtifact,
  type DbClient,
  type Tables,
} from '../packages/db/src/index.ts';

const password = process.env.DEMO_USER_PASSWORD;
if (!password) throw new Error('DEMO_USER_PASSWORD missing from .env');

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

function errMessage(e: unknown): string {
  return (e as { message?: string }).message ?? String(e);
}

async function signIn(email: string): Promise<DbClient> {
  const client = createAnonClient();
  const { error } = await client.auth.signInWithPassword({ email, password: password! });
  if (error) throw new Error(`Sign-in failed (${email}): ${error.message}`);
  return client;
}

const service = createServiceClient();
const owner = await signIn('owner@demo.test');

async function getRunRow(runId: string): Promise<Tables<'runs'>> {
  const { data, error } = await service.from('runs').select('*').eq('id', runId).single();
  if (error) throw error;
  return data;
}

async function getTaskRow(taskId: string): Promise<Tables<'tasks'>> {
  const { data, error } = await service.from('tasks').select('*').eq('id', taskId).single();
  if (error) throw error;
  return data;
}

console.log('\nSetup: disposable project + approved run');
const project = await createProject(owner, `sm-${Date.now()}`);
const storagePaths: string[] = [];

/** Abort-safe claim guard: never touch other agents' queued runs. */
async function assertNoForeignQueued(): Promise<void> {
  const { data, error } = await service
    .from('runs')
    .select('id, project_id')
    .eq('state', 'queued')
    .neq('project_id', project.id);
  if (error) throw error;
  if ((data ?? []).length > 0) {
    throw new Error(
      `ABORT: ${data!.length} foreign queued run(s) exist on the shared DB; ` +
      'refusing to run claim gates (they would steal another agent\'s work).',
    );
  }
}

/** Verify a claim result belongs to our project; best-effort restore + abort otherwise. */
async function assertOurs(claimed: ClaimedRun | null): Promise<void> {
  if (claimed && claimed.run.project_id !== project.id) {
    await service
      .from('runs')
      .update({
        state: 'queued',
        attempt: claimed.run.attempt - 1,
        attempt_id: null,
        lease_token_hash: null,
        lease_expires_at: null,
        runner_last_seen_at: null,
      })
      .eq('id', claimed.run.id);
    throw new Error(`ABORT: claimed a foreign run ${claimed.run.id}; restored it to queued and stopped.`);
  }
}

async function makeApprovedRun(
  title: string,
  opts?: { approvalExpiresAt?: string },
): Promise<{ task: Tables<'tasks'>; run: Tables<'runs'> }> {
  const save = await saveContext(owner, {
    projectId: project.id,
    source: { kind: 'chatgpt', label: `Setup chat for ${title}` },
    coverage: 'summary_only',
    summary: `Setup entry for ${title}.`,
    tasks: [{ title }],
  });
  const task = save.tasks[0]!;
  const run = await prepareRun(owner, {
    projectId: project.id,
    taskId: task.id,
    contextRevision: save.contextRevision,
    contextEntryIds: [save.entry.id],
  });
  await approveRun(owner, {
    projectId: project.id,
    runId: run.id,
    payloadHash: run.payload_hash!,
    expiresAt: opts?.approvalExpiresAt,
  });
  return { task, run };
}

/** Upload artifact bytes to Storage first (as the service caller must), then
 * return the metadata complete_run records. */
async function makeArtifact(content: string, fileName: string): Promise<CompleteRunArtifact> {
  const bytes = new TextEncoder().encode(content);
  const path = `${project.id}/${crypto.randomUUID()}/${fileName}`;
  const { error } = await service.storage
    .from('artifacts')
    .upload(path, bytes, { contentType: 'text/markdown' });
  if (error) throw error;
  storagePaths.push(path);
  return {
    file_name: fileName,
    mime_type: 'text/markdown',
    size_bytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    storage_path: path,
  };
}

async function expireLease(runId: string): Promise<void> {
  const { error } = await service
    .from('runs')
    .update({ lease_expires_at: new Date(Date.now() - 1000).toISOString() })
    .eq('id', runId);
  if (error) throw error;
}

try {
  const { task: task1, run: run1 } = await makeApprovedRun('State machine task 1');
  await activateDueRuns(service);
  const run1Activated = await getRunRow(run1.id);
  check('setup: approved immediate run is queued after activate_due_runs',
    run1Activated.state === 'queued', `state: ${run1Activated.state}`);

  console.log('\nGate 1: parallel claim — exactly one winner');
  await assertNoForeignQueued();
  const [claimA, claimB] = await Promise.all([claimRun(service), claimRun(service)]);
  await assertOurs(claimA);
  await assertOurs(claimB);
  const winners = [claimA, claimB].filter((c): c is ClaimedRun => c !== null);
  check('exactly one of two concurrent claims wins', winners.length === 1,
    `winners: ${winners.length}`);
  const claim1 = winners[0]!;
  check('the winner claimed our run with attempt 1 and a lease token',
    claim1.run.id === run1.id && claim1.run.attempt === 1
      && claim1.run.state === 'running' && claim1.lease_token.length > 0);
  const task1Running = await getTaskRow(task1.id);
  check('task is running with latest_run_id set',
    task1Running.status === 'running' && task1Running.latest_run_id === run1.id);
  const beat = await heartbeatRun(service, run1.id, claim1.run.attempt_id!, claim1.lease_token);
  check('heartbeat with the live lease extends lease_expires_at',
    new Date(beat.lease_expires_at).getTime() > Date.now());

  console.log('\nGate 2: double complete — identical receipt, no second transition');
  const artifact1 = await makeArtifact('# Brief\n\n- one\n- two\n- three\n', 'brief.md');
  const closureHash = artifact1.sha256; // fingerprint of the reported closure
  const checks = { title_ok: true, bullet_count: 3, marker_ok: true };
  const receiptA = await completeRun(service, {
    runId: run1.id,
    attemptId: claim1.run.attempt_id!,
    leaseToken: claim1.lease_token,
    resultKey: 'final',
    payloadHash: closureHash,
    artifact: artifact1,
    checks,
  });
  const runAfterFirst = await getRunRow(run1.id);
  const receiptB = await completeRun(service, {
    runId: run1.id,
    attemptId: claim1.run.attempt_id!,
    leaseToken: claim1.lease_token,
    resultKey: 'final',
    payloadHash: closureHash,
    artifact: artifact1,
    checks,
  });
  const runAfterSecond = await getRunRow(run1.id);
  check('identical retry returns the identical receipt',
    JSON.stringify(receiptA) === JSON.stringify(receiptB));
  const { count: artifactCount } = await service
    .from('artifacts')
    .select('*', { count: 'exact', head: true })
    .eq('run_id', run1.id);
  check('exactly one artifact row for the run', artifactCount === 1,
    `artifact rows: ${artifactCount}`);
  check('run stayed succeeded with finished_at unchanged',
    runAfterFirst.state === 'succeeded' && runAfterSecond.state === 'succeeded'
      && runAfterFirst.finished_at !== null
      && runAfterFirst.finished_at === runAfterSecond.finished_at,
    `finished_at: ${runAfterFirst.finished_at} vs ${runAfterSecond.finished_at}`);
  const task1Done = await getTaskRow(task1.id);
  check('task is done after completion', task1Done.status === 'done');

  console.log('\nGate 3: conflicting complete — same result_key, different payload');
  let conflictErr: unknown = null;
  try {
    await completeRun(service, {
      runId: run1.id,
      attemptId: claim1.run.attempt_id!,
      leaseToken: claim1.lease_token,
      resultKey: 'final',
      payloadHash: 'b'.repeat(64),
      artifact: artifact1,
      checks,
    });
  } catch (e) {
    conflictErr = e;
  }
  check('different payload for the same result_key raises IDEMPOTENCY_CONFLICT',
    conflictErr !== null && errMessage(conflictErr).includes('IDEMPOTENCY_CONFLICT'),
    conflictErr ? errMessage(conflictErr) : 'the call succeeded!');

  console.log('\nGate 4: stale attempt exclusion after lease expiry + reclaim');
  const { run: run2 } = await makeApprovedRun('State machine task 2');
  await activateDueRuns(service);
  await assertNoForeignQueued();
  const claim2old = await claimRun(service);
  await assertOurs(claim2old);
  check('attempt 1 claimed', claim2old !== null && claim2old.run.id === run2.id
    && claim2old.run.attempt === 1);
  const oldAttemptId = claim2old!.run.attempt_id!;
  const oldToken = claim2old!.lease_token;

  await expireLease(run2.id);
  await activateDueRuns(service);
  const run2Requeued = await getRunRow(run2.id);
  check('expired lease with attempts left requeues the run (attempt kept)',
    run2Requeued.state === 'queued' && run2Requeued.attempt === 1,
    `state: ${run2Requeued.state}, attempt: ${run2Requeued.attempt}`);

  await assertNoForeignQueued();
  const claim2new = await claimRun(service);
  await assertOurs(claim2new);
  check('reclaim produced attempt 2 with a fresh attempt_id',
    claim2new !== null && claim2new.run.id === run2.id && claim2new.run.attempt === 2
      && claim2new.run.attempt_id !== oldAttemptId);

  const staleArtifact = await makeArtifact('# Stale attempt output\n', 'brief.md');
  let staleErr: unknown = null;
  try {
    await completeRun(service, {
      runId: run2.id,
      attemptId: oldAttemptId,
      leaseToken: oldToken,
      resultKey: 'final-old', // not receipted → must hit the live-lease check
      payloadHash: staleArtifact.sha256,
      artifact: staleArtifact,
      checks: {},
    });
  } catch (e) {
    staleErr = e;
  }
  check('the OLD attempt cannot close the run (LEASE_EXPIRED)',
    staleErr !== null && errMessage(staleErr).includes('LEASE_EXPIRED'),
    staleErr ? errMessage(staleErr) : 'the call succeeded!');
  const run2AfterStale = await getRunRow(run2.id);
  check('no state change from the stale attempt',
    run2AfterStale.state === 'running' && run2AfterStale.attempt === 2
      && run2AfterStale.result_artifact_id === null,
    `state: ${run2AfterStale.state}`);

  const artifact2 = await makeArtifact('# Brief v2\n\n- one\n- two\n- three\n', 'brief.md');
  const receipt2 = await completeRun(service, {
    runId: run2.id,
    attemptId: claim2new!.run.attempt_id!,
    leaseToken: claim2new!.lease_token,
    resultKey: 'final',
    payloadHash: artifact2.sha256,
    artifact: artifact2,
    checks: { title_ok: true },
  });
  check('the NEW attempt closes the run successfully', receipt2.state === 'succeeded');

  console.log('\nGate 5: attempt cap — second expired lease fails the run');
  const { task: task3, run: run3 } = await makeApprovedRun('State machine task 3');
  await activateDueRuns(service);
  await assertNoForeignQueued();
  const claim3a = await claimRun(service);
  await assertOurs(claim3a);
  check('attempt 1 claimed', claim3a !== null && claim3a.run.id === run3.id
    && claim3a.run.attempt === 1);
  await expireLease(run3.id);
  await activateDueRuns(service);
  await assertNoForeignQueued();
  const claim3b = await claimRun(service);
  await assertOurs(claim3b);
  check('attempt 2 claimed after requeue', claim3b !== null && claim3b.run.id === run3.id
    && claim3b.run.attempt === 2);
  await expireLease(run3.id);
  await activateDueRuns(service);
  const run3Final = await getRunRow(run3.id);
  check('run failed with LEASE_EXPIRED after the attempt cap',
    run3Final.state === 'failed' && run3Final.error_code === 'LEASE_EXPIRED'
      && run3Final.finished_at !== null,
    `state: ${run3Final.state}, error_code: ${run3Final.error_code}`);
  const task3Final = await getTaskRow(task3.id);
  check('task is blocked after the final failure', task3Final.status === 'blocked',
    `status: ${task3Final.status}`);

  console.log('\nGate 6: expired approval blocks the run');
  const { run: run4 } = await makeApprovedRun('State machine task 4', {
    approvalExpiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  await activateDueRuns(service);
  const run4Final = await getRunRow(run4.id);
  check('run with only an expired approval becomes blocked (APPROVAL_EXPIRED)',
    run4Final.state === 'blocked' && run4Final.error_code === 'APPROVAL_EXPIRED',
    `state: ${run4Final.state}, error_code: ${run4Final.error_code}`);
} finally {
  console.log('\nCleanup (service role)…');
  if (storagePaths.length > 0) {
    await service.storage.from('artifacts').remove(storagePaths);
  }
  const { error: cleanupError } = await service.from('projects').delete().eq('id', project.id);
  check('disposable project deleted (cascade)', cleanupError === null, cleanupError?.message);
}

console.log(`\nResult: ${passed} PASS, ${failed} FAIL`);
if (failed > 0) process.exit(1);
