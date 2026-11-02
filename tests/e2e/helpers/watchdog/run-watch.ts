/**
 * THE RUN'S LISTENERS, AND THE TEST EACH ONE REPORTS TO.
 *
 * One `RunWatch` per Playwright worker holds the run's two subscriptions:
 *
 *  - OPERATOR ALERTS, as the e2e admin's own Amazon Chime SDK messaging session on the admin notification
 *    channel. Every `ae.alert` (a CloudWatch alarm through the one alarm notifier, an assistant error, an audit
 *    finding) is posted there by the admin assistant, and the channel flow emails it to the admins, so this is
 *    the same event the owner's inbox receives. The session is the event path (tenet D6); a reconnect reads
 *    the channel's messages since the last one seen, which is its catch-up step, never a timer.
 *  - BACKEND LOG LINES, as CloudWatch Logs Live Tail sessions over the turn path's live log groups.
 *
 * Each `TestWatch` is one test's view: the stall clock, the conversations it drives, the errors it allows.
 * A finding fails that test at once. A finding with no test to fail (an alert between tests, an error during
 * a file's `afterAll`) is kept in the run record and fails the worker when it ends.
 *
 * THE RUN RECORD (`<outputDir>/watchdog-record.json`) survives a worker restart, which Playwright does after
 * every failed test: it carries the phase's start, the alerts already reported, and the alarms a spec
 * declared, so a restarted worker neither reports an alert twice nor forgets a declaration. `validate.mjs`
 * prints it after each phase.
 */
import * as fs from 'fs';
import * as path from 'path';
import { expect, type BrowserContext, type Page, type TestInfo, type WorkerInfo } from '@playwright/test';
import { awsv } from '../aws';
import { getAdminUser, getTestCredentials, hasTestCredentials } from '../test-credentials';
import { idTokenFor } from '../person';
import { exchange } from '../admin-api';
import { STACK_PREFIX, SSM_ROOT, classificationStacks, instanceStacks, physicalIdsIn, ANY_FUNCTION } from '../stack-prefix';
import { TURN_PATH_FAMILIES } from '../backend-errors';
import { type AwsCredentials, type CredentialSource, REGION, credentialsFrom, operatorCredentials, operatorCredentialsPresent } from './aws-signing';
import { ChimeMessagingSession, closeAllSessions, listChannelMessages, type ListedMessage } from './chime-session';
import { LiveTail, type TailLine } from './live-tail';
import {
  BACKEND_LEAD_IN_MS, BACKEND_SETTLE_MS, StallClock, classifyAlert, conversationKey, correlates, describeAlert,
  describeBackendLine, isBackendFailureLine, type AlertVerdict, type Pattern, type SignalSource,
} from './logic';
import { setCurrentWatch, type WatchHandle } from './current';

/** Off entirely with `E2E_WATCHDOG=0`, for a run that must not open any stream. */
export function watchdogEnabled(): boolean {
  return process.env.E2E_WATCHDOG !== '0';
}

interface ExpectedAlert extends Pattern {
  declaredBy: string;
  at: number;
}

export interface RunRecord {
  phaseStartedAt: number;
  /** This instance's alarms already in ALARM when the phase began, read once; null until read. */
  preexistingAlarms: string[] | null;
  alerts: AlertVerdict[];
  expected: ExpectedAlert[];
  /** Failures that arrived with no test running. */
  unattributed: string[];
  watched: { liveTailGroups: string[] | null; alertChannel: string | null; notes: string[] };
  lastAlertAtMs: number;
}

const log = (s: string) => console.log(`[watchdog] ${s}`);

function readRecord(file: string): RunRecord | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as RunRecord;
  } catch {
    return null;
  }
}

/** One test's watch. */
export class TestWatch implements WatchHandle {
  readonly clock: StallClock;
  private readonly keys = new Set<string>();
  private readonly requests = new Set<string>();
  readonly allowed: Pattern[] = [];
  private failure: string | null = null;
  private surfaced = false;
  private timer: NodeJS.Timeout | null = null;
  readonly startedAt = Date.now();

