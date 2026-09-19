# DB domain round — full documentation and merge handover

Single source for everything this round did: the approved plan, the execution
record, every deliverable with exact signatures, the gate evidence, the
deviations, the live-DB state, and the playbook for the agent merging the three
workstreams (DB domain + MCP server + UI). Companion contracts:
`PROJECT_CONTEXT.md` §15 and the English section of `AGENTS.md`.

---

# PART I — What was done and how

## 1. Mission and approved plan (PLAN v1.1)

Executed on branch `feat/db-domain` (worktree
`/Users/nagypatrik2008/projects/devin-demo-db-work`), merged fast-forward into
local `main`. User-approved decisions that shaped the round:

| Decision | Choice |
| --- | --- |
| Execution model | Parallel background agents on disjoint paths; orchestrator commits per phase |
| RPC scope | BOTH `save_context` and `prepare_run` (not just save) |
| RPC security mode | SECURITY INVOKER (deviation from the original SECURITY DEFINER plan — RLS keeps enforcing all row rules inside; atomicity is identical) |
| Multi-provider connections | Migration 7 included NOW (for the MCP integrations workstream), Vault-backed |
| End of round | Merge `feat/db-domain` → local `main`; NO push |
| Language | Everything in English (code, comments, SQL, docs, commits) |
| Stale branch handling | Main folder switched from the misleading local `feat/mcp-server` to `main`; the stale branch left in place (see Part II hazards) |

Numbers were derived, not invented (PROJECT_CONTEXT §8/§10): lease 90 s,
heartbeat 30 s, runtime cap 180 s, max 2 attempts, worker poll 5 s, approval
window 1 h, claim-after-due target ≤ 15 s.

## 2. Execution record

| Phase | Who | What |
| --- | --- | --- |
| 0 | orchestrator | Worktree from `main`, `.env` copy, workspaces + `apps/*`, vitest 4.1.11 (newest release older than 7 days, verified against TypeScript 7), skeletons for `packages/domain` + `apps/worker`; committed `fa41b7e` |
| 1 | 2 parallel agents | Lane 1: migrations 5+6 + `@demo/db` RPC/state-machine helpers + smoke/statemachine gates. Lane 2: `packages/domain` (JCS, hashing, validator, 47 tests). Orchestrator re-ran all gates, committed `5774d25`, `731cb9d` |
| 2 | 3 parallel agents | Agent A: migration 7 (user_connections + Vault) + helpers + smoke section 8. Agent B: `apps/worker` + `scripts/e2e-run-test.ts`. Agent C: hash cutover of `@demo/db` to `@demo/domain`. Orchestrator re-ran the full suite, committed `e90add7`, `42fa76f`, `cec1d41` |
| Docs | orchestrator | `PROJECT_CONTEXT.md` §15 + `AGENTS.md` English rules (`462f0f2`); this file (`5c12d51`+) |
| Close | orchestrator | `git merge --ff-only feat/db-domain` into local `main` |

All live testing ran in disposable projects (`smoke-*`, `e2e-*`) with full
cleanup; the seeded users/projects were never touched. Nothing was pushed.

## 3. Deliverables in detail

### 3.1 Migration 5 — `save_context` + `prepare_run` (SECURITY INVOKER RPCs)

File: `supabase/migrations/20260919130000_save_context_prepare_run.sql`.
EXECUTE: `authenticated` + `service_role`; revoked from `public`/`anon`.
RLS still applies inside (invoker); atomicity = the single function transaction.

```sql
public.save_context(p_project_id uuid, p_source jsonb, p_coverage public.coverage_kind,
  p_summary text, p_content_hash text, p_submitted_text text default null,
  p_full_text_artifact_id uuid default null, p_decisions jsonb default '[]',
  p_tasks jsonb default '[]') returns jsonb
  -- -> {entry, decisions:[...], tasks:[...], context_revision}
  -- p_source = {kind, label, conversation_ref?, occurred_at?}
  -- p_decisions[] = {key, value, source_excerpt?, supersedes_decision_ids?}
  -- p_tasks[] = {title, required_decision_keys?, input_artifact_ids?}

public.prepare_run(p_project_id uuid, p_task_id uuid, p_context_revision integer,
  p_context_entry_ids uuid[], p_payload_hash text, p_snapshot_hash text default null,
  p_run_at timestamptz default null) returns jsonb  -- -> full run row
```

