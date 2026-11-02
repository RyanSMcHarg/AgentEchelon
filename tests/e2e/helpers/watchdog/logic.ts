/**
 * THE WATCHDOG'S DECISIONS, WITH NO I/O.
 *
 * Everything that decides whether a test is stalled, whether an operator alert fails the run, and whether a
 * backend log line is a failure lives here, imported by the listeners and by the backend unit tests
 * (`backend/test/e2e-watchdog.test.ts`). Nothing in this file reads a clock, a socket or a file, so each
 * rule is proven without an account.
 */

/** How long a test may go with no progress signal from anywhere before it is failed as stalled. */
export const DEFAULT_STALL_WINDOW_MS = 120_000;
/** The slack after a declared timer's due time: a schedule fires within its minute, and its work then runs. */
export const DECLARED_WAIT_MARGIN_MS = 90_000;
/** How long a passing test waits at its end for a log line still on its way through Live Tail. */
export const BACKEND_SETTLE_MS = 3_000;
/** Lead-in before a test's start that still counts as its own: a handler's clock is not the runner's. */
export const BACKEND_LEAD_IN_MS = 5_000;
/** A Live Tail session takes at most ten log groups. */
export const LIVE_TAIL_GROUPS_PER_SESSION = 10;

/** Split a list into runs of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Stall detection
// ---------------------------------------------------------------------------

export type SignalSource = 'frontend' | 'backend' | 'harness';

export interface Signal {
  source: SignalSource;
  detail: string;
  at: number;
}

export interface DeclaredWait {
  reason: string;
  /** When the timer is due (epoch ms). Silence is expected until this plus the margin. */
  dueAt: number;
}

export interface StallVerdict {
  silentForMs: number;
  message: string;
}

const ago = (now: number, at?: number): string => {
  if (at === undefined) return 'never';
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s > 120 ? `${Math.floor(s / 60)}m${s % 60}s ago` : `${s}s ago`;
};

/**
 * The progress of one test: the last signal from each side, and the timers it declared it waits on.
 *
 * A test is stalled when nothing has happened for the window AND no declared timer accounts for the
 * silence. Every signal pushes the deadline forward, so a test that keeps making progress never stalls,
 * however long it runs.
 */
export class StallClock {
  private readonly last: Partial<Record<SignalSource, Signal>> = {};
  private readonly waits: DeclaredWait[] = [];

  constructor(readonly windowMs: number, readonly startedAt: number) {}

  signal(source: SignalSource, detail: string, at: number): void {
    this.last[source] = { source, detail: detail.replace(/\s+/g, ' ').slice(0, 160), at };
  }

  declareWait(reason: string, dueAt: number): void {
    this.waits.push({ reason, dueAt });
  }

  lastSignal(source: SignalSource): Signal | undefined {
    return this.last[source];
  }

  /** The latest moment anything happened, the test's start when nothing has. */
  lastProgressAt(): number {
    return Math.max(this.startedAt, ...Object.values(this.last).map((s) => s!.at));
  }

  /** The moment silence becomes a stall. */
  deadline(): number {
    const quietUntil = Math.max(0, ...this.waits.map((w) => w.dueAt + DECLARED_WAIT_MARGIN_MS));
    return Math.max(this.lastProgressAt() + this.windowMs, quietUntil);
  }

  /** The declared wait covering `now`, if any. */
  activeWait(now: number): DeclaredWait | undefined {
    return this.waits.find((w) => now <= w.dueAt + DECLARED_WAIT_MARGIN_MS);
  }

  verdict(now: number): StallVerdict | null {
    if (now < this.deadline()) return null;
    const silentForMs = now - this.lastProgressAt();
    const describe = (s: SignalSource) => {
      const sig = this.last[s];
      return `last ${s} signal ${ago(now, sig?.at)}${sig ? ` (${sig.detail})` : ''}`;
    };
    const lapsed = this.waits.filter((w) => w.dueAt + DECLARED_WAIT_MARGIN_MS <= now);
    const message = `stalled: no progress for ${Math.round(silentForMs / 1000)}s (window ${Math.round(this.windowMs / 1000)}s); `
      + `${describe('frontend')}; ${describe('backend')}; ${describe('harness')}`
      + (lapsed.length ? `; declared wait(s) already due: ${lapsed.map((w) => `"${w.reason}" due ${ago(now, w.dueAt)}`).join(', ')}` : '');
    return { silentForMs, message };
  }
}

