# REVIEW.md

Review guide for this repo (hackathon project). Authoritative companions:
`AGENTS.md`, `PROJECT_CONTEXT.md` (§14/§15), `HANDOVER_DB_DOMAIN.md` (§3, §5, §9).

## Project intent

A shared context store for AI agents: users save conversation context (entries,
decisions, tasks, artifacts) into a Supabase-backed, RLS-enforced multi-tenant DB,
and agent runs execute only after explicit owner approval. Surfaces: `packages/db`
(`@demo/db` helpers), `packages/domain` (`@demo/domain` canonical hashing/validation),
`apps/worker` (activation worker), `apps/api` (Fastify + MCP server, loopback-only),
a static demo UI under `docs/design/preview/`, and a server-side Anthropic-backed
chat proxy (`POST /api/chat`: serverless `api/chat.mjs` and a local proxy in the
preview server). A public, stateless MCP endpoint is deployed at `/mcp`
(`api/mcp.mjs` + `api/_lib/mcp.mjs`, dependency-free, Streamable HTTP with JSON
responses; tools: read-only `server_info` and `chat`, which reuses the chat proxy;
tests in `api/_lib/mcp.test.mjs`). The Fastify MCP scaffold in `apps/api` stays
loopback-only for local development (`npm run dev`).

**No authentication in the deployed preview (user decision, 2026-09-19).** The app
opens directly; `/api/chat`, `/api/keys/check` and `/mcp` are public and protected only by
per-IP rate limits (10/60 s per warm instance). `api/_lib/auth.mjs` and the `/auth`
page exist but are not wired into the app — do not re-add a login gate.

## Critical flows

- **Context writes are atomic RPCs**: `saveContext`/`prepareRun` in
  `packages/db/src/helpers/context.ts` / `runs.ts` wrap the SECURITY INVOKER
  `save_context`/`prepare_run` RPCs (`supabase/migrations/20260919130000_save_context_prepare_run.sql`).
  RLS still applies inside; a poisoned batch must write zero rows.
- **Run state machine is service-role only**: transitions happen exclusively via
  `activate_due_runs`, `claim_run`, `heartbeat_run`, `complete_run`, `fail_run`
  (`supabase/migrations/20260919131000_run_state_machine.sql`, wrapped in
  `packages/db/src/helpers/statemachine.ts`). Closure is receipt-based and
  idempotent (`run_receipts`); artifact bytes go to Storage BEFORE `complete_run`.
  Clients may only INSERT runs in `awaiting_approval`.
- **Approvals are owner-only**; there is no model-invokable "approve" operation
  (PROJECT_CONTEXT.md §7). Approval expiry window is 1 h.
- **User connections are Vault-backed** (`supabase/migrations/20260919140000_user_connections.sql`,
  `packages/db/src/helpers/user-connections.ts`): store via `store_user_connection`,
  read back only server-side via `get_user_connection_secret` (service role).
  Secrets never appear in table columns, logs, or RPC responses.
- **Artifact integrity**: SHA-256-verified upload/download
  (`packages/db/src/helpers/artifacts.ts`); limits 1 MiB/file (DB CHECK),
  5 files/save, 20 MiB/project (helper layer); private `artifacts` bucket at
  `project_id/artifact_id/filename`.
- **Bring-your-own-key connectors** (Connectors page): every connector takes the
  user's own key — Composio, Anthropic (Claude card), OpenAI (ChatGPT card),
  Notion, GitHub, Supabase; Gmail/Calendar/Drive connect through the user's
  Composio project (status = ACTIVE `gmail`/`googlecalendar`/`googledrive`
  accounts among the first 100). Keys live ONLY in the browser's localStorage
  (`coffeenator-preview-keys-v1`). `POST /api/keys/check {provider, apiKey}`
  (`api/keys/check.mjs`, `handleKeyCheck` in `api/_lib/connections.mjs`) is
  stateless: one outbound call per check using `PROVIDER_HEALTH_CHECKS`, response
  = `{provider, healthy, account|reason[, toolkits]}` only. A new key is kept
  only after the provider accepts it. Each card has an in-dialog guide with the
  official key page; nothing is labelled "Coming soon".
- **Chat proxy**: `ANTHROPIC_API_KEY` lives only server-side (serverless
  `api/chat.mjs` / the local preview proxy). It must never reach the client
  bundle, response bodies, or logs — in any code path, including errors.

## Correctness — flag these

- Swallowed errors (empty catch, ignored rejected promises, unchecked Supabase
  `error` fields) and unhandled promise rejections.
