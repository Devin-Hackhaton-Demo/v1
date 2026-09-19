import { describe, expect, it } from 'vitest';
import { DRAFT_BRIEF_MAX_BYTES, validateDraftBrief } from '../src/index.ts';

const expected = { title: 'Common context', bulletCount: 3, marker: 'DEMO-42' };

const goodDoc = [
  '# Common context',
  '',
  'Intro paragraph.',
  '',
  '- first point',
  '- second point',
  '- third point',
  '',
  'Verification marker: DEMO-42',
  '',
].join('\n');

/** The named check, asserting it exists (all checks must always run). */
function check(result: ReturnType<typeof validateDraftBrief>, name: string) {
  const found = result.checks.find((c) => c.name === name);
  expect(found, `check "${name}" must be present`).toBeDefined();
  return found!;
}

describe('validateDraftBrief — positive case', () => {
  it('passes with exact H1, exact bullet count, marker present, small doc', () => {
    const result = validateDraftBrief(goodDoc, expected);
    expect(result.validator_version).toBe('v1');
    expect(result.ok).toBe(true);
    for (const c of result.checks) expect(c.ok, `check "${c.name}" should pass`).toBe(true);
    // Every contract check ran:
    for (const name of ['size', 'title', 'bullets', 'marker']) check(result, name);
  });

  it('does not count nested (indented) bullets', () => {
    const doc = goodDoc.replace('- second point', '- second point\n  - nested a\n    * nested b');
    const result = validateDraftBrief(doc, expected);
    expect(check(result, 'bullets').ok).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('ignores headings and bullets inside fenced code blocks', () => {
    const doc = [
      '```md',
      '# Wrong title in code',
      '- fake bullet',
      '- fake bullet',
      '```',
      goodDoc,
      '~~~',
      '* another fake bullet',
      '~~~',
    ].join('\n');
    const result = validateDraftBrief(doc, expected);
    expect(check(result, 'title').ok).toBe(true); // first REAL H1 wins
    expect(check(result, 'bullets').ok).toBe(true); // still exactly 3
    expect(result.ok).toBe(true);
  });
});

describe('validateDraftBrief — negative cases (specific check names)', () => {
  it('fails the title check when the document only has an H2', () => {
    const result = validateDraftBrief(goodDoc.replace('# Common context', '## Common context'), expected);
    expect(result.ok).toBe(false);
    expect(check(result, 'title').ok).toBe(false);
    expect(check(result, 'bullets').ok).toBe(true); // no early exit: other checks still ran
    expect(check(result, 'marker').ok).toBe(true);
  });

  it('fails the title check when the first H1 has the wrong text', () => {
    const result = validateDraftBrief(goodDoc.replace('# Common context', '# Wrong title'), expected);
    expect(result.ok).toBe(false);
    expect(check(result, 'title').ok).toBe(false);
  });

  it('fails the bullets check on one extra top-level bullet', () => {
    const result = validateDraftBrief(goodDoc.replace('- third point', '- third point\n- fourth point'), expected);
    expect(result.ok).toBe(false);
    expect(check(result, 'bullets').ok).toBe(false);
    expect(check(result, 'title').ok).toBe(true);
  });

  it('fails the bullets check on one missing bullet', () => {
    const result = validateDraftBrief(goodDoc.replace('- third point\n', ''), expected);
    expect(result.ok).toBe(false);
    expect(check(result, 'bullets').ok).toBe(false);
  });

  it('fails the marker check when the marker is absent', () => {
    const result = validateDraftBrief(goodDoc.replace('DEMO-42', 'DEMO-43'), expected);
    expect(result.ok).toBe(false);
    expect(check(result, 'marker').ok).toBe(false);
    expect(check(result, 'title').ok).toBe(true);
  });

  it('fails the size check just over 32 KiB', () => {
    const padding = 'x'.repeat(DRAFT_BRIEF_MAX_BYTES + 1 - new TextEncoder().encode(goodDoc).length);
    const bigDoc = goodDoc + padding; // exactly 32769 UTF-8 bytes
    expect(new TextEncoder().encode(bigDoc).length).toBe(DRAFT_BRIEF_MAX_BYTES + 1);
    const result = validateDraftBrief(bigDoc, expected);
    expect(result.ok).toBe(false);
    expect(check(result, 'size').ok).toBe(false);
    expect(check(result, 'title').ok).toBe(true); // content checks still ran
  });

  it('counts multi-byte characters by UTF-8 bytes, not string length', () => {
    // 16385 three-byte chars = 49155 bytes but only 16385 UTF-16 units.
    const result = validateDraftBrief(goodDoc + '\u20ac'.repeat(16385), expected);
    expect(check(result, 'size').ok).toBe(false);
  });
});

describe('validateDraftBrief — expected-input checks (reported, never thrown)', () => {
  it('fails expected_bullet_count when out of the 1..5 preset range', () => {
    for (const bulletCount of [0, 6, 2.5]) {
      const result = validateDraftBrief(goodDoc, { ...expected, bulletCount });
      expect(result.ok).toBe(false);
      expect(check(result, 'expected_bullet_count').ok).toBe(false);
    }
  });

  it('fails expected_title / expected_marker when empty', () => {
    const noTitle = validateDraftBrief(goodDoc, { ...expected, title: '' });
    expect(noTitle.ok).toBe(false);
    expect(check(noTitle, 'expected_title').ok).toBe(false);

    const noMarker = validateDraftBrief(goodDoc, { ...expected, marker: '' });
    expect(noMarker.ok).toBe(false);
    expect(check(noMarker, 'expected_marker').ok).toBe(false);
  });

  it('never throws on garbage documents', () => {
    for (const doc of ['', '\u0000\uffff', '```', '```\n# open fence forever', '   # indented hash']) {
      expect(() => validateDraftBrief(doc, expected)).not.toThrow();
      expect(validateDraftBrief(doc, expected).ok).toBe(false); // no H1 → title fails
    }
  });
});
