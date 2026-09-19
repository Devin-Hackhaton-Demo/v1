/**
 * E2E gate for the smallest working demo slice (PROJECT_CONTEXT.md section 10):
 * saved context → prepared + approved scheduled run → the REAL worker process
 * (apps/worker) activates it on DB time → a simulated runner claims it,
 * heartbeats, produces brief.md, validates it deterministically, uploads the
 * bytes and closes the run → evidence is re-read and byte-verified.
 * Run with: npm run test:e2e
 *
 * Gates (each one fails for the reason it was written):
 *   1. claim latency ≤ 15 s after run_at (section 10 acceptance target)
 *   2. heartbeat extends a live lease
 *   3. generated brief.md passes validateDraftBrief (title/bullets/marker)
 *   4. complete_run → succeeded; run row + task row reflect the closure
 *   5. downloaded artifact bytes are hash-identical to the uploaded bytes
 *   6. identical complete_run retry → identical receipt, exactly one artifact
 *   7. worker shuts down gracefully on SIGTERM (exit 0 within 10 s)
 *   8. worker stdout proves the WORKER activated the run (tick with queued ≥ 1)
 *      and leaks no service role key
 *
 * Shared-DB safety: claim_run is global by design, so a claim may return a
 * concurrent test's run. Such a foreign claim is logged as a WARN, never
 * closed (its lease lapses harmlessly and activate_due_runs requeues it),
 * and polling continues. Everything this test creates lives in a disposable
 * project and is removed in the finally block (storage objects + cascade).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  approveRun,
  ARTIFACTS_BUCKET,
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
  type DbClient,
  type Json,
  type Tables,
} from '../packages/db/src/index.ts';
import { validateDraftBrief } from '../packages/domain/src/index.ts';

const password = process.env.DEMO_USER_PASSWORD;
if (!password) throw new Error('DEMO_USER_PASSWORD missing from .env');
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY missing from .env');

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

/** Non-failing observation (shared-DB events outside this test's control). */
function warn(name: string): void {
  console.log(`  WARN  ${name}`);
}

