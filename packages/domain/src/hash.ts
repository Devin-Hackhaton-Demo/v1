/**
 * SHA-256 helpers on top of the RFC 8785 serializer.
 *
 * Web Crypto only (no `node:crypto` import) so the exact same bytes hash
 * identically in Node 20+, workers and browsers — the same portability
 * approach as packages/db/src/helpers/hash.ts, which this package's
 * canonical form supersedes at integration time.
 */
import { canonicalJson, type JsonValue } from './canonical-json.ts';

/** SHA-256 of a string (UTF-8 encoded) or raw bytes, as lowercase hex. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** SHA-256 hex of the RFC 8785 canonical UTF-8 bytes of `value`. */
export async function canonicalHash(value: JsonValue): Promise<string> {
  return sha256Hex(canonicalJson(value));
}
