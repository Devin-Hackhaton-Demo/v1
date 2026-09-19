import type { DbClient } from '../client.ts';
import type { Enums, Tables } from '../types.ts';

export async function listTasks(
  client: DbClient,
  projectId: string,
  status?: Enums<'task_status'>,
): Promise<Tables<'tasks'>[]> {
  let query = client
    .from('tasks')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}
