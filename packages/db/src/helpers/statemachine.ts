import type { DbClient } from '../client.ts';
import type { Enums, Json, Tables } from '../types.ts';

/**
 * Thin typed wrappers around the service-role-only run state machine RPCs
 * (supabase/migrations/20260919131000_run_state_machine.sql). Every function
 * here MUST be called with the service client (`createServiceClient()`):
 * execute rights are revoked from authenticated/anon, so a client call
 * fails with a permission error by design.
 */

/** Transition counts returned by one activate_due_runs() worker tick. */
export interface ActivationSummary {
  scheduled: number;
  queued: number;
  blocked: number;
  lease_requeued: number;
  lease_failed: number;
}

/** Worker tick: activate due/approved runs, reap expired leases (§8). */
export async function activateDueRuns(client: DbClient): Promise<ActivationSummary> {
  const { data, error } = await client.rpc('activate_due_runs');
  if (error) throw error;
  return data as unknown as ActivationSummary;
}

export interface ClaimedRun {
  run: Tables<'runs'>;
  /** Plaintext lease token — returned exactly once; only its hash is stored. */
  lease_token: string;
}

/** Atomically claim the next queued run for a preset; null when none. */
export async function claimRun(
  client: DbClient,
  preset: Enums<'task_kind'> = 'draft_brief',
): Promise<ClaimedRun | null> {
  const { data, error } = await client.rpc('claim_run', { p_preset: preset });
  if (error) throw error;
  return (data as unknown as ClaimedRun | null) ?? null;
}

/** Extend a live lease; raises LEASE_EXPIRED for any stale attempt/token. */
export async function heartbeatRun(
  client: DbClient,
  runId: string,
  attemptId: string,
  leaseToken: string,
): Promise<{ lease_expires_at: string }> {
  const { data, error } = await client.rpc('heartbeat_run', {
    p_run_id: runId,
    p_attempt_id: attemptId,
    p_lease_token: leaseToken,
  });
  if (error) throw error;
  return data as unknown as { lease_expires_at: string };
}

/** Artifact metadata recorded at completion. The caller must upload the
 * artifact bytes to the private Storage bucket BEFORE calling completeRun. */
export interface CompleteRunArtifact {
  file_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_path: string;
}

/** Receipt response shared by complete_run and fail_run closures. */
export interface RunClosureReceipt {
  state: string;
  run_id: string;
  attempt_id: string;
  result_key: string;
  artifact_id?: string;
  checks?: Json;
  error_code?: string;
}

export interface CompleteRunInput {
  runId: string;
  attemptId: string;
  leaseToken: string;
  resultKey: string;
  /** Fingerprint of the reported closure payload (64 hex chars). */
  payloadHash: string;
  artifact: CompleteRunArtifact;
  checks: Json;
}

/**
 * Receipt-based idempotent successful closure (§8): an identical retry gets
 * the stored receipt verbatim (even after lease expiry); a different payload
 * for the same result_key raises IDEMPOTENCY_CONFLICT; a new closure
 * requires a live lease.
 */
export async function completeRun(client: DbClient, input: CompleteRunInput): Promise<RunClosureReceipt> {
  const { data, error } = await client.rpc('complete_run', {
    p_run_id: input.runId,
    p_attempt_id: input.attemptId,
    p_lease_token: input.leaseToken,
    p_result_key: input.resultKey,
    p_payload_hash: input.payloadHash,
    p_artifact: { ...input.artifact },
    p_checks: input.checks,
  });
  if (error) throw error;
  return data as unknown as RunClosureReceipt;
}

export interface FailRunInput {
  runId: string;
  attemptId: string;
  leaseToken: string;
  resultKey: string;
  errorCode: string;
  /** Must already be sanitized: no secrets, no raw provider errors (§6). */
  safeMessage: string;
  retryable?: boolean;
}

/**
 * Receipt-based idempotent failure closure (§8). Retryable failures with
 * attempts left and a still-valid approval requeue the run; otherwise the
 * run fails permanently and the task becomes blocked.
 */
export async function failRun(client: DbClient, input: FailRunInput): Promise<RunClosureReceipt> {
  const { data, error } = await client.rpc('fail_run', {
    p_run_id: input.runId,
    p_attempt_id: input.attemptId,
    p_lease_token: input.leaseToken,
    p_result_key: input.resultKey,
    p_error_code: input.errorCode,
    p_safe_message: input.safeMessage,
    p_retryable: input.retryable ?? false,
  });
  if (error) throw error;
  return data as unknown as RunClosureReceipt;
}
