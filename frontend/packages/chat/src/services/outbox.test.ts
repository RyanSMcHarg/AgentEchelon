/**
 * The device cache and its outbox (`composerCache.ts`, `outbox.ts`): records are per person, a write from an ended session
 * is dropped, the cache clears when a session ends, a staged file is kept only within the cap, and the outbox is sent in
 * order with each message once - including one whose earlier send was never answered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  STAGED_FILE_CAP_BYTES, cacheSession, keepStagedFile, outboxEntries, putOutboxEntry, readDraft, restoreStagedFile,
  setBlobStore, writeDraft, type BlobStore, type OutboxEntry,
} from './composerCache';
import { drainOutbox, isUnknownOutcome } from './outbox';
import { endSessionEpoch } from '@ae/shared/services/sessionEpoch.ts';

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';

function memoryBlobStore(): BlobStore & { map: Map<string, Blob> } {
  const map = new Map<string, Blob>();
  return {
    map,
    put: async (k, b) => { map.set(k, b); },
    get: async (k) => map.get(k),
    delete: async (k) => { map.delete(k); },
    clear: async () => { map.clear(); },
  };
}

const entry = (id: string, createdAt: number, extra: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id, conversationId: 'c1', channelArn: CHANNEL, content: `message ${id}`, createdAt, ...extra,
});

/** An error as the AWS SDK raises a service's answer. */
const refused = (status: number) => Object.assign(new Error(`refused ${status}`), { $metadata: { httpStatusCode: status } });

let blobs: ReturnType<typeof memoryBlobStore>;
beforeEach(() => {
  blobs = memoryBlobStore();
  setBlobStore(blobs);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the draft record', () => {
  it('is restored as written, picks and all, for its person and conversation only', () => {
    const s = cacheSession();
    writeDraft('p1', 'c1', { draft: { text: '@Alice hi', mentions: [{ start: 0, end: 6, token: '@<Alice|a>' }] } }, s);
    expect(readDraft('p1', 'c1')).toEqual({ draft: { text: '@Alice hi', mentions: [{ start: 0, end: 6, token: '@<Alice|a>' }] } });
    expect(readDraft('p2', 'c1')).toBeUndefined();
    expect(readDraft('p1', 'c2')).toBeUndefined();
  });

  it('a record whose picks no longer fit its text is read as its text alone', () => {
    localStorage.setItem('ae.composer.v1.draft.p1.c1', JSON.stringify({ draft: { text: 'hi', mentions: [{ start: 0, end: 9, token: '@<X|x>' }] } }));
    expect(readDraft('p1', 'c1')).toEqual({ draft: { text: 'hi', mentions: [] } });
  });

  it('an empty draft with no file removes the record', () => {
    const s = cacheSession();
    writeDraft('p1', 'c1', { draft: { text: 'x', mentions: [] } }, s);
    writeDraft('p1', 'c1', { draft: { text: '', mentions: [] } }, s);
    expect(localStorage.getItem('ae.composer.v1.draft.p1.c1')).toBeNull();
  });

  it('a storage that refuses leaves the composer working, with nothing kept', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    expect(() => writeDraft('p1', 'c1', { draft: { text: 'x', mentions: [] } }, cacheSession())).not.toThrow();
    expect(readDraft('p1', 'c1')).toBeUndefined();
  });
});

describe('sign-out', () => {
  it('clears every record and file, and a write from the ended session is dropped', async () => {
    const s = cacheSession();
    writeDraft('p1', 'c1', { draft: { text: 'x', mentions: [] } }, s);
    putOutboxEntry('p1', entry('a', 1), s);
    await keepStagedFile('p1', 'c1', new File(['abc'], 'a.txt', { type: 'text/plain' }), s);
    expect(blobs.map.size).toBe(1);

    endSessionEpoch('signed-out');
    await Promise.resolve();
    await Promise.resolve();

    expect(readDraft('p1', 'c1')).toBeUndefined();
    expect(outboxEntries('p1')).toEqual([]);
    expect(blobs.map.size).toBe(0);
    writeDraft('p1', 'c1', { draft: { text: 'late', mentions: [] } }, s);
    putOutboxEntry('p1', entry('late', 2), s);
    expect(readDraft('p1', 'c1')).toBeUndefined();
    expect(outboxEntries('p1')).toEqual([]);
  });
});

describe('a session that ends without a sign-out', () => {
  it('leaves the drafts, the outbox and the staged files, which another window may still be sending from', async () => {
    const s = cacheSession();
    writeDraft('p1', 'c1', { draft: { text: 'kept', mentions: [] } }, s);
    putOutboxEntry('p1', entry('q', 1), s);
    await keepStagedFile('p1', 'c1', new File(['abc'], 'a.txt', { type: 'text/plain' }), s);

    endSessionEpoch('ended');
    await Promise.resolve();
    await Promise.resolve();

    expect(readDraft('p1', 'c1')?.draft.text).toBe('kept');
    expect(outboxEntries('p1').map((e) => e.id)).toEqual(['q']);
    expect(blobs.map.size).toBe(1);
  });
});