Error contract (exception messages): `NOT_FOUND` (foreign/unknown project or
task — no existence leak), `VALIDATION_ERROR: <detail>`,
`DECISION_CONFLICT: <key>`, `CONTEXT_INCOMPLETE: <key>` (required keys resolved
over the SELECTED entries only). `run_at`: at most 24 h ahead, 10 s past grace.
Hashes are computed by the TypeScript layer and shape-checked (`^[0-9a-f]{64}$`)
in SQL — RFC 8785 cannot be reproduced reliably in plpgsql.

### 3.2 Migration 6 — run state machine (service-role only)

File: `supabase/migrations/20260919131000_run_state_machine.sql`.
New table `run_receipts` (RLS on, ZERO policies; unique
`(run_id, attempt_id, result_key)`; composite FK to runs, cascade). Functions
(SECURITY DEFINER, EXECUTE only `service_role`):

```sql
public.activate_due_runs() returns jsonb
  -- {scheduled, queued, blocked, lease_requeued, lease_failed}; DB-time based:
  -- approved+due -> queued / future -> scheduled; expired/revoked approval ->
  -- blocked (APPROVAL_EXPIRED); expired lease -> requeue (attempt<2, valid
  -- approval) or failed (LEASE_EXPIRED) + task blocked
public.claim_run(p_preset public.task_kind default 'draft_brief') returns jsonb
  -- FOR UPDATE SKIP LOCKED; {run, lease_token} or null; attempt+1, new
  -- attempt_id, lease 90 s; plaintext token returned exactly once, SHA-256 stored
public.heartbeat_run(p_run_id uuid, p_attempt_id uuid, p_lease_token text) returns jsonb
  -- {lease_expires_at}; raises LEASE_EXPIRED on any mismatch/expiry
public.complete_run(p_run_id uuid, p_attempt_id uuid, p_lease_token text,
  p_result_key text, p_payload_hash text, p_artifact jsonb, p_checks jsonb) returns jsonb
  -- receipt-idempotent: identical retry -> stored receipt (even after lease
  -- expiry); different payload -> IDEMPOTENCY_CONFLICT; new closure needs a
  -- live lease + current attempt; artifact row + run succeeded + task done +
  -- receipt in ONE transaction. Bytes go to Storage BEFORE this call.
public.fail_run(p_run_id uuid, p_attempt_id uuid, p_lease_token text,
  p_result_key text, p_error_code text, p_safe_message text,
  p_retryable boolean default false) returns jsonb
  -- same receipt logic; retryable + attempt<2 + valid approval -> queued,
  -- else failed + task blocked. Fingerprint derived in-function:
  -- sha256(error_code \n safe_message \n retryable)
```

### 3.3 Migration 7 — user-scoped provider connections + Vault

File: `supabase/migrations/20260919140000_user_connections.sql`. For the MCP
integrations (user-provided, persistent credentials: google, github, vercel,
composio, supabase, notion). New enum `provider_kind`; table `user_connections`
(user-scoped; unique `(user_id, provider, label)`; RLS: select-own-rows ONLY,
no client write policies — every write goes through the functions so Vault
bookkeeping can never be skipped). Credentials live in Supabase Vault
(supabase_vault 0.3.1); the table stores only the `vault.secrets.id` reference
and RPC responses strip even that.

```sql
public.store_user_connection(p_provider public.provider_kind, p_secret text,
  p_label text default '', p_scopes text[] default '{}',
  p_metadata jsonb default '{}') returns jsonb   -- authenticated + service_role
  -- upsert on (user, provider, label): active row -> Vault secret rotated in
  -- place; revoked row -> re-activated with a fresh Vault secret
public.revoke_user_connection(p_connection_id uuid) returns jsonb
  -- authenticated + service_role; deletes the Vault row, sets revoked_at;
  -- idempotent; foreign/missing id -> NOT_FOUND (no existence leak)
public.get_user_connection_secret(p_connection_id uuid) returns text
  -- SERVICE ROLE ONLY: decrypted readback for the MCP backend; user-facing
  -- clients can never read a secret back
```

