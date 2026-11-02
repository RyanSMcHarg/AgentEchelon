/**
 * THE CONVERSATION LIST IS EVERY MEMBERSHIP THE PLATFORM GRANTED, ON EVERY PAGE.
 *
 * Two defects met here, and both presented to a person as "my conversation is gone":
 *
 *   1. The provider filtered the membership list through a hardcoded basic/standard/premium rank. The
 *      server had already answered the question - `ListChannelMembershipsForAppInstanceUser` runs under the
 *      person's own bearer - so the filter could only remove conversations they were legitimately in,
 *      including ones they had created. It ranked on `modelTier`, which is read from channel Metadata that
 *      members can write, and it failed OPEN, because `modelTier` defaults to 'basic' when metadata is
 *      missing and 'basic' is the bucket a basic reader may see.
 *   2. `listConversations` sent the command once and ignored `NextToken`, so the sidebar stopped at one
 *      page with nothing on screen to say so. The deep-link helper's own comment documented the symptom
 *      from the other side: it exists so a link resolves "even when the channel isn't in the recipient's
 *      sidebar yet (past the first page...)".
 *
 * These are asserted against the SERVICE, with a stubbed client, because the bug was in what the service
 * returned and what the provider then did to it - not in anything a rendered component would show.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const sendMock = vi.fn();

vi.mock('@aws-sdk/client-chime-sdk-messaging', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ChimeSDKMessagingClient: class {
      send = sendMock;
    },
  };
});

vi.mock('@ae/shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    REGION: 'us-east-1',
    APP_INSTANCE_ARN: 'arn:aws:chime:us-east-1:000000000000:app-instance/test',
    USER_POOL_ID: 'users',
    // The exchange is the only credential source; the provider is stubbed because no call here signs.
    PERSON_API_URL: 'https://person.example.com',
    exchangeCredentialsProvider: () => async () => ({ accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' }),
    trackEvent: () => {},
  };
});

/** One membership, with whatever metadata the test wants to put on the channel. */
const membership = (id: string, metadata: Record<string, unknown> | null) => ({
  ChannelSummary: {
    ChannelArn: `arn:aws:chime:us-east-1:000000000000:app-instance/test/channel/${id}`,
    Name: id,
    ...(metadata === null ? {} : { Metadata: JSON.stringify(metadata) }),
  },
});

