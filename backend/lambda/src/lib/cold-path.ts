/**
 * A COLD FUNCTION'S HEAD START, AND THE LINE THAT SAYS WHERE ITS TIME WENT.
 *
 * Opening a conversation crosses two functions in a chain, the person-facing API and the classification's
 * creator, and on a cold container most of each one's time is first-call work: the SDK's middleware, endpoint
 * rules, credentials and TLS for every AWS service it touches, at the CPU share its memory buys. The reads it
 * needs before it can act are known before any request arrives, so each function starts them while its
 * module loads ({@link PrimedRead}) and the handler awaits what is already in flight.
 *
 * ── A HEAD START, NEVER A SECOND CACHE ──────────────────────────────────────────────────────────
 *
 * A primed read is taken ONCE, by the first request that asks for it, and only within
 * {@link PRIMED_READ_MAX_AGE_MS} of being started. Every later call goes to the loader itself, which keeps
 * the TTL and the failure rules it has always had, so priming changes when a value is first read and never
 * which value a request sees. A priming that failed, or that answered with nothing, is read again once by
 * the request that takes it, and a second failure reaches the handler's own error handling.
 *
 * ── MEASURED, NOT INFERRED ──────────────────────────────────────────────────────────────────────
 *
 * {@link phaseTimer} records how long each named phase of one request took, and {@link logPhaseTiming}
 * writes them as one structured line per request with whether the container was cold, so the effect of a
 * change here is read from the logs rather than argued.
 */

/** True inside a deployed Lambda execution environment, where priming at module load runs. */
export function runsInLambda(): boolean {
  return (process.env.AWS_EXECUTION_ENV || '').startsWith('AWS_Lambda_');
}

/** How long a primed read may wait for the request that takes it before it is discarded unread. */
export const PRIMED_READ_MAX_AGE_MS = 30_000;

export interface PrimedReadOptions<T> {
  /** A value the request should not use as it came from the priming: read again once. Default: none. */
  unusable?: (value: T) => boolean;
  /** Override {@link PRIMED_READ_MAX_AGE_MS}. */
  maxAgeMs?: number;
  /** Override the clock. Tests only. */
  now?: () => number;
}

/** One read started while the module loads and taken by the first request that needs it. */
export class PrimedRead<T> {
  private head: { value: Promise<T>; at: number } | undefined;

  constructor(
    private readonly name: string,
    private readonly load: () => Promise<T>,
    private readonly options: PrimedReadOptions<T> = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * Start the read now, without awaiting it, so its synchronous setup runs inside Init. A throw or a rejection
   * is held for {@link get}, never thrown into module load.
   */
  prime(): void {
    if (this.head) return;
    let value: Promise<T>;
    try {
      value = this.load();
    } catch (err) {
      value = Promise.reject(err);
    }
    value.catch(() => undefined);
    this.head = { value, at: this.now() };
  }

  /** The primed value when one is held and fresh, else a read of its own. */
  async get(): Promise<T> {
    const head = this.head;
    this.head = undefined;
    if (!head || this.now() - head.at > (this.options.maxAgeMs ?? PRIMED_READ_MAX_AGE_MS)) return this.load();
    try {
      const value = await head.value;
      if (!this.options.unusable?.(value)) return value;
      console.warn(`[cold-path] the primed ${this.name} read answered with nothing; reading it again`);
    } catch (err) {
      console.warn(`[cold-path] the primed ${this.name} read failed; reading it again`, {
        name: (err as { name?: string })?.name, message: (err as Error)?.message,
      });
    }
    try {
      return await this.load();
    } catch (err) {
      console.error(`[cold-path] the ${this.name} read failed when primed and again when retried`, {
        name: (err as { name?: string })?.name, message: (err as Error)?.message,
      });
      throw err;
    }
  }

  /** Whether a primed read is waiting to be taken. Tests only. */
  get primed(): boolean {
    return this.head !== undefined;
  }
}

/** The durations of one request's phases, in milliseconds, by name. */
export interface PhaseTimer {
  /** Run `work` and record how long it took under `phase`, whether it resolves or throws. */
  time<T>(phase: string, work: () => Promise<T>): Promise<T>;
  readonly phases: Record<string, number>;
  /** Milliseconds since the timer started. */
  elapsed(): number;
}

export function phaseTimer(now: () => number = Date.now): PhaseTimer {
  const started = now();
  const phases: Record<string, number> = {};
  return {
    phases,
    elapsed: () => now() - started,
    async time(phase, work) {
      const at = now();
      try {
        return await work();
      } finally {
        phases[phase] = (phases[phase] ?? 0) + (now() - at);
      }
    },
  };
}

/** Time `work` under `phase` when a timer is present, else just run it. */
export function timed<T>(timer: PhaseTimer | undefined, phase: string, work: () => Promise<T>): Promise<T> {
  return timer ? timer.time(phase, work) : work();
}

/** One structured line per request: what ran, whether the container was cold, and each phase's duration. */
export function logPhaseTiming(event: string, timer: PhaseTimer, fields: { cold: boolean } & Record<string, unknown>): void {
  console.log(JSON.stringify({ _timing: event, ...fields, totalMs: timer.elapsed(), phases: timer.phases }));
}