### 3.4 `packages/domain` (`@demo/domain`)

- `canonicalJson` — RFC 8785/JCS: recursive UTF-16 code-unit key sort,
  ECMAScript number/string serialization; THROWS on NaN/Infinity/BigInt/
  `undefined` (silent dropping could make two different inputs hash equal).
  Pinned byte-exactly to the RFC test vectors (incl. the §3.2.3 key-order
  vector with the surrogate-pair case).
- `sha256Hex`, `canonicalHash` (Web Crypto, portable).
- `ContextSnapshotV1`, `RunInputV1` types + `computeSnapshotHash`,
  `computeRunInputHash` — normalize list order field-by-field (stray runtime
  properties are stripped), so caller ordering can never change a hash.
  `RUN_LIMITS_V1` = {90, 30, 180, 2}.
- `validateDraftBrief(md, {title, bulletCount, marker})` — deterministic v1
  validator: ≤ 32 KiB UTF-8, exact first ATX H1, exact top-level unordered
  bullet count (nested/fenced-code content ignored, CommonMark-style fences),
  literal marker substring; all checks always run; never throws on bad docs.

### 3.5 `packages/db` (`@demo/db`) changes

- `saveContext`/`prepareRun` now call the RPCs (same TS signatures as before).
- `content_hash`/`payload_hash` computed with `@demo/domain` `canonicalHash`
  over explicitly null-normalized shapes (canonicalJson throws on `undefined`).
  `stableStringify` demoted: internal decision-value comparison only.
- New `helpers/statemachine.ts`: `activateDueRuns`, `claimRun`, `heartbeatRun`,
  `completeRun`, `failRun` (service client wrappers).
- New `helpers/user-connections.ts`: `storeUserConnection`,
  `listUserConnections`, `revokeUserConnection`, `getUserConnectionSecret`.
- `types.ts` extended BY HAND (gen types needs Docker, absent here) with the
  new table, enum and all 10 functions.

### 3.6 `apps/worker` (`@demo/worker`)

5 s tick calling `activate_due_runs` with the service client (all state
decisions are DB-time based inside the RPC). JSON-line logs `{ts, level,
event, ...}`; ticks logged only when transitions > 0; NO env values/keys/
tokens ever logged (E2E asserts the service key never appears in output).
Missing env → one clear line + exit 1. After 5 consecutive failures:
exponential backoff 10→20→40→60 s, reset on success. SIGTERM/SIGINT →
graceful shutdown (finish in-flight tick, exit 0). Start: `npm run worker`.

### 3.7 Gate scripts

- `scripts/smoke.ts` — 40 live checks (19 original + RPC atomicity/decision
  gates + user_connections/Vault section).
- `scripts/statemachine-test.ts` — 22 checks: parallel claim (exactly one
  winner), double complete (identical receipt, one artifact, no second
  transition), payload conflict, stale-attempt exclusion after lease expiry,
  attempt cap → failed + task blocked, expired approval → blocked.
- `scripts/e2e-run-test.ts` — 20 checks: full loop (save → prepare → approve →
  REAL worker child activates → simulated runner claims → domain-validated
  brief.md → storage upload → receipt closure → byte-equal download →
  idempotent retry → graceful worker shutdown), with the ≤ 15 s claim gate.

## 4. Gate evidence (final, re-run by the orchestrator after integration)

| Gate | Result |
| --- | --- |
| `npm run build` (tsc -b, 3 packages) | green |
| `npm test` (vitest, domain) | 47/47 |
| `npm run smoke` | 40 PASS, 0 FAIL |
| `npm run test:statemachine` | 22 PASS, 0 FAIL |
| `npm run test:e2e` | 20 PASS, 0 FAIL; claim latency **1.98 s** (target ≤ 15 s) |

Gates were proven to fail for the reason they were written (guard-weakening via
psql `create or replace`, observed failures, restored): receipt lookup disabled
→ the double-complete gate failed; attempt_id/lease checks removed → the
stale-attempt gates failed. Afterwards the live function bodies were verified
byte-identical to the migration files. The save_context atomicity gate measures
exactly the failure mode of the old three-statement path (poisoned batch →
zero rows, revision unchanged). Post-round DB state: only the two seeded
projects; zero leftover Vault rows.

