import type { DbClient } from '../client.ts';
import type { Tables } from '../types.ts';
import { sha256Hex, stableStringify } from './hash.ts';

export interface PrepareRunInput {
  projectId: string;
  taskId: string;
  /** A futáshoz rögzített kontextusrevízió (§5: a run revízióhoz kötött). */
  contextRevision: number;
  /** A snapshotba tartozó context entry ID-k. */
  contextEntryIds: string[];
  /** Egyszeri UTC időzítés; üresen azonnali (jóváhagyás utáni) futás. */
  runAt?: string;
}

/**
 * run_prepare: új futás 'awaiting_approval' állapotban. Az RLS csak ezt
 * az állapotot engedi kliensről; minden további állapotátmenet a
 * szerveroldali worker/API dolga (service role).
 */
export async function prepareRun(client: DbClient, input: PrepareRunInput): Promise<Tables<'runs'>> {
  const payloadHash = await sha256Hex(
    stableStringify({
      task_id: input.taskId,
      context_revision: input.contextRevision,
      context_entry_ids: [...input.contextEntryIds].sort(),
      preset: 'draft_brief',
      run_at: input.runAt ?? null,
    }),
  );

  const { data, error } = await client
    .from('runs')
    .insert({
      project_id: input.projectId,
      task_id: input.taskId,
      context_revision: input.contextRevision,
      context_entry_ids: input.contextEntryIds,
      payload_hash: payloadHash,
      run_at: input.runAt ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
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
