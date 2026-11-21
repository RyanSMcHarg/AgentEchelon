/**
 * A TASK CARD IS CLOSED ONLY BY A READ OF THE PERSON'S OPEN ITEMS ASKED AFTER IT ARRIVED.
 *
 * A new card (an approval of a customer notice) arrives before the open items list its task, so a card newer than the last
 * read is drawn as sent; one older than the read whose task is missing, or there in another state, is closed, after a
 * reload as before it, but only where the read listed every open item: a list at its cap closes nothing by absence. A read
 * that failed installs nothing, so it closes nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { bandOffersChoices, cardClosed } from './ConversationInterface';
import { fetchOpenWork, fetchOpenWorkItems } from '../services/openWorkItemService';

vi.mock('@ae/shared', async (orig) => ({ ...(await orig<object>()), personApiServes: () => true, personUrl: (p: string) => `https://api.example${p}` }));

const at = (iso: string) => ({ taskCard: { id: 't1', state: 'deciding', choices: ['approved'] }, timestamp: new Date(iso) });
const READ = Date.parse('2026-11-20T00:20:00Z');

describe('whether a task card is closed', () => {
  it('a card that arrived after the open items were asked for is drawn as sent, though its task is not in them yet', () => {
    expect(cardClosed(at('2026-11-20T00:20:37Z'), true, READ, [], true)).toBe(false);
  });

  it('a card older than the read is closed where its task is missing or moved on, and open where it is there in its state', () => {
    expect(cardClosed(at('2026-11-20T00:10:00Z'), true, READ, [], true)).toBe(true);
    expect(cardClosed(at('2026-11-20T00:10:00Z'), true, READ, [{ taskId: 't1', taskState: 'approved' }], true)).toBe(true);
    expect(cardClosed(at('2026-11-20T00:10:00Z'), true, READ, [{ taskId: 't1', taskState: 'deciding' }], true)).toBe(false);
    // A NEWER CARD WHOSE TASK MOVED ON is closed by the read that says so.
    expect(cardClosed(at('2026-11-20T00:20:37Z'), true, READ, [{ taskId: 't1', taskState: 'approved' }], true)).toBe(true);
  });

  it('nothing is closed before the open items are first read', () => {
    expect(cardClosed(at('2026-11-20T00:10:00Z'), false, 0, [], true)).toBe(false);
  });
});

describe('a read of the open items that failed', () => {
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
  it('answers null, which says nothing about what is open; an empty list is an answer', async () => {
    localStorage.setItem('idToken', 'tok');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
    expect(await fetchOpenWorkItems()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await fetchOpenWorkItems()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) }));
    expect(await fetchOpenWorkItems()).toEqual([]);
  });
});

describe('DENY: a task missing from a list at its cap is not closed', () => {
  it('absence closes a card only where the read listed every open item', () => {
    expect(cardClosed(at('2026-11-20T00:10:00Z'), true, READ, [], false)).toBe(false);
    // A TASK THERE IN ANOTHER STATE is known to have moved on, whatever the cap.
    expect(cardClosed(at('2026-11-20T00:10:00Z'), true, READ, [{ taskId: 't1', taskState: 'approved' }], false)).toBe(true);
  });

  it('the read says whether it listed every open item, and a list that does not say is not taken as complete', async () => {
    localStorage.setItem('idToken', 'tok');
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [], complete: true }) }));
      expect(await fetchOpenWork()).toEqual({ items: [], complete: true });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) }));
      expect(await fetchOpenWork()).toEqual({ items: [], complete: false });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
      expect(await fetchOpenWork()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      localStorage.clear();
    }
  });
});

describe('a pinned card keeps its choices unless the band offers them to this person', () => {
  const decide = { taskId: 't1', by: ['p-lead', 'p-secondary'] };
  it('defers them to the band only for the band\'s own task, and only for those who decide it', () => {
    expect(bandOffersChoices(decide, 't1', 'p-lead')).toBe(true);
    expect(bandOffersChoices(decide, 't1', 'p-other')).toBe(false);
    expect(bandOffersChoices(decide, 't2', 'p-lead')).toBe(false);
    expect(bandOffersChoices(undefined, 't1', 'p-lead')).toBe(false);
    expect(bandOffersChoices(decide, 't1', undefined)).toBe(false);
  });
});
