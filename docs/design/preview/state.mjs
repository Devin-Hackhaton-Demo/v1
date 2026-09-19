export const STORAGE_KEY = 'coffeenator-preview-profile-v1';
export const SESSION_KEY = 'coffeenator-preview-context-v1';
export const STACK_KEY = 'coffeenator-preview-stack-v1';
export const CAPABILITIES = ['Text', 'Images', 'Code', 'Research', 'Meeting notes', 'Dictation'];
export const MAX_CONTEXT_BYTES = 1024 * 1024;
export const MAX_SOURCES = 5;

export const THEMES = [
  { id: 'coffee', name: 'Oat milk', description: 'Warm, grounded, a little cosy.' },
  { id: 'sage', name: 'Matcha', description: 'A fresh perspective. A softer pace.' },
  { id: 'ocean', name: 'Ocean', description: 'Clear thoughts, open horizons.' },
  { id: 'lavender', name: 'Lavender', description: 'A little room for imagination.' },
];

export const BRANDS = [
  { id: 'coffeenator', name: 'Coffeenator', tagline: 'Your context. Freshly brewed.', idea: 'A personal AI companion that brews useful ideas from your own context. Familiar, playful, and ready for the next chapter.', logo: 'A smiling cup with a conversation-shaped handle. Two rising steam lines suggest ideas taking shape.', theme: 'coffee' },
  { id: 'carrynest', name: 'Carrynest', tagline: 'Your knowledge. At home anywhere.', idea: 'A portable home for your knowledge. The focus is on keeping what you have built, even when your AI tools change.', logo: 'Soft nesting lines around a protected seed: a home and a carry bag in one simple mark.', theme: 'ocean' },
  { id: 'kithlane', name: 'Kithlane', tagline: 'A familiar guide. A new way forward.', idea: 'A calm, capable guide for personal and professional growth. More thoughtful co-pilot than playful pet.', logo: 'Two paths meeting and moving forward together: your direction, supported by AI.', theme: 'lavender' },
];

export const COMPANIONS = [
  { id: 'bean', name: 'Bean', description: 'Your little brewing buddy', color: 'coffee' },
  { id: 'pip', name: 'Pip', description: 'A curious little explorer', color: 'sage' },
  { id: 'orbit', name: 'Orbit', description: 'A quiet keeper of ideas', color: 'lavender' },
  { id: 'fox', name: 'Fox', description: 'A resourceful little guide', color: 'coffee' },
  { id: 'sprout', name: 'Sprout', description: 'Growing at your own pace', color: 'sage' },
  { id: 'pebble', name: 'Pebble', description: 'Your calm, steady companion', color: 'neutral' },
  { id: 'cloud', name: 'Nimbus', description: 'A little room to daydream', color: 'ocean' },
  { id: 'pixel', name: 'Pixel', description: 'Curious, capable, quietly nerdy', color: 'sage' },
  { id: 'luna', name: 'Luna', description: 'A gentle spark after dark', color: 'lavender' },
  { id: 'none', name: 'Just me', description: 'Keep it clean and simple', color: 'neutral' },
];

export const ROLES = ['Founder', 'Creator', 'Team member', 'Freelancer', 'Student', 'Explorer'];
export const INTERESTS = ['Writing & ideas', 'Business', 'Technology', 'Learning', 'Planning', 'Everyday life'];
export const PROVIDERS = ['ChatGPT', 'Claude', 'Other AI', 'File', 'Personal note'];
export const PROACTIVITY = [
  { id: 'quiet', name: 'Quiet', description: 'Only steps in when you ask.' },
  { id: 'gentle', name: 'A gentle nudge', description: 'Offers a useful next step now and then.' },
  { id: 'active', name: 'One step ahead', description: 'Future routines, always with your permission.' },
];

