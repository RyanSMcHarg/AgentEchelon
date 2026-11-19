/**
 * WHETHER THIS PERSON IS IN A CONVERSATION'S MEETING, in another window of this browser: the meeting window holds a Web
 * Lock named for the conversation while it is joined, and says so on a BroadcastChannel. The browser releases a lock when
 * its window closes, so the app learns the person left, however they left, by waiting on that lock: nothing polls.
 *
 * Without Web Locks the broadcast alone answers, and a window closed without leaving reads as still present until the
 * next status read. Without either, nobody reads as present, and the app offers Join, which brings the window forward.
 */

const CHANNEL = 'ae-meeting-presence';
const lockName = (conversationId: string): string => `ae-in-meeting-${conversationId}`;

type PresenceMessage = { conversationId: string; present: boolean };

function locks(): LockManager | undefined {
  return typeof navigator !== 'undefined' ? navigator.locks : undefined;
}

function broadcast(message: PresenceMessage): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage(message);
    bc.close();
  } catch { /* another window learns at its next status read */ }
}

/**
 * The meeting window is joined: hold the conversation's lock and say so. Answers the release, which says the window left.
 * A request still waiting for the lock when the window leaves is withdrawn, and one granted after that lets go at once,
 * so a window that has left never holds the lock.
 */
export function holdMeetingPresence(conversationId: string): () => void {
  let release: (() => void) | undefined;
  let stopped = false;
  const waiting = new AbortController();
  const lm = locks();
  if (lm) {
    void lm.request(lockName(conversationId), { signal: waiting.signal }, () => {
      if (stopped) return undefined;
      // HELD NOW, said again: a window that heard this one's last release while this request waited reads it present.
      broadcast({ conversationId, present: true });
      return new Promise<void>((resolve) => { release = resolve; });
    }).catch(() => undefined);
  }
  broadcast({ conversationId, present: true });
  // ASKED TO COME FORWARD by another window of this person's (the app's Return to meeting): this window raises itself,
  // where the browser lets a window do so.
  let forward: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      forward = new BroadcastChannel(FORWARD_CHANNEL);
      forward.onmessage = (e: MessageEvent<{ conversationId?: string }>) => {
        if (!stopped && e.data?.conversationId === conversationId) {
          try { window.focus(); } catch { /* the person brings it forward themselves */ }
        }
      };
    } catch { forward = null; }
  }
  return () => {
    stopped = true;
    waiting.abort();
    release?.();
    forward?.close();
    broadcast({ conversationId, present: false });
  };
}

const FORWARD_CHANNEL = 'ae-meeting-forward';

/**
 * ASK THE WINDOW THIS PERSON IS IN THE MEETING FROM TO COME FORWARD, under any name the meeting goes by. A browser may
 * refuse a background tab's request to raise itself, so the caller also tells the person where the meeting is.
 */
export function askMeetingWindowForward(conversationIds: readonly string[]): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const bc = new BroadcastChannel(FORWARD_CHANNEL);
    for (const conversationId of new Set(conversationIds.filter(Boolean))) bc.postMessage({ conversationId });
    bc.close();
  } catch { /* the person brings it forward themselves */ }
}

/**
 * Hold presence under every name one meeting goes by (the conversation the window entered from, the meeting's own
 * conversation, and the room it was started from), so each of those conversations sees this person in it. Answers the
 * release of all of them.
 */
export function holdMeetingPresenceAs(conversationIds: readonly string[]): () => void {
  const releases = [...new Set(conversationIds.filter(Boolean))].map(holdMeetingPresence);
  return () => { for (const release of releases) release(); };
}

/**
 * RUN `then` UNLESS THIS PERSON IS IN THE CONVERSATION'S MEETING in a window of this browser (a window holds its lock): a
 * ring for a meeting they are already in, their own start among them, rings nobody. Without Web Locks nobody reads as
 * present, and `then` runs at once.
 */
export function unlessInMeeting(conversationId: string, then: () => void): void {
  const lm = locks();
  if (!lm) { then(); return; }
  const name = lockName(conversationId);
  void lm.query()
    .then((s) => { if (!(s.held ?? []).some((l) => l.name === name)) then(); })
    .catch(() => then());
}

/**
 * Follow whether this person is in a meeting known by any of several names, in another window: present while a window
 * holds any of them. Answers the stop.
 */
