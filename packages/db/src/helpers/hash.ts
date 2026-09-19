/** SHA-256 hex — Web Crypto, Node 20+ és böngésző alatt egyaránt fut. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Deterministic key-sorted JSON (simplified canonical form). Kept ONLY for
 * decision-value comparison in getContext. Hashing of contract payloads
 * (content_hash, payload_hash) now lives in @demo/domain (RFC 8785 via
 * canonicalJson/canonicalHash) — do NOT use this simplified form for new
 * hashes: unlike canonicalJson it silently drops undefined values, so two
 * semantically different inputs can serialize identically.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