export const CONNECTORS = [
  { id: 'gmail', name: 'Gmail', category: 'Google', featured: true, status: 'soon', description: 'Less inbox noise. More clarity.', benefit: 'Summarize selected emails and prepare thoughtful replies with the right context.', permission: 'Read selected emails. Sending a message will require separate permission and approval.', icon: 'gmail' },
  { id: 'calendar', name: 'Google Calendar', category: 'Google', featured: true, status: 'soon', description: 'Make room for what matters.', benefit: 'Plan your priorities around the events already in your day.', permission: 'Read events in your chosen calendars. Creating or changing an event will require approval.', icon: 'calendar' },
  { id: 'drive', name: 'Google Drive', category: 'Google', featured: true, status: 'soon', description: 'Your files, part of the conversation.', benefit: 'Work with the documents you choose, without uploading them again each time.', permission: 'Read approved files. The real Google authorization screen will show the exact access requested.', icon: 'drive' },
  { id: 'claude', name: 'Claude', category: 'AI tools', status: 'soon', description: 'Bring along what it knows about you.', benefit: 'A direct connection is planned. You can already try importing a selected text export.', permission: 'No automatic access to chat history. Only the export you choose is read locally.', icon: 'claude' },
  { id: 'chatgpt', name: 'ChatGPT', category: 'AI tools', status: 'soon', description: 'A new chapter, not a blank page.', benefit: 'A direct connection is planned. A selected text memory export can already be imported locally.', permission: 'Your full history is not automatically available. A future connection will still need explicit authorization.', icon: 'chatgpt' },
  { id: 'notion', name: 'Notion', category: 'Work', status: 'soon', description: 'Pages and project notes', benefit: 'Work with pages you explicitly choose to share.', permission: 'Access to selected pages only. Writing or changing content will require separate permission.', icon: 'notion' },
  { id: 'github', name: 'GitHub', category: 'Development', status: 'soon', description: 'Repositories and issues', benefit: 'Bring approved project context into your workflow. The repository currently documents this integration as a plan, not a live implementation.', permission: 'Selected repositories only. Creating an issue requires a reviewed payload and explicit approval.', icon: 'github' },
  { id: 'supabase', name: 'Supabase', category: 'Development', status: 'soon', description: 'Project and database context', benefit: 'Access explicitly approved project resources through a future integration.', permission: 'No database or project access is granted by the app yet. Credentials must remain on the server.', icon: 'supabase' },
];

const MILESTONES = ['style', 'profile', 'companion', 'import', 'note', 'export'];
const pick = (value, choices, fallback) => choices.includes(value) ? value : fallback;
const uniqueChoices = (value, choices) => Array.isArray(value) ? [...new Set(value.filter((entry) => choices.includes(entry)))].slice(0, 6) : [];

export function createProfile() {
  return {
    version: 1, appearance: 'system', theme: 'coffee', brand: 'coffeenator', name: '',
    roles: [], interests: [], replyLength: 1, proactivity: 'gentle',
    companion: 'bean', accessory: 'none', avatar: '',
    themeChosen: false, profileSaved: false, companionChosen: false,
    onboarded: false, achievements: [],
  };
}

export function normalizeProfile(input) {
  const defaults = createProfile();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return defaults;
  const avatar = typeof input.avatar === 'string' && input.avatar.length <= 400000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(input.avatar) ? input.avatar : '';
  return {
    ...defaults,
    appearance: pick(input.appearance, ['system', 'light', 'dark'], defaults.appearance),
    theme: pick(input.theme, THEMES.map(({ id }) => id), defaults.theme),
    brand: pick(input.brand, BRANDS.map(({ id }) => id), defaults.brand),
    name: typeof input.name === 'string' ? input.name.trim().slice(0, 40) : '',
    roles: uniqueChoices(input.roles, ROLES),
    interests: uniqueChoices(input.interests, INTERESTS),
    replyLength: Number.isFinite(input.replyLength) ? Math.max(0, Math.min(2, Math.round(input.replyLength))) : defaults.replyLength,
    proactivity: pick(input.proactivity, PROACTIVITY.map(({ id }) => id), defaults.proactivity),
    companion: pick(input.companion, COMPANIONS.map(({ id }) => id), defaults.companion),
    accessory: pick(input.accessory, ['leaf', 'scarf', 'none'], defaults.accessory),
    avatar,
    themeChosen: input.themeChosen === true,
    profileSaved: input.profileSaved === true,
    companionChosen: input.companionChosen === true,
    onboarded: input.onboarded === true,
    achievements: uniqueChoices(input.achievements, MILESTONES),
  };
}

