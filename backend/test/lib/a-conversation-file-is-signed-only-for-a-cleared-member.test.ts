/**
 * A CONVERSATION'S FILE IS SIGNED ONLY FOR A CURRENT MEMBER CLEARED FOR IT (tenets D3 and D15).
 *
 * Through the presigner's own handler, for every key family it serves and for an upload: a non-member
 * (including a removed member holding an old key), a member whose clearance does not reach the
 * conversation's classification, and a conversation whose classification cannot be read are each refused
 * before anything is signed. A cleared member is signed. The narrowed role behind it is asserted from the
 * synthesized template by `the-presigner-holds-only-the-key-families-it-signs`.
 *
 * Each case opens its own conversation. A conversation's classification never changes, and the check
 * remembers a tag once read, so a case that gave one conversation a second classification would be
 * describing a state the platform does not allow.
 */
// The conversation's type allows what these cases do; the refusal is `a-type-that-turns-a-capability-off-is-refused`.
jest.mock('../../lambda/src/lib/type-capability', () => ({ ...jest.requireActual('../../lambda/src/lib/type-capability'), typeAllows: jest.fn(async () => ({ ok: true })) }));
import type { APIGatewayProxyEvent } from 'aws-lambda';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai';
const PERSON = 'person-1';

const state = {
  member: true,
  token: 'premium' as string | undefined,
  source: 'edge' as 'edge' | 'console-session',
  /** Who the meeting `m-1`'s own record names its hosts; 'UNREADABLE' when its row cannot be read. */
  hosts: [PERSON] as string[] | 'UNREADABLE' | 'NONE',
  /** Whether the caller moderates the parent conversation the meeting was started from, as Amazon Chime SDK answers it. */
  moderates: false,
};
const ROOM_ARN = `arn:aws:chime:us-east-1:111122223333:app-instance/ai/channel/the-room`;
// A meeting's transcript and recording are its hosts' (FR28, FR70): the meeting's record on its conversation's row.
jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  ...jest.requireActual('../../lambda/src/lib/channel-context-client'),
  readChannelContext: async () => {
    if (state.hosts === 'UNREADABLE') throw Object.assign(new Error('x'), { name: 'ChannelContextUnreadable' });
    // 'NONE': a workflow's meeting whose record names no host, started from the parent conversation `ROOM_ARN`.
    if (state.hosts === 'NONE') return { meetingOf: ROOM_ARN, lastMeeting: { meetingId: 'm-1', createdAt: 'x', createdBy: 'ops-bot', startedVia: 'workflow' } };
    return { lastMeeting: { meetingId: 'm-1', createdAt: 'x', createdBy: 'someone', hosts: state.hosts.map((personId) => ({ personId })) } };
  },
}));
const signedWith: Array<Record<string, unknown>> = [];
/** The classification tag each conversation was created with; null means the tag cannot be read. */
const tags = new Map<string, string | null>();
const sent: Array<{ name: string; input: Record<string, unknown> }> = [];

jest.mock('../../lambda/src/lib/auth', () => ({
  ...jest.requireActual('../../lambda/src/lib/auth'),
  callerPersonId: async () => PERSON,
  callerPerson: async () => ({ personId: PERSON, personArn: `${APP}/user/${PERSON}`, source: state.source, issuer: null }),
  callerHolderToken: () => state.token,
}));
jest.mock('../../lambda/src/lib/chime/clients', () => ({
  chimeMessagingClient: () => ({
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === 'DescribeChannelMembershipCommand') {
        if (!state.member) throw Object.assign(new Error('not a member'), { name: 'NotFoundException' });
        return {};
      }
      if (cmd.constructor.name === 'DescribeChannelModeratorCommand') {
        if (!state.moderates) throw Object.assign(new Error('not a moderator'), { name: 'NotFoundException' });
        return {};
      }
      if (cmd.constructor.name === 'ListTagsForResourceCommand') {
        const tag = tags.get(String(cmd.input.ResourceARN));
        if (tag === 'DENIED') throw Object.assign(new Error('denied'), { name: 'ForbiddenException' });
        if (tag === 'THROTTLED') throw Object.assign(new Error('slow down'), { name: 'ThrottledClientException' });
        return { Tags: tag ? [{ Key: 'classification', Value: tag }] : [] };
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    },
  }),
}));
const signed: string[] = [];
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async (_c: unknown, cmd: { input: { Key: string } }) => {
    signed.push(cmd.input.Key);
    signedWith.push(cmd.input);
    return `https://signed.example/${cmd.input.Key}`;
  },
}));
// An upload is a presigned POST, from the function's own package.
jest.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: async (_c: unknown, input: { Key: string }) => {
    signed.push(input.Key);
    return { url: 'https://signed.example/', fields: { key: input.Key } };
  },
}), { virtual: true });

