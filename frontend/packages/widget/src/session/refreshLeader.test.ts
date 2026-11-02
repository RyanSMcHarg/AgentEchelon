/**
 * One refresh holder for every tab of a guest visit: only the leader presents the refresh credential,
 * a follower is handed the leader's rotation, a new tab joins the open visit, and a visit that ends
 * ends everywhere (A7).
 */
import { describe, it, expect, vi } from 'vitest';
import { GuestVisit, TOKEN_MARGIN_MS, type TabChannel, type TabLocks } from './refreshLeader';
import { WidgetRefusal, type GuestTokens } from './personApi';

/** An in-memory BroadcastChannel: every channel on one bus hears the others, never itself. */
function bus() {
  const members = new Set<TabChannel>();
  return () => {
    const ch: TabChannel = {
      onmessage: null,
      postMessage(message) {
        for (const other of members) if (other !== ch) queueMicrotask(() => other.onmessage?.({ data: structuredClone(message) }));
      },
      close() {
        members.delete(ch);
      },
    };
    members.add(ch);
    return ch;
  };
}

/** An in-memory Web Lock: the first requester holds it; the next is granted it when the holder releases. */
function lockManager(): TabLocks {
  const queue: Array<() => Promise<void>> = [];
  let held = false;
  const next = () => {
    const cb = queue.shift();
    if (!cb) return;
    held = true;
    void cb().then(() => {
      held = false;
      next();
    });
  };
  return {
    request(_name, cb) {
      queue.push(cb);
      if (!held) next();
      return Promise.resolve();
    },
  };
}

const memoryStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

let clock = 1_000_000_000_000;
const now = () => clock;

function tokens(n: number, overrides: Partial<GuestTokens> = {}): GuestTokens {
  return {
    guestToken: `guest-${n}`,
    guestTokenExpiresAt: Math.floor(clock / 1000) + 600,
    refreshToken: `refresh-${n}`,
    sessionEndsAt: Math.floor(clock / 1000) + 86400,
    channelArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/c1',
    userArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/i/user/visitor',
    ...overrides,
  };
}

function twoTabs(refresh = vi.fn(async (presented: string) => tokens(Number(presented.split('-')[1]) + 1))) {
  const channel = bus();
  const locks = lockManager();
  const a = new GuestVisit('v', { refresh, channel: channel(), locks, storage: memoryStorage(), now, followerWaitMs: 50, helloWaitMs: 20 });
  const b = new GuestVisit('v', { refresh, channel: channel(), locks, storage: memoryStorage(), now, followerWaitMs: 50, helloWaitMs: 20 });
  return { a, b, refresh, channel, locks };
}

