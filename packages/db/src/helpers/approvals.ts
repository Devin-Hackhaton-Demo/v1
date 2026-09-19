import type { DbClient } from '../client.ts';
import type { Tables } from '../types.ts';

export interface ApproveRunInput {
  projectId: string;
  runId: string;
  /** A jóváhagyott RunInput payload hash-e — az approval ehhez kötött (§7). */
  payloadHash: string;
  /** Lejárat; alapértelmezés: 1 óra (§8 végrehajtási ablak). */
  expiresAt?: string;
  runAt?: string;
}

/** Owner-jóváhagyás helyi futásra. Csak owner tudja beszúrni (RLS). */
export async function approveRun(client: DbClient, input: ApproveRunInput): Promise<Tables<'approvals'>> {
  const expiresAt = input.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from('approvals')
    .insert({
      project_id: input.projectId,
      subject: 'run',
      run_id: input.runId,
      payload_hash: input.payloadHash,
      run_at: input.runAt ?? null,
      expires_at: expiresAt,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Még fel nem használt jóváhagyás visszavonása (owner). */
export async function revokeApproval(client: DbClient, projectId: string, approvalId: string): Promise<void> {
  const { error } = await client
    .from('approvals')
    .update({ revoked_at: new Date().toISOString() })
    .eq('project_id', projectId)
    .eq('id', approvalId);
  if (error) throw error;
}