export function watchMeetingPresenceAs(conversationIds: readonly string[], onChange: (present: boolean) => void): () => void {
  const present = new Set<string>();
  let last = false;
  const stops = [...new Set(conversationIds.filter(Boolean))].map((id) => watchMeetingPresence(id, (here) => {
    if (here) present.add(id); else present.delete(id);
    const now = present.size > 0;
    if (now !== last) { last = now; onChange(now); }
  }));
  return () => { for (const stop of stops) stop(); };
}

/**
 * Follow whether this person is in the conversation's meeting in another window. `onChange` hears true while a window
 * holds it and false once none does. Answers the stop.
 */
export function watchMeetingPresence(conversationId: string, onChange: (present: boolean) => void): () => void {
  const lm = locks();
  const name = lockName(conversationId);
  let stopped = false;
  let waiting: AbortController | null = null;

  // Wait for the holder to let go: the lock is granted to this window the moment it does, and handed straight back.
  const awaitRelease = () => {
    if (!lm || waiting || stopped) return;
    waiting = new AbortController();
    void lm.request(name, { signal: waiting.signal }, async () => undefined)
      .then(async () => {
        waiting = null;
        if (stopped) return;
        // PRESENCE RE-TAKEN (a rejoin lets go and holds again): a window that holds it again by now is still present.
        const again = await lm.query().then((s) => (s.held ?? []).some((l) => l.name === name)).catch(() => false);
        if (stopped) return;
        if (again) present(); else onChange(false);
      })
      .catch(() => { waiting = null; });
  };
  const present = () => { if (!stopped) { onChange(true); awaitRelease(); } };

  if (lm) {
    void lm.query().then((s) => { if ((s.held ?? []).some((l) => l.name === name)) present(); }).catch(() => undefined);
  }
  let bc: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      bc = new BroadcastChannel(CHANNEL);
      bc.onmessage = (e: MessageEvent<PresenceMessage>) => {
        if (e.data?.conversationId !== conversationId) return;
        if (e.data.present) present();
        else if (!lm && !stopped) onChange(false);
      };
    } catch { bc = null; }
  }
  return () => {
    stopped = true;
    waiting?.abort();
    bc?.close();
  };
}

/**
 * ONE TAB RINGS PER PERSON: the ring's tone plays in the tab that takes this lock, and the others show the ring silently.
 * Answers the stop. Without Web Locks every tab rings, as before.
 */
/**
 * THE TONE LOCK THIS TAB HOLDS, and the ring playing under it. A ring that replaces another in this tab stops the old one
 * and starts in the same render, before the old ring's lock is let go, so it takes the tone over under the same lock
 * rather than asking for one this tab still holds. The lock is let go once no ring of this tab took it over.
 */
let tabTone: { owner: symbol | null; stopTone?: () => void; release: () => void } | null = null;

export function ringInOneTab(startTone: () => () => void): () => void {
  const lm = locks();
  if (!lm) return startTone();
  const me = Symbol('ring');
  let stopped = false;
  const play = () => {
    if (!tabTone) return;
    tabTone.owner = me;
    tabTone.stopTone = startTone();
  };
  if (tabTone && tabTone.owner === null) {
    play();
  } else {
    void lm.request('ae-meeting-ring-tone', { ifAvailable: true }, (lock) => {
      if (!lock || stopped) return undefined;
      return new Promise<void>((resolve) => {
        tabTone = { owner: null, release: () => { tabTone = null; resolve(); } };
        play();
      });
    }).catch(() => undefined);
  }
  return () => {
    stopped = true;
    const held = tabTone;
    if (!held || held.owner !== me) return;
    held.stopTone?.();
    held.stopTone = undefined;
    held.owner = null;
    // Let go once this render is done, unless a ring that replaced this one took the tone over meanwhile.
    queueMicrotask(() => { if (tabTone === held && held.owner === null) held.release(); });
  };
}

/**
 * ONE OUTCOME PER RING PER PERSON. Every tab and window of this person's app hears the same ring, so the first to settle
 * it (answered, dismissed, or run out) records that for all of them and says so: the others stop showing it and report
 * nothing, so one ring is one answered, dismissed or timed-out figure. Settling is serialized on a Web Lock where the
 * browser has one, and the record lasts a little past when the ring would have stopped.
 */