## 5. Deviations log (all of them, with reasons)

1. SECURITY INVOKER instead of DEFINER for the two client RPCs (user-approved;
   defense in depth — RLS cannot be bypassed even by an RPC bug).
2. `fail_run` derives its receipt fingerprint in-function (the signature
   carries no client hash; identical retries must match, different reports
   must conflict).
3. `claim_run` defensive attempt-cap path reuses error code `LEASE_EXPIRED`
   (stays within the documented §6 code list; unreachable race guard).
4. `run_at` past grace made concrete: 10 seconds (client clock skew).
5. Vault re-store after revoke re-activates the revoked row with a fresh Vault
   secret (the unique key covers revoked rows; a plain insert would violate it).
6. Per-function `log_statement='none'` is NOT installable on hosted Supabase
   (SUSET parameter, verified "permission denied") — documented in migration 7;
   project-level statement logging must stay off (default `log_statement=ddl`
   complies) so `store_user_connection` arguments are never logged.
7. `apps/worker/tsconfig.json` sets `emitDeclarationOnly: true` +
   `rewriteRelativeImportExtensions: false` (TS2878 with cross-package `.ts`
   source imports under TypeScript 7); worker runs via tsx, typecheck flows
   through project references.
8. E2E storage path uses `projectId/<random-uuid>/brief.md` — the middle
   segment is a placeholder for the artifact id; the future runner HTTP API
   owns the exact convention (`complete_run` records `storage_path` verbatim).

## 6. Environment and commands reference

`.env` keys (values never printed/committed): `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`
(session pooler — the direct `db.<ref>.supabase.co` host is IPv6-only and
unreachable from this network), `DEMO_USER_PASSWORD`, plus MCP-side
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`ANTHROPIC_*`.

| Command | What it does |
| --- | --- |
| `npm run build` | `tsc -b packages/db packages/domain apps/worker` |
| `npm test` | vitest (domain unit tests) |
| `npm run smoke` | 40 live checks (disposable project) |
| `npm run test:statemachine` | 22 live state-machine checks |
| `npm run test:e2e` | full-loop gate incl. real worker + latency measurement |
| `npm run worker` | starts the activation worker |
| `npm run seed` | idempotent seed (test users + demo projects) |
| `npm run db:push` | apply NEW migrations (must be a no-op right now) |
| `npm run db:types` | type generation — REQUIRES DOCKER, not available here |

Test users: `owner@demo.test` (owner @ "Demo projekt"), `member@demo.test`
(member @ "Demo projekt", owner @ "Zárt projekt").

---

# PART II — Merge playbook (for the single merging agent)

## 7. Branch and repo topology — read before touching git

| Where | Branch | Head | Content |
| --- | --- | --- | --- |
| `/Users/nagypatrik2008/projects/Devin Demo` (this repo) | `main` | contains everything above (MERGE TARGET) | base + full DB domain round; ahead of `origin/main` (`a225ead`); NOT pushed |
| same repo | `feat/db-domain` | = `main` | already fast-forwarded; checked out in the worktree below |
| same repo | `feat/mcp-server` | `dc1989f` | **STALE, MISLEADING**: only old DB commits, NO MCP work |
| same repo | `codex/munka-2026-09-19` | `4e0cc40` | UI branch — currently BEHIND base, no UI work committed here |
| `/Users/nagypatrik2008/projects/devin-demo-db-work` | worktree of `feat/db-domain` | = `main` | safe to remove after merge (`git worktree remove`) |
| `/Users/nagypatrik2008/projects/Devin Demo MCP` (separate clone) | `feat/mcp-server` | `c0849df` | **THE REAL MCP WORK** ("Establish an isolated, locally testable MCP foundation"), forked from `a225ead`; adds `apps/api` (`@demo/api`) + `packages/contracts` (`@demo/contracts`); its remote `source` points back at this repo |

Hazards:

1. **Two different branches named `feat/mcp-server`.** Delete the stale local
   one FIRST (`git branch -D feat/mcp-server` here is safe — its commits are
   all in `main`), then fetch the real one:
   `git remote add mcp "../Devin Demo MCP" && git fetch mcp feat/mcp-server`.
