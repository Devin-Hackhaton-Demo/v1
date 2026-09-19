/**
 * Hashing contract for ContextSnapshotV1 / RunInputV1 (PROJECT_CONTEXT.md
 * section 6): both hashes are SHA-256 over RFC 8785 canonical JSON UTF-8
 * bytes, with every ID list sorted so caller ordering can never change the
 * hash that an owner approved.
 *
 * These types deliberately contain NO live state (task status, cursors,
 * view mode, response formatting): the snapshot is the immutable input a
 * run was approved against, and anything mutable in it would let the same
 * approval cover different payloads.
 */
import { canonicalHash } from './hash.ts';

/** One immutable context entry as captured at snapshot time. */
export type SnapshotEntry = {
  id: string;
  revision: number;
  source_kind: string;
  source_label: string;
  conversation_ref: string | null;
  occurred_at: string | null;
  coverage: string;
  submitted_text: string | null;
  summary: string;
  content_hash: string;
  full_text_artifact_id: string | null;
};

/** A resolved decision; `value` is typed (string | number | boolean) per the contract. */
export type SnapshotDecision = {
  id: string;
  context_entry_id: string;
  key: string;
  value: string | number | boolean;
  source_excerpt: string | null;
  supersedes_decision_ids: string[];
};

/** Original task definition — no live status, by design. */
export type SnapshotTask = {
  id: string;
  title: string;
  kind: string;
  required_decision_keys: string[];
  input_artifact_ids: string[];
};

/** File reference; the byte hash (sha256) is what counts for files. */
export type SnapshotArtifact = {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
};

export type ContextSnapshotV1 = {
  schema: 'ContextSnapshotV1';
  project_id: string;
  context_revision: number;
  entries: SnapshotEntry[];
  decisions: SnapshotDecision[];
  tasks: SnapshotTask[];
  artifacts: SnapshotArtifact[];
};

/** Section-8 execution limits, frozen into every RunInputV1. */
export type RunLimitsV1 = {
  lease_seconds: 90;
  heartbeat_seconds: 30;
  run_seconds: 180;
  max_attempts: 2;
};

export const RUN_LIMITS_V1: RunLimitsV1 = {
  lease_seconds: 90,
  heartbeat_seconds: 30,
  run_seconds: 180,
  max_attempts: 2,
};

export type RunInputV1 = {
  schema: 'RunInputV1';
  task_id: string;
  task: SnapshotTask;
  context_revision: number;
  snapshot_hash: string;
  input_artifacts: { id: string; sha256: string }[];
  preset: 'draft_brief';
  preset_version: 'v1';
  validator_version: 'v1';
  limits: RunLimitsV1;
  run_at: string | null;
};

/** UTF-16 code-unit string compare — same order canonicalJson uses for keys. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sortIds = (ids: readonly string[]): string[] => [...ids].sort(byCodeUnit);

function sortById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => byCodeUnit(a.id, b.id));
}

/**
 * Normalizers rebuild every object field-by-field instead of spreading.
 * Why: a stray runtime property (live status, cursor, UI state) smuggled
 * onto a caller's object must not leak into the approved hash — only the
 * contract fields above can ever be hashed.
 */
function normalizeTask(t: SnapshotTask): SnapshotTask {
  return {
    id: t.id,
    title: t.title,
    kind: t.kind,
    required_decision_keys: sortIds(t.required_decision_keys),
    input_artifact_ids: sortIds(t.input_artifact_ids),
  };
}

function normalizeSnapshot(s: ContextSnapshotV1): ContextSnapshotV1 {
  return {
    schema: 'ContextSnapshotV1',
    project_id: s.project_id,
    context_revision: s.context_revision,
    entries: sortById(s.entries).map((e) => ({
      id: e.id,
      revision: e.revision,
      source_kind: e.source_kind,
      source_label: e.source_label,
      conversation_ref: e.conversation_ref,
      occurred_at: e.occurred_at,
      coverage: e.coverage,
      submitted_text: e.submitted_text,
      summary: e.summary,
      content_hash: e.content_hash,
      full_text_artifact_id: e.full_text_artifact_id,
    })),
    decisions: sortById(s.decisions).map((d) => ({
      id: d.id,
      context_entry_id: d.context_entry_id,
      key: d.key,
      value: d.value,
      source_excerpt: d.source_excerpt,
      supersedes_decision_ids: sortIds(d.supersedes_decision_ids),
    })),
    tasks: sortById(s.tasks).map(normalizeTask),
    artifacts: sortById(s.artifacts).map((a) => ({
      id: a.id,
      file_name: a.file_name,
      mime_type: a.mime_type,
      size_bytes: a.size_bytes,
      sha256: a.sha256,
    })),
  };
}

/** Order-independent SHA-256 of the snapshot (`context_get.snapshot_hash`). */
export async function computeSnapshotHash(snapshot: ContextSnapshotV1): Promise<string> {
  return canonicalHash(normalizeSnapshot(snapshot));
}

/** Order-independent SHA-256 of the run input (the approved `payload_hash`). */
export async function computeRunInputHash(runInput: RunInputV1): Promise<string> {
  const normalized: RunInputV1 = {
    schema: 'RunInputV1',
    task_id: runInput.task_id,
    task: normalizeTask(runInput.task),
    context_revision: runInput.context_revision,
    snapshot_hash: runInput.snapshot_hash,
    input_artifacts: sortById(runInput.input_artifacts).map((a) => ({ id: a.id, sha256: a.sha256 })),
    preset: 'draft_brief',
    preset_version: 'v1',
    validator_version: 'v1',
    limits: {
      lease_seconds: runInput.limits.lease_seconds,
      heartbeat_seconds: runInput.limits.heartbeat_seconds,
      run_seconds: runInput.limits.run_seconds,
      max_attempts: runInput.limits.max_attempts,
    },
    run_at: runInput.run_at,
  };
  return canonicalHash(normalized);
}
