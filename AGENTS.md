# AGENTS.md — közös szabályok és a kész DB-réteg használata

Terv és szerződések: `PROJECT_CONTEXT.md` (a §14 tartalmazza a jóváhagyott
v1 eltéréseket). Ez a fájl a gyakorlati tudnivalókat rögzíti.

## Munkamegosztás és branchek

- `main` — közös alap, tartalmazza a kész DB-réteget
- `feat/mcp-server` — MCP-szerver (külön agent építi)
- `codex/munka-2026-09-19` — UI (külön fejlesztő)
- A DB-séma és a `packages/db` a DB-kör tulajdona: sémaigényt közös
  egyeztetéssel, ÚJ migrációs fájllal kell bevinni (lásd lent).

## Parancsok

| Parancs | Mit csinál |
| --- | --- |
| `npm run build` | `packages/db` typecheck + build (tsc) |
| `npm run seed` | Idempotens seed: teszt userek + demo projektek |
| `npm run smoke` | 40 élő ellenőrzés a Supabase DB ellen (RLS, trigger, hash, RPC-k, Vault) |
| `npm run db:push` | Új migrációk alkalmazása az élő DB-re |
| `npm run db:types` | Típusgenerálás — Dockert igényel, ezen a gépen nincs! |

Env: `.env` a gyökérben (minta: `.env.example`). `SUPABASE_URL` = https URL;
a Postgres kapcsolat `SUPABASE_DB_URL` (session pooler — a direkt
`db.<ref>.supabase.co` host IPv6-only, erről a hálózatról NEM elérhető).

## A DB-réteg használata (`packages/db`, import: `@demo/db`)

- `createAnonClient()` — RLS-sel védett kliens; bejelentkezett felhasználói
  műveletekhez. UI és minden felhasználó nevében futó hívás ezt használja.
- `createServiceClient()` — RLS-t megkerüli. KIZÁRÓLAG szerveroldali
  folyamatban (MCP-szerver backend, worker, seed). Soha nem kerülhet UI
  bundle-be vagy kliens felé kiadott kódba.
- Helperök: `saveContext`, `getContext`, `listTasks`, `prepareRun`,
  `approveRun`, `uploadArtifact`/`downloadArtifact` (SHA-256 ellenőrzéssel),
  `listProjects`, `createProject`, `addMember`. Új adatelérési igényt ide
  (helper) tegyél, ne inline query-ként — ez a közös konzisztencia-réteg.

## DB-szabályok, amiket a séma kikényszerít (ne kerüld meg!)

- `context_entries.revision`-t trigger tölti ki és lépteti a projekt
  revíziót atomikusan — kliensről beküldött revision értéket felülír.
- `context_entries` és `decisions` IMMUTÁBILIS (a service role-nak is);
  javítás új bejegyzéssel + `supersedes_decision_ids`-szel.
- Kliensről (authenticated) `runs`/`external_actions` csak
  `awaiting_approval` állapotban szúrható be; minden állapotátmenet
  service role-lal történik (worker/API).
- Approvalt csak owner hozhat létre; nincs modellnek kiadható "approve"
  művelet (PROJECT_CONTEXT.md §7).
- Artifact bájtok: privát `artifacts` Storage bucket,
  `project_id/artifact_id/fájlnév` útvonalon; limitek: 1 MiB/fájl (DB
  CHECK), 20 MiB/projekt és 5 fájl/mentés (helper rétegben).

## Sémamódosítás

- MÁR ALKALMAZOTT migrációs fájlt (`supabase/migrations/*.sql`) TILOS
  módosítani — mindig új, időbélyeges fájl + `npm run db:push`.
- Sémaváltozásnál a `packages/db/src/types.ts`-t kézzel kell frissíteni
  (a generátor Dockert igényelne), és a `npm run smoke`-nak zöldnek kell
  maradnia.
- Titok (token, jelszó, kulcs) SOHA nem kerülhet táblába — a
  `connections.secret_ref` csak titoktári hivatkozás.

## Teszthozzáférés

- Userek: `owner@demo.test` (owner @ "Demo projekt"), `member@demo.test`
  (member @ "Demo projekt", owner @ "Zárt projekt"). Jelszó:
  `DEMO_USER_PASSWORD` az `.env`-ben.
- A "Zárt projekt" a jogosultsági negatív tesztekhez van — az
  `owner@demo.test` felől semminek nem szabad látszania belőle.

