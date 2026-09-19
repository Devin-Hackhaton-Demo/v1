import { describe, expect, it } from 'vitest';
import {
  canonicalHash,
  computeRunInputHash,
  computeSnapshotHash,
  RUN_LIMITS_V1,
  sha256Hex,
  type ContextSnapshotV1,
  type RunInputV1,
  type SnapshotArtifact,
  type SnapshotDecision,
  type SnapshotEntry,
  type SnapshotTask,
} from '../src/index.ts';

const entryA: SnapshotEntry = {
  id: 'ctx-aaa',
  revision: 1,
  source_kind: 'chatgpt',
  source_label: 'Chat A',
  conversation_ref: 'https://chat.example/a',
  occurred_at: '2026-09-19T10:00:00Z',
  coverage: 'partial_text',
  submitted_text: 'the brief title is exactly X',
  summary: 'Title decision',
  content_hash: 'hash-a',
  full_text_artifact_id: null,
};
const entryB: SnapshotEntry = {
  id: 'ctx-bbb',
  revision: 2,
  source_kind: 'chatgpt',
  source_label: 'Chat B',
  conversation_ref: null,
  occurred_at: null,
  coverage: 'summary_only',
  submitted_text: null,
  summary: 'Marker decision',
  content_hash: 'hash-b',
  full_text_artifact_id: 'art-222',
};
const decisionTitle: SnapshotDecision = {
  id: 'dec-111',
  context_entry_id: 'ctx-aaa',
  key: 'brief.title',
  value: 'Common context',
  source_excerpt: 'title is exactly X',
  supersedes_decision_ids: ['dec-00b', 'dec-00a'],
};
const decisionCount: SnapshotDecision = {
  id: 'dec-222',
  context_entry_id: 'ctx-aaa',
  key: 'brief.bullet_count',
  value: 3,
  source_excerpt: null,
  supersedes_decision_ids: [],
};
const decisionMarker: SnapshotDecision = {
  id: 'dec-333',
  context_entry_id: 'ctx-bbb',
  key: 'brief.required_marker',
  value: 'DEMO-42',
  source_excerpt: null,
  supersedes_decision_ids: [],
};
const task: SnapshotTask = {
  id: 'task-111',
  title: 'Write the brief',
  kind: 'draft_brief',
  required_decision_keys: ['brief.title', 'brief.required_marker', 'brief.bullet_count'],
  input_artifact_ids: ['art-222', 'art-111'],
};
const artifact1: SnapshotArtifact = {
  id: 'art-111',
  file_name: 'notes.md',
  mime_type: 'text/markdown',
  size_bytes: 120,
  sha256: 'a'.repeat(64),
};
const artifact2: SnapshotArtifact = {
  id: 'art-222',
  file_name: 'export.txt',
  mime_type: 'text/plain',
  size_bytes: 512,
  sha256: 'b'.repeat(64),
};

function makeSnapshot(overrides: Partial<ContextSnapshotV1> = {}): ContextSnapshotV1 {
  return {
    schema: 'ContextSnapshotV1',
    project_id: 'proj-1',
    context_revision: 2,
    entries: [entryA, entryB],
    decisions: [decisionTitle, decisionCount, decisionMarker],
    tasks: [task],
    artifacts: [artifact1, artifact2],
    ...overrides,
  };
}

describe('computeSnapshotHash — order independence', () => {
  it('yields an identical hash when every list arrives in a different order', async () => {
    const shuffled = makeSnapshot({
      entries: [entryB, entryA],
      decisions: [decisionMarker, decisionCount, decisionTitle],
      artifacts: [artifact2, artifact1],
      tasks: [
        {
          ...task,
          required_decision_keys: ['brief.bullet_count', 'brief.title', 'brief.required_marker'],
          input_artifact_ids: ['art-111', 'art-222'],
        },
      ],
    });
    const withInnerReorder = makeSnapshot({
      decisions: [
        { ...decisionTitle, supersedes_decision_ids: ['dec-00a', 'dec-00b'] },
        decisionCount,
        decisionMarker,
      ],
    });
    const base = await computeSnapshotHash(makeSnapshot());
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeSnapshotHash(shuffled)).toBe(base);
    expect(await computeSnapshotHash(withInnerReorder)).toBe(base);
  });

  it('ignores stray runtime properties (live status can never leak into the hash)', async () => {
    const polluted = makeSnapshot({
      tasks: [{ ...task, status: 'running' } as unknown as SnapshotTask],
    });
    expect(await computeSnapshotHash(polluted)).toBe(await computeSnapshotHash(makeSnapshot()));
  });
});

