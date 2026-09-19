# Coffeenator

Coffeenator is a hackathon demo of a shared context store and approval-gated run
orchestration for AI agents, built on Supabase (Postgres with RLS, Vault,
Storage). Users explicitly save conversation context (decisions, tasks,
artifacts) into versioned, immutable project records; runs are prepared against
a hashed context snapshot and only execute after an owner approval, driven by a
worker through service-role-only state-machine RPCs. A hardened localhost
Fastify MCP server and a dependency-free demo UI (Chat / Connectors / Memory)
sit on top; the chat screen talks to a server-side Anthropic proxy.

## Architecture overview

```
packages/db         Typed Supabase data access + RPC wrappers (@demo/db)
packages/domain     RFC 8785 canonical JSON, SHA-256 hashing, draft_brief validator (@demo/domain)
packages/contracts  zod API/MCP schemas + shared response envelope (@demo/contracts)
apps/worker         Run activation worker (5 s tick, service client)
apps/api            Localhost Fastify MCP server: /health, /mcp (server_info tool),
                    POST /api/chat (server-side Anthropic proxy)
docs/design/preview Static, dependency-free demo UI (Chat / Connectors / Memory)
api/chat.mjs        Vercel serverless function (Anthropic proxy) + vercel.json
supabase/           SQL migrations (applied to the live project; append-only)
scripts/            seed + live gate scripts (smoke, statemachine, e2e)
```

## Requirements

- Node.js >= 24 and npm
- A Supabase project (URL, anon + service-role keys, session-pooler DB URL)
- An Anthropic API key (for the chat feature)

## Setup

```bash
git clone <repo-url> && cd <repo>
npm ci --ignore-scripts
cp .env.example .env   # then fill in values
npm run seed           # idempotent: test users + demo projects
```

`.env` variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` (use the session pooler — the
direct `db.<ref>.supabase.co` host is IPv6-only and may be unreachable),
`DEMO_USER_PASSWORD`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`.

## Running the demo

```bash
npm run demo   # then open http://127.0.0.1:4173
```

Three screens:

- **Chat** (default) — sends messages to `POST /api/chat`, which proxies
  Anthropic server-side (the key never reaches the browser). Requires
  `ANTHROPIC_API_KEY` in `.env`.
- **Connectors** — provider connection UI with explicitly labelled sample
  data; no live provider integrations are wired up.
- **Memory** — import/review of exported ChatGPT/Claude context; imported
  content lives only in `sessionStorage` for the current tab and is not sent
  to any backend.

## Commands

| Command | What it does |
| --- | --- |
| `npm run build` | Build db, domain, worker, contracts and api (tsc) |
| `npm test` | vitest unit tests (`packages/domain`) |
| `npm run test:api` | contracts + apps/api tests (node --test) |
| `npm run test:contracts` | contracts tests only |
| `npm run typecheck` | Full-repo typecheck |
| `npm run check` | typecheck + contracts/api tests + build |
| `npm run smoke` | Live checks against the Supabase DB (RLS, triggers, hashes, Vault) |
| `npm run test:statemachine` | Live run state-machine checks (disposable project) |
| `npm run test:e2e` | Full loop: save → prepare → approve → worker → claim → complete |
| `npm run worker` | Start the activation worker |
| `npm run seed` | Idempotent seed (test users + demo projects) |
| `npm run demo` | Serve the static demo UI + chat proxy on 127.0.0.1:4173 |
| `npm run db:push` | Apply NEW migrations to the live DB (should be a no-op) |

## Verification gates

Expected results (exact counts — fewer passes means a gate silently vanished):

- `npm run build` — green
- `npm test` — 47/47 (vitest, domain)
- `npm run test:api` — all contracts/api tests pass
- `npm run smoke` — 40 PASS, 0 FAIL
- `npm run test:statemachine` — 22 PASS, 0 FAIL
- `npm run test:e2e` — 20 PASS, 0 FAIL; claim latency ≤ 15 s
- UI tests: `node --test docs/design/preview/*.test.mjs`

CI (GitHub Actions, `.github/workflows/ci.yml`) runs install, build, unit,
api, typecheck and UI checks on every push to main and every pull request.
The live-DB gates are excluded from CI (they need Supabase credentials).

**Warning:** `smoke`, `test:statemachine` and `test:e2e` run against the live,
shared Supabase database (in disposable projects with cleanup). Never run
`test:statemachine` and `test:e2e` in parallel — run claiming is global and
they can steal each other's queued runs. Don't leave `npm run worker` running
during the state-machine tests.

## Deployment (Vercel)

The user deploys to Vercel: `vercel.json` serves the static UI
(`docs/design/preview`) as the site root and the `api/` directory as serverless
functions (Anthropic chat proxy, sign-in, user connections). Environment
variables to set in Vercel:

- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` — chat proxy
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — sign-in
  and user connections (the service-role key stays server-side; it is required
  for connection health checks that read secrets back from Supabase Vault)

Without the Supabase variables the site still serves and chat works; sign-in
and connections return a clear "not configured" error.

## Security notes

- Row Level Security on every table; run/task state transitions happen only
  through service-role RPCs.
- The service-role key is server-only — never in a UI bundle or client code.
- Integration credentials live only in Supabase Vault (tables hold references,
  never secrets); readback is service-role only.
- `context_entries` and `decisions` are immutable, even for the service role;
  corrections are new entries with supersede links.
- Logs are sanitized: no payloads, tokens, keys or raw upstream errors.
- `POST /api/chat` is rate limited (10 requests/min per IP, sliding window).
  On Vercel the limiter is per warm instance — for a strict global limit add a
  shared store (e.g. Vercel KV). Replies are tuned server-side for concise,
  plain-text output (no markdown), in the user's language.

## Further reading

- `AGENTS.md` — working rules, DB-layer usage, MCP and UI-preview constraints
- `REVIEW.md` — review notes
- `HANDOVER_DB_DOMAIN.md` — DB/domain round deliverables, gate evidence, merge playbook
- `PROJECT_CONTEXT.md` — original plan and contracts (§14/§15 = approved deviations)
