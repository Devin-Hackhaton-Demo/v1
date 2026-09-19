# Handover — DB domain round (`main`, formerly `feat/db-domain`)

Audience: the single agent performing the three-way merge (DB domain + MCP server
+ UI). This documents what this round delivered, what is already live, exactly
where the merge will hurt, and how to verify the result. Read this together
with `PROJECT_CONTEXT.md` section 15 and the English section of `AGENTS.md` —
those two are the binding contracts; this file is the merge playbook.

---

## 1. TL;DR

- This repo's local `main` (`462f0f2`) contains the complete, gate-verified DB
  domain round: 9 commits ahead of `origin/main` (`a225ead`). Nothing was pushed.
- The live Supabase database is ALREADY migrated (7 migration files applied and
  recorded). Merging code does not require any DB action; re-applying or editing
  migrations is the main thing that can break the world.
- Full gate suite at close: build green, vitest 47/47, smoke 40 PASS,
  statemachine 22 PASS, e2e 20 PASS (claim latency 1.98 s vs the 15 s target).
- Everything the MCP server needs (atomic `save_context`, validated
  `prepare_run`, canonical hashing, Vault-backed user connections) is live and
  documented with exact signatures in `PROJECT_CONTEXT.md` §15.

## 2. Branch and repo topology — read before touching git

| Where | Branch | Head | Content |
| --- | --- | --- | --- |
| `/Users/nagypatrik2008/projects/Devin Demo` (this repo) | `main` | `462f0f2` | Base + full DB domain round (MERGE TARGET) |
| same repo | `feat/db-domain` | `462f0f2` | Identical to `main` (already fast-forwarded); lives in the worktree below |
| same repo | `feat/mcp-server` | `dc1989f` | **STALE, MISLEADING**: contains only old DB commits, NO MCP work |
| same repo | `codex/munka-2026-09-19` | `4e0cc40` | UI branch — currently BEHIND base, no UI work committed here |
| `/Users/nagypatrik2008/projects/devin-demo-db-work` | worktree of `feat/db-domain` | `462f0f2` | Working copy used by this round; safe to remove after merge (`git worktree remove`) |
| `/Users/nagypatrik2008/projects/Devin Demo MCP` (separate clone) | `feat/mcp-server` | `c0849df` | **THE REAL MCP WORK** ("Establish an isolated, locally testable MCP foundation"), branched from `a225ead`; its git remote `source` points back at this repo |

Hazards:

1. **Two different branches named `feat/mcp-server` exist** (stale one here,
   real one in the MCP clone). Delete or rename the stale local one FIRST
   (`git branch -D feat/mcp-server` here is safe — its commits are all in
   `main`), then fetch the real one:
   `git remote add mcp "../Devin Demo MCP" && git fetch mcp feat/mcp-server`.
2. The UI branch in this repo has no UI work. Confirm with the UI developer
   where their commits actually live before assuming the branch is the source.
3. Nothing has been pushed to `origin`. Do not push without explicit approval.

## 3. What this round delivered (commit by commit)

| Commit | Content |
| --- | --- |
| `fa41b7e` | Workspace scaffold: `apps/*` workspaces, vitest 4.1.11 (verified against TypeScript 7), skeletons for `packages/domain` and `apps/worker` |
| `5774d25` | `packages/domain` (`@demo/domain`): RFC 8785 canonical JSON (pinned byte-exactly to the RFC test vectors), `sha256Hex`/`canonicalHash`, `ContextSnapshotV1`/`RunInputV1` + order-normalizing hash functions, `RUN_LIMITS_V1`, deterministic `validateDraftBrief` (v1). 47 vitest tests |
| `731cb9d` | Migration 5 (`save_context`, `prepare_run` — SECURITY INVOKER RPCs) + migration 6 (run state machine: `run_receipts` table + 5 SECURITY DEFINER service-role-only functions); `@demo/db` helpers switched to the RPCs; `scripts/statemachine-test.ts` (22 checks); smoke extended to 26 |
| `e90add7` | Migration 7 (`provider_kind` enum, `user_connections` table, Vault-backed secret functions) + `@demo/db` user-connection helpers; smoke extended to 40 |
| `42fa76f` | `@demo/db` hashing cutover: `content_hash`/`payload_hash` now computed with `@demo/domain` `canonicalHash` (RFC 8785); `stableStringify` demoted to internal comparison only |
| `cec1d41` | `apps/worker` (5 s activation loop, secret-free JSON logs, backoff, graceful shutdown) + `scripts/e2e-run-test.ts` (full loop incl. real worker child process, ≤15 s claim gate) |
| `462f0f2` | Docs: `PROJECT_CONTEXT.md` §15 (exact RPC signatures, semantics, gate results) + `AGENTS.md` English rules section |

