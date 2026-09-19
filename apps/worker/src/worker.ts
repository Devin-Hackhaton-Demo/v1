/**
 * Worker activation loop (PROJECT_CONTEXT.md section 8).
 *
 * Every tick calls the service-role-only `activate_due_runs()` RPC. ALL state
 * decisions (due run_at, approval validity, lease expiry, attempt cap) are
 * made inside that function on DB time now() — this process only provides the
 * cadence, so a slow/skewed local clock or a restart can never corrupt run
 * state; at worst a transition happens one tick later.
 */
import {
  activateDueRuns,
  type ActivationSummary,
  type DbClient,
} from '../../../packages/db/src/index.ts';

/** Section 8 poll cadence: the worker activates due runs every 5 seconds. */
export const BASE_INTERVAL_MS = 5_000;
/** Consecutive tick failures tolerated at base cadence before backing off. */
export const FAILURE_THRESHOLD = 5;
/** Backoff ladder after the threshold: 10s, 20s, 40s, capped at 60s. */
export const BACKOFF_START_MS = 10_000;
export const BACKOFF_CAP_MS = 60_000;

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Structured JSON-line logging to stdout. Callers must only pass
 * already-safe fields: never env values, keys, tokens or whole config/error
 * objects — errors are reduced to error.message before they get here.
 */
export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
}

function errorMessage(e: unknown): string {
  return (e as { message?: string }).message ?? String(e);
}

export interface WorkerHandle {
  /** Stop scheduling, wait for the in-flight tick, log the shutdown event. */
  stop(reason: string): Promise<void>;
}

/**
 * Start the activation loop. A tick is logged only when the activation
 * summary has at least one transition (a healthy idle worker stays silent).
 * A failed tick logs error.message and continues; after FAILURE_THRESHOLD
 * consecutive failures the cadence backs off exponentially until one
 * success resets it to the base interval.
 */
export function startWorker(client: DbClient): WorkerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;
  let consecutiveFailures = 0;

  function nextDelayMs(): number {
    if (consecutiveFailures < FAILURE_THRESHOLD) return BASE_INTERVAL_MS;
    const step = consecutiveFailures - FAILURE_THRESHOLD; // 0 → 10s, 1 → 20s, 2 → 40s…
    return Math.min(BACKOFF_START_MS * 2 ** step, BACKOFF_CAP_MS);
  }

  async function tick(): Promise<void> {
    try {
      const summary: ActivationSummary = await activateDueRuns(client);
      consecutiveFailures = 0;
      const transitions =
        summary.scheduled + summary.queued + summary.blocked +
        summary.lease_requeued + summary.lease_failed;
      if (transitions > 0) log('info', 'tick', { ...summary });
    } catch (e) {
      consecutiveFailures += 1;
      // error.message only: a serialized Supabase error/config object could
      // embed connection details; the message alone is the safe part.
      log('error', 'tick_failed', {
        error: errorMessage(e),
        consecutive_failures: consecutiveFailures,
      });
    }
  }

  // Interruptible sleep: shutdown resolves the pending wait immediately so
  // stop() never blocks on a full backoff interval.
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, ms);
    });
  }

  const loop = (async () => {
    log('info', 'startup', { interval_ms: BASE_INTERVAL_MS });
    while (!stopped) {
      await tick(); // awaited: stop() waits for this via `loop`
      if (stopped) break;
      const delay = nextDelayMs();
      if (delay > BASE_INTERVAL_MS) {
        log('warn', 'backoff', { delay_ms: delay, consecutive_failures: consecutiveFailures });
      }
      await sleep(delay);
    }
  })();

  return {
    async stop(reason: string): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      wake?.(); // interrupt a pending sleep; an in-flight tick still finishes
      await loop;
      log('info', 'shutdown', { reason });
    },
  };
}
