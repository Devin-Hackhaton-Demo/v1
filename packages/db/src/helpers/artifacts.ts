import type { DbClient } from '../client.ts';
import type { Tables } from '../types.ts';
import { sha256Hex } from './hash.ts';

export const ARTIFACTS_BUCKET = 'artifacts';

// Limitek levezetése (PROJECT_CONTEXT.md §4):
//   1 MiB/fájl  = 1 048 576 bájt
//   20 MiB/projekt = 20 971 520 bájt
export const MAX_ARTIFACT_BYTES = 1_048_576;
export const MAX_PROJECT_BYTES = 20_971_520;

export const ALLOWED_MIME_TYPES = ['text/plain', 'text/markdown', 'application/json'] as const;
export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export interface UploadArtifactInput {
  projectId: string;
  fileName: string;
  mimeType: AllowedMimeType;
  /** UTF-8 szöveg vagy nyers bájtok. */
  content: string | Uint8Array;
}

/**
 * Artifact feltöltés: bájtok a privát Storage bucketbe
 * (<project_id>/<artifact_id>/<fájlnév>), metaadat + SHA-256 a táblába.
 * A limit túllépése explicit hiba, nincs csendes csonkolás (§4).
 */
export async function uploadArtifact(client: DbClient, input: UploadArtifactInput): Promise<Tables<'artifacts'>> {
  const bytes = typeof input.content === 'string' ? new TextEncoder().encode(input.content) : input.content;

  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(`LIMIT_EXCEEDED: az artifact mérete 1..${MAX_ARTIFACT_BYTES} bájt lehet (kapott: ${bytes.byteLength})`);
  }

  const { data: existing, error: quotaError } = await client
    .from('artifacts')
    .select('size_bytes')
    .eq('project_id', input.projectId);
  if (quotaError) throw quotaError;
  const used = existing.reduce((sum, a) => sum + a.size_bytes, 0);
  if (used + bytes.byteLength > MAX_PROJECT_BYTES) {
    throw new Error(`LIMIT_EXCEEDED: a projekt artifact-kvótája ${MAX_PROJECT_BYTES} bájt (használt: ${used})`);
  }

  const id = crypto.randomUUID();
  const storagePath = `${input.projectId}/${id}/${input.fileName}`;
  const sha256 = await sha256Hex(bytes);

  const { error: uploadError } = await client.storage
    .from(ARTIFACTS_BUCKET)
    .upload(storagePath, bytes, { contentType: input.mimeType });
  if (uploadError) throw uploadError;

  const { data, error } = await client
    .from('artifacts')
    .insert({
      id,
      project_id: input.projectId,
      file_name: input.fileName,
      mime_type: input.mimeType,
      size_bytes: bytes.byteLength,
      sha256,
      storage_path: storagePath,
    })
    .select()
    .single();
  if (error) {
    await client.storage.from(ARTIFACTS_BUCKET).remove([storagePath]).catch(() => undefined);
    throw error;
  }
  return data;
}

export interface DownloadedArtifact {
  meta: Tables<'artifacts'>;
  bytes: Uint8Array;
}

/**
 * Artifact letöltés bájtazonosság-ellenőrzéssel: a letöltött tartalom
 * SHA-256-a kötelezően egyezik a tárolt hash-sel (§5).
 */
export async function downloadArtifact(
  client: DbClient,
  projectId: string,
  artifactId: string,
): Promise<DownloadedArtifact> {
  const { data: meta, error } = await client
    .from('artifacts')
    .select('*')
    .eq('project_id', projectId)
    .eq('id', artifactId)
    .maybeSingle();
  if (error) throw error;
  if (!meta) throw new Error('NOT_FOUND: artifact nem található');

  const { data: blob, error: downloadError } = await client.storage
    .from(ARTIFACTS_BUCKET)
    .download(meta.storage_path);
  if (downloadError) throw downloadError;

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const actual = await sha256Hex(bytes);
  if (actual !== meta.sha256) {
    throw new Error(`FILE_UNAVAILABLE: hash-eltérés (várt ${meta.sha256}, kapott ${actual})`);
  }
  return { meta, bytes };
}
