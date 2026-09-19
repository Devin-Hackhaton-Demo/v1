import { describe, expect, it } from 'vitest';
import { DOMAIN_VERSION } from '../src/index.ts';

describe('workspace bootstrap', () => {
  it('runs TypeScript tests through vitest', () => {
    expect(DOMAIN_VERSION).toBe('v1');
  });
});