Package map after this round: `@demo/db` (packages/db), `@demo/domain`
(packages/domain), `@demo/worker` (apps/worker). The MCP clone adds `@demo/api`
(apps/api) and `@demo/contracts` (packages/contracts) — no name or path
collisions with ours.

## 4. CRITICAL: the live database is already migrated

The shared Supabase project (see `.env`: `SUPABASE_URL`, session-pooler
`SUPABASE_DB_URL`) already has ALL SEVEN migrations applied and recorded in
`supabase_migrations.schema_migrations`:

```
20260919110000_types.sql
20260919110100_tables.sql
20260919110200_functions_triggers.sql
20260919110300_rls_storage.sql
20260919130000_save_context_prepare_run.sql
20260919131000_run_state_machine.sql
20260919140000_user_connections.sql
```

Rules for the merge agent:

- **Never edit an applied migration file.** Any fix = a NEW timestamped file +
  `npm run db:push`. If a merge conflict touches a migration file, the resolution
  is always "keep it byte-identical to what was applied" (they only exist on the
  DB-domain side, so conflicts here would mean something went very wrong).
- `npm run db:push` after the merge should report "nothing to push". If it wants
  to apply anything, STOP and investigate before letting it.
- `npm run db:types` requires Docker (absent on this machine): `types.ts` is
  maintained BY HAND. If the MCP side also touched `packages/db/src/types.ts`
  (it should not have), merge both hunks manually and typecheck.
- Seeded data must survive untouched: users `owner@demo.test`, `member@demo.test`
  (password `DEMO_USER_PASSWORD` in `.env`), projects "Demo projekt" and
  "Zárt projekt". All tests create disposable projects and clean up.

## 5. Binding contracts every merged workstream must respect

Exact signatures live in `PROJECT_CONTEXT.md` §15. Summary of the boundaries:

1. **Context writes** go through `saveContext`/`prepareRun` in `@demo/db`
   (they wrap the atomic `save_context`/`prepare_run` RPCs). No hand-rolled
   multi-statement context inserts — the whole point of migration 5 is that a
   poisoned batch rolls back completely (smoke gate proves it).
2. **Run state transitions are service-role only**: `activate_due_runs`,
   `claim_run`, `heartbeat_run`, `complete_run`, `fail_run` (wrappers in
   `@demo/db` `helpers/statemachine.ts`). Clients can only INSERT runs in
   `awaiting_approval` (RLS-enforced). Never UPDATE `runs.state` directly, not
   even from the API. Closure is receipt-based and idempotent; artifact bytes
   go to the `artifacts` Storage bucket BEFORE `complete_run`.
3. **Hashing**: `@demo/domain` `canonicalJson`/`canonicalHash` (RFC 8785) is
   the only sanctioned hash serialization. It THROWS on `undefined` — normalize
   optionals to explicit `null` (see `helpers/context.ts` for the pattern).
   `stableStringify` is legacy, internal-only.
4. **Secrets**: user-provided integration credentials (google/github/vercel/
   composio/supabase/notion) go through `store_user_connection` into Supabase
   Vault; readback ONLY server-side via `get_user_connection_secret`
   (service role). No credential in any table column, log line, RPC response or
   UI bundle. The service-role key itself must never reach `apps/api` client
   responses or any browser bundle — `createServiceClient` is backend-only.
5. **Immutability**: `context_entries` and `decisions` reject UPDATE even for
   the service role (trigger). Corrections = new entry + `supersedes_decision_ids`.
6. **Limits** (DB CHECK + helper layer): 1 MiB/file, 5 files/save, 20 MiB/project,
   64 KiB submitted_text, 8 KiB summary, 32 KiB brief.

## 6. Expected merge conflicts and recommended resolutions