export const serializeProfile = (profile) => JSON.stringify(normalizeProfile(profile));

export function onboardingProgress(profile) {
  const completed = [profile.themeChosen, profile.profileSaved, profile.companionChosen].filter(Boolean).length;
  return { completed, total: 3, percent: Math.round(completed / 3 * 100) };
}

export function earnMilestone(profile, milestone) {
  if (!MILESTONES.includes(milestone)) return profile;
  return { ...profile, achievements: [...new Set([...profile.achievements, milestone])] };
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function validateContextFile(name, input) {
  if (typeof name !== 'string' || /(?:^|[./_-])(?:env|credentials?|secrets?|id_rsa|id_ed25519)(?:[._-]|$)/i.test(name)) {
    throw new Error('Environment and credential files cannot be imported. Choose a personal context export instead.');
  }
  const format = name.split('.').pop().toLowerCase();
  if (!['txt', 'md', 'json'].includes(format)) throw new Error('Choose a .txt, .md or .json file. ZIP archives, PDFs and images are not supported yet.');
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (data.byteLength > MAX_CONTEXT_BYTES) throw new Error('Each file can be up to 1 MiB. Choose a smaller, relevant excerpt.');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new Error('This file is not valid UTF-8 text. Save it as UTF-8 and try again.');
  }
  if (!text.trim()) throw new Error('This file is empty. Choose an export that contains some text.');
  if (text.includes('\0')) throw new Error('This file contains binary data. Choose a UTF-8 text file.');
  if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?\s*[=:]\s*["']?[^\s"']{8,}/i.test(text)) {
    throw new Error('This file may contain a secret or access key. Remove it before importing.');
  }
  if (format === 'json') {
    try { JSON.parse(text); } catch { throw new Error('This JSON file is invalid or incomplete. Fix it, or export a .txt file instead.'); }
  }
  const basename = name.split(/[\\/]/).pop();
  const safeName = basename.length > 160 ? `${basename.slice(0, 159 - format.length)}.${format}` : basename;
  return { name: safeName, text, bytes: data.byteLength, format };
}

export function addSource(sources, source) {
  if (sources.some((item) => item.hash === source.hash)) return sources;
  if (sources.length >= MAX_SOURCES) throw new Error('You can add up to 5 sources. Remove one before adding another.');
  return [...sources, source];
}

export function normalizeSources(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, MAX_SOURCES).flatMap((item) => {
    if (!item || typeof item.text !== 'string' || typeof item.id !== 'string' || !item.id || item.id.length > 80) return [];
    try {
      const file = validateContextFile(item.name, new TextEncoder().encode(item.text));
      return [{ ...file, id: item.id, hash: typeof item.hash === 'string' ? item.hash.slice(0, 128) : item.id, provider: pick(item.provider, PROVIDERS, 'Other AI'), savedAt: Number.isNaN(Date.parse(item.savedAt)) ? new Date().toISOString() : item.savedAt }];
    } catch { return []; }
  });
}

export function buildExport(profile, sources) {
  const clean = normalizeProfile(profile);
  return {
    schema_version: 1,
    kind: 'personal-context-preview',
    exported_at: new Date().toISOString(),
    profile: { name: clean.name, roles: clean.roles, interests: clean.interests },
    preferences: { language: 'en', reply_length: ['short', 'balanced', 'detailed'][clean.replyLength], proactivity: clean.proactivity },
    sources: sources.map((source) => ({ name: source.name, provider_label: source.provider, saved_at: source.savedAt, coverage: source.provider === 'Personal note' ? 'partial_text' : 'supplied_export', source_verified: false, text: source.text })),
    note: 'User-supplied local context, not an authenticated platform export. Does not include access tokens or provider permissions.',
  };
}

const safeDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const boundedText = (value, max = 80) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function normalizeConnection(account = {}, observations = {}) {
  const status = account.is_disabled ? 'INACTIVE' : pick(account.status, ['INITIALIZING', 'INITIATED', 'ACTIVE', 'EXPIRED', 'FAILED', 'INACTIVE'], 'UNKNOWN');
  const checkedAt = safeDate(observations.checkedAt);
  const syncedAt = safeDate(observations.syncedAt);
  const sync = pick(observations.sync, ['not_synced', 'not_supported', 'syncing', 'synced', 'error'], 'not_synced');
  return {
    id: boundedText(account.id),
    toolkit: boundedText(account.toolkit?.slug),
    label: boundedText(observations.label) || 'Account',
    status,
    addedAt: safeDate(account.created_at),
    connectedAt: safeDate(observations.connectedAt),
    health: checkedAt && (status === 'ACTIVE' || observations.health === 'error') ? pick(observations.health, ['healthy', 'error'], 'unknown') : 'unknown',
    checkedAt,
    sync: sync === 'synced' && !syncedAt ? 'not_synced' : sync,
    syncedAt,
    records: Number.isInteger(observations.records) && observations.records >= 0 ? observations.records : null,
    sample: observations.sample === true,
  };
}

export function sampleConnections(now = new Date()) {
  const ago = (hours) => new Date(now.getTime() - hours * 3600000).toISOString();
  return [
    normalizeConnection({ id: 'sample-gmail', toolkit: { slug: 'gmail' }, status: 'ACTIVE', created_at: ago(72) }, { label: 'Sample workspace', connectedAt: ago(71.9), health: 'healthy', checkedAt: ago(.2), sync: 'synced', syncedAt: ago(1), records: 42, sample: true }),
    normalizeConnection({ id: 'sample-calendar', toolkit: { slug: 'googlecalendar' }, status: 'ACTIVE', created_at: ago(48) }, { label: 'Sample calendar', connectedAt: ago(47.9), health: 'healthy', checkedAt: ago(.5), sync: 'not_supported', sample: true }),
    normalizeConnection({ id: 'sample-drive', toolkit: { slug: 'googledrive' }, status: 'EXPIRED', created_at: ago(168) }, { label: 'Sample drive', connectedAt: ago(167.9), health: 'error', checkedAt: ago(1), sync: 'error', syncedAt: ago(28), records: 12, sample: true }),
  ];
}

export function sourceCoverage(sources, now = new Date()) {
  const groups = Object.fromEntries(['chatgpt', 'claude', 'files', 'notes'].map((id) => [id, { count: 0, latestAt: null, needsReview: false }]));
  let bytes = 0;
  for (const source of sources) {
    const key = ({ ChatGPT: 'chatgpt', Claude: 'claude', 'Personal note': 'notes' })[source.provider] || 'files';
    const group = groups[key];
    group.count++;
    bytes += new TextEncoder().encode(source.text || '').length;
    const date = safeDate(source.savedAt);
    if (date && (!group.latestAt || date > group.latestAt)) group.latestAt = date;
  }
  for (const group of Object.values(groups)) group.needsReview = Boolean(group.latestAt && now.getTime() - Date.parse(group.latestAt) >= 21 * 86400000);
  return { groups, total: sources.length, bytes, categoriesAdded: Object.values(groups).filter(({ count }) => count > 0).length };
}

