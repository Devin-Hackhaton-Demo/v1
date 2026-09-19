/**
 * RFC 8785 (JSON Canonicalization Scheme) serializer.
 *
 * Why JSON.stringify for primitives and property names: JCS explicitly
 * specifies ECMAScript semantics — Number::toString for numbers (section
 * 3.2.2.3, so `-0` becomes "0", `1e30` becomes "1e+30") and ECMAScript
 * JSON string escaping (section 3.2.2.2: `\n`/`\r`/`\t`/`\b`/`\f`
 * shorthands, other control chars as lowercase `\u00xx`, `"` and `\`
 * escaped, nothing else — notably `/` stays literal). A conforming JS
 * runtime therefore already implements the exact required output.
 *
 * Why we throw instead of dropping invalid values: this serializer feeds
 * SHA-256 hashes that anchor approvals (PROJECT_CONTEXT.md section 6).
 * Silently dropping `undefined`/NaN/functions (as JSON.stringify does)
 * could make two semantically different inputs canonicalize — and hash —
 * identically. JCS input must be valid JSON data, so anything else is a
 * hard TypeError.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Serialize a JSON value to its RFC 8785 canonical form (no whitespace). */
export function canonicalJson(value: JsonValue): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number ${String(value)} is not valid JSON`);
      }
      return JSON.stringify(value);
    case 'object':
      if (Array.isArray(value)) {
        // Arrays keep caller order; element `undefined` falls through to the
        // default case below and throws (JSON.stringify would emit "null").
        return `[${value.map(serialize).join(',')}]`;
      }
      return serializeObject(value as Record<string, unknown>);
    default:
      // undefined, bigint, function, symbol
      throw new TypeError(`canonicalJson: ${typeof value} is not valid JSON data`);
  }
}

function serializeObject(obj: Record<string, unknown>): string {
  // Default string sort compares UTF-16 code units — exactly the JCS
  // section 3.2.3 property ordering (surrogate D83D sorts before FB33).
  const keys = Object.keys(obj).sort();
  const members = keys.map((key) => {
    const v = obj[key];
    if (v === undefined) {
      // Reject, do not drop: {"a":1,"b":undefined} must not hash like {"a":1}.
      throw new TypeError(`canonicalJson: undefined value for key ${JSON.stringify(key)}`);
    }
    return `${JSON.stringify(key)}:${serialize(v)}`;
  });
  return `{${members.join(',')}}`;
}
