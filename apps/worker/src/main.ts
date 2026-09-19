/**
 * Worker entry point (PROJECT_CONTEXT.md section 8): validate configuration,
 * start the 5-second activation loop, and translate SIGTERM/SIGINT into a
 * graceful stop (finish the in-flight tick, log a shutdown event, exit 0).
 * Run with: npm run worker
 */
import { createServiceClient } from '../../../packages/db/src/index.ts';
import { log, startWorker } from './worker.ts';

// Fail fast on missing config. Only the PRESENCE of the variables is checked
// and reported — the values are secrets and are never logged anywhere.
const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((name) => !process.env[name]);
if (missing.length > 0) {
  log('error', 'startup_failed', { reason: `missing required env: ${missing.join(', ')}` });
  process.exit(1);
}

const worker = startWorker(createServiceClient());

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return; // a second signal must not race the first stop
    shuttingDown = true;
    void worker.stop(signal).then(() => process.exit(0));
  });
}