export function normalizeStack(input) {
  if (!Array.isArray(input)) return [];
  const ids = new Set();
  return input.slice(0, 30).flatMap((item) => {
    if (!item || !boundedText(item.id) || !boundedText(item.name) || ids.has(item.id)) return [];
    ids.add(item.id);
    return [{
      id: boundedText(item.id), name: boundedText(item.name, 60), plan: boundedText(item.plan, 60),
      cost: typeof item.cost === 'number' && Number.isFinite(item.cost) && item.cost >= 0 && item.cost <= 100000 ? item.cost : null,
      currency: pick(item.currency, ['USD', 'EUR', 'GBP'], 'USD'),
      cycle: pick(item.cycle, ['month', 'year'], 'month'),
      active: item.active !== false,
      version: boundedText(item.version, 60), device: boundedText(item.device, 60),
      capabilities: uniqueChoices(item.capabilities, CAPABILITIES),
      checkedAt: safeDate(item.checkedAt),
    }];
  });
}

export function stackSummary(input) {
  const active = normalizeStack(input).filter((item) => item.active);
  const totals = {};
  const capabilities = {};
  let unknownCosts = 0;
  for (const item of active) {
    if (item.cost === null) unknownCosts++;
    else totals[item.currency] = (totals[item.currency] || 0) + item.cost / (item.cycle === 'year' ? 12 : 1);
    for (const capability of item.capabilities) capabilities[capability] = (capabilities[capability] || 0) + 1;
  }
  for (const currency of Object.keys(totals)) totals[currency] = Math.round(totals[currency] * 100) / 100;
  return { active: active.length, totals, unknownCosts, overlap: Object.entries(capabilities).filter(([, count]) => count > 1).map(([capability, count]) => ({ capability, count })) };
}

export const CHAT_KEY = 'coffeenator-preview-chat-v1';
export const MAX_CHAT_TURNS = 40;
export const MAX_TURN_LENGTH = 65536;
export const CHAT_TIMEOUT_MS = 60000;
export const CHAT_COPY = {
  notConfigured: 'Chat backend is not configured. Set ANTHROPIC_API_KEY on the server.',
  network: 'The reply did not arrive. Check your connection and retry.',
  timeout: 'The reply took longer than 60 seconds and was cancelled. Retry to send the same conversation.',
  unreadable: 'The server sent a response the app could not read. Retry to send the same conversation.',
  rejected: 'The server rejected this chat request.',
  interrupted: 'The last message has not been answered yet. Retry to send it again.',
};

const boundedErrorMessage = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : fallback;

export function normalizeConversation(input) {
  if (!Array.isArray(input)) return [];
  return input.flatMap((turn) => {
    if (!turn || !['user', 'assistant'].includes(turn.role) || typeof turn.content !== 'string' || !turn.content.trim()) return [];
    return [{ role: turn.role, content: turn.content.slice(0, MAX_TURN_LENGTH) }];
  }).slice(-MAX_CHAT_TURNS);
}

export function appendChatTurn(turns, role, content) {
  return normalizeConversation([...(Array.isArray(turns) ? turns : []), { role, content }]);
}

export function chatRequestBody(turns, system = '') {
  const messages = normalizeConversation(turns);
  while (messages.length && messages[0].role !== 'user') messages.shift();
  while (messages.length && messages[messages.length - 1].role !== 'user') messages.pop();
  if (!messages.length) throw new Error('Type a message before sending.');
  const instructions = typeof system === 'string' ? system.trim() : '';
  return instructions ? { messages, system: instructions } : { messages };
}

export function parseChatResponse(status, body) {
  const data = body && body.ok === true && body.schema_version === 1 && body.data && typeof body.data === 'object' ? body.data : null;
  if (status === 200 && data && typeof data.reply === 'string' && data.reply.trim()) {
    const usage = data.usage && typeof data.usage === 'object' ? data.usage : {};
    return {
      ok: true,
      reply: data.reply.slice(0, MAX_TURN_LENGTH),
      model: typeof data.model === 'string' ? data.model.slice(0, 80) : '',
      usage: {
        input_tokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : null,
        output_tokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : null,
      },
    };
  }
  const error = body && body.ok === false && body.error && typeof body.error === 'object' ? body.error : null;
  if (error && status === 503 && error.code === 'PROVIDER_ERROR' && error.retryable !== true) {
    return { ok: false, retryable: false, message: CHAT_COPY.notConfigured };
  }
  if (error) {
    const retryable = error.retryable === true;
    return { ok: false, retryable, message: boundedErrorMessage(error.message, retryable ? CHAT_COPY.network : CHAT_COPY.rejected) };
  }
  return { ok: false, retryable: !(status >= 400 && status < 500), message: CHAT_COPY.unreadable };
}

