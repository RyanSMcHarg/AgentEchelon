/**
 * ONE REFRESH HOLDER FOR EVERY TAB OF A GUEST VISIT (A7).
 *
 * A guest's refresh credential is single-use and rotated on every use, and presenting a used one again
 * is a replay that revokes the whole visit (`backend/lambda/src/guest-session.ts`). Two tabs of the same
 * visitor that each refreshed on their own would spend the same credential twice. So the tabs on one
 * origin elect one leader, and only the leader ever presents the refresh credential:
 *
 *  - **Election** is a Web Lock (`navigator.locks`): every tab asks for the same lock, the first holds it
 *    for as long as it is open, and when it closes the browser hands the lock to the next tab in line.
 *  - **The record travels on a `BroadcastChannel`**: the leader publishes every rotation (`state`), a
 *    follower whose guest token is near its expiry asks for a fresh one (`need`), and a new tab asks
 *    whether a visit is already open (`hello`), so it joins the same conversation.
 *  - **A visit that ends ends in every tab** (`ended`): a refused refresh is shown once, everywhere,
 *    as the settled state its reason names.
 *
 * The server's short reuse grace (a used credential presented again within 10 seconds, at most twice) is
 * the backstop for the moments this cannot cover: a leader that closed mid-rotation, a browser with no
 * Web Locks (where each tab refreshes for itself), or a follower whose leader did not answer in time.
 *
 * The record is also kept in this tab's `sessionStorage`, bounded by the visit's end, so a reload keeps
 * the conversation. It is never in `localStorage` and never outlives the visit.
 */
import { WidgetRefusal, type GuestTokens, type RefusalCode } from './personApi';

/** A guest token this close to its expiry is refreshed before it is used. */
export const TOKEN_MARGIN_MS = 60_000;
/** How long a follower waits for the leader before refreshing for itself. */
export const FOLLOWER_WAIT_MS = 5_000;
/** How long a new tab waits to hear of an open visit. */
export const HELLO_WAIT_MS = 400;

/** The refusals that end the visit, in every tab: the conversation was opened elsewhere, or it is over. */
export const ENDING: ReadonlySet<RefusalCode> = new Set(['replayed', 'revoked', 'ended', 'expired']);

type Message =
  | { t: 'state'; record: GuestTokens }
  | { t: 'need' }
  | { t: 'hello' }
  | { t: 'ended'; code: RefusalCode };

/** The `BroadcastChannel` surface this uses. */
export interface TabChannel {
  postMessage(message: Message): void;
  onmessage: ((event: { data: Message }) => void) | null;
  close(): void;
}

/** The `navigator.locks` surface this uses. */
export interface TabLocks {
  request(name: string, callback: () => Promise<void>): Promise<unknown>;
}

export interface RefreshLeaderDeps {
  /** Spends a refresh credential (`POST /guest/refresh`), minting a sign-in hand-off when asked to. */
  refresh: (refreshToken: string, opts?: { bindSecretHash?: string }) => Promise<GuestTokens & { bindNonce?: string }>;
  /** Default: a `BroadcastChannel` named for the holder, when the browser has one. */
  channel?: TabChannel | null;
  /** Default: `navigator.locks`, when the browser has it. */
  locks?: TabLocks | null;
  /** Default: `sessionStorage`. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  now?: () => number;
  followerWaitMs?: number;
  helloWaitMs?: number;
}

const STORAGE_KEY = 'ae-widget:guest-visit';

function defaultChannel(name: string): TabChannel | null {
  return typeof BroadcastChannel === 'function' ? (new BroadcastChannel(name) as unknown as TabChannel) : null;
}

function defaultLocks(): TabLocks | null {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: TabLocks }).locks : undefined;
  return locks && typeof locks.request === 'function' ? locks : null;
}

function defaultStorage(): RefreshLeaderDeps['storage'] {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

export class GuestVisit {
  private record: GuestTokens | null = null;
  private leader = false;
  private releaseLock: (() => void) | null = null;
  private refreshing: Promise<GuestTokens> | null = null;
  private waiters: Array<(r: GuestTokens) => void> = [];
  private readonly changed = new Set<(r: GuestTokens) => void>();
  private readonly endedListeners = new Set<(code: RefusalCode) => void>();
  private endedCode: RefusalCode | null = null;
  private readonly channel: TabChannel | null;
  private readonly locks: TabLocks | null;
  private readonly storage: RefreshLeaderDeps['storage'];
  private readonly now: () => number;
  private readonly deps: RefreshLeaderDeps;

  constructor(name: string, deps: RefreshLeaderDeps) {
    this.deps = deps;
    this.channel = deps.channel === undefined ? defaultChannel(name) : deps.channel;
    this.locks = deps.locks === undefined ? defaultLocks() : deps.locks;
    this.storage = deps.storage === undefined ? defaultStorage() : deps.storage;
    this.now = deps.now ?? Date.now;
    if (this.channel) this.channel.onmessage = (e) => this.receive(e.data);
    if (this.locks) {
      void this.locks.request(name, () => {
        this.leader = true;
        return new Promise<void>((resolve) => { this.releaseLock = resolve; });
      });
    } else {
      // No election: this tab refreshes for itself, and the server's reuse grace absorbs a second tab.
      this.leader = true;
    }
  }

  /** Whether this tab holds the refresh credential's lock. */
  isLeader(): boolean {
    return this.leader;
  }

