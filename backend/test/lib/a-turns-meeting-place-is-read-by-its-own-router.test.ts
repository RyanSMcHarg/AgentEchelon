/**
 * A TURN'S MEETING PLACE IS READ BY ITS OWN ROUTER (`handleMeetingPlaceRead`, SPEC-ASSISTANT-MEETINGS FR42; tenets D1, D3, D12).
 *
 * `propose_meeting_invites` needs to know whether the conversation's meeting runs, who hosts it and the room's role
 * holdings. The assistant's session holds no read of the context table (`a-meeting-row-read-names-only-its-meeting-fields.test.ts`):
 * the processor asks its own classification's router, which answers only for conversations whose immutable
 * classification tag is its own, and only with the rows' meeting attributes.
 */
const mockTag = jest.fn();
jest.mock('../../lambda/src/lib/channel-classification', () => ({
  ...jest.requireActual('../../lambda/src/lib/channel-classification'),
  readChannelClassificationTag: (...a: unknown[]) => mockTag(...a),
}));
const mockRow = jest.fn();
jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  ...jest.requireActual('../../lambda/src/lib/channel-context-client'),
  readChannelContext: (...a: unknown[]) => mockRow(...a),
}));

process.env.CLASSIFICATION = 'premium';
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_LAMBDA_FUNCTION_NAME = 'router';

import * as fs from 'fs';
import * as path from 'path';
import { handleMeetingPlaceRead } from '../../lambda/src/router-agent-handler';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai';
const ROOM = `${APP}/channel/ops-room`;
const MEETING = `${APP}/channel/meeting-1`;
const HOST = 'host-person';

const ROWS: Record<string, Record<string, unknown>> = {
  [ROOM]: {
    channelArn: ROOM, conversationType: 'ops', meetingConversation: { channelArn: MEETING, at: '2026-11-12T00:00:00Z' },
    participantRoles: { 'on-call:ops': { [HOST]: { origin: 'group' } } },
    // Attributes a meeting place never carries.
    lastMeeting: { meetingId: 'm-0', summary: 'what was said last time' }, members: ['x'],
  },
  [MEETING]: {
    channelArn: MEETING, conversationType: 'meeting', meetingOf: ROOM,
    activeMeeting: { meetingId: 'm-1', meeting: {}, classification: 'premium', createdAt: '2026-11-12T00:00:00Z', createdBy: HOST, startedVia: 'person', hosts: [{ personId: HOST }] },
    lastMeeting: { meetingId: 'm-0', summary: 'what was said last time' },
  },
};

beforeEach(() => {
  mockTag.mockReset().mockResolvedValue('premium');
  mockRow.mockReset().mockImplementation(async (arn: string) => ROWS[arn] ?? null);
});

describe("the router answers a turn's meeting place", () => {
  it("for a conversation of its own classification: the room's running meeting, with the meeting attributes alone", async () => {
    const out = await handleMeetingPlaceRead({ channelArn: ROOM });
    expect(out.place).toMatchObject({ meetingArn: MEETING, roomArn: ROOM });
    expect(out.place!.meetingRow.activeMeeting?.meetingId).toBe('m-1');
    expect(JSON.stringify(out)).not.toMatch(/lastMeeting|what was said|members/);
    for (const arn of [ROOM, MEETING]) expect(mockTag).toHaveBeenCalledWith(expect.anything(), arn, expect.any(String));
  });

  it('REFUSED: a conversation of another classification, before its row is read', async () => {
    mockTag.mockResolvedValue('standard');
    expect(await handleMeetingPlaceRead({ channelArn: ROOM })).toEqual({ reason: 'not this classification' });
    expect(mockRow).not.toHaveBeenCalled();
  });

  it('REFUSED: a room whose linked meeting conversation is of another classification', async () => {
    mockTag.mockImplementation(async (_c: unknown, arn: string) => (arn === MEETING ? 'standard' : 'premium'));
    expect(await handleMeetingPlaceRead({ channelArn: ROOM })).toEqual({ reason: 'not this classification' });
    expect(mockRow).not.toHaveBeenCalledWith(MEETING, expect.anything());
  });

  it('REFUSED: a conversation whose classification tag cannot be read, and a malformed request', async () => {
    mockTag.mockResolvedValue(undefined);
    expect(await handleMeetingPlaceRead({ channelArn: ROOM })).toEqual({ reason: 'not this classification' });
    expect(await handleMeetingPlaceRead({ channelArn: 'arn:aws:s3:::bucket/channel/x' })).toEqual({ reason: 'malformed' });
    expect(await handleMeetingPlaceRead({})).toEqual({ reason: 'malformed' });
    expect(mockRow).not.toHaveBeenCalled();
  });

  it('answers no place where no meeting runs', async () => {
    mockRow.mockImplementation(async (arn: string) => (arn === MEETING ? { ...ROWS[MEETING], activeMeeting: undefined } : ROWS[arn]));
    expect(await handleMeetingPlaceRead({ channelArn: ROOM })).toEqual({ reason: 'no meeting runs here' });
  });
});

describe('the processor asks its router, and reads no row itself', () => {
  it('reaches the place through the router, and holds no context-table read of its own', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'assistant-async-processor.ts'), 'utf8');
    expect(src).toContain('meetingPlaceThroughRouter((await resolveRouterArn(CLASSIFICATION))');
    expect(src).not.toMatch(/CHANNEL_CONTEXT_TABLE/);
    expect(src).not.toMatch(/readMeetingRow/);
  });
});