process.env.APP_INSTANCE_ARN = APP;
process.env.BUCKET_NAME = 'attachments';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require('../../lambda/presigned-url/index.js');

let opened = 0;
/** A new conversation, created with `classification`, or with no readable tag when it is null. */
function conversation(classification: string | null = 'premium'): string {
  opened += 1;
  const id = `c0ffee00-0000-0000-0000-${String(opened).padStart(12, '0')}`;
  tags.set(`${APP}/channel/${id}`, classification);
  return id;
}

const FAMILIES: Array<[string, (c: string) => string]> = [
  ['attachments', (c) => `attachments/${c}/${PERSON}/1-notes.pdf`],
  ['generated-docs', (c) => `generated-docs/${c}/report.docx`],
  ['battle-images', (c) => `battle-images/${c}/image.png`],
  // A meeting's transcript (SPEC-ASSISTANT-MEETINGS FR28): the conversation's own, at the conversation's classification.
  ['transcripts', (c) => `transcripts/premium/${c}/m-1.md`],
  // A meeting's audio and video recording (SPEC-ASSISTANT-MEETINGS FR70): the same rule as its transcript.
  ['recordings', (c) => `recordings/premium/${c}/m-1/p-1/media/composited-video/cp-1.mp4`],
];

const call = async (body: Record<string, unknown>) => {
  const res = await handler({
    httpMethod: 'POST', path: '/presigned-url', headers: { origin: 'http://localhost:5173' }, body: JSON.stringify(body),
  } as unknown as APIGatewayProxyEvent);
  return { status: res.statusCode as number, body: JSON.parse(res.body) };
};
const download = (conversationId: string, fileKey: string) => call({ action: 'download', conversationId, fileKey });
const upload = (conversationId: string) =>
  call({ action: 'upload', conversationId, fileName: 'notes.pdf', fileType: 'application/pdf' });