  constructor(private readonly run: RunWatch, readonly testInfo: TestInfo, windowMs: number) {
    this.clock = new StallClock(windowMs, this.startedAt);
    this.arm();
  }

  get title(): string {
    return this.testInfo.titlePath.slice(1).join(' > ');
  }

  signal(source: SignalSource, detail: string): void {
    this.clock.signal(source, detail, Date.now());
  }

  track(idOrArn: string): void {
    this.keys.add(conversationKey(idOrArn));
  }

  declareWait(reason: string, dueAt: number): void {
    this.clock.declareWait(reason, dueAt);
    log(`${this.title}: waits on "${reason}", due ${new Date(dueAt).toISOString()}`);
    this.arm();
  }

  allowBackendError(pattern: Pattern): void {
    this.allowed.push(pattern);
  }

  onBackendLine(line: TailLine): void {
    const c = correlates(line.message, this.keys, this.requests);
    if (c.hit && c.requestId) this.requests.add(c.requestId);
    // A test that has named no conversation cannot be told apart from the rest of the turn path, so any
    // turn-path line is its progress; once it names one, only that conversation's lines are.
    if (c.hit || this.keys.size === 0) this.signal('backend', `${line.logGroup.split('/').pop()}: ${line.message}`);
    if (!isBackendFailureLine(line.message, this.allowed)) return;
    if (line.timestamp < this.startedAt - BACKEND_LEAD_IN_MS) {
      this.run.unattributed(`${describeBackendLine(line)} (logged before "${this.title}" began)`);
      return;
    }
    this.fail(describeBackendLine(line));
  }

  /** Fail this test now with `reason`: the first finding wins, and the test is ended rather than left to wait. */
  fail(reason: string): void {
    if (this.failure) return;
    this.failure = reason;
    log(`${this.title}: ${reason}`);
    // The test body (or a before hook) is still running while `duration` is unset. Ending it there turns a
    // silent wait into an immediate failure; after the body, the finding is thrown at teardown instead, so
    // an afterEach that cleans up is never cut short.
    if (this.testInfo.duration === 0) {
      this.surfaced = true;
      this.testInfo.annotations.push({ type: 'watchdog', description: reason });
      expect.soft(reason, 'the e2e watchdog ended this test').toBe('');
      this.testInfo.setTimeout(1);
    }
  }

  /** One timer, set for the moment silence would become a stall, and set again whenever it fires early. */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    // A window of 0 is the manual demo's: a person drives it, so there is no progress to expect.
    if (this.clock.windowMs <= 0) return;
    const wait = Math.max(1_000, this.clock.deadline() - Date.now());
    this.timer = setTimeout(() => {
      const v = this.clock.verdict(Date.now());
      if (v) this.fail(v.message);
      else this.arm();
    }, wait);
    this.timer.unref?.();
  }

  /** End the watch. Returns the finding still to be thrown, if the test otherwise passed. */
  async finish(): Promise<string | null> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const passing = this.testInfo.status === this.testInfo.expectedStatus;
    // A line still on its way through Live Tail is this test's: wait for it while the test is still current.
    if (passing && !this.failure && this.run.tailing) await new Promise((r) => setTimeout(r, BACKEND_SETTLE_MS));
    if (!this.failure || this.surfaced) return null;
    if (passing) return this.failure;
    log(`${this.title} (already failing): ${this.failure}`);
    return null;
  }
}

/** The worker's listeners. */
export class RunWatch {
  private readonly recordFile: string;
  record: RunRecord;
  current: TestWatch | null = null;
  private tail: LiveTail | null = null;
  private alertSession: ChimeMessagingSession | null = null;
  private readonly contexts = new WeakSet<BrowserContext>();
  private readonly pages = new WeakSet<Page>();
  private readonly unattributedAtStart: number;
  private lastAllowed: Pattern[] = [];
  tailing = false;