## DB domain round additions (2026-09-19, English — authoritative for new work)

Details and exact signatures: PROJECT_CONTEXT.md section 15. New rules:

### Commands added

| Command | What it does |
| --- | --- |
| `npm test` | vitest unit tests (packages/domain — JCS vectors, validator) |
| `npm run test:statemachine` | 22 live checks of the run state machine (disposable project) |
| `npm run test:e2e` | Full loop: save → prepare → approve → worker activates → claim → complete; measures claim latency vs the 15 s target |
| `npm run worker` | Starts the activation worker (5 s tick, service client) |

### Rules

- **Context writes**: use `saveContext` / `prepareRun` from `@demo/db` — they call the
  atomic `save_context` / `prepare_run` RPCs (SECURITY INVOKER; RLS still applies).
  Do not insert context batches with separate table writes any more.
- **Run state transitions**: ONLY via the service-role RPCs
  (`activate_due_runs`, `claim_run`, `heartbeat_run`, `complete_run`, `fail_run`,
  wrapped in `@demo/db` helpers). Never update `runs.state` directly. Closure is
  receipt-based and idempotent; artifact bytes go to Storage BEFORE `complete_run`.
- **Canonical hashing**: use `@demo/domain` (`canonicalJson`, `canonicalHash`,
  `computeSnapshotHash`, `computeRunInputHash`). `stableStringify` in `@demo/db`
  is legacy for internal comparison only — never for new hashes.
- **User-provided integration credentials** (Google/GitHub/Vercel/Composio/
  Supabase/Notion for the MCP workstream): store via `store_user_connection`
  (goes into Supabase Vault), read back ONLY server-side via
  `get_user_connection_secret` (service role). Never put a credential in any
  table column, log line or RPC response. The project-scoped `connections`
  table is unchanged and stays GitHub/external-action-only.
- **draft_brief validation**: `validateDraftBrief` from `@demo/domain` is the
  deterministic validator (v1); the model's own "done" claim is never proof.

## MCP workstream rules (merged from feat/mcp-server, 2026-09-19 — adapted to the merged root)

- Scope at merge time: local MCP server foundation — `apps/api` (Fastify + official
  MCP SDK v2) and `packages/contracts` (shared schemas; exports compiled `dist`).
- Root script mapping after the merge: the MCP branch's `npm test` is now
  `npm run test:api`; `npm run check` = typecheck + contracts/api tests + build;
  root `npm run build` builds db/domain/worker AND contracts/api; root `npm test`
  stays vitest (domain unit tests).
- Dependencies: `npm ci --ignore-scripts`. Pin new direct dependencies to exact
  versions released at least 7 days ago; keep the lockfile.
- Dev: `npm run dev`. Contracts compile on start; after contracts changes rerun
  `npm run build -w @demo/contracts` or restart.
- apps/api config comes from env vars: `HOST` only `127.0.0.1`; `PORT` default
  3000; `NODE_ENV` only `development` or `test`; `LOG_LEVEL` default `info`.
  No automatic dotenv loading in apps/api.
- `/health` is process liveness only. `/mcp` publishes only the read-only
  `server_info` diagnostic tool (no data storage, no external actions yet).
- Host/Origin validation, server-side request ids, request size limits and
  sanitized errors/logs are mandatory. Never log payloads, URL params, tokens,
  cookies or raw upstream errors.

## Design preview workspace (merged from design/personal-workspace-preview, 2026-09-19)

- The hackathon and the entire product are English-first. All UI copy, validation, accessibility labels, metadata, default preferences, sample data, and branding explanations must be in English, even when the user speaks Hungarian in chat.
- Coffeenator is the user's primary brand direction: a personal AI home with an optional coffee companion, gentle brewing metaphors, and reduced-motion-aware animations. It is not a coffee-ordering application.
- The only primary navigation items are Chat, Connectors, and Memory. Chat is the default landing screen. Profile, appearance, companions, onboarding, brand concepts, and AI subscription tracking are secondary dialogs or tabs, never extra main navigation items.
- Keep everyday screens visual and concise. Use explicit verbs such as Send, Connect, Import, Export, and Add note. Put explanations behind keyboard-accessible info controls that also open on tap.
- Composio ACTIVE means its connection flow completed, not that credentials were health-checked or content was indexed. Connection, health, and sync are independent states. Provider account payloads can contain credentials: only allowlisted, sanitized metadata may reach the UI. Sample records must be explicitly labelled and must never be persisted as live connections.
- The remote GitHub repo inspected on 2026-09-19 contains only .gitignore, README.md, and PROJECT_CONTEXT.md on main, with no published implementation branch or PR. Do not label integrations implemented on that evidence.
- Subscription costs, capabilities, device versions, and check dates in the local AI stack are user-reported. Never infer installed versions, paid plans, pricing, or guaranteed savings. Meeting notes and system-wide dictation are distinct capabilities.
- Privacy badges must describe actual behavior, not promise 100% security, production no-training terms, encryption, or inaccessible data without implementation and policy evidence.

