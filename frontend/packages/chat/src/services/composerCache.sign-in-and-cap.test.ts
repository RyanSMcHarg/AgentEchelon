/**
 * The device cache keeps only the signed-in person's unsent work, and a bounded amount of staged files (`composerCache.ts`):
 * a sign-in removes every draft, outbox and staged file another person's session left behind without a sign-out, and the
 * person's staged files stay within `STAGED_FILES_TOTAL_CAP_BYTES` across conversations, the oldest let go first.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  STAGED_FILES_TOTAL_CAP_BYTES, STAGED_FILE_CAP_BYTES, cacheSession, keepOnlyPersonsComposerCache, keepStagedFile, outboxEntries,
  putOutboxEntry, readDraft, restoreStagedFile, setBlobStore, writeDraft, forgetStagedFile, type BlobStore,
} from './composerCache';

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';

function memoryBlobStore(listable = true): BlobStore & { map: Map<string, Blob> } {
  const map = new Map<string, Blob>();
  return {
    map,
    put: async (k, b) => { map.set(k, b); },
    get: async (k) => map.get(k),
    delete: async (k) => { map.delete(k); },
    clear: async () => { map.clear(); },
    ...(listable ? { keys: async () => [...map.keys()] } : {}),
  };
}

/** A file of `bytes` bytes, without allocating them: the cache reads only its size, name and type. */
const fileOf = (name: string, bytes: number) => {
  const f = new File(['x'], name, { type: 'text/plain' });
  Object.defineProperty(f, 'size', { value: bytes });
  return f;
};

let blobs: ReturnType<typeof memoryBlobStore>;
beforeEach(() => {
  blobs = memoryBlobStore();
  setBlobStore(blobs);
});

describe('a sign-in keeps only its own person\'s unsent work', () => {
  it("removes another person's drafts, outbox and staged files, and keeps the signed-in person's", async () => {
    const s = cacheSession();
    writeDraft('p1', 'c1', { draft: { text: 'mine', mentions: [] } }, s);
    writeDraft('p2', 'c1', { draft: { text: 'theirs', mentions: [] } }, s);
    putOutboxEntry('p1', { id: 'm1', conversationId: 'c1', channelArn: CHANNEL, content: 'mine', createdAt: 1 }, s);
    putOutboxEntry('p2', { id: 'm2', conversationId: 'c1', channelArn: CHANNEL, content: 'theirs', createdAt: 1 }, s);
    await keepStagedFile('p1', 'c1', fileOf('mine.txt', 10), s);
    await keepStagedFile('p2', 'c1', fileOf('theirs.txt', 10), s);

    await keepOnlyPersonsComposerCache('p1');

    expect(readDraft('p1', 'c1')?.draft.text).toBe('mine');
    expect(outboxEntries('p1').map((e) => e.id)).toEqual(['m1']);
    expect([...blobs.map.keys()]).toEqual(['p1.c1']);
    expect(readDraft('p2', 'c1')).toBeUndefined();
    expect(outboxEntries('p2')).toEqual([]);
    const left = Object.keys(localStorage).filter((k) => k.startsWith('ae.composer.v1.'));
    expect(left.every((k) => k.includes('.p1'))).toBe(true);
  });

  it('removes a record it cannot place and keeps a person whose id holds dots', async () => {
    const s = cacheSession();
    localStorage.setItem('ae.composer.v1.something-else', '{}');
    writeDraft('first.last', 'c1', { draft: { text: 'mine', mentions: [] } }, s);
    putOutboxEntry('first.last', { id: 'm1', conversationId: 'c1', channelArn: CHANNEL, content: 'mine', createdAt: 1 }, s);
    await keepOnlyPersonsComposerCache('first.last');
    expect(localStorage.getItem('ae.composer.v1.something-else')).toBeNull();
    expect(readDraft('first.last', 'c1')?.draft.text).toBe('mine');
    expect(outboxEntries('first.last')).toHaveLength(1);
  });

  it("removes another person's staged files by their index where the store cannot list its keys", async () => {
    blobs = memoryBlobStore(false);
    setBlobStore(blobs);
    const s = cacheSession();
    await keepStagedFile('p2', 'c1', fileOf('theirs.txt', 10), s);
    await keepStagedFile('p1', 'c1', fileOf('mine.txt', 10), s);
    await keepOnlyPersonsComposerCache('p1');
    expect([...blobs.map.keys()]).toEqual(['p1.c1']);
  });
});

describe("a person's staged files stay within the total cap", () => {
  it('lets the oldest go first, and marks its draft so the person is asked to attach it again', async () => {
    const s = cacheSession();
    const each = STAGED_FILE_CAP_BYTES;
    const fits = Math.floor(STAGED_FILES_TOTAL_CAP_BYTES / each);
    for (let n = 0; n < fits; n++) {
      const record = await keepStagedFile('p1', `c${n}`, fileOf(`f${n}.txt`, each), s);
      writeDraft('p1', `c${n}`, { draft: { text: '', mentions: [] }, file: record }, s);
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(blobs.map.size).toBe(fits);
    const newest = await keepStagedFile('p1', 'cNew', fileOf('new.txt', each), s);
    expect(newest.kept).toBe(true);
    // The oldest is let go; every other one, and the newest, stays.
    expect(blobs.map.has('p1.c0')).toBe(false);
    expect(blobs.map.has('p1.cNew')).toBe(true);
    expect(blobs.map.size).toBe(fits);
    const oldest = readDraft('p1', 'c0');
    expect(oldest?.file).toMatchObject({ name: 'f0.txt', kept: false });
    expect(await restoreStagedFile('p1', 'c0', oldest!.file!)).toBeUndefined();
    expect(readDraft('p1', 'c1')?.file?.kept).toBe(true);
  });

  it('a forgotten staged file no longer counts toward the cap', async () => {
    const s = cacheSession();
    const each = STAGED_FILE_CAP_BYTES;
    const fits = Math.floor(STAGED_FILES_TOTAL_CAP_BYTES / each);
    for (let n = 0; n < fits; n++) {
      await keepStagedFile('p1', `c${n}`, fileOf(`f${n}.txt`, each), s);
      await new Promise((r) => setTimeout(r, 2));
    }
    await forgetStagedFile('p1', 'c1');
    await keepStagedFile('p1', 'cNew', fileOf('new.txt', each), s);
    expect(blobs.map.has('p1.c0')).toBe(true);
    expect(blobs.map.has('p1.cNew')).toBe(true);
  });
});