// ---------------------------------------------------------------------------
// Expected declarations (alarms, backend errors)
// ---------------------------------------------------------------------------

/** A declaration that survives a worker restart, so it is stored as data, not as a RegExp. */
export interface Pattern {
  source: string;
  regex: boolean;
}

export function toPattern(p: string | RegExp): Pattern {
  return typeof p === 'string' ? { source: p, regex: false } : { source: p.source, regex: true };
}

export function matches(text: string, p: Pattern): boolean {
  if (!p.regex) return text.includes(p.source);
  try {
    return new RegExp(p.source).test(text);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Operator alerts (the admin notification channel)
// ---------------------------------------------------------------------------

/** An alert as it arrives on the admin notification channel. */
export interface AlertMessage {
  messageId: string;
  createdAtMs: number;
  /** The words the admins are emailed, URI-decoded. */
  content: string;
  /** The message's Metadata: `messageType`, and for an alarm `alarmName` and `alarmState`. */
  metadata: Record<string, unknown>;
}

export type AlertKind = 'alarm' | 'recovery' | 'notice' | 'report';

export interface AlertVerdict {
  messageId: string;
  kind: AlertKind;
  /** The alarm's name, else the notice's message type. */
  name: string;
  reason: string;
  atIso: string;
  /** Posted before this phase began: reported, never a failure of this run. */
  preexisting: boolean;
  /** A spec declared it. */
  expected: boolean;
  /** Fails the test it arrives during. */
  fails: boolean;
}

/**
 * Why an alert was raised, from its rendered words: CloudWatch's state reason (or a notice's reason, detail
 * or error line) and what the alarm watches, else the alert's first words.
 */
export function alertReason(content: string): string {
  const lines = content.replace(/<!--[\s\S]*?-->/g, '').replace(/[*_`#>]/g, '')
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pick = (re: RegExp) => lines.find((l) => re.test(l));
  const parts = [pick(/^(cloudwatch|reason|detail|error)\s*:/i), pick(/^what\s*:/i)].filter(Boolean) as string[];
  return (parts.length ? parts.join(' | ') : lines.join(' ')).replace(/\s+/g, ' ').slice(0, 500);
}

/**
 * What one alert means for this run.
 *
 * An alarm going INTO alarm fails the test it arrives during, unless a spec declared it. A recovery is
 * reported and fails nothing: the alarm that went in already did. A clean-copy run that completed is a
 * routine report. Every other notice (an assistant error, a turn that did not start, an audit finding) is a
 * failure the admins were emailed about, so it fails the run the same way an alarm does.
 */
export function classifyAlert(msg: AlertMessage, ctx: { phaseStartMs: number; expected: Pattern[] }): AlertVerdict {
  const meta = msg.metadata ?? {};
  const type = String(meta.messageType ?? 'unknown');
  const alarmName = typeof meta.alarmName === 'string' ? meta.alarmName : '';
  let kind: AlertKind = 'notice';
  if (type === 'cloudwatch_alarm') kind = meta.alarmState === 'OK' ? 'recovery' : 'alarm';
  else if (type === 'clean_copy_run' && meta.outcome === 'complete') kind = 'report';
  const name = alarmName || type;
  const preexisting = msg.createdAtMs < ctx.phaseStartMs;
  // By the alarm's name, the notice's type, or words the alert carries (a synthetic alarm's own description).
  const expected = ctx.expected.some((p) => matches(name, p) || matches(type, p) || matches(msg.content, p));
  return {
    messageId: msg.messageId,
    kind,
    name,
    reason: alertReason(msg.content),
    atIso: new Date(msg.createdAtMs).toISOString(),
    preexisting,
    expected,
    fails: !preexisting && !expected && (kind === 'alarm' || kind === 'notice'),
  };
}

export function describeAlert(v: AlertVerdict): string {
  const what = v.kind === 'alarm' ? 'CloudWatch alarm went into ALARM' : v.kind === 'recovery' ? 'alarm recovered' : v.kind === 'report' ? 'report' : 'operator notice';
  return `[operator alert] ${what}: ${v.name} at ${v.atIso}. ${v.reason}`;
}

// ---------------------------------------------------------------------------
// Backend log lines
// ---------------------------------------------------------------------------

/**
 * Log lines that are real but are not a failure of the turn under test. The bar is "cannot possibly indicate
 * a broken turn", not "noisy": this list is exactly the mechanism that once let the console monitor hide real
 * React defects, so every entry carries its reason.
 */
export const NOT_A_TURN_FAILURE: { pattern: string; why: string }[] = [
  {
    pattern: 'NodeVersionSupportWarning',
    why: 'AWS SDK v3 deprecation notice logged at ERROR level by the Aurora Lambdas. Real '
      + 'forward-looking work (runtime is node20, SDK wants >=22 after early 2027), but it is '
      + 'emitted on every cold start regardless of the turn and says nothing about this request.',
  },
];

export function isTurnFailure(line: string): boolean {
  return !NOT_A_TURN_FAILURE.some((e) => line.includes(e.pattern));
}

/**
 * The terms the per-file CloudWatch sweep filters on (`?ERROR ?Exception ?AccessDenied ?Denied`), matched
 * as whole terms the way a filter pattern matches them, plus the Lambda runtime's own timeout line, which
 * carries no level. The live check and the sweep agree on what an error is, so the live check can only ever
 * report what the sweep would have reported later.
 */
const ERROR_TERM = /(^|[^A-Za-z0-9])(ERROR|Exception|AccessDenied|Denied)(?=[^A-Za-z0-9]|$)/;
const RUNTIME_FAILURE = /Task timed out after|Runtime\.(ExitError|ImportModuleError|UnhandledPromiseRejection)/;

/** Whether a log line is a backend failure the current test must answer for. */
export function isBackendFailureLine(message: string, allowed: Pattern[] = []): boolean {
  if (!ERROR_TERM.test(message) && !RUNTIME_FAILURE.test(message)) return false;
  if (!isTurnFailure(message)) return false;
  return !allowed.some((p) => matches(message, p));
}

export interface ParsedLine {
  requestId?: string;
  level?: string;
  text: string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * A Lambda log line's request id and level, in each of the shapes the runtime writes: the text format
 * (`<time>\t<requestId>\t<LEVEL>\t<message>`), the JSON format, and the runtime's own `START`/`END`/`REPORT`
 * and timeout lines.
 */
export function parseLambdaLine(message: string): ParsedLine {
  const trimmed = message.trim();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed);
      return { requestId: j.requestId ?? j.awsRequestId, level: j.level, text: String(j.message ?? trimmed) };
    } catch { /* not JSON after all */ }
  }
  const runtime = /^(START|END|REPORT) RequestId: ([0-9a-f-]{36})/i.exec(trimmed);
  if (runtime) return { requestId: runtime[2], level: runtime[1], text: trimmed };
  const parts = trimmed.split('\t');
  if (parts.length >= 4 && UUID.test(parts[1])) return { requestId: parts[1], level: parts[2], text: parts.slice(3).join('\t') };
  if (parts.length >= 3 && UUID.test(parts[1])) return { requestId: parts[1], text: parts.slice(2).join('\t') };
  const id = UUID.exec(trimmed);
  return { ...(id ? { requestId: id[0] } : {}), text: trimmed };
}

/** The id a conversation is known by in logs: an ARN's last segment, or the id itself. */
export function conversationKey(idOrArn: string): string {
  return idOrArn.split('/').pop() || idOrArn;
}

/**
 * Whether a log line belongs to the current test: it names one of the test's conversations or correlation
 * ids, or it was logged by a request that did. A request that named the conversation once is followed for the
 * rest of its invocation, so a long model call still reports progress when it returns.
 */
export function correlates(message: string, keys: Set<string>, requests: Set<string>): { hit: boolean; requestId?: string } {
  const { requestId } = parseLambdaLine(message);
  if (requestId && requests.has(requestId)) return { hit: true, requestId };
  for (const k of keys) {
    if (k && message.includes(k)) return { hit: true, ...(requestId ? { requestId } : {}) };
  }
  return { hit: false };
}

export function describeBackendLine(line: { logGroup: string; message: string; timestamp: number }): string {
  const { requestId } = parseLambdaLine(line.message);
  const group = line.logGroup.split(':log-group:').pop() || line.logGroup;
  return `[backend error] ${group.split('/').pop()} at ${new Date(line.timestamp).toISOString()}`
    + `${requestId ? ` request ${requestId}` : ''}: ${line.message.replace(/\s+/g, ' ').trim().slice(0, 500)}`;
}
