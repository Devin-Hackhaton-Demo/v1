import type { DbClient } from '../client.ts';
import type { Enums, Tables } from '../types.ts';

/** A bejelentkezett felhasználó projektjei (RLS: csak a tagságok). */
export async function listProjects(client: DbClient): Promise<Tables<'projects'>[]> {
  const { data, error } = await client
    .from('projects')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

export async function getProject(client: DbClient, projectId: string): Promise<Tables<'projects'> | null> {
  const { data, error } = await client
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Új projekt; a DB-trigger a létrehozót automatikusan owner taggá teszi.
 * (INSERT után külön SELECT, mert a RETURNING még a membership-trigger
 * előtt értékelődne ki.)
 */
export async function createProject(client: DbClient, name: string): Promise<Tables<'projects'>> {
  const id = crypto.randomUUID();
  const { error } = await client.from('projects').insert({ id, name });
  if (error) throw error;
  const project = await getProject(client, id);
  if (!project) throw new Error('createProject: a létrehozott projekt nem olvasható vissza');
  return project;
}

/** Tag hozzáadása — ownerként vagy service klienssel hívható. */
export async function addMember(
  client: DbClient,
  projectId: string,
  userId: string,
  role: Enums<'membership_role'> = 'member',
): Promise<Tables<'memberships'>> {
  const { data, error } = await client
    .from('memberships')
    .upsert({ project_id: projectId, user_id: userId, role }, { onConflict: 'project_id,user_id' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function listMembers(client: DbClient, projectId: string): Promise<Tables<'memberships'>[]> {
  const { data, error } = await client
    .from('memberships')
    .select('*')
    .eq('project_id', projectId);
  if (error) throw error;
  return data;
}