  /** The visit as this tab knows it, or null before one is opened or joined. */
  current(): GuestTokens | null {
    return this.record;
  }

  /** Called with every record this tab adopts, its own refreshes and other tabs' alike. */
  onChange(cb: (r: GuestTokens) => void): () => void {
    this.changed.add(cb);
    return () => this.changed.delete(cb);
  }

  /** Called once when the visit ends, in this tab or another, with the refusal that ended it. */
  onEnded(cb: (code: RefusalCode) => void): () => void {
    this.endedListeners.add(cb);
    if (this.endedCode) cb(this.endedCode);
    return () => this.endedListeners.delete(cb);
  }

  /**
   * The visit already open on this origin: this tab's own (a reload), or another tab's, which answers a
   * `hello`. Null when there is none, so the widget offers a guest start.
   */
  async join(): Promise<GuestTokens | null> {
    const stored = this.readStored();
    if (stored) {
      this.adopt(stored, false);
      return stored;
    }
    if (!this.channel) return null;
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: GuestTokens | null) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      this.waiters.push((r) => done(r));
      this.channel!.postMessage({ t: 'hello' });
      setTimeout(() => done(this.record), this.deps.helloWaitMs ?? HELLO_WAIT_MS);
    });
  }

  /** A visit this tab just started (guest start): adopt it, and tell the other tabs. */
  open(record: GuestTokens): void {
    this.endedCode = null;
    this.adopt(record, true);
  }

  /**
   * A guest token valid for at least `TOKEN_MARGIN_MS`. The leader refreshes when it must, one refresh at
   * a time; a follower asks the leader, and refreshes for itself only when the leader does not answer.
   * Throws the refusal when the visit cannot continue.
   */
  async guestToken(): Promise<string> {
    if (this.endedCode) throw new WidgetRefusal(this.endedCode, 401);
    const r = this.record;
    if (!r) throw new WidgetRefusal('ended', 401);
    if (this.fresh(r)) return r.guestToken;
    if (this.leader || !this.channel) return (await this.refreshOnce()).guestToken;
    const fromLeader = await this.askLeader();
    if (fromLeader && this.fresh(fromLeader)) return fromLeader.guestToken;
    if (this.endedCode) throw new WidgetRefusal(this.endedCode, 401);
    return (await this.refreshOnce()).guestToken;
  }

  /**
   * A SIGN-IN HAND-OFF (path A): one refresh, made with the hash of the secret this page keeps, which the
   * server answers with a nonce naming the credential it issued. One refresh at a time, as every refresh.
   * The nonce is never stored or announced: it goes into the sign-in link, and nowhere else.
   */
  async handOff(bindSecretHash: string): Promise<string> {
    if (this.endedCode) throw new WidgetRefusal(this.endedCode, 401);
    if (this.refreshing) await this.refreshing.catch(() => undefined);
    const presented = this.record?.refreshToken;
    if (!presented) throw new WidgetRefusal('ended', 401);
    let nonce: string | undefined;
    const run = this.deps.refresh(presented, { bindSecretHash })
      .then((next) => {
        const { bindNonce, ...tokens } = next;
        nonce = bindNonce;
        this.adopt(tokens, true);
        return tokens;
      })
      .catch((err: unknown) => {
        if (err instanceof WidgetRefusal && ENDING.has(err.code)) this.end(err.code, true);
        throw err;
      })
      .finally(() => {
        this.refreshing = null;
      });
    this.refreshing = run;
    await run;
    if (!nonce) throw new WidgetRefusal('unavailable', 0);
    return nonce;
  }

  /** Forget the visit in this tab (a reload action after it ended), without touching the other tabs. */
  forget(): void {
    this.record = null;
    this.endedCode = null;
    this.storage?.removeItem(STORAGE_KEY);
  }

  close(): void {
    this.releaseLock?.();
    this.releaseLock = null;
    this.leader = false;
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────

  private fresh(r: GuestTokens): boolean {
    return r.guestTokenExpiresAt * 1000 - this.now() > TOKEN_MARGIN_MS;
  }

  private receive(m: Message): void {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'state') {
      if (!this.record || m.record.guestTokenExpiresAt >= this.record.guestTokenExpiresAt) this.adopt(m.record, false);
      return;
    }
    if (m.t === 'ended') {
      this.end(m.code, false);
      return;
    }
    // A `hello` or a `need` is answered by the leader, or by any tab where nothing was elected.
    if (!this.leader && this.locks) return;
    if (m.t === 'hello' && this.record) {
      this.channel?.postMessage({ t: 'state', record: this.record });
      return;
    }
    if (m.t === 'need' && this.record) {
      if (this.fresh(this.record)) this.channel?.postMessage({ t: 'state', record: this.record });
      else void this.refreshOnce().catch(() => undefined);
    }
  }

  private adopt(record: GuestTokens, announce: boolean): void {
    this.record = record;
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(record));
    } catch {
      /* storage full or unavailable: the visit lasts as long as this tab */
    }
    if (announce) this.channel?.postMessage({ t: 'state', record });
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w(record);
    for (const cb of this.changed) cb(record);
  }

  private end(code: RefusalCode, announce: boolean): void {
    if (this.endedCode) return;
    this.endedCode = code;
    this.record = null;
    this.storage?.removeItem(STORAGE_KEY);
    if (announce) this.channel?.postMessage({ t: 'ended', code });
    for (const cb of this.endedListeners) cb(code);
  }

  private readStored(): GuestTokens | null {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return null;
      const r = JSON.parse(raw) as GuestTokens;
      if (!r || typeof r.refreshToken !== 'string' || !(r.sessionEndsAt * 1000 > this.now())) {
        this.storage?.removeItem(STORAGE_KEY);
        return null;
      }
      return r;
    } catch {
      return null;
    }
  }

  private askLeader(): Promise<GuestTokens | null> {
    return new Promise((resolve) => {
      let settled = false;
      let off: () => void = () => undefined;
      const done = (r: GuestTokens | null) => {
        if (settled) return;
        settled = true;
        off();
        resolve(r);
      };
      this.waiters.push((r) => done(r));
      off = this.onEnded(() => done(null));
      this.channel!.postMessage({ t: 'need' });
      setTimeout(() => done(null), this.deps.followerWaitMs ?? FOLLOWER_WAIT_MS);
    });
  }

  private refreshOnce(): Promise<GuestTokens> {
    if (this.refreshing) return this.refreshing;
    const presented = this.record?.refreshToken;
    if (!presented) return Promise.reject(new WidgetRefusal('ended', 401));
    this.refreshing = this.deps.refresh(presented)
      .then((next) => {
        this.adopt(next, true);
        return next;
      })
      .catch((err: unknown) => {
        if (err instanceof WidgetRefusal && ENDING.has(err.code)) this.end(err.code, true);
        throw err;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }
}
