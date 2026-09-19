import { canonicalHash } from '@demo/domain';
import type { DbClient } from '../client.ts';
import type { Tables } from '../types.ts';

export interface PrepareRunInput {
  projectId: string;
  taskId: string;
  /** A futáshoz rögzített kontextusrevízió (§5: a run revízióhoz kötött). */
  contextRevision: number;
  /** A snapshotba tartozó context entry ID-k. */
  contextEntryIds: string[];
  /** Egyszeri UTC időzítés; üresen azonnali (jóváhagyás utáni) futás. */
  runAt?: string;
  /** Optional ContextSnapshotV1 hash computed by the domain layer (§6). */
  snapshotHash?: string;
}

/**
 * run_prepare via the `prepare_run` RPC (SECURITY INVOKER — the existing RLS
 * insert policy still applies, so only the 'awaiting_approval' state is
 * possible from a client). The RPC additionally validates the pinned
 * revision, the selected entries, the run_at window and the decision gate
 * (DECISION_CONFLICT / CONTEXT_INCOMPLETE) in one transaction. All further
 * state transitions stay server-side (service role).
 *
 * payload_hash is the RFC 8785 (JCS) canonical hash from @demo/domain.
 */
export async function prepareRun(client: DbClient, input: PrepareRunInput): Promise<Tables<'runs'>> {
  // RFC 8785 hash over the v1 CLIENT payload only. The full RunInputV1 hash
  // (computeRunInputHash in @demo/domain) is the API-layer contract for the
  // future run_prepare snapshot; this helper deliberately hashes just the
  // fields the client submits. canonicalJson throws on undefined, so the
  // optional run_at is normalized to an explicit null.
  const payloadHash = await canonicalHash({
    task_id: input.taskId,
    context_revision: input.contextRevision,
    context_entry_ids: [...input.contextEntryIds].sort(),
    preset: 'draft_brief',
    run_at: input.runAt ?? null,
  });

  const { data, error } = await client.rpc('prepare_run', {
    p_project_id: input.projectId,
    p_task_id: input.taskId,
    p_context_revision: input.contextRevision,
    p_context_entry_ids: input.contextEntryIds,
    p_payload_hash: payloadHash,
    p_snapshot_hash: input.snapshotHash ?? null,
    p_run_at: input.runAt ?? null,
  });
  if (error) throw error;
  return data as unknown as Tables<'runs'>;
}

export async function getRun(client: DbClient, projectId: string, runId: string): Promise<Tables<'runs'> | null> {
  const { data, error } = await client
    .from('runs')
    .select('*')
    .eq('project_id', projectId)
    .eq('id', runId)
    .maybeSingle();
  if (error) throw error;
  return data;
}
