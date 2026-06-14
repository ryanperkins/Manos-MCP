export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PollResult<T> {
  value: T;
  satisfied: boolean;
  elapsedMs: number;
  attempts: number;
}

/**
 * Repeatedly run `attempt` until `done` returns true or the timeout elapses.
 * The backbone of smart waits — replaces fixed sleeps with condition polling
 * so flows are fast when the UI is ready and patient when it isn't.
 */
export async function poll<T>(opts: {
  timeoutMs: number;
  intervalMs: number;
  attempt: () => Promise<T>;
  done: (value: T) => boolean;
}): Promise<PollResult<T>> {
  const start = Date.now();
  let attempts = 0;
  let value = await opts.attempt();
  attempts++;
  while (!opts.done(value)) {
    if (Date.now() - start >= opts.timeoutMs) {
      return { value, satisfied: false, elapsedMs: Date.now() - start, attempts };
    }
    await sleep(opts.intervalMs);
    value = await opts.attempt();
    attempts++;
  }
  return { value, satisfied: true, elapsedMs: Date.now() - start, attempts };
}