describe('computeSnapshotHash — content sensitivity', () => {
  it('changes when one byte of an entry content field changes', async () => {
    const base = await computeSnapshotHash(makeSnapshot());
    const mutated = makeSnapshot({
      entries: [{ ...entryA, summary: 'Title decisioN' }, entryB],
    });
    expect(await computeSnapshotHash(mutated)).not.toBe(base);
  });

  it('changes when a decision value changes', async () => {
    const base = await computeSnapshotHash(makeSnapshot());
    const mutated = makeSnapshot({
      decisions: [decisionTitle, { ...decisionCount, value: 4 }, decisionMarker],
    });
    expect(await computeSnapshotHash(mutated)).not.toBe(base);
  });

  it('changes when one artifact sha256 changes by one character', async () => {
    const base = await computeSnapshotHash(makeSnapshot());
    const mutated = makeSnapshot({
      artifacts: [artifact1, { ...artifact2, sha256: 'c' + 'b'.repeat(63) }],
    });
    expect(await computeSnapshotHash(mutated)).not.toBe(base);
  });
});

function makeRunInput(overrides: Partial<RunInputV1> = {}): RunInputV1 {
  return {
    schema: 'RunInputV1',
    task_id: 'task-111',
    task,
    context_revision: 2,
    snapshot_hash: 'f'.repeat(64),
    input_artifacts: [
      { id: 'art-222', sha256: 'b'.repeat(64) },
      { id: 'art-111', sha256: 'a'.repeat(64) },
    ],
    preset: 'draft_brief',
    preset_version: 'v1',
    validator_version: 'v1',
    limits: RUN_LIMITS_V1,
    run_at: '2026-09-19T12:00:00Z',
    ...overrides,
  };
}

describe('computeRunInputHash', () => {
  it('is stable under array reordering', async () => {
    const base = await computeRunInputHash(makeRunInput());
    const reordered = makeRunInput({
      input_artifacts: [
        { id: 'art-111', sha256: 'a'.repeat(64) },
        { id: 'art-222', sha256: 'b'.repeat(64) },
      ],
      task: {
        ...task,
        required_decision_keys: ['brief.required_marker', 'brief.bullet_count', 'brief.title'],
        input_artifact_ids: ['art-111', 'art-222'],
      },
    });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeRunInputHash(reordered)).toBe(base);
  });

  it('changes when an input artifact sha256 changes', async () => {
    const base = await computeRunInputHash(makeRunInput());
    const mutated = makeRunInput({
      input_artifacts: [
        { id: 'art-222', sha256: 'b'.repeat(64) },
        { id: 'art-111', sha256: 'a'.repeat(63) + '0' },
      ],
    });
    expect(await computeRunInputHash(mutated)).not.toBe(base);
  });

  it('changes when snapshot_hash or run_at changes', async () => {
    const base = await computeRunInputHash(makeRunInput());
    expect(await computeRunInputHash(makeRunInput({ snapshot_hash: 'e'.repeat(64) }))).not.toBe(base);
    expect(await computeRunInputHash(makeRunInput({ run_at: null }))).not.toBe(base);
  });
});

describe('sha256Hex / canonicalHash', () => {
  it('matches known SHA-256 vectors', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes the canonical UTF-8 bytes (key order irrelevant)', async () => {
    expect(await canonicalHash({ b: 1, a: 2 })).toBe(await canonicalHash({ a: 2, b: 1 }));
    // canonicalJson({a:2,b:1}) === '{"a":2,"b":1}'
    expect(await canonicalHash({ a: 2, b: 1 })).toBe(await sha256Hex('{"a":2,"b":1}'));
  });
});