export async function requestChatReply(turns, { fetchImpl = globalThis.fetch, signal, system } = {}) {
  const body = JSON.stringify(chatRequestBody(turns, system));
  let response;
  try { response = await fetchImpl('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal }); }
  catch { return { ok: false, retryable: true, message: signal?.aborted ? CHAT_COPY.timeout : CHAT_COPY.network }; }
  let payload = null;
  try { payload = await response.json(); } catch {}
  return parseChatResponse(response.status, payload);
}

export function createChat() { return { turns: [], status: 'idle', error: null }; }

export function normalizeChat(input) {
  const turns = normalizeConversation(input && typeof input === 'object' && !Array.isArray(input) ? input.turns : null);
  if (turns.length && turns[turns.length - 1].role === 'user') {
    return { turns, status: 'error', error: { retryable: true, message: CHAT_COPY.interrupted } };
  }
  return { turns, status: 'idle', error: null };
}

export const serializeChat = (chat) => JSON.stringify({ turns: normalizeConversation(chat?.turns) });

export function chatWithUserTurn(chat, content) {
  return { turns: appendChatTurn(chat.turns, 'user', content), status: 'sending', error: null };
}

export function chatRetrying(chat) {
  return { ...chat, status: 'sending', error: null };
}

export function chatWithReply(chat, reply) {
  return { turns: appendChatTurn(chat.turns, 'assistant', reply), status: 'idle', error: null };
}

export function chatWithError(chat, error) {
  return { ...chat, status: 'error', error: { retryable: error?.retryable === true, message: boundedErrorMessage(error?.message, CHAT_COPY.network) } };
}

export const EXPORT_GUIDES = {
  ChatGPT: {
    url: 'https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data',
    quick: 'List the work preferences, goals, projects, and response instructions you remember about me in a plain-text block. Exclude passwords, keys, and sensitive personal details. Do not infer missing information. State if this is only a partial summary.',
    steps: [
      { title: 'Request your export', text: 'In ChatGPT: Settings → Data controls → Export data → Confirm export.' },
      { title: 'Download and unpack', text: 'Use the link sent to your email or phone. It expires after 24 hours; preparation can take up to 7 days. Unzip the download.' },
      { title: 'Choose what to bring', text: 'Select a relevant conversations JSON file under 1 MiB, or copy a useful excerpt into a .txt file. Review before importing.' },
    ],
    note: 'Availability depends on your plan and workspace. Business and Enterprise users need their workspace owner. A ChatGPT export is not a complete account migration.',
  },
  Claude: {
    url: 'https://support.claude.com/en/articles/9450526-export-your-claude-data',
    quick: 'Write out the work-related preferences, projects, goals, and response instructions in your memory, as plain text. Exclude secrets and sensitive personal details. Do not invent missing information. Explain if any context is unavailable.',
    steps: [
      { title: 'Request your export', text: 'In Claude on the web or desktop: Settings → Privacy → Export data. This export flow is not available in the mobile app.' },
      { title: 'Download your data', text: 'Open the emailed link while signed in. The link expires after 24 hours. If the download is an archive, extract it first.' },
      { title: 'Select useful context', text: 'Choose a relevant .json, .txt, or .md file under 1 MiB. You can also copy a reviewed memory summary and paste it here.' },
    ],
    note: 'Individual Free, Pro and Max accounts can export. Team and Enterprise exports require the Primary Owner. A copied memory summary may be incomplete.',
  },
};
