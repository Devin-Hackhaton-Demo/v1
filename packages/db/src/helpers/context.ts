import type { DbClient } from '../client.ts';
import type { Enums, Tables } from '../types.ts';
import { sha256Hex, stableStringify } from './hash.ts';

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
 * Kontextusmentés: bejegyzés + döntések + nyitott feladatok. A projekt
 * revízióját a DB-trigger lépteti atomikusan a bejegyzés INSERT-jekor.
 *
 * Korlát (tudatos döntés, PROJECT_CONTEXT.md "v1 eltérések"): a három
 * lépés nem egyetlen DB-tranzakció — félbeszakadás esetén a bejegyzés
 * döntések/feladatok nélkül maradhat meg. A revíziószámozás ettől még
 * sérthetetlen; szigorúbb atomicitáshoz később save_context RPC jöhet.
 */
export async function saveContext(client: DbClient, input: SaveContextInput): Promise<SaveContextResult> {
  const contentHash = await sha256Hex(
    stableStringify({
      source: input.source,
      coverage: input.coverage,
      submitted_text: input.submittedText ?? null,
      summary: input.summary,
    }),
  );

  const { data: entry, error: entryError } = await client
    .from('context_entries')
    .insert({
      project_id: input.projectId,
      source_kind: input.source.kind,
      source_label: input.source.label,
      conversation_ref: input.source.conversationRef ?? null,
      occurred_at: input.source.occurredAt ?? null,
      coverage: input.coverage,
      submitted_text: input.submittedText ?? null,
      summary: input.summary,
      full_text_artifact_id: input.fullTextArtifactId ?? null,
      content_hash: contentHash,
    })
    .select()
    .single();
  if (entryError) throw entryError;

  let decisions: Tables<'decisions'>[] = [];
  if (input.decisions?.length) {
    const { data, error } = await client
      .from('decisions')
      .insert(
        input.decisions.map((d) => ({
          project_id: input.projectId,
          context_entry_id: entry.id,
          key: d.key,
          value: d.value,
          source_excerpt: d.sourceExcerpt ?? null,
          supersedes_decision_ids: d.supersedesDecisionIds ?? [],
        })),
      )
      .select();
    if (error) throw error;
    decisions = data;
  }

  let tasks: Tables<'tasks'>[] = [];
  if (input.tasks?.length) {
    const { data, error } = await client
      .from('tasks')
      .insert(
        input.tasks.map((t) => ({
          project_id: input.projectId,
          context_entry_id: entry.id,
          title: t.title,
          required_decision_keys: t.requiredDecisionKeys ?? [],
          input_artifact_ids: t.inputArtifactIds ?? [],
        })),
      )
      .select();
    if (error) throw error;
    tasks = data;
  }

  return { entry, decisions, tasks, contextRevision: entry.revision };
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
