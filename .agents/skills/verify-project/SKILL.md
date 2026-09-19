---
name: verify-project
description: Full pre-submission verification procedure for this repository (build, tests, live DB gates, API and UI checks).
---

# Verify project

Run every step below, in order, before submitting work. All commands run from
the repository root. Every `npm run` command below was verified to exist in the
root `package.json` `scripts` section at the time of writing.

## Procedure

1. **Clean install** — `npm ci --ignore-scripts`. The clean install must
   succeed; keep the lockfile intact.
2. **Build** — `npm run build`. Builds `packages/db`, `packages/domain`,
   `apps/worker`, then `@demo/contracts` and `@demo/api`. Must be green.
3. **Domain unit tests** — `npm test` (vitest, `packages/domain` — JCS
   vectors, validator). Expected: **47 passing**.
4. **Contracts + API tests** — `npm run test:api` (builds `@demo/contracts`,
   then runs the contracts and Fastify API tests under `node:test`).
5. **Typecheck** — `npm run typecheck`.
6. **UI checks (design preview)** —
   `node --test docs/design/preview/*.test.mjs` and
   `node --check docs/design/preview/app.mjs`. Both must pass.
7. **Live smoke** — `npm run smoke` (live checks against the Supabase DB —
   RLS, triggers, hashing). Expected: **40 PASS, 0 FAIL**. Requires a valid
   `.env` in the repository root (sample: `.env.example`).
8. **State machine (live)** — `npm run test:statemachine`. Expected:
   **22 PASS**. **WARNING:** never run this in parallel with `test:e2e` —
   they share the live DB and the global `claim_run` RPC. Do not leave
   `npm run worker` running while these tests execute.
9. **End-to-end (live)** — `npm run test:e2e` (save → prepare → approve →
   worker activates → claim → complete). Expected: **20 PASS**, and the
   measured claim latency must be **<= 15 s**.

10. **Local demo smoke** — `npm run demo` (serves the preview at
    `http://127.0.0.1:4173`), then
    `curl -s -X POST http://127.0.0.1:4173/api/chat -H 'content-type: application/json' -d '{"messages":[]}'`
    must return a `VALIDATION_ERROR` envelope. This proves the chat endpoint
    is mounted without spending tokens. Stop the server afterwards.

## Rules

- A lower-than-expected PASS count is a **failure**, even if no errors are
  printed. The expected counts are gates, not suggestions.
- Live tests (`smoke`, `test:statemachine`, `test:e2e`) use disposable
  projects and must clean up after themselves.
- Never edit already-applied `supabase/migrations/*.sql` files — schema
  changes always go into a new, timestamped migration file.
- Report every failure. Never bypass, weaken, or skip a check to get to
  green.
- Expected counts are current as of **2026-09-19** — update them in this file
  whenever gates are added or removed.