2. The UI branch in this repo has no UI work. Confirm with the UI developer
   where their commits actually live before assuming this branch is the source.
3. Nothing has been pushed to `origin`. Do not push without explicit approval.

## 8. CRITICAL: the live database is already migrated

All seven migrations are applied and recorded in
`supabase_migrations.schema_migrations`:

```
20260919110000_types.sql            20260919130000_save_context_prepare_run.sql
20260919110100_tables.sql           20260919131000_run_state_machine.sql
20260919110200_functions_triggers.sql   20260919140000_user_connections.sql
20260919110300_rls_storage.sql
```

- **Never edit an applied migration file.** Any fix = a NEW timestamped file +
  `npm run db:push`.
- Post-merge `npm run db:push` must report nothing to apply. If it wants to
  apply anything, STOP and investigate first.
- `packages/db/src/types.ts` is maintained by hand (no Docker for the
  generator). If the MCP side also touched it (it should not have), merge both
  hunks manually and typecheck.
- Seeded users/projects must survive untouched.

## 9. Binding contracts every merged workstream must respect

1. **Context writes** via `saveContext`/`prepareRun` (`@demo/db`) — they wrap
   the atomic RPCs. No hand-rolled multi-statement context inserts.
2. **Run state transitions are service-role only** (the five state-machine
   RPCs / their wrappers). Clients can only INSERT runs in `awaiting_approval`
   (RLS). Never UPDATE `runs.state` directly, not even from the API. Artifact
   bytes go to Storage BEFORE `complete_run`.
3. **Hashing**: `@demo/domain` is the only sanctioned canonical-JSON/hash
   implementation. It THROWS on `undefined` — normalize optionals to explicit
   `null` (pattern in `packages/db/src/helpers/context.ts`).
4. **Secrets**: integration credentials only via `store_user_connection`
   (Vault); readback only server-side via `get_user_connection_secret`
   (service role). No credential in any table column, log, RPC response or UI
   bundle. `createServiceClient` is backend-only, never in a browser bundle.
5. **Immutability**: `context_entries`/`decisions` reject UPDATE even for the
   service role. Corrections = new entry + `supersedes_decision_ids`.
6. **Limits** (DB CHECK + helper layer): 1 MiB/file, 5 files/save,
   20 MiB/project, 64 KiB submitted_text, 8 KiB summary, 32 KiB brief.

## 10. Expected merge conflicts and recommended resolutions

The MCP branch forked from `a225ead`, BEFORE the DB round created the root
tooling, so both sides CREATED several root files → expect add/add conflicts:

| File | Conflict type | Recommended resolution |
| --- | --- | --- |
| `package.json` (root) | add/add | Union. Workspaces `["packages/*", "apps/*"]` covers both sides. Merge scripts (keep all of ours; add theirs, renaming on collision). Merge devDependencies: single versions of `typescript` (^7.0.2) and `vitest` (^4.1.11); if the MCP side pins different majors, test with ours first — our gates are pinned to them |
| `package-lock.json` | add/add | Do NOT hand-merge. Resolve `package.json` first, delete the conflicted lockfile, `npm install`, commit the regenerated one. Then a fresh `npm ci --ignore-scripts` must succeed |
| `tsconfig.base.json` | add/add | Compare carefully (theirs also has a `tsconfig.check.json`). Prefer per-package overrides over changing the base — `apps/worker/tsconfig.json` shows the pattern and documents why |
| `AGENTS.md` | add/add or content | Concatenate: keep the full DB-domain version (Hungarian core + English rules) and append the MCP-specific sections. Nothing may be dropped |
| `PROJECT_CONTEXT.md` | content (if MCP edited it) | Ours adds §15 + one English parenthetical in §14. Keep both sides' additions; sections are append-only by convention |
| `.gitignore`, `README.md` | trivial | Union |
| `scripts/`, `supabase/`, `packages/db`, `packages/domain`, `apps/worker` | none expected | DB-domain territory. If the MCP side touched them, treat as a red flag and reconcile deliberately |
| `apps/api`, `packages/contracts` | none expected | MCP territory, new paths |

If the UI branch adds a third workspace (e.g. `apps/web`), repeat the union
logic; the UI must consume ONLY `createAnonClient` + helpers from `@demo/db`
(never the service key; approvals are owner-only and RLS enforces it).

