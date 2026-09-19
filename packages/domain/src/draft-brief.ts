/**
 * Deterministic draft_brief validator, v1 (PROJECT_CONTEXT.md section 6).
 *
 * The preset promise: the FIRST Markdown H1 exactly equals the decided
 * title, the count of TOP-LEVEL unordered list items exactly equals the
 * decided bullet count, the marker appears literally, and the document
 * fits in 32 KiB UTF-8. The model's own "done" claim is never evidence —
 * this function is, so it must never throw on a bad document and must run
 * ALL checks (no early exit) so every failure is visible in `run_get`.
 */

export type DraftBriefCheck = { name: string; ok: boolean; detail?: string };

export type DraftBriefValidation = {
  ok: boolean;
  validator_version: 'v1';
  checks: DraftBriefCheck[];
};

export const DRAFT_BRIEF_VALIDATOR_VERSION = 'v1';
/** brief.md size cap: 32 KiB of UTF-8 (section 6). */
export const DRAFT_BRIEF_MAX_BYTES = 32768;

export function validateDraftBrief(
  markdown: string,
  expected: { title: string; bulletCount: number; marker: string },
): DraftBriefValidation {
  const checks: DraftBriefCheck[] = [];

  // Input checks first: a run configured with invalid decisions must fail
  // visibly here rather than throw (the caller stores checks verbatim).
  checks.push({
    name: 'expected_title',
    ok: expected.title.length > 0,
    ...(expected.title.length > 0 ? {} : { detail: 'expected.title must be non-empty' }),
  });
  const bulletCountValid =
    Number.isInteger(expected.bulletCount) && expected.bulletCount >= 1 && expected.bulletCount <= 5;
  checks.push({
    name: 'expected_bullet_count',
    ok: bulletCountValid,
    ...(bulletCountValid
      ? {}
      : { detail: `expected.bulletCount must be an integer in 1..5, got ${expected.bulletCount}` }),
  });
  checks.push({
    name: 'expected_marker',
    ok: expected.marker.length > 0,
    ...(expected.marker.length > 0 ? {} : { detail: 'expected.marker must be non-empty' }),
  });

  // 1. size — UTF-8 bytes, not UTF-16 length (multi-byte chars count fully).
  const byteLength = new TextEncoder().encode(markdown).length;
  checks.push({
    name: 'size',
    ok: byteLength <= DRAFT_BRIEF_MAX_BYTES,
    detail: `${byteLength} bytes (limit ${DRAFT_BRIEF_MAX_BYTES})`,
  });

  // Single line scan classifying H1s and top-level bullets, skipping fenced
  // code blocks so a code sample can never satisfy (or break) the checks.
  const { firstH1, topLevelBullets } = scanMarkdown(markdown);

  // 2. title — first ATX H1 must exist and match exactly. An H2 is not an H1.
  const titleOk = firstH1 !== null && firstH1 === expected.title;
  checks.push({
    name: 'title',
    ok: titleOk,
    detail:
      firstH1 === null
        ? 'no top-level ATX H1 (`# ...`) found'
        : `first H1 is ${JSON.stringify(firstH1)}, expected ${JSON.stringify(expected.title)}`,
  });

  // 3. bullets — exact count of top-level unordered list items.
  checks.push({
    name: 'bullets',
    ok: topLevelBullets === expected.bulletCount,
    detail: `found ${topLevelBullets} top-level bullet(s), expected ${expected.bulletCount}`,
  });

  // 4. marker — literal substring anywhere in the document.
  checks.push({
    name: 'marker',
    ok: markdown.includes(expected.marker),
    detail: markdown.includes(expected.marker)
      ? 'marker present'
      : `marker ${JSON.stringify(expected.marker)} not found`,
  });

  return {
    ok: checks.every((c) => c.ok),
    validator_version: DRAFT_BRIEF_VALIDATOR_VERSION,
    checks,
  };
}

/** CommonMark-style fence: up to 3 spaces indent, then 3+ backticks or tildes. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

function scanMarkdown(markdown: string): { firstH1: string | null; topLevelBullets: number } {
  let firstH1: string | null = null;
  let topLevelBullets = 0;
  let fence: { char: string; length: number } | null = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const fenceMatch = FENCE_RE.exec(rawLine);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) {
        fence = { char: marker[0]!, length: marker.length };
        continue;
      }
      // Closing fence: same character, at least as long, nothing else on the line.
      if (marker[0] === fence.char && marker.length >= fence.length && rawLine.trim() === marker) {
        fence = null;
        continue;
      }
    }
    if (fence !== null) continue; // inside a fenced code block: ignore everything

    // Exactly one leading '#', top level (no indentation), space, then text.
    const h1 = /^# (.+)$/.exec(rawLine);
    if (h1 !== null && firstH1 === null) {
      firstH1 = h1[1]!.replace(/\s+$/u, ''); // trim trailing whitespace only
    }
    // Top-level unordered bullet: marker at column 0; indented items are nested.
    if (/^[-*+] /.test(rawLine)) topLevelBullets += 1;
  }

  return { firstH1, topLevelBullets };
}