const RING_CHANNEL = 'ae-meeting-ring';
const RING_SETTLED = 'ae.meeting.ringSettled';
/**
 * How long past its stop a settled ring stays settled: every tab's own ring runs out at about the same moment, by clocks
 * that agree only to within a delivery, and each must find it settled. A ring-off forgets it sooner.
 */
const RING_SETTLED_GRACE_MS = 30_000;

type RingSettled = { channelArn: string; until: number };

function settledRings(now: number): Record<string, number> {
  try {
    const all = JSON.parse(localStorage.getItem(RING_SETTLED) || '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(all).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > now));
  } catch {
    return {};
  }
}

function writeSettledRings(rings: Record<string, number>): void {
  try { localStorage.setItem(RING_SETTLED, JSON.stringify(rings)); } catch { /* this tab still settles its own ring */ }
}

/** Whether another tab of this person's already settled the conversation's ring. */
export function isRingSettled(channelArn: string, now = Date.now()): boolean {
  return channelArn in settledRings(now);
}

/** A new meeting may ring the conversation again: what was settled for its last ring is forgotten. */
export function forgetSettledRing(channelArn: string, now = Date.now()): void {
  const rings = settledRings(now);
  if (!(channelArn in rings)) return;
  delete rings[channelArn];
  writeSettledRings(rings);
}

/**
 * Settle the conversation's ring, which stops ringing at `until`: the first tab to settle it runs `report` and tells the
 * others; a ring another tab settled first reports nothing here.
 */
export function settleRingOnce(channelArn: string, until: number, report: () => void): void {
  const settle = () => {
    const now = Date.now();
    const rings = settledRings(now);
    if (channelArn in rings) return;
    rings[channelArn] = Math.max(until, now) + RING_SETTLED_GRACE_MS;
    writeSettledRings(rings);
    report();
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      const bc = new BroadcastChannel(RING_CHANNEL);
      bc.postMessage({ channelArn, until } satisfies RingSettled);
      bc.close();
    } catch { /* the other tabs find it settled when theirs runs out */ }
  };
  const lm = locks();
  if (!lm) { settle(); return; }
  void lm.request('ae-meeting-ring-outcome', async () => { settle(); }).catch(() => undefined);
}

/** Hear another tab settle a ring, so this one stops showing it. Answers the stop. */
export function onRingSettledElsewhere(onSettled: (ring: RingSettled) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel(RING_CHANNEL);
    bc.onmessage = (e: MessageEvent<RingSettled>) => {
      if (typeof e.data?.channelArn === 'string' && typeof e.data.until === 'number') onSettled(e.data);
    };
  } catch { bc = null; }
  return () => { bc?.close(); };
}

/** How long one tab's claim on a meeting's ring stands: the sibling project's invitation claim window. */
export const RING_CLAIM_MS = 30_000;
const ringClaimKey = (conversationId: string): string => `meeting-invite-claim-${conversationId}`;
/** This tab, as its claims name it. */
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * ONE TAB OF THIS BROWSER RINGS FOR A MEETING (the sibling project's per-invitation claim): the first tab to hear the ring
 * of a meeting, by its own conversation, claims it in local storage for {@link RING_CLAIM_MS}, and every other tab that
 * hears the same ring inside that window shows nothing. The claiming tab may ring again for it. Without local storage
 * every tab rings, as before.
 */
export function claimMeetingRing(conversationId: string, now = Date.now()): boolean {
  if (!conversationId) return true;
  try {
    const held = localStorage.getItem(ringClaimKey(conversationId));
    if (held) {
      const [tab, at] = held.split('@');
      if (tab !== TAB_ID && now - Number(at) < RING_CLAIM_MS) return false;
    }
    localStorage.setItem(ringClaimKey(conversationId), `${TAB_ID}@${now}`);
  } catch { /* this tab rings */ }
  return true;
}

/**
 * A MEETING'S RING IS OVER FOR THIS PERSON, wherever they are: they took the meeting (a ring-off addressed to them), or it
 * ended. Recorded as settled for as long as any ring of it could still sound, so a ring that arrives after the ring-off
 * (their own start, taken before its ring went out) rings nobody here.
 */
export function ringOver(channelArn: string, now = Date.now(), ringSeconds = 60): void {
  settleRingOnce(channelArn, now + ringSeconds * 1000, () => undefined);
}