function errMessage(e: unknown): string {
  return (e as { message?: string }).message ?? String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function signIn(email: string): Promise<DbClient> {
  const client = createAnonClient();
  const { error } = await client.auth.signInWithPassword({ email, password: password! });
  if (error) throw new Error(`Sign-in failed (${email}): ${error.message}`);
  return client;
}

const service = createServiceClient();
const owner = await signIn('owner@demo.test');

console.log('\nSetup: disposable project');
const project = await createProject(owner, `e2e-${Date.now()}`);
const storagePaths: string[] = [];
let worker: ChildProcess | null = null;
let workerStdout = '';
let workerStderr = '';

try {
  // --- 1–2. context: three draft_brief decisions + one task requiring them.
  const TITLE = 'E2E Demo Brief';
  const BULLET_COUNT = 3;
  const marker = `DEMO-${crypto.randomUUID().slice(0, 8)}`;
  const save = await saveContext(owner, {
    projectId: project.id,
    source: { kind: 'chatgpt', label: 'E2E setup chat' },
    coverage: 'summary_only',
    summary: 'E2E: brief decisions and the draft_brief task in one save.',
    decisions: [
      { key: 'brief.title', value: TITLE },
      { key: 'brief.bullet_count', value: BULLET_COUNT },
      { key: 'brief.required_marker', value: marker },
    ],
    tasks: [
      {
        title: 'E2E: produce brief.md',
        requiredDecisionKeys: ['brief.title', 'brief.bullet_count', 'brief.required_marker'],
      },
    ],
  });
  check('context saved: 3 decisions + 1 draft_brief task',
    save.decisions.length === 3 && save.tasks.length === 1);
  const task = save.tasks[0]!;

  // --- 3. prepare a run scheduled 5 seconds from now (ISO UTC).
  const runAt = new Date(Date.now() + 5_000).toISOString();
  const run = await prepareRun(owner, {
    projectId: project.id,
    taskId: task.id,
    contextRevision: save.contextRevision,
    contextEntryIds: [save.entry.id],
    runAt,
  });
  check('run prepared in awaiting_approval with run_at set',
    run.state === 'awaiting_approval' && run.run_at !== null,
    `state: ${run.state}`);

  // --- 4. owner approval bound to the payload hash (1h expiry by default).
  await approveRun(owner, {
    projectId: project.id,
    runId: run.id,
    payloadHash: run.payload_hash!,
    runAt: run.run_at ?? runAt,
  });

  // --- 5. spawn the REAL worker; IT must do the activation, not this test.
  worker = spawn('npx', ['tsx', '--env-file=.env', 'apps/worker/src/main.ts'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stdout!.on('data', (chunk: Buffer) => { workerStdout += chunk.toString(); });
  worker.stderr!.on('data', (chunk: Buffer) => { workerStderr += chunk.toString(); });

  // --- 6. simulated runner: poll claim_run every second until OUR run comes.
  const runAtMs = Date.parse(run.run_at ?? runAt);
  const pollDeadline = runAtMs + 30_000; // generous; the hard gate is 15 s below
  let claimed: ClaimedRun | null = null;
  let claimedAtMs = 0;
  while (Date.now() < pollDeadline) {
    const candidate = await claimRun(service, 'draft_brief');
    if (candidate !== null && candidate.run.project_id !== project.id) {
      // Shared live DB: this run belongs to a concurrent test. NEVER close it
      // (no complete/fail) — its 90 s lease lapses harmlessly and
      // activate_due_runs requeues it. Keep polling for our own run.
      warn(`claimed a foreign run ${candidate.run.id} — left untouched, lease will lapse`);
      continue;
    }
    if (candidate !== null) {
      claimedAtMs = Date.now();
      claimed = candidate;
      break;
    }
    await sleep(1_000);
  }
  check('our run was claimed by the simulated runner', claimed !== null,
    'no claim before the poll deadline');
  if (claimed === null) throw new Error('claim did not happen; skipping dependent gates');

  // --- 7a. section 10 acceptance target: claim within 15 s of due time.
  const latencyMs = claimedAtMs - runAtMs;
  console.log(`  INFO  measured claim latency: ${(latencyMs / 1000).toFixed(2)} s (run_at → claim)`);
  check('claim latency ≤ 15 s (section 10 acceptance target)', latencyMs <= 15_000,
    `${(latencyMs / 1000).toFixed(2)} s`);
  check('claim is attempt 1 in running state with a lease token',
    claimed.run.attempt === 1 && claimed.run.state === 'running' && claimed.lease_token.length > 0);

  // --- 7b. one heartbeat with the live lease.
  const beat = await heartbeatRun(service, run.id, claimed.run.attempt_id!, claimed.lease_token);
  check('heartbeat succeeds with lease_expires_at in the future',
    Date.parse(beat.lease_expires_at) > Date.now(), `lease_expires_at: ${beat.lease_expires_at}`);

  // --- 7c. produce brief.md and validate it with the domain validator.
  const briefMd = [
    `# ${TITLE}`,
    '',
    '- Context saved in one chat is used by the runner unchanged.',
    '- The approved, scheduled run was activated by the worker on DB time.',
    `- Verification marker for this run: ${marker}`,
    '',
  ].join('\n');
  const validation = validateDraftBrief(briefMd, {
    title: TITLE,
    bulletCount: BULLET_COUNT,
    marker,
  });
  check('generated brief.md passes validateDraftBrief', validation.ok,
    JSON.stringify(validation.checks.filter((c) => !c.ok)));

  // --- 7d. upload the bytes (service client) + sha256 (Web Crypto).
  // NOTE: the middle path segment is a placeholder for the artifact id — the
  // runner HTTP API will own the exact `project/artifact/file` convention
  // later; complete_run only records the metadata we report here.
  const briefBytes = new TextEncoder().encode(briefMd);
  const storagePath = `${project.id}/${crypto.randomUUID()}/brief.md`;
  const { error: uploadError } = await service.storage
    .from(ARTIFACTS_BUCKET)
    .upload(storagePath, briefBytes, { contentType: 'text/markdown' });
  check('artifact bytes uploaded to the artifacts bucket', uploadError === null,
    uploadError?.message);
  storagePaths.push(storagePath);
  const briefSha256 = await sha256Hex(briefBytes);

  // --- 7e. close the run; payload hash = the artifact sha256.
  const artifactMeta = {
    file_name: 'brief.md',
    mime_type: 'text/markdown',
    size_bytes: briefBytes.byteLength,
    sha256: briefSha256,
    storage_path: storagePath,
  };
  const completeInput = {
    runId: run.id,
    attemptId: claimed.run.attempt_id!,
    leaseToken: claimed.lease_token,
    resultKey: 'final',
    payloadHash: briefSha256,
    artifact: artifactMeta,
    checks: validation as unknown as Json,
  };
  const receipt = await completeRun(service, completeInput);
  check('complete_run returns state succeeded', receipt.state === 'succeeded',
    `state: ${receipt.state}`);

  // --- 7f. re-read the evidence: run closed, task done.
  const { data: runAfter, error: runReadError } = await service
    .from('runs').select('*').eq('id', run.id).single();
  if (runReadError) throw runReadError;
  check('run row: succeeded, result_artifact_id and finished_at set',
    runAfter.state === 'succeeded' && runAfter.result_artifact_id !== null
      && runAfter.finished_at !== null,
    `state: ${runAfter.state}`);
  const { data: taskAfter, error: taskReadError } = await service
    .from('tasks').select('*').eq('id', task.id).single();
  if (taskReadError) throw taskReadError;
  check('task status is done', taskAfter.status === 'done', `status: ${taskAfter.status}`);

  // --- 7g. byte-equality: download and recompute the hash.
  const { data: blob, error: downloadError } = await service.storage
    .from(ARTIFACTS_BUCKET)
    .download(storagePath);
  if (downloadError) throw downloadError;
  const downloaded = new Uint8Array(await blob.arrayBuffer());
  const downloadedSha256 = await sha256Hex(downloaded);
  check('downloaded artifact bytes are hash-identical to the upload',
    downloadedSha256 === briefSha256 && downloaded.byteLength === briefBytes.byteLength,
    `sha256: ${downloadedSha256}`);

  // --- 7h. idempotency spot-check: identical retry → identical receipt.
  const retryReceipt = await completeRun(service, completeInput);
  check('identical complete_run retry returns the identical receipt',
    JSON.stringify(retryReceipt) === JSON.stringify(receipt));
  check('retry receipt references the same artifact_id',
    retryReceipt.artifact_id !== undefined && retryReceipt.artifact_id === receipt.artifact_id);
  const { count: artifactCount, error: countError } = await service
    .from('artifacts')
    .select('*', { count: 'exact', head: true })
    .eq('run_id', run.id);
  if (countError) throw countError;
  check('still exactly one artifact row for the run', artifactCount === 1,
    `artifact rows: ${artifactCount}`);

  // --- 8. graceful shutdown gate + worker stdout assertions.
  const exitCode = await new Promise<number | null>((resolve) => {
    const timeout = setTimeout(() => resolve(null), 10_000);
    worker!.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
    worker!.kill('SIGTERM');
  });
  check('worker exits within 10 s of SIGTERM with code 0', exitCode === 0,
    `exit code: ${exitCode === null ? 'still running after 10 s' : exitCode}`);

  const workerEvents = workerStdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line): Record<string, unknown>[] => {
      try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    });
  check('worker logged an activation tick with queued ≥ 1 (the WORKER activated the run)',
    workerEvents.some((e) => e.event === 'tick' && typeof e.queued === 'number' && e.queued >= 1),
    `tick events seen: ${JSON.stringify(workerEvents.filter((e) => e.event === 'tick'))}`);
  check('worker logged startup and shutdown events',
    workerEvents.some((e) => e.event === 'startup') && workerEvents.some((e) => e.event === 'shutdown'));
  check('worker output contains no service role key',
    !workerStdout.includes(serviceRoleKey) && !workerStderr.includes(serviceRoleKey));
} catch (e) {
  check('E2E flow completed without unexpected error', false, errMessage(e));
} finally {
  console.log('\nCleanup (service role)…');
  // Kill the worker child if it is still alive (e.g. an early throw).
  if (worker !== null && worker.exitCode === null && worker.signalCode === null) {
    worker.kill('SIGKILL');
  }
  // Remove every storage object of the disposable project: the paths we
  // uploaded plus anything an artifacts row points at (defense in depth).
  const { data: artifactRows } = await service
    .from('artifacts')
    .select('storage_path')
    .eq('project_id', project.id);
  const allPaths = [...new Set([
    ...storagePaths,
    ...((artifactRows ?? []) as Pick<Tables<'artifacts'>, 'storage_path'>[]).map((r) => r.storage_path),
  ])];
  if (allPaths.length > 0) {
    await service.storage.from(ARTIFACTS_BUCKET).remove(allPaths);
  }
  const { error: cleanupError } = await service.from('projects').delete().eq('id', project.id);
  check('disposable project deleted (cascade)', cleanupError === null, cleanupError?.message);
}

console.log(`\nResult: ${passed} PASS, ${failed} FAIL`);
if (failed > 0) process.exit(1);