- The `design/personal-workspace-preview` branch is isolated from the parallel backend sessions. Its implementation is under `docs/design/preview/`.
- The existing `PROJECT_CONTEXT.md` and `docs/design/README.md` describe the separate server-rendered backend MVP. The user subsequently approved a standalone, interactive product-design preview; do not change backend scope, auth, contracts, root manifests, or the original design tokens to implement this preview.
- This preview has no runtime dependencies and uses browser ES modules and Node.js built-ins. Run from the repository root with `node docs/design/preview/server.mjs`. It binds to loopback, on port 4173 by default; use `PORT=4174` if necessary.
- Run checks with `node --test docs/design/preview/*.test.mjs`, `node --check docs/design/preview/app.mjs`, and `git diff --check`.
- Google login, Google connectors, and backend synchronization are not implemented. Chat replies ARE live: the UI posts the conversation to same-origin `POST /api/chat`, which proxies the Anthropic API server-side (key never reaches the browser). Never simulate successful authentication or connected-account states. Keep upcoming capabilities explicitly labelled.
- No authentication (2026-09-19, user decision): the app opens directly; `/api/chat` and `/api/composio/check` are public, protected only by the per-IP rate limits. The `/auth` page and `api/_lib/auth.mjs` are kept but not wired into the app.
- Public MCP endpoint: `POST /mcp` (Vercel rewrite → `api/mcp.mjs`, logic in `api/_lib/mcp.mjs`, no npm deps). Stateless Streamable HTTP, JSON responses, GET → 405, Origin must match the deployment host, unsupported `MCP-Protocol-Version` → 400, 10 requests/60 s per IP. Tools: `server_info` and `chat` (uses the server's Anthropic key). Run `node --test api/_lib/mcp.test.mjs`.
- Connectors are bring-your-own-key only (no "Coming soon"): Composio, Anthropic (Claude card), OpenAI (ChatGPT card), Notion, GitHub and Supabase keys are stored only in the browser's localStorage (`coffeenator-preview-keys-v1`) and checked through the stateless `POST /api/keys/check` (`{ provider, apiKey }` → `{ healthy, account | reason }`). Gmail/Calendar/Drive connect through the user's Composio project. Keys are never stored, logged or echoed server-side; a new key is kept only after the provider accepts it. Every connector has an in-dialog guide linking the official key page.
- Profile preferences and a resized avatar are stored in localStorage. Imported context is only in sessionStorage for the current tab. Memory imports and profile data are never sent anywhere; chat messages are sent to the server-side Anthropic proxy only when the user presses Send. Keep import review, size/type validation, explicit consent, and source provenance intact.
- All in-app graphics are served locally; there are no external font, image, analytics, or tracking requests. Google product PNGs come from gstatic, Composio marks from https://brand.composio.dev/logo (preserve black/white variants), GitHub/Supabase/Claude marks from the CC0 Simple Icons repository, and the ChatGPT mark from Wikimedia Commons. Provider trademarks still belong to their owners; these marks identify tools, not partnerships.
- Import tutorials were checked against https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data and https://support.claude.com/en/articles/9450526-export-your-claude-data on 2026-09-19. Quick memory summaries may be partial. Full account exports must be extracted and reviewed; this preview does not accept ZIP, HTML, or PDF and does not migrate accounts or subscriptions.
- Before sharing the preview, check desktop and mobile layouts, dark/light/system modes, keyboard navigation, dialog dismissal, reduced motion, avatar upload, context import/export, and rejection of invalid files.
- Brand names are provisional design directions, not cleared trademarks or confirmed available domains.