describe('the refresh leader', () => {
  it('elects exactly one leader among the tabs', async () => {
    const { a, b } = twoTabs();
    await flush();
    expect([a.isLeader(), b.isLeader()]).toEqual([true, false]);
  });

  it('a new tab joins the visit another tab opened, without a guest start of its own', async () => {
    const { a, b } = twoTabs();
    await flush();
    a.open(tokens(1));
    await flush();
    const joined = await b.join();
    expect(joined?.channelArn).toBe(tokens(1).channelArn);
    expect(b.current()?.refreshToken).toBe('refresh-1');
  });

  it('two tabs needing a fresh token at once spend the refresh credential once, in the leader', async () => {
    const { a, b, refresh } = twoTabs();
    await flush();
    a.open(tokens(1));
    await flush();
    // Both tabs' tokens are now inside the margin.
    clock += 600_000 - TOKEN_MARGIN_MS + 1;
    const [ta, tb] = await Promise.all([a.guestToken(), b.guestToken()]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('refresh-1');
    expect([ta, tb]).toEqual(['guest-2', 'guest-2']);
    expect(b.current()?.refreshToken).toBe('refresh-2');
  });

  it('a follower never presents the refresh credential while the leader answers', async () => {
    const leaderRefresh = vi.fn(async () => tokens(2));
    const followerRefresh = vi.fn(async () => tokens(99));
    const channel = bus();
    const locks = lockManager();
    const a = new GuestVisit('v', { refresh: leaderRefresh, channel: channel(), locks, storage: memoryStorage(), now, followerWaitMs: 200 });
    const b = new GuestVisit('v', { refresh: followerRefresh, channel: channel(), locks, storage: memoryStorage(), now, followerWaitMs: 200 });
    await flush();
    a.open(tokens(1));
    await flush();
    clock += 600_000;
    expect(await b.guestToken()).toBe('guest-2');
    expect(followerRefresh).not.toHaveBeenCalled();
    expect(leaderRefresh).toHaveBeenCalledTimes(1);
  });

  it('hands the lock to the next tab when the leader closes, and that tab refreshes', async () => {
    const { a, b, refresh } = twoTabs();
    await flush();
    a.open(tokens(1));
    await flush();
    a.close();
    await flush();
    expect(b.isLeader()).toBe(true);
    clock += 600_000;
    expect(await b.guestToken()).toBe('guest-2');
    expect(refresh).toHaveBeenCalledWith('refresh-1');
  });

  it('a replayed refresh ends the visit in every tab, as "opened elsewhere"', async () => {
    const refresh = vi.fn(async () => {
      throw new WidgetRefusal('replayed', 401);
    });
    const { a, b } = twoTabs(refresh);
    await flush();
    a.open(tokens(1));
    await flush();
    const endedA = vi.fn();
    const endedB = vi.fn();
    a.onEnded(endedA);
    b.onEnded(endedB);
    clock += 600_000;
    await expect(a.guestToken()).rejects.toMatchObject({ code: 'replayed' });
    await flush();
    expect(endedA).toHaveBeenCalledWith('replayed');
    expect(endedB).toHaveBeenCalledWith('replayed');
    expect(a.current()).toBeNull();
    expect(b.current()).toBeNull();
    await expect(b.guestToken()).rejects.toMatchObject({ code: 'replayed' });
  });

  it('a refusal that does not end the visit (the store is down) keeps it', async () => {
    const refresh = vi.fn(async () => {
      throw new WidgetRefusal('unavailable', 503);
    });
    const { a } = twoTabs(refresh);
    await flush();
    a.open(tokens(1));
    clock += 600_000;
    await expect(a.guestToken()).rejects.toMatchObject({ code: 'unavailable' });
    expect(a.current()?.refreshToken).toBe('refresh-1');
  });

  it('keeps the visit across a reload, in this tab only, and never past its end', () => {
    const storage = memoryStorage();
    const first = new GuestVisit('v', { refresh: vi.fn(), channel: null, locks: null, storage, now });
    first.open(tokens(1));
    first.close();
    const reloaded = new GuestVisit('v', { refresh: vi.fn(), channel: null, locks: null, storage, now });
    return reloaded.join().then((joined) => {
      expect(joined?.refreshToken).toBe('refresh-1');
      clock += 86_400_001;
      const later = new GuestVisit('v', { refresh: vi.fn(), channel: null, locks: null, storage, now });
      return later.join();
    }).then((joined) => expect(joined).toBeNull());
  });

  it('without Web Locks, each tab refreshes for itself (the server grace window covers the second)', async () => {
    const channel = bus();
    const a = new GuestVisit('v', { refresh: vi.fn(), channel: channel(), locks: null, storage: memoryStorage(), now });
    const b = new GuestVisit('v', { refresh: vi.fn(), channel: channel(), locks: null, storage: memoryStorage(), now });
    expect([a.isLeader(), b.isLeader()]).toEqual([true, true]);
  });
});

describe('a sign-in hand-off', () => {
  it('is one refresh with the secret hash, whose nonce is returned and never stored or announced', async () => {
    const storage = memoryStorage();
    const refresh = vi.fn(async (_t: string, _o?: { bindSecretHash?: string }) => ({ ...tokens(2), bindNonce: 'nonce-1' }));
    const visit = new GuestVisit('handoff', { refresh, channel: null, locks: null, storage, now });
    visit.open(tokens(1));
    expect(await visit.handOff('h'.repeat(43))).toBe('nonce-1');
    expect(refresh).toHaveBeenCalledWith(tokens(1).refreshToken, { bindSecretHash: 'h'.repeat(43) });
    expect(visit.current()).toEqual(tokens(2));
    expect(JSON.stringify(storage.getItem('ae-widget:guest-visit'))).not.toContain('nonce-1');
  });

  it('is refused when the server mints no nonce, and ends the visit on an ending refusal', async () => {
    const visit = new GuestVisit('handoff2', { refresh: vi.fn(async () => tokens(2)), channel: null, locks: null, storage: memoryStorage(), now });
    visit.open(tokens(1));
    await expect(visit.handOff('h'.repeat(43))).rejects.toMatchObject({ code: 'unavailable' });
    const ended = new GuestVisit('handoff3', { refresh: vi.fn(async () => { throw new WidgetRefusal('revoked', 401); }), channel: null, locks: null, storage: memoryStorage(), now });
    ended.open(tokens(1));
    await expect(ended.handOff('h'.repeat(43))).rejects.toMatchObject({ code: 'revoked' });
    expect(ended.current()).toBeNull();
  });
});