The MCP branch forked from `a225ead` (before the DB round created the root
tooling), so both sides CREATED several root files → expect add/add conflicts:

| File | Conflict type | Recommended resolution |
| --- | --- | --- |
| `package.json` (root) | add/add | Union. Workspaces `["packages/*", "apps/*"]` already covers both sides. Merge scripts (keep our `build`/`test`/`test:statemachine`/`test:e2e`/`worker`/`seed`/`smoke`/`db:push`/`db:types` + their dev/build/check scripts, renaming on collision — e.g. their `dev` can stay, our `build` may need to become `tsc -b` over all five packages). Merge devDependencies: keep single versions of `typescript` (^7.0.2) and `vitest` (^4.1.11); if the MCP side pins different majors, prefer testing with ours first since our gates are pinned to them |
| `package-lock.json` | add/add | Do NOT hand-merge. Resolve `package.json` first, delete the conflicted lockfile, run `npm install`, commit the regenerated one. Then `npm ci --ignore-scripts` from scratch must succeed |
| `tsconfig.base.json` | add/add | Compare carefully. Ours: NodeNext, strict, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `rewriteRelativeImportExtensions`, composite-friendly. The MCP clone has its own base + a `tsconfig.check.json`. If their compiler options differ, prefer per-package overrides over changing the base — `apps/worker/tsconfig.json` already documents why it locally disables `rewriteRelativeImportExtensions` (TS2878 on cross-package `.ts` imports); the same trick works for their packages if needed |
| `AGENTS.md` | add/add or content | Concatenate: keep the full DB-domain version (Hungarian core + English rules section) and append the MCP-specific sections from their version. Nothing may be dropped — both contain workstream-binding rules |
| `PROJECT_CONTEXT.md` | content (if MCP edited it) | Ours adds §15 and one English parenthetical in §14. Keep both sides' additions; sections are append-only by convention |
| `.gitignore`, `README.md` | trivial | Union |
| `scripts/`, `supabase/`, `packages/db`, `packages/domain`, `apps/worker` | none expected | DB-domain territory; MCP side should not have touched them. If it did, treat as a red flag and reconcile deliberately |
| `apps/api`, `packages/contracts` | none expected | MCP territory, new paths |

After resolving: `npm install`, then the full verification below. If the UI
branch adds a third workspace (e.g. `apps/web`), repeat the same union logic;
it must consume ONLY `createAnonClient` + helpers from `@demo/db` (never the
service key).

## 7. Post-merge verification checklist (in this order)

```bash
npm ci --ignore-scripts          # lockfile-clean install must succeed
npm run build                    # tsc -b over all packages — green
npm test                         # vitest: 47/47 (domain)
npm run db:push                  # MUST say nothing to apply (see section 4)
npm run smoke                    # 40 PASS, 0 FAIL
npm run test:statemachine        # 22 PASS, 0 FAIL
npm run test:e2e                 # 20 PASS, 0 FAIL; prints claim latency ≤ 15 s
# MCP side (from their package scripts): their check/test suite + a live
# tools/list + server_info call against apps/api, per their handover doc
```

Expected numbers are exact — a lower PASS count means a gate silently vanished
in the merge; treat that as a failure even if nothing "errors".

## 8. Live-DB test etiquette (shared database!)

- Every test creates a disposable project (`smoke-*`, `e2e-*`) and cleans up in
  a `finally` block. If a test crashes mid-run, delete leftovers with the
  service client before re-running.
- `claim_run` is GLOBAL by design (a claimer takes the oldest queued run of the
  preset). **Never run `test:statemachine` and `test:e2e` in parallel** — they
  can steal each other's queued runs. The scripts have defensive guards
  (foreign-claim warnings / abort), but serializing them is the rule. Run smoke
  freely; it never queues runs.
- Do not leave `npm run worker` running while executing the state-machine tests
  for the same reason (the E2E test spawns and owns its own worker child).

## 9. Sharp edges the merge agent should know

1. **TypeScript 7 (tsgo)**: `apps/worker/tsconfig.json` sets
   `emitDeclarationOnly: true` + `rewriteRelativeImportExtensions: false`
   locally (TS2878 with cross-package `.ts` source imports). The worker always
   runs via tsx; typecheck flows through project references. Don't "clean up"
   this deviation without re-running the build.
