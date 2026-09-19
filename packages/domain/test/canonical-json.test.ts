import { describe, expect, it } from 'vitest';
import { canonicalJson, DOMAIN_VERSION, type JsonValue } from '../src/index.ts';

describe('canonicalJson — RFC 8785 test vectors', () => {
  it('serializes the RFC 8785 combined vector exactly', () => {
    const input: JsonValue = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: '\u20ac$\u000f\nA\'B"\\/',
      literals: [null, true, false],
    };
    // Control char U+000F escaped as lowercase \u000f, newline as \n, quote
    // and backslash escaped, forward slash NOT escaped, € stays literal UTF-8.
    const expected =
      '{"literals":[null,true,false],' +
      '"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
      '"string":"\u20ac$\\u000f\\nA\'B\\"\\\\/"}';
    expect(canonicalJson(input)).toBe(expected);
  });

  it('orders keys by UTF-16 code units (RFC 8785 section 3.2.3 vector)', () => {
    const input: JsonValue = {
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\ud83d\ude00': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    };
    // Surrogate D83D sorts before FB33, so the emoji precedes the dalet.
    const expected =
      '{"\\r":"Carriage Return",' +
      '"1":"One",' +
      '"\u0080":"Control",' +
      '"\u00f6":"Latin Small Letter O With Diaeresis",' +
      '"\u20ac":"Euro Sign",' +
      '"\ud83d\ude00":"Emoji: Grinning Face",' +
      '"\ufb33":"Hebrew Letter Dalet With Dagesh"}';
    expect(canonicalJson(input)).toBe(expected);
  });

  it('sorts nested object keys recursively with no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 0, y: 1 }] } })).toBe(
      '{"a":{"c":[3,{"y":1,"z":0}],"d":2},"b":1}',
    );
  });
});

describe('canonicalJson — number edge cases (ES Number::toString)', () => {
  const cases: [number, string][] = [
    [1e30, '1e+30'],
    [2e-3, '0.002'],
    [0.000000000000000000000000001, '1e-27'],
    [333333333.33333329, '333333333.3333333'],
    [4.5, '4.5'],
    [-0, '0'],
    [0, '0'],
    [9007199254740996, '9007199254740996'], // 2^53 + 4, exactly representable
    [5e-324, '5e-324'], // smallest subnormal
    [-1234567890.123456789, '-1234567890.1234567'],
  ];
  for (const [value, expected] of cases) {
    it(`serializes ${expected}`, () => {
      expect(canonicalJson(value)).toBe(expected);
    });
  }

  it('matches JSON.stringify semantics at the 2^53 boundary', () => {
    expect(canonicalJson(9007199254740992)).toBe(JSON.stringify(9007199254740992));
    expect(canonicalJson(9007199254740994)).toBe(JSON.stringify(9007199254740994));
  });
});

describe('canonicalJson — rejects non-JSON data instead of dropping it', () => {
  it('throws TypeError on NaN', () => {
    expect(() => canonicalJson(NaN)).toThrow(TypeError);
  });
  it('throws TypeError on +Infinity', () => {
    expect(() => canonicalJson(Infinity)).toThrow(TypeError);
  });
  it('throws TypeError on -Infinity', () => {
    expect(() => canonicalJson(-Infinity)).toThrow(TypeError);
  });
  it('throws TypeError on BigInt', () => {
    expect(() => canonicalJson(10n as unknown as JsonValue)).toThrow(TypeError);
  });
  it('throws TypeError on undefined property value (must not silently drop)', () => {
    // If undefined were dropped, {"a":1,"b":undefined} would hash like {"a":1}.
    expect(() => canonicalJson({ a: 1, b: undefined } as unknown as JsonValue)).toThrow(TypeError);
  });
  it('throws TypeError on undefined array element', () => {
    expect(() => canonicalJson([1, undefined] as unknown as JsonValue)).toThrow(TypeError);
  });
  it('throws TypeError on function values', () => {
    expect(() => canonicalJson({ f: () => 1 } as unknown as JsonValue)).toThrow(TypeError);
  });
  it('throws TypeError on symbol values', () => {
    expect(() => canonicalJson({ s: Symbol('x') } as unknown as JsonValue)).toThrow(TypeError);
  });
  it('throws TypeError on top-level undefined', () => {
    expect(() => canonicalJson(undefined as unknown as JsonValue)).toThrow(TypeError);
  });
});

describe('package version', () => {
  it('keeps DOMAIN_VERSION at v1', () => {
    expect(DOMAIN_VERSION).toBe('v1');
  });
});
