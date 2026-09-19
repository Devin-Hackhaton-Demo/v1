import { canonicalHash } from '@demo/domain';
import type { DbClient } from '../client.ts';
import type { Enums, Tables } from '../types.ts';
import { stableStringify } from './hash.ts';

export interface DecisionInput {
  key: string;
  value: string | number | boolean;
  sourceExcerpt?: string;
  supersedesDecisionIds?: string[];
}

export interface TaskInput {
  title: string;
  requiredDecisionKeys?: string[];
  inputArtifactIds?: string[];
}

export interface SaveContextInput {
  projectId: string;
  source: {
    kind: Enums<'source_kind'>;
    label: string;
    conversationRef?: string;
    occurredAt?: string;
  };
  coverage: Enums<'coverage_kind'>;
  submittedText?: string;
  summary: string;
  /** Csak coverage='supplied_export' esetén; a DB constraint is őrzi. */
  fullTextArtifactId?: string;
  decisions?: DecisionInput[];
  tasks?: TaskInput[];
}

export interface SaveContextResult {
  entry: Tables<'context_entries'>;
  decisions: Tables<'decisions'>[];
  tasks: Tables<'tasks'>[];
  contextRevision: number;
}

/**
 * Context save: entry + decisions + open tasks via the `save_context` RPC
 * (SECURITY INVOKER — RLS keeps enforcing every row rule inside). The whole
 * batch runs in ONE database transaction: if any decision or task insert
 * fails, the entry insert and the project revision bump roll back with it,
 * so no orphan entry can remain. The revision trigger still assigns
 * entry.revision atomically.
 *
 * content_hash is the RFC 8785 (JCS) canonical hash from @demo/domain.
 */
export async function saveContext(client: DbClient, input: SaveContextInput): Promise<SaveContextResult> {
  // Canonical content-hash shape v1: RFC 8785 over exactly these fields
  // ({source, coverage, submitted_text, summary}). canonicalJson THROWS on
  // undefined (it never silently drops fields the way stableStringify did),
  // so every optional field is normalized to an explicit null and the
  // source sub-object is rebuilt field-by-field.
  const contentHash = await canonicalHash({
    source: {
      kind: input.source.kind,
      label: input.source.label,
      conversation_ref: input.source.conversationRef ?? null,
      occurred_at: input.source.occurredAt ?? null,
    },
    coverage: input.coverage,
    submitted_text: input.submittedText ?? null,
    summary: input.summary,
  });

  const { data, error } = await client.rpc('save_context', {
    p_project_id: input.projectId,
    p_source: {
      kind: input.source.kind,
      label: input.source.label,
      conversation_ref: input.source.conversationRef ?? null,
      occurred_at: input.source.occurredAt ?? null,
    },
    p_coverage: input.coverage,
    p_summary: input.summary,
    p_content_hash: contentHash,
    p_submitted_text: input.submittedText ?? null,
    p_full_text_artifact_id: input.fullTextArtifactId ?? null,
    p_decisions: (input.decisions ?? []).map((d) => ({
      key: d.key,
      value: d.value,
      source_excerpt: d.sourceExcerpt ?? null,
      supersedes_decision_ids: d.supersedesDecisionIds ?? [],
    })),
    p_tasks: (input.tasks ?? []).map((t) => ({
      title: t.title,
      required_decision_keys: t.requiredDecisionKeys ?? [],
      input_artifact_ids: t.inputArtifactIds ?? [],
    })),
  });
  if (error) throw error;

  const result = data as unknown as {
    entry: Tables<'context_entries'>;
    decisions: Tables<'decisions'>[];
    tasks: Tables<'tasks'>[];
    context_revision: number;
  };
  return {
    entry: result.entry,
    decisions: result.decisions,
    tasks: result.tasks,
    contextRevision: result.context_revision,
  };
}

export interface ContextView {
  entries: Tables<'context_entries'>[];
  decisions: Tables<'decisions'>[];
  openTasks: Tables<'tasks'>[];
  /** Kulcsok, amelyekhez több, nem felülírt eltérő érték tartozik (§5 konfliktus). */
  unresolvedDecisionKeys: string[];
}

/** Projektkontextus olvasása; adott revízióra szűkíthető. */
export async function getContext(
  client: DbClient,
  projectId: string,
  revision?: number,
): Promise<ContextView> {
  let entryQuery = client
    .from('context_entries')
    .select('*')
    .eq('project_id', projectId)
    .order('revision', { ascending: true });
  if (revision !== undefined) entryQuery = entryQuery.eq('revision', revision);
  const { data: entries, error: entriesError } = await entryQuery;
  if (entriesError) throw entriesError;

  const entryIds = entries.map((e) => e.id);
  let decisions: Tables<'decisions'>[] = [];
  if (entryIds.length) {
    const { data, error } = await client
      .from('decisions')
      .select('*')
      .eq('project_id', projectId)
      .in('context_entry_id', entryIds)
      .order('created_at', { ascending: true });
    if (error) throw error;
    decisions = data;
  }

  const { data: openTasks, error: tasksError } = await client
    .from('tasks')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'open');
  if (tasksError) throw tasksError;

  const superseded = new Set(decisions.flatMap((d) => d.supersedes_decision_ids));
  const activeByKey = new Map<string, Set<string>>();
  for (const d of decisions) {
    if (superseded.has(d.id)) continue;
    const values = activeByKey.get(d.key) ?? new Set<string>();
    values.add(stableStringify(d.value));
    activeByKey.set(d.key, values);
  }
  const unresolvedDecisionKeys = [...activeByKey.entries()]
    .filter(([, values]) => values.size > 1)
    .map(([key]) => key)
    .sort();

  return { entries, decisions, openTasks, unresolvedDecisionKeys };
}