beforeEach(() => {
  Object.assign(state, { member: true, token: 'premium', source: 'edge', hosts: [PERSON], moderates: false });
  sent.length = 0;
  signed.length = 0;
  signedWith.length = 0;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('a meeting transcript is signed only as its own conversation\'s, at its classification', () => {
  it('DENIED: a key naming another classification than the conversation carries, for a cleared member', async () => {
    const c = conversation('premium');
    expect(await download(c, `transcripts/standard/${c}/m-1.md`)).toMatchObject({ status: 403, body: { code: 'FILE_KEY_NOT_OWNED' } });
    expect(signed).toEqual([]);
  });

  it('DENIED: a key naming another conversation, and a segment rather than the transcript', async () => {
    const c = conversation('premium');
    const other = conversation('premium');
    expect(await download(c, `transcripts/premium/${other}/m-1.md`)).toMatchObject({ status: 403 });
    expect(await download(c, `transcripts/premium/${c}/m-1/segments/1-r1.json`)).toMatchObject({ status: 403 });
    expect(signed).toEqual([]);
  });
});

describe("a meeting recording is signed only as its own conversation's, at its classification", () => {
  it('DENIED: a key naming another classification than the conversation carries, for a cleared member', async () => {
    const c = conversation('premium');
    expect(await download(c, `recordings/standard/${c}/m-1/p-1/media/composited-video/cp-1.mp4`)).toMatchObject({ status: 403, body: { code: 'FILE_KEY_NOT_OWNED' } });
    expect(signed).toEqual([]);
  });

  it('DENIED: a non-member, a key naming another conversation, and a capture chunk rather than the recording', async () => {
    const c = conversation('premium');
    const other = conversation('premium');
    expect(await download(c, `recordings/premium/${other}/m-1/p-1/media/composited-video/cp-1.mp4`)).toMatchObject({ status: 403 });
    expect(await download(c, `recordings/premium/${c}/m-1/p-1/capture/composited-video/2026-11-12-chunk.mp4`)).toMatchObject({ status: 403 });
    state.member = false;
    expect((await download(c, `recordings/premium/${c}/m-1/p-1/media/composited-video/cp-1.mp4`)).status).toBe(403);
    expect(signed).toEqual([]);
  });
});

describe("a meeting's transcript and recording are signed for its hosts alone", () => {
  const MEETING_FILES = FAMILIES.filter(([f]) => f === 'transcripts' || f === 'recordings');

  it.each(MEETING_FILES)('DENIED: %s for a cleared member of its conversation who did not host the meeting', async (_family, keyOf) => {
    const c = conversation();
    state.hosts = ['someone-else'];
    expect(await download(c, keyOf(c))).toMatchObject({ status: 403, body: { code: 'NOT_A_HOST' } });
    expect(signed).toEqual([]);
  });

  it.each(MEETING_FILES)('DENIED: %s when the meeting\'s record cannot be read, and signs nothing', async (_family, keyOf) => {
    const c = conversation();
    state.hosts = 'UNREADABLE';
    expect(await download(c, keyOf(c))).toMatchObject({ status: 503, body: { code: 'MEETING_UNREADABLE' } });
    expect(signed).toEqual([]);
  });

  it.each(MEETING_FILES)("%s of a meeting whose record names no host is signed for a moderator of the conversation it was started from, asked as the caller", async (_family, keyOf) => {
    const c = conversation();
    state.hosts = 'NONE';
    state.moderates = true;
    expect((await download(c, keyOf(c))).status).toBe(200);
    const asked = sent.find((x) => x.name === 'DescribeChannelModeratorCommand');
    expect(asked?.input).toMatchObject({ ChannelArn: ROOM_ARN, ChannelModeratorArn: `${APP}/user/${PERSON}`, ChimeBearer: `${APP}/user/${PERSON}` });
  });

  it.each(MEETING_FILES)('DENIED: %s of a meeting whose record names no host, for a member who does not moderate its room', async (_family, keyOf) => {
    const c = conversation();
    state.hosts = 'NONE';
    expect(await download(c, keyOf(c))).toMatchObject({ status: 403, body: { code: 'NOT_A_HOST' } });
    expect(signed).toEqual([]);
  });

  it.each(MEETING_FILES)('DENIED: %s for a moderator of the parent conversation where the record names its hosts and they are not one', async (_family, keyOf) => {
    const c = conversation();
    state.hosts = ['someone-else'];
    state.moderates = true;
    expect(await download(c, keyOf(c))).toMatchObject({ status: 403, body: { code: 'NOT_A_HOST' } });
    expect(signed).toEqual([]);
  });

  it.each(MEETING_FILES)('a host downloads %s under the platform\'s name for it, and views it without one', async (_family, keyOf) => {
    const c = conversation();
    expect((await call({ action: 'download', conversationId: c, fileKey: keyOf(c), disposition: 'attachment' })).status).toBe(200);
    expect(String(signedWith[0].ResponseContentDisposition)).toMatch(/^attachment; filename="meeting-m-1(-p-1)?-(transcript\.md|recording\.mp4)"$/);
    expect((await download(c, keyOf(c))).status).toBe(200);
    expect(signedWith[1].ResponseContentDisposition).toBeUndefined();
  });
});

describe('a conversation file is signed only for a cleared member', () => {
  it.each(FAMILIES)('signs %s for a member cleared for the conversation', async (_family, keyOf) => {
    const c = conversation();
    const res = await download(c, keyOf(c));
    expect(res.status).toBe(200);
    expect(signed).toEqual([keyOf(c)]);
    // The membership is asked with the caller as bearer, so only their own membership can answer.
    const lookup = sent.find((s) => s.name === 'DescribeChannelMembershipCommand');
    expect(lookup?.input).toMatchObject({ MemberArn: `${APP}/user/${PERSON}`, ChimeBearer: `${APP}/user/${PERSON}` });
  });

  it('signs an upload for a member cleared for the conversation', async () => {
    const c = conversation();
    const res = await upload(c);
    expect(res.status).toBe(200);
    expect(signed).toHaveLength(1);
    expect(signed[0]).toMatch(new RegExp(`^attachments/${c}/${PERSON}/`));
  });

  it('DENIED: an upload in a conversation whose type turns attachments off, and signs nothing', async () => {
    const { typeAllows } = jest.requireMock('../../lambda/src/lib/type-capability') as { typeAllows: jest.Mock };
    typeAllows.mockResolvedValueOnce({ ok: false, statusCode: 403, code: 'CAPABILITY_OFF_FOR_TYPE', conversationType: 'customer-engagement', capability: 'attachments' });
    const c = conversation();
    const res = await upload(c);
    expect(res).toMatchObject({ status: 403, body: { code: 'CAPABILITY_OFF_FOR_TYPE' } });
    expect(typeAllows).toHaveBeenLastCalledWith(`${APP}/channel/${c}`, 'attachments');
    expect(signed).toEqual([]);
  });

  it.each(FAMILIES)('DENIED: %s for a non-member or a removed member holding the key', async (_family, keyOf) => {
    const c = conversation();
    state.member = false;
    expect(await download(c, keyOf(c))).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    expect(signed).toEqual([]);
  });

  it.each(FAMILIES)('DENIED: %s for a member whose clearance does not reach the conversation', async (_family, keyOf) => {
    const c = conversation('premium');
    state.token = 'basic';
    expect(await download(c, keyOf(c))).toMatchObject({ status: 403, body: { code: 'NOT_CLEARED' } });
    expect(signed).toEqual([]);
  });

  it.each(FAMILIES)('DENIED: %s when the conversation classification cannot be read', async (_family, keyOf) => {
    const c = conversation(null);
    expect(await download(c, keyOf(c))).toMatchObject({ status: 403, body: { code: 'CLASSIFICATION_UNREADABLE' } });
    expect(signed).toEqual([]);
  });

  it('DENIED: an upload by a non-member, and by a member without clearance', async () => {
    state.member = false;
    expect(await upload(conversation())).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    state.member = true;
    state.token = 'basic';
    expect(await upload(conversation('premium'))).toMatchObject({ status: 403, body: { code: 'NOT_CLEARED' } });
    expect(signed).toEqual([]);
  });

  it('DENIED: a console session, which is an operator\'s credential and not a person\'s', async () => {
    state.source = 'console-session';
    const c = conversation();
    expect(await download(c, `generated-docs/${c}/report.docx`))
      .toMatchObject({ status: 403, body: { code: 'NOT_A_PERSON_SESSION' } });
    expect(sent).toEqual([]);
    expect(signed).toEqual([]);
  });

  it('reads nothing about a conversation for a caller who is not its member', async () => {
    state.member = false;
    const c = conversation();
    expect((await download(c, `generated-docs/${c}/report.docx`)).status).toBe(403);
    expect(sent.map((s) => s.name)).toEqual(['DescribeChannelMembershipCommand']);
  });

  it('DENIED: a conversation that is not a string, as a request body can send, is a refusal and not an error', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { callerReachesConversation } = require('../../lambda/src/lib/conversation-access');
    for (const value of [123, {}, null, '']) {
      expect(await callerReachesConversation({} as APIGatewayProxyEvent, value))
        .toMatchObject({ ok: false, status: 403, code: 'NOT_A_MEMBER' });
    }
    expect(sent).toEqual([]);
  });

  it('DENIED: a caller with no clearance at all', async () => {
    state.token = undefined;
    const c = conversation();
    expect(await download(c, `generated-docs/${c}/report.docx`)).toMatchObject({ status: 403, body: { code: 'NOT_CLEARED' } });
  });

  it('reads a conversation\'s classification once, and its membership on every request', async () => {
    const c = conversation();
    const key = `generated-docs/${c}/report.docx`;
    await download(c, key);
    await download(c, key);
    expect(sent.filter((s) => s.name === 'ListTagsForResourceCommand')).toHaveLength(1);
    expect(sent.filter((s) => s.name === 'DescribeChannelMembershipCommand')).toHaveLength(2);
    // Removed after its classification was remembered: still refused, because membership is never remembered.
    state.member = false;
    expect(await download(c, key)).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
  });

  it('treats a denied tag read as a missing grant the operator must see, and a throttle as an outage', async () => {
    // The presigner's role reads every channel's tags, so a denial is a missing grant: 503, never a
    // business answer that hides it.
    const denied = conversation('DENIED');
    expect(await download(denied, `generated-docs/${denied}/r.docx`))
      .toMatchObject({ status: 503, body: { code: 'UNAVAILABLE' } });
    const throttled = conversation('THROTTLED');
    expect(await download(throttled, `generated-docs/${throttled}/r.docx`))
      .toMatchObject({ status: 503, body: { code: 'UNAVAILABLE' } });
    expect(signed).toEqual([]);
  });

  it('reads an unreadable classification again on the next request rather than remembering the refusal', async () => {
    const c = conversation(null);
    const key = `generated-docs/${c}/report.docx`;
    expect((await download(c, key)).status).toBe(403);
    expect((await download(c, key)).status).toBe(403);
    expect(sent.filter((s) => s.name === 'ListTagsForResourceCommand')).toHaveLength(2);
  });
});