describe('listConversations', () => {
  type Row = { id: string };
  let service: {
    initialize: (t: string, u: string) => Promise<void>;
    /** The optional per-page callback is part of the contract: the provider passes `setConversations` to it. */
    listConversations: (onPage?: (soFar: Row[]) => void) => Promise<Row[]>;
  };

  beforeEach(async () => {
    sendMock.mockReset();
    vi.resetModules();
    const mod = await import('./chimeService');
    service = mod.chimeService as unknown as typeof service;
    await service.initialize('token', 'user-1');
  });

  it('follows NextToken, so a list longer than one page is complete', async () => {
    sendMock
      .mockResolvedValueOnce({ ChannelMemberships: [membership('a', {}), membership('b', {})], NextToken: 'page-2' })
      .mockResolvedValueOnce({ ChannelMemberships: [membership('c', {})], NextToken: 'page-3' })
      .mockResolvedValueOnce({ ChannelMemberships: [membership('d', {})] });

    const got = await service.listConversations();

    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(got.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns a premium-metadata conversation as readily as a basic one, since membership already decided', async () => {
    // The old filter dropped this for anyone not premium. The server returned it as a membership, which is
    // the platform saying the person is in it.
    sendMock.mockResolvedValueOnce({
      ChannelMemberships: [
        membership('premium-one', { modelTier: 'premium' }),
        membership('basic-one', { modelTier: 'basic' }),
      ],
    });

    const got = await service.listConversations();
    expect(got.map((c) => c.id).sort()).toEqual(['basic-one', 'premium-one']);
  });

  it('keeps a conversation whose metadata is absent or unparseable', async () => {
    // Metadata is member-writable, so it can be anything, including gone. Losing the row would hide a real
    // conversation on the strength of a field nobody authoritative wrote.
    sendMock.mockResolvedValueOnce({
      ChannelMemberships: [
        membership('no-metadata', null),
        { ChannelSummary: { ChannelArn: 'arn:aws:chime:us-east-1:000000000000:app-instance/test/channel/bad-json', Name: 'bad-json', Metadata: '{not json' } },
      ],
    });

    const got = await service.listConversations();
    expect(got.map((c) => c.id).sort()).toEqual(['bad-json', 'no-metadata']);
  });

  it('stops at the page bound and SAYS SO, when the tokens keep advancing', async () => {
    // A truncated list that looks complete is the defect, so hitting the bound has to be visible. The tokens
    // ADVANCE here; a token that repeats is a different stop, covered below.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    sendMock.mockImplementation(() => {
      n += 1;
      return Promise.resolve({ ChannelMemberships: [membership(`c${n}`, {})], NextToken: `page-${n + 1}` });
    });

    const got = await service.listConversations();

    expect(got.length).toBe(20);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('incomplete'));
    warn.mockRestore();
  });

  it('stops and SAYS SO when the same token comes back twice, instead of re-reading one page to the bound', async () => {
    // The service claimed there was more and could not advance, so the list is incomplete for the same
    // reason the bound makes it incomplete - and a person cannot tell the two apart, so both report.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendMock.mockResolvedValue({ ChannelMemberships: [membership('loop', {})], NextToken: 'always-more' });

    const got = await service.listConversations();

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(got.map((c) => c.id)).toEqual(['loop']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('incomplete'));
    warn.mockRestore();
  });

  it('hands over the first page before the later ones arrive, so startup is not linear in membership count', async () => {
    /**
     * Following every page is what stopped the sidebar truncating silently, and awaiting all of it before
     * the first render replaced that with a different defect: six sequential round trips on an account with
     * 289 memberships, before anything appeared. The provider passes `setConversations` as `onPage`, so this
     * asserts the sequence it depends on - growing snapshots, not one at the end.
     */
    sendMock
      .mockResolvedValueOnce({ ChannelMemberships: [membership('first', {})], NextToken: 'p2' })
      .mockResolvedValueOnce({ ChannelMemberships: [membership('second', {})], NextToken: 'p3' })
      .mockResolvedValueOnce({ ChannelMemberships: [membership('third', {})] });

    const snapshots: string[][] = [];
    const all = await service.listConversations((soFar) => snapshots.push(soFar.map((c) => c.id)));

    // One snapshot per page, each a superset of the last - the first arrives without waiting for page three.
    expect(snapshots).toEqual([['first'], ['first', 'second'], ['first', 'second', 'third']]);
    // And the awaited value is still the whole list, so a caller that wants all of it is unchanged.
    expect(all.map((c) => c.id)).toEqual(['first', 'second', 'third']);
  });

  it('gives each page its own array, so holding one is not mutated by the next', async () => {
    // React state set from `onPage` must not be the same array the loop keeps pushing into, or a later page
    // would change a value already handed over and the render could miss the update entirely.
    sendMock
      .mockResolvedValueOnce({ ChannelMemberships: [membership('a', {})], NextToken: 'p2' })
      .mockResolvedValueOnce({ ChannelMemberships: [membership('b', {})] });

    const held: Array<Array<{ id: string }>> = [];
    await service.listConversations((soFar) => held.push(soFar));

    expect(held[0]).not.toBe(held[1]);
    expect(held[0].map((c) => c.id)).toEqual(['a']);
  });

  it('shows a conversation once when two pages overlap, because a duplicate row is worse than the truncation', async () => {
    // Pagination is only safe while the pages are disjoint. A service that repeats a membership would make
    // the sidebar list the same conversation twice, and that is visible to a person.
    sendMock
      .mockResolvedValueOnce({ ChannelMemberships: [membership('a', {}), membership('b', {})], NextToken: 'p2' })
      .mockResolvedValueOnce({ ChannelMemberships: [membership('b', {}), membership('c', {})] });

    const got = await service.listConversations();
    expect(got.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });
});
