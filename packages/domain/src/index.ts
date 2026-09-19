/**
 * Domain package: canonical JSON (RFC 8785 / JCS), snapshot and run-input
 * hashing (PROJECT_CONTEXT.md section 6), and the draft_brief validator.
 * Pure computation — no I/O, no network, no database.
 */
export const DOMAIN_VERSION = 'v1';

export { canonicalJson, type JsonValue } from './canonical-json.ts';
export { sha256Hex, canonicalHash } from './hash.ts';
export {
  computeSnapshotHash,
  computeRunInputHash,
  RUN_LIMITS_V1,
  type ContextSnapshotV1,
  type SnapshotEntry,
  type SnapshotDecision,
  type SnapshotTask,
  type SnapshotArtifact,
  type RunInputV1,
  type RunLimitsV1,
} from './snapshot.ts';
export {
  validateDraftBrief,
  DRAFT_BRIEF_MAX_BYTES,
  DRAFT_BRIEF_VALIDATOR_VERSION,
  type DraftBriefValidation,
  type DraftBriefCheck,
} from './draft-brief.ts';