describe('a staged file', () => {
  it('within the cap is kept and read back by name and type', async () => {
    const s = cacheSession();
    const record = await keepStagedFile('p1', 'c1', new File(['abc'], 'a.txt', { type: 'text/plain' }), s);
    expect(record).toEqual({ name: 'a.txt', size: 3, type: 'text/plain', kept: true });
    const back = await restoreStagedFile('p1', 'c1', record);
    expect(back?.name).toBe('a.txt');
    expect(back?.size).toBe(3);
  });

  it('above the cap keeps its name only', async () => {
    const big = new File([new Uint8Array(STAGED_FILE_CAP_BYTES + 1)], 'big.bin');
    const record = await keepStagedFile('p1', 'c1', big, cacheSession());
    expect(record.kept).toBe(false);
    expect(blobs.map.size).toBe(0);
    expect(await restoreStagedFile('p1', 'c1', record)).toBeUndefined();
  });

  it('with no place to keep bytes keeps its name only', async () => {
    setBlobStore(null);
    const record = await keepStagedFile('p1', 'c1', new File(['abc'], 'a.txt'), cacheSession());
    expect(record.kept).toBe(false);
  });
});

describe('the outbox', () => {
  it('sends in order, each once, and empties', async () => {
    const s = cacheSession();
    putOutboxEntry('p1', entry('b', 2), s);
    putOutboxEntry('p1', entry('a', 1), s);
    const send = vi.fn().mockResolvedValue({ id: 'm' });
    const sentAlready = vi.fn();
    await Promise.all([
      drainOutbox('p1', { send, sentAlready }),
      drainOutbox('p1', { send, sentAlready }),
    ]);
    expect(send.mock.calls.map((c) => c[0].id)).toEqual(['a', 'b']);
    expect(sentAlready).not.toHaveBeenCalled();
    expect(outboxEntries('p1')).toEqual([]);
    await drainOutbox('p1', { send, sentAlready });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('offline sends nothing; back online sends it', async () => {
    putOutboxEntry('p1', entry('a', 1), cacheSession());
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const send = vi.fn().mockResolvedValue({ id: 'm' });
    await drainOutbox('p1', { send, sentAlready: vi.fn() });
    expect(send).not.toHaveBeenCalled();
    expect(outboxEntries('p1')).toHaveLength(1);
    online.mockReturnValue(true);
    await drainOutbox('p1', { send, sentAlready: vi.fn() });
    expect(send).toHaveBeenCalledTimes(1);
    expect(outboxEntries('p1')).toEqual([]);
  });

  it('a send never answered stays, in its place, and is looked for before it is sent again', async () => {
    const s = cacheSession();
    putOutboxEntry('p1', entry('a', 1), s);
    putOutboxEntry('p1', entry('b', 2), s);
    const send = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await drainOutbox('p1', { send, sentAlready: vi.fn() });
    expect(send).toHaveBeenCalledTimes(1);
    expect(outboxEntries('p1').map((e) => [e.id, !!e.attempted])).toEqual([['a', true], ['b', false]]);

    // The service had it after all: it is not posted a second time.
    send.mockReset().mockResolvedValue({ id: 'm' });
    const sentAlready = vi.fn().mockResolvedValue(true);
    const onSent = vi.fn();
    await drainOutbox('p1', { send, sentAlready, onSent });
    expect(sentAlready).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.map((c) => c[0].id)).toEqual(['b']);
    expect(onSent.mock.calls.map((c) => c[0].id)).toEqual(['a', 'b']);
    expect(outboxEntries('p1')).toEqual([]);
  });

  it('a refused send stays, marked, and is not sent again until the person retries it', async () => {
    putOutboxEntry('p1', entry('a', 1), cacheSession());
    const send = vi.fn().mockRejectedValue(refused(403));
    await drainOutbox('p1', { send, sentAlready: vi.fn() });
    expect(outboxEntries('p1')[0]).toMatchObject({ id: 'a', failed: 'refused 403' });
    await drainOutbox('p1', { send, sentAlready: vi.fn() });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('one conversation never holds back another: a lookup the service refuses marks its entry failed, one unanswered waits alone', async () => {
    const s = cacheSession();
    const OTHER = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c2';
    const THIRD = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c3';
    putOutboxEntry('p1', entry('left', 1, { attempted: true }), s);
    putOutboxEntry('p1', entry('flaky', 2, { attempted: true, channelArn: THIRD, conversationId: 'c3' }), s);
    putOutboxEntry('p1', entry('flaky-next', 3, { channelArn: THIRD, conversationId: 'c3' }), s);
    putOutboxEntry('p1', entry('elsewhere', 4, { channelArn: OTHER, conversationId: 'c2' }), s);
    const sentAlready = vi.fn(async (e: OutboxEntry) => {
      if (e.id === 'left') throw refused(403);
      throw new TypeError('Failed to fetch');
    });
    const send = vi.fn().mockResolvedValue({ id: 'm' });
    await drainOutbox('p1', { send, sentAlready });
    expect(send.mock.calls.map((c) => c[0].id)).toEqual(['elsewhere']);
    expect(outboxEntries('p1').map((e) => [e.id, e.failed ?? null])).toEqual([['left', 'refused 403'], ['flaky', null], ['flaky-next', null]]);
  });

  it('only a service refusal is final', () => {
    expect(isUnknownOutcome(new TypeError('Failed to fetch'))).toBe(true);
    expect(isUnknownOutcome(refused(500))).toBe(true);
    expect(isUnknownOutcome(refused(429))).toBe(true);
    expect(isUnknownOutcome(refused(403))).toBe(false);
    expect(isUnknownOutcome(refused(400))).toBe(false);
  });

  it('is per person', () => {
    putOutboxEntry('p1', entry('a', 1), cacheSession());
    expect(outboxEntries('p2')).toEqual([]);
  });
});