## 11. Post-merge verification checklist (in this order)

```bash
npm ci --ignore-scripts          # lockfile-clean install must succeed
npm run build                    # green
npm test                         # 47/47 (domain)
npm run db:push                  # MUST report nothing to apply
npm run smoke                    # 40 PASS, 0 FAIL
npm run test:statemachine        # 22 PASS, 0 FAIL
npm run test:e2e                 # 20 PASS, 0 FAIL; claim latency ≤ 15 s
# MCP side: their check/test suite + a live tools/list + server_info call
# against apps/api, per their own handover doc
```

Expected numbers are exact — a lower PASS count means a gate silently vanished
in the merge; treat that as a failure even if nothing "errors".

## 12. Live-DB test etiquette (shared database!)

- Every test uses a disposable project and cleans up in `finally`. After a
  crashed run, delete leftovers with the service client before re-running.
- `claim_run` is GLOBAL by design. **Never run `test:statemachine` and
  `test:e2e` in parallel** — they can steal each other's queued runs. Smoke is
  always safe (it never queues).
- Don't leave `npm run worker` running while executing the state-machine tests
  (the E2E test spawns and owns its own worker child).

## 13. Sharp edges the merge agent should know

1. TypeScript 7 (tsgo): keep the `apps/worker/tsconfig.json` deviation
   (section 5, item 7) unless you re-run the build to prove an alternative.
2. `import { canonicalHash } from '@demo/domain'` works via workspace symlink +
   `exports → ./src/index.ts` under NodeNext — use the package name everywhere.
3. vitest 4.1.11 was chosen deliberately (supply-chain age rule, TS 7
   compatibility verified). Don't bump to 5.x during the merge.
4. Session pooler only for psql/CLI (`SUPABASE_DB_URL`); the direct DB host is
   unreachable from this network.
5. Worker logs are secret-free BY CONTRACT (E2E asserts it). Keep that property
   when touching logging.
6. Statement logging must stay off at project level (see section 5, item 6).

## 14. Integration pointers for the MCP and UI workstreams

- MCP `context_save` tool = thin wrapper: validate input against
  `@demo/contracts`, call `saveContext` with an authenticated client, map the
  RPC exception messages (`NOT_FOUND`, `VALIDATION_ERROR: …`,
  `DECISION_CONFLICT: <key>`, `CONTEXT_INCOMPLETE: <key>`) onto the §6
  error-code envelope. Same pattern for `run_prepare` → `prepareRun`.
- **Overlap to resolve deliberately**: `@demo/contracts` (envelope,
  request_id, error codes) and `@demo/domain` (canonical JSON, hashes,
  validator) are complementary. If contracts contains any hashing or
  canonicalization stub, replace it with `@demo/domain` imports — there must be
  exactly ONE canonical-JSON implementation in the merged repo.
- The API layer that assembles `RunInputV1` should adopt `computeRunInputHash`
  (the current `prepareRun` helper hashes the v1 client payload; the full
  snapshot hash is the API-layer contract).

## 15. Hard rules (do not violate during or after the merge)

1. No editing/renumbering applied migrations; new file or nothing.
2. No secrets in tables, logs, commit messages or client bundles; Vault +
   `secret_ref` only. `.env` never gets committed.
3. No direct `runs`/`tasks`/`external_actions` state writes from any client
   path; service RPCs only.
4. No `git push` and no destructive git surgery without explicit user approval.
5. Safe teardown order: finish merge on `main` → `git worktree remove
   ../devin-demo-db-work` → delete stale branches.

## 16. Known open items (NOT delivered by this round — don't expect them)

- OAuth/MCP auth flow (§7), the MCP business tools, public hosting — MCP
  workstream territory.
- `apps/runner` (Codex CLI executor), the GitHub issue worker action (§9) and
  the runner HTTP API — developer B territory; the DB side
  (claim/heartbeat/complete/fail + receipts) is live and tested, so they are
  unblocked.
- UI beyond seeded-login basics.
- `github_issue_prepare`/`github_issue_get` RPC hardening analogous to
  `prepare_run` (external_actions still use the RLS-guarded INSERT path).