2. **Import specifier for domain**: `import { canonicalHash } from '@demo/domain'`
   works via workspace symlink + `exports → ./src/index.ts` under NodeNext.
   Apps and the MCP server should use the package name, not relative paths.
3. **`fail_run` fingerprint**: derived in-function as
   `sha256(error_code \n safe_message \n retryable)` — identical failure retries
   match the receipt, different reports conflict. Documented in migration 6.
4. **Storage path for run artifacts**: the E2E runner uploads to
   `projectId/<random-uuid>/brief.md`; the middle segment is a placeholder for
   the artifact id (the runner HTTP API will own the exact convention later —
   `complete_run` records `storage_path` verbatim).
5. **`store_user_connection` logging caveat**: per-function
   `log_statement='none'` is NOT installable on hosted Supabase (SUSET,
   verified). Project-level statement logging must stay off (default
   `log_statement=ddl` complies) so credentials in RPC arguments are never
   logged. Do not enable statement logging on this project.
6. **vitest 4.1.11** was chosen deliberately (newest release older than 7 days
   at selection time, verified against TS 7). Don't bump to 5.x during the
   merge; that's a separate, tested upgrade.
7. **Session pooler only**: the direct `db.<ref>.supabase.co` host is
   IPv6-only and unreachable from this network — psql/CLI must use
   `SUPABASE_DB_URL`.
8. **Worker logs are secret-free by contract** (E2E asserts the service key
   never appears in captured output). Keep that property when touching logging.

## 10. Integration pointers for the MCP and UI workstreams

- The MCP `context_save` tool should be a thin wrapper: validate the tool
  input against `@demo/contracts`, then call `saveContext` (`@demo/db`) with an
  authenticated (anon+JWT) client. Same pattern for `run_prepare` → `prepareRun`.
  Error mapping: the RPCs raise `NOT_FOUND`, `VALIDATION_ERROR: …`,
  `DECISION_CONFLICT: <key>`, `CONTEXT_INCOMPLETE: <key>` in the exception
  message — map them onto the §6 error-code envelope in `@demo/contracts`.
- **Overlap to resolve deliberately**: `@demo/contracts` (envelope, request_id,
  error codes) and `@demo/domain` (canonical JSON, hashes, validator) are
  complementary, not duplicates. If the MCP side implemented any hashing or
  canonicalization stub in contracts, replace it with `@demo/domain` imports —
  there must be exactly ONE canonical-JSON implementation in the repo.
- Snapshot/payload hashes for `run_prepare` are computed in TypeScript
  (`computeSnapshotHash` / `computeRunInputHash` are the API-layer contract;
  the current `prepareRun` helper hashes the v1 client payload). The API layer
  that assembles `RunInputV1` should adopt `computeRunInputHash` when built.
- UI: `createAnonClient(url, anonKey)` with explicit params (no `process.env`
  in the browser), sign-in with the seeded users, helpers for everything;
  approvals are owner-only (RLS enforces it — the UI should also hide the
  button for members).

## 11. Hard rules (do not violate during or after the merge)

1. No editing/renumbering applied migrations; new file or nothing.
2. No secrets in tables, logs, commit messages or client bundles; Vault +
   `secret_ref` only. `.env` never gets committed (gitignored).
3. No direct `runs`/`tasks`/`external_actions` state writes from any client
   path; service RPCs only.
4. No `git push` and no destructive git surgery (force-push, history rewrite)
   without explicit user approval.
5. Don't delete the `devin-demo-db-work` worktree while `feat/db-domain` is
   checked out there if you still need the branch ref; `main` already contains
   everything, so the safe order is: finish merge on `main` → `git worktree
   remove ../devin-demo-db-work` → delete stale branches.

## 12. Known open items (NOT delivered by this round — don't expect them)

- OAuth/MCP auth flow (§7), the MCP business tools themselves, and any
  public hosting — MCP workstream territory.
- `apps/runner` (Codex CLI executor), GitHub issue worker action (§9) and the
  runner HTTP API — developer B territory; the DB side (claim/heartbeat/
  complete/fail + receipts) is live and tested, so they are unblocked.
- UI beyond the seeded-login basics.
- `github_issue_prepare`/`github_issue_get` RPC hardening analogous to
  `prepare_run` (external_actions still use the RLS-guarded INSERT path).
