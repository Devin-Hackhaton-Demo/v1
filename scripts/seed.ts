/**
 * Seed: 2 tesztfelhasználó (Supabase Auth), demo projektek, tagságok,
 * GitHub-kapcsolat rekord. Idempotens — többszöri futtatásra ugyanaz az
 * állapot. Futtatás: npm run seed
 */
import { addMember, createServiceClient, type DbClient } from '../packages/db/src/index.ts';

const OWNER_EMAIL = 'owner@demo.test';
const MEMBER_EMAIL = 'member@demo.test';
const DEMO_PROJECT = 'Demo projekt';
const CLOSED_PROJECT = 'Zárt projekt (jogosultságteszt)';

const password = process.env.DEMO_USER_PASSWORD;
if (!password) throw new Error('DEMO_USER_PASSWORD hiányzik az .env-ből');

const service: DbClient = createServiceClient();

async function ensureUser(email: string): Promise<string> {
  const { data, error } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  const existing = data.users.find((u) => u.email === email);
  if (existing) {
    console.log(`user megvan:    ${email} (${existing.id})`);
    return existing.id;
  }
  const { data: created, error: createError } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError) throw createError;
  console.log(`user létrehozva: ${email} (${created.user.id})`);
  return created.user.id;
}

async function ensureProject(name: string, createdBy: string): Promise<string> {
  const { data, error } = await service.from('projects').select('id').eq('name', name).maybeSingle();
  if (error) throw error;
  if (data) {
    console.log(`projekt megvan:    ${name} (${data.id})`);
    return data.id;
  }
  const id = crypto.randomUUID();
  const { error: insertError } = await service
    .from('projects')
    .insert({ id, name, created_by: createdBy });
  if (insertError) throw insertError;
  console.log(`projekt létrehozva: ${name} (${id})`);
  return id;
}

async function ensureConnection(projectId: string, createdBy: string): Promise<void> {
  const { data, error } = await service
    .from('connections')
    .select('id')
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) throw error;
  if (data) {
    console.log(`connection megvan (${data.id})`);
    return;
  }
  const { error: insertError } = await service.from('connections').insert({
    project_id: projectId,
    kind: 'github',
    target_repo: 'Devin-Hackhaton-Demo/issue-sandbox',
    secret_ref: 'vault:github/demo-fine-grained-pat', // csak hivatkozás, token soha nem kerül DB-be
    created_by: createdBy,
  });
  if (insertError) throw insertError;
  console.log('connection létrehozva (GitHub tesztrepó)');
}

const ownerId = await ensureUser(OWNER_EMAIL);
const memberId = await ensureUser(MEMBER_EMAIL);

// Demo projekt: owner a tulaj (trigger), member sima tag.
const demoProjectId = await ensureProject(DEMO_PROJECT, ownerId);
await addMember(service, demoProjectId, memberId, 'member');

// Zárt projekt: csak a member user tagja — a §10 jogosultságteszthez
// (az owner user innen semmit nem láthat).
await ensureProject(CLOSED_PROJECT, memberId);

await ensureConnection(demoProjectId, ownerId);

console.log('\nSeed kész.');
console.log(`  ${OWNER_EMAIL}  → owner @ "${DEMO_PROJECT}"`);
console.log(`  ${MEMBER_EMAIL} → member @ "${DEMO_PROJECT}", owner @ "${CLOSED_PROJECT}"`);
console.log('  Jelszó mindkettőhöz: DEMO_USER_PASSWORD az .env-ben');
