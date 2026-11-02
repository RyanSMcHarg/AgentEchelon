/**
 * CLOUDWATCH LOGS LIVE TAIL, AS A STREAM THE WATCHDOG SUBSCRIBES TO.
 *
 * `StartLiveTail` holds one HTTPS response open and pushes each log event as it is ingested, typically
 * within a second or two. One session serves up to ten log groups and lasts up to three hours, so the run
 * opens one session per ten groups and reopens a session when the service ends it. A reopened session
 * resumes from "now": the events in between are the per-file CloudWatch sweep's to catch
 * (`backend-errors.ts`), which stays as the backstop.
 *
 * Unfiltered on purpose. Error lines fail the test, and every other line that carries the test's
 * conversation or request id is the backend half of the stall detector's progress signal; one stream
 * serves both, so the run pays for one session rather than two.
 */
import https from 'https';
import { EventStreamDecoder } from './eventstream';
import { type CredentialSource, REGION, signHeaders } from './aws-signing';
import { chunk, LIVE_TAIL_GROUPS_PER_SESSION } from './logic';

/** One log event as Live Tail delivers it. */
export interface TailLine {
  logGroup: string;
  logStream: string;
  message: string;
  /** Epoch ms the handler logged it. */
  timestamp: number;
}

export interface LiveTailOptions {
  /** Log group ARNs (`arn:aws:logs:<region>:<account>:log-group:<name>`), any number; split per session. */
  groupArns: string[];
  credentials: CredentialSource;
  onLine: (line: TailLine) => void;
  /** Told when a session opens, ends or fails, so the run record can say what was watched. */
  onStatus?: (status: string) => void;
}

const HOST = `streaming-logs.${REGION}.amazonaws.com`;

/** One `StartLiveTail` session over at most ten groups, reopened whenever the service ends it. */
class TailSession {
  private stopped = false;
  private req: ReturnType<typeof https.request> | null = null;
  private retryMs = 1_000;

  constructor(private readonly groups: string[], private readonly opts: LiveTailOptions) {}

  start(): void {
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    this.req?.destroy();
  }

  private reopenLater(why: string): void {
    if (this.stopped) return;
    // A REFUSAL NAMING A GROUP THAT DOES NOT EXIST IS NOT TRANSIENT: reopening the same request repeats it forever while
    // the run believes it is watched. The session stops and says so once; the run record names the groups it covers.
    if (/ResourceNotFoundException/.test(why)) {
      this.stopped = true;
      this.opts.onStatus?.(`live tail session over ${this.groups.length} group(s) STOPPED (${why}): these groups are UNWATCHED live`);
      return;
    }
    this.opts.onStatus?.(`live tail session over ${this.groups.length} group(s) ended (${why}); reopening`);
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    const t = setTimeout(() => void this.open(), wait);
    t.unref?.();
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    const body = JSON.stringify({ logGroupIdentifiers: this.groups });
    let headers: Record<string, string>;
    try {
      const creds = await this.opts.credentials();
      headers = await signHeaders(creds, 'logs', {
        method: 'POST', hostname: HOST, path: '/',
        headers: {
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-target': 'Logs_20140328.StartLiveTail',
          accept: 'application/vnd.amazon.eventstream',
        },
        body,
      });
    } catch (err) {
      this.reopenLater(`could not sign: ${err}`);
      return;
    }
    const decoder = new EventStreamDecoder();
    const req = https.request({ host: HOST, path: '/', method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, (res) => {
      if ((res.statusCode ?? 0) >= 300) {
        let text = '';
        res.on('data', (c) => { text += c.toString(); });
        res.on('end', () => this.reopenLater(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        return;
      }
      res.on('data', (c: Buffer) => {
        let messages;
        try {
          messages = decoder.push(c);
        } catch (err) {
          req.destroy();
          this.reopenLater(`unreadable stream: ${err}`);
          return;
        }
        for (const m of messages) this.handle(m.headers, m.payload);
      });
      res.on('end', () => this.reopenLater('the service closed the session'));
      res.on('error', (err) => this.reopenLater(String(err)));
    });
    req.on('error', (err) => this.reopenLater(String(err)));
    this.req = req;
    req.end(body);
  }

  private handle(headers: Record<string, unknown>, payload: Buffer): void {
    const kind = String(headers[':message-type'] ?? '');
    const event = String(headers[':event-type'] ?? headers[':exception-type'] ?? '');
    let json: any = {};
    try { json = JSON.parse(payload.toString('utf8') || '{}'); } catch { return; }
    if (kind === 'exception') {
      this.opts.onStatus?.(`live tail exception ${event}: ${String(json.message ?? '').slice(0, 200)}`);
      return;
    }
    if (event === 'sessionStart') {
      this.retryMs = 1_000;
      this.opts.onStatus?.(`live tail session open over ${this.groups.length} group(s)`);
      return;
    }
    if (event !== 'sessionUpdate') return;
    if (json.sessionMetadata?.sampled) this.opts.onStatus?.('live tail is SAMPLING (over 500 events/s); the per-file sweep covers what it drops');
    for (const r of (json.sessionResults ?? []) as any[]) {
      this.opts.onLine({
        logGroup: String(r.logGroupIdentifier ?? ''),
        logStream: String(r.logStreamName ?? ''),
        message: String(r.message ?? ''),
        timestamp: Number(r.timestamp ?? Date.now()),
      });
    }
  }
}

/** Every session the run holds, over every group it watches. */
export class LiveTail {
  private readonly sessions: TailSession[];

  constructor(opts: LiveTailOptions) {
    this.sessions = chunk(opts.groupArns, LIVE_TAIL_GROUPS_PER_SESSION).map((g) => new TailSession(g, opts));
  }

  get sessionCount(): number {
    return this.sessions.length;
  }

  start(): void {
    for (const s of this.sessions) s.start();
  }

  stop(): void {
    for (const s of this.sessions) s.stop();
  }
}