- Direct `runs.state` updates (SQL or supabase-js) bypassing the five state-machine
  RPCs — this breaks lease/attempt/receipt invariants.
- Hand-rolled multi-statement context inserts instead of `saveContext`/`prepareRun`
  — the old three-statement path is exactly the non-atomic failure mode the RPCs fixed.
- Hashing anywhere other than `@demo/domain` (`canonicalJson`, `canonicalHash`,
  `computeSnapshotHash`, `computeRunInputHash`). `stableStringify` in `@demo/db`
  (`packages/db/src/helpers/hash.ts`) is legacy, comparison-only — never for new
  hashes. Note `canonicalJson` THROWS on `undefined`; normalize optionals to
  explicit `null` (pattern in `packages/db/src/helpers/context.ts`).
- Any edit to an already-applied migration under `supabase/migrations/`
  (all seven `20260919*` files are applied on the live DB). Fixes = NEW
  timestamped file + `npm run db:push`.
- Race conditions around claim/lease/heartbeat, or code that trusts client clocks
  where the RPCs use DB time.
- UI success states not backed by a confirmed server response (the preview must
  never simulate successful auth or connected-account states; Composio ACTIVE
  means the connection flow completed, nothing more).

## Security — flag these

- Hardcoded secrets; credentials in logs, RPC responses, or error messages.
- `SUPABASE_SERVICE_ROLE_KEY` or `createServiceClient()` reachable from UI/client
  code or any browser bundle — it is backend-only (worker, API, seed, scripts).
- Injection (SQL, header, path); missing authorization checks; anything that
  weakens or bypasses RLS (e.g. SECURITY DEFINER additions without justification).
- Raw upstream provider errors (Anthropic, Supabase, OAuth providers) leaked to
  clients — `apps/api/src/app.ts` sets the pattern: sanitized error handler,
  redacting serializers, no payload/URL-param/token/cookie logging, host/origin
  validation, server-generated request ids.
- Oversized inputs bypassing documented limits: 64 KiB `submitted_text`,
  8 KiB `summary`, 32 KiB brief (plus the artifact limits above).
- Provider account payloads reaching the UI unfiltered — only allowlisted,
  sanitized metadata may be shown (AGENTS.md design-preview rules).
- A user API key persisted server-side (DB, Vault, cache), logged, echoed in any
  response/error, placed in a URL, or sent to any host other than the provider's
  documented endpoint in `PROVIDER_HEALTH_CHECKS`. `/api/keys/check` must stay
  allowlisted (`KEY_CHECK_PROVIDERS`), size-capped (4096 chars) and rate-limited.
- Known accepted risk: the public `/api/chat` spends the server's Anthropic
  credit; only the per-IP limit protects it.

## Maintainability

- Prefer existing patterns: `@demo/db` helpers for all data access (no inline
  queries), the `@demo/contracts` response envelope
  (`packages/contracts/src/index.ts`: `{ok, schema_version, request_id, data|error}`
  with the fixed error-code enum), and the existing Fastify hardening in
  `apps/api/src/app.ts`.
- Exactly ONE canonical-JSON/hash implementation: `@demo/domain`. Reject any new
  or copied JCS/hash code.
- No new dependency without checking existing usage first; new direct dependencies
  must be pinned to exact versions released at least 7 days ago; keep the lockfile
  (`npm ci --ignore-scripts` must succeed).
- `packages/db/src/types.ts` is maintained BY HAND (no Docker for the generator) —
  schema changes must update it and keep smoke green.

## Tests

- Every critical behavior change needs an executable test — a model's or author's
  "done" claim is never proof (cf. `validateDraftBrief` in `@demo/domain`).
- Gates keep their exact expected counts: `npm test` = 47 vitest domain tests,
  `npm run smoke` = 40, `npm run test:statemachine` = 22, `npm run test:e2e` = 20
  (incl. the ≤ 15 s claim-latency gate), plus `npm run test:api` (apps/api) and
  the UI suites (`node --test docs/design/preview/*.test.mjs docs/design/preview/auth/*.test.mjs`
  = 98, incl. the key-check endpoint tests: per-provider URL/header, key never
  echoed, 400 before any network call, 429 on the 11th check). A changed count
  needs an explicit, reviewed reason.
- Mocked happy-path tests are not sufficient proof for the main flow — the main
  loop is proven live (save → prepare → approve → activate → claim → complete).
- Live-DB tests (smoke/statemachine/e2e) use disposable projects (`smoke-*`,
  `e2e-*`) with full cleanup; seeded users/projects stay untouched.
  `test:statemachine` and `test:e2e` must never run in parallel.