  constructor(workerInfo: WorkerInfo) {
    this.recordFile = path.join(workerInfo.project.outputDir, 'watchdog-record.json');
    const declaredStart = Number(process.env.E2E_PHASE_STARTED_AT) || 0;
    const phaseStart = declaredStart || Date.now();
    const kept = readRecord(this.recordFile);
    // A record from an earlier invocation of the same phase is not this run's.
    this.record = (kept && (!declaredStart || kept.phaseStartedAt === declaredStart) ? kept : null) ?? {
      phaseStartedAt: phaseStart,
      preexistingAlarms: null,
      alerts: [],
      expected: [],
      unattributed: [],
      watched: { liveTailGroups: null, alertChannel: null, notes: [] },
      lastAlertAtMs: phaseStart,
    };
    this.unattributedAtStart = this.record.unattributed.length;
    this.persist();
  }

  persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.recordFile), { recursive: true });
      fs.writeFileSync(this.recordFile, JSON.stringify(this.record, null, 2));
    } catch (err) {
      log(`could not write the run record: ${err}`);
    }
  }

  note(s: string): void {
    log(s);
    if (!this.record.watched.notes.includes(s)) this.record.watched.notes.push(s);
    this.persist();
  }

  unattributed(finding: string): void {
    log(`no test running to fail: ${finding}`);
    this.record.unattributed.push(finding);
    this.persist();
  }

  expectAlert(pattern: Pattern, declaredBy: string): void {
    this.record = readRecord(this.recordFile) ?? this.record;
    this.record.expected.push({ ...pattern, declaredBy, at: Date.now() });
    this.persist();
  }

  async start(): Promise<void> {
    if (!watchdogEnabled()) {
      this.note('DISABLED by E2E_WATCHDOG=0: no alert listener, no live backend errors, no stall detection');
      return;
    }
    if (!operatorCredentialsPresent()) {
      this.note('no AWS credentials: operator alerts and live backend errors are UNWATCHED this run (the stall detector still runs on the page)');
      return;
    }
    await Promise.all([
      this.startTail().catch((err) => this.note(`live backend errors are UNWATCHED: ${err}`)),
      this.startAlerts().catch((err) => this.note(`operator alerts are UNWATCHED: ${err}`)),
    ]);
    this.persist();
  }

  async stop(): Promise<string[]> {
    this.tail?.stop();
    this.alertSession?.stop();
    closeAllSessions();
    this.persist();
    return this.record.unattributed.slice(this.unattributedAtStart);
  }

  beginTest(testInfo: TestInfo, windowMs: number): TestWatch {
    const w = new TestWatch(this, testInfo, windowMs);
    this.current = w;
    setCurrentWatch(w);
    return w;
  }

  endTest(w: TestWatch): void {
    if (this.current === w) {
      this.current = null;
      setCurrentWatch(null);
    }
    this.lastAllowed = [...w.allowed];
  }

  // ── Frontend signals ─────────────────────────────────────────────────────────────────────────────

  /** Every page event of a context reports progress to whichever test is current when it happens. */
  async attachContext(context: BrowserContext): Promise<void> {
    if (this.contexts.has(context)) return;
    this.contexts.add(context);
    const signal = (detail: string) => this.current?.signal('frontend', detail);
    context.on('response', (r) => signal(`response ${r.status()} ${r.url().replace(/\?.*$/, '').slice(0, 120)}`));
    context.on('console', (m) => signal(`console ${m.type()}: ${m.text().slice(0, 80)}`));
    context.on('page', (p) => this.attachPage(p));
    for (const p of context.pages()) this.attachPage(p);
    try {
      // DOM mutations, coalesced to one report a second, from every document the context loads.
      await context.exposeBinding('__aeWatchdogDom', (_src, n: number) => signal(`DOM changed (${n} mutation(s))`));
      await context.addInitScript(() => {
        let pending = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const report = () => {
          timer = null;
          const n = pending;
          pending = 0;
          (window as any).__aeWatchdogDom?.(n).catch?.(() => {});
        };
        const start = () => new MutationObserver((records) => {
          pending += records.length;
          if (!timer) timer = setTimeout(report, 1000);
        }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
        if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
      });
    } catch (err) {
      log(`DOM mutations are not reported for one context: ${err}`);
    }
  }

  private attachPage(page: Page): void {
    if (this.pages.has(page)) return;
    this.pages.add(page);
    page.on('websocket', (ws) => {
      ws.on('framereceived', (f) => {
        const text = typeof f.payload === 'string' ? f.payload : f.payload.toString();
        const arn = /arn:aws:chime:[^"\\]+\/channel\/[0-9a-f-]+/.exec(text)?.[0];
        if (arn) this.current?.track(arn);
        this.current?.signal('frontend', `websocket frame${arn ? ` on ${conversationKey(arn)}` : ''}`);
      });
    });
  }

  // ── Backend errors: Live Tail ────────────────────────────────────────────────────────────────────

  private async startTail(): Promise<void> {
    let groups = this.record.watched.liveTailGroups;
    if (!groups) {
      const account = String(awsv(['sts', 'get-caller-identity', '--query', 'Account']) ?? '');
      const stacks = instanceStacks();
      const turnStacks = [...new Set([...classificationStacks(), ...stacks.filter((s) => /Archive$|ChannelFlow$/.test(s))])];
      const fns = physicalIdsIn(turnStacks, ANY_FUNCTION).filter((fn) => TURN_PATH_FAMILIES.some((f) => fn.includes(f)));
      for (const family of TURN_PATH_FAMILIES) {
        if (!fns.some((fn) => fn.includes(family))) this.note(`no live function of the "${family}" family in ${STACK_PREFIX}: that part of the turn path is UNWATCHED live`);
      }
      // ONLY GROUPS THAT EXIST: a function's log group appears on its first run, and Live Tail refuses a whole session
      // that names one that does not. A function that has not run yet is named as unwatched rather than breaking the rest.
      const existing = fns.filter((fn) => {
        const names = awsv(['logs', 'describe-log-groups', '--log-group-name-prefix', `/aws/lambda/${fn}`, '--query', 'logGroups[].logGroupName']) as string[] | null;
        return (names ?? []).includes(`/aws/lambda/${fn}`);
      });
      for (const fn of fns.filter((f) => !existing.includes(f))) this.note(`/aws/lambda/${fn} has no log group yet (the function has not run): it is UNWATCHED live until it does`);
      groups = existing.map((fn) => `arn:aws:logs:${REGION}:${account}:log-group:/aws/lambda/${fn}`);
      this.record.watched.liveTailGroups = groups;
      this.persist();
    }
    if (!groups.length) throw new Error('no live turn-path log groups were found');
    this.tail = new LiveTail({
      groupArns: groups,
      credentials: operatorCredentials,
      onStatus: (s) => log(s),
      onLine: (line) => {
        if (this.current) this.current.onBackendLine(line);
        // Between tests, the last test's declared errors still apply: its file's afterAll runs here.
        else if (isBackendFailureLine(line.message, this.lastAllowed)) this.unattributed(`${describeBackendLine(line)} (no test running)`);
      },
    });
    this.tail.start();
    this.tailing = true;
    log(`live tail over ${groups.length} log group(s) in ${this.tail.sessionCount} session(s)`);
  }

  // ── Operator alerts: the admin notification channel ──────────────────────────────────────────────

  private async startAlerts(): Promise<void> {
    if (this.record.preexistingAlarms === null) {
      // ONE READ, at the phase's start, so an alarm already in ALARM is reported as standing rather than
      // blamed on this run. Every change after this arrives as an event.
      const names: string[] = awsv(['cloudwatch', 'describe-alarms', '--state-value', 'ALARM', '--query', 'MetricAlarms[].AlarmName']) ?? [];
      this.record.preexistingAlarms = names.filter((n) => n.startsWith(STACK_PREFIX));
      if (this.record.preexistingAlarms.length) log(`already in ALARM when the phase began: ${this.record.preexistingAlarms.join(', ')}`);
      this.persist();
    }
    let channel = this.record.watched.alertChannel;
    if (!channel) {
      channel = String(awsv(['ssm', 'get-parameter', '--name', `${SSM_ROOT}/admin-notification/channel-arn`, '--query', 'Parameter.Value']) ?? '');
      if (!channel) throw new Error(`no admin notification channel is published at ${SSM_ROOT}/admin-notification/channel-arn`);
      this.record.watched.alertChannel = channel;
    }
    if (!hasTestCredentials()) throw new Error('the test credentials are not available, so the e2e admin cannot sign in');
    const { credentials, userArn } = await this.adminIdentity();
    const session = new ChimeMessagingSession({ userArn, credentials, label: 'admin alert listener', onStatus: (s) => log(s) });
    const alertChannel = channel;
    session.onEvent((e) => {
      if (e.channelArn === alertChannel && e.eventType === 'CREATE_CHANNEL_MESSAGE') this.onAlert(e);
    });
    session.onConnected(() => {
      void (async () => {
        try {
          const missed = await listChannelMessages(await credentials(), alertChannel, userArn, { notBeforeMs: this.record.lastAlertAtMs - 1_000 });
          for (const m of missed) this.onAlert(m);
        } catch (err) {
          this.note(`the alert listener could not read the channel as the e2e admin (${err}). The admin must be a member of the admin notification channel; membership follows the admins group (admin-conversation-sync)`);
        }
      })();
    });
    await session.start();
    this.alertSession = session;
    log(`listening for operator alerts on ${alertChannel.split('/').pop()} as the e2e admin`);
  }

  /** The e2e admin's own vended credentials, through the person exchange the chat app uses; renewed when they lapse. */
  private async adminIdentity(): Promise<{ credentials: CredentialSource; userArn: string }> {
    let held: AwsCredentials | null = null;
    let userArn = '';
    const vend = async (): Promise<AwsCredentials> => {
      const admin = await getAdminUser();
      const creds = await getTestCredentials();
      const idToken = idTokenFor(admin.email, admin.password, creds.cognitoClientId);
      const r = await exchange(idToken, {});
      if (r.status !== 200 || !r.body?.credentials || !String(r.body?.userArn || '').includes('/user/')) {
        throw new Error(`the person exchange refused the e2e admin (status ${r.status})`);
      }
      userArn = String(r.body.userArn);
      const c = credentialsFrom(r.body.credentials);
      // A vend that does not say when it lapses is renewed every 50 minutes.
      return { ...c, expiresAt: c.expiresAt ?? Date.now() + 50 * 60_000 };
    };
    const credentials: CredentialSource = async () => {
      if (!held || (held.expiresAt ?? 0) - Date.now() < 5 * 60_000) held = await vend();
      return held;
    };
    await credentials();
    return { credentials, userArn };
  }

  private onAlert(m: ListedMessage): void {
    this.record = readRecord(this.recordFile) ?? this.record;
    if (this.record.alerts.some((a) => a.messageId === m.messageId)) return;
    const v = classifyAlert(
      { messageId: m.messageId, createdAtMs: m.createdAtMs, content: m.content, metadata: m.metadata },
      { phaseStartMs: this.record.phaseStartedAt, expected: this.record.expected },
    );
    this.record.alerts.push(v);
    this.record.lastAlertAtMs = Math.max(this.record.lastAlertAtMs, m.createdAtMs);
    this.persist();
    const text = describeAlert(v);
    if (!v.fails) {
      log(`${text}${v.expected ? ' (declared by a spec)' : v.preexisting ? ' (before this phase)' : ''}`);
      return;
    }
    if (this.current) this.current.fail(text);
    else this.unattributed(`${text} (no test running)`);
  }
}
