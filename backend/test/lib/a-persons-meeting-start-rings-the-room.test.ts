/**
 * A PERSON'S MEETING START RINGS THE ROOM, AND EVERY END STOPS THE RING (SPEC-ASSISTANT-MEETINGS FR27; `meeting-ring.ts`).
 *
 * An app takes a ring from the room's primary assistant alone, so the router, which posts the started card as the
 * primary, rings the room for a person's start for what is left of the meeting's ring. A workflow's start rang in its own
 * step, so the lifecycle does not ring it twice. Every end sends the ring-off, so a ring still sounding stops. The ring
 * is the meeting's (one ring key): it sounds in the meeting's own conversation, which everyone in the parent conversation is a member of
 * from its opening, and a person who takes the meeting is sent a ring-off addressed to them alone, so their other tabs
 * and devices stop ringing (the sibling project's cancel on accept).
 */
import * as fs from 'fs';
import * as path from 'path';
import { RING_OFF, parseRing, ringUntilOf } from '../../lambda/src/lib/meeting-ring';
import { readLifecycleHandoff } from '../../lambda/src/lib/meeting-lifecycle';

const router = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'router-agent-handler.ts'), 'utf8');
const fnOf = (name: string): string => {
  const start = router.search(new RegExp(`\\n(export )?(async )?function ${name}[(<]`));
  expect(start).toBeGreaterThan(-1);
  const next = router.slice(start + 10).search(/\n(export )?(async )?function /);
  return router.slice(start, next < 0 ? undefined : start + 10 + next);
};

describe('what is left of a ring', () => {
  let ringLeftFor: (m: { createdAt: string; ringSeconds?: number }, now?: number) => string | null;
  beforeAll(async () => { ({ ringLeft: ringLeftFor } = await import('../../lambda/src/lib/meeting-ring')); });
  const at = Date.parse('2026-11-12T10:00:00Z');

  it('rings for the rest of the recorded length, from the meeting\'s start', () => {
    expect(ringLeftFor({ createdAt: '2026-11-12T10:00:00Z', ringSeconds: 30 }, at + 4_000)).toBe('ae:ring:26');
    expect(parseRing(ringLeftFor({ createdAt: '2026-11-12T10:00:00Z', ringSeconds: 30 }, at))).toBe(30);
  });

  it('rings nobody once less than the shortest ring is left, or for an unreadable start', () => {
    expect(ringLeftFor({ createdAt: '2026-11-12T10:00:00Z', ringSeconds: 10 }, at + 6_500)).toBeNull();
    expect(ringLeftFor({ createdAt: 'not a time', ringSeconds: 10 }, at)).toBeNull();
  });
});

describe('a started card says when its ring stops, so a person the ring did not reach is rung from it', () => {
  const at = Date.parse('2026-11-12T10:00:00Z');

  it('is the recorded ring from the meeting start, while it still sounds', () => {
    expect(ringUntilOf({ createdAt: '2026-11-12T10:00:00Z', ringSeconds: 30 }, at + 4_000)).toBe('2026-11-12T10:00:30.000Z');
    expect(ringUntilOf({ createdAt: '2026-11-12T10:00:00Z', ringSeconds: 30 }, at + 31_000)).toBeUndefined();
    expect(ringUntilOf({ createdAt: 'not a time', ringSeconds: 30 }, at)).toBeUndefined();
  });

  it("a person's start and a workflow's start each put it on their started card", () => {
    const lifecycle = fnOf('handleMeetingLifecycle');
    expect(lifecycle).toContain("record?.activeMeeting?.meetingId === h.meetingId ? ringUntilOf(record.activeMeeting) : undefined");
    expect(lifecycle).toContain('const ended = started ? (ringUntil ? { ringUntil } : {})');
    const step = fnOf('startMeetingStep');
    expect(step).toContain("meetingCardMetadata('meeting-started', meetingId, meetingArn, ringUntil ? { ringUntil } : {})");
  });
});

describe('the lifecycle rings as the room\'s primary', () => {
  const fn = fnOf('handleMeetingLifecycle');

  it('rings the room for a person\'s start of this meeting, never for a workflow\'s, and stops it on every end', () => {
    expect(fn).toContain("last.startedVia !== 'workflow' && record?.activeMeeting?.meetingId === h.meetingId ? ringLeft(record.activeMeeting) : null");
    expect(fn).toContain(': RING_OFF;');
    // In the meeting's own conversation (the handoff's), never the conversation it was started from.
    expect(fn).toContain('if (ring) await ringTheRoom(h.channelArn, primary.botArn, ring);');
    expect(fn).not.toContain('ringTheRoom(room,');
    expect(RING_OFF).toBe('ae:ring:off');
  });

  it('sends it as one CONTROL message that is never stored, through the scoped speak', () => {
    const ring = fnOf('ringTheRoom');
    expect(ring).toContain('speakingAs({ botArn, channelArn: room');
    expect(ring).toContain('Type: ChannelMessageType.CONTROL');
    expect(ring).toContain('Persistence: ChannelMessagePersistenceType.NON_PERSISTENT');
    expect(ring).toContain('ChimeBearer: botArn');
    // To one person alone where it names one: Amazon Chime SDK delivers a targeted message to its target only.
    expect(ring).toContain('...(to ? { Target: [{ MemberArn: to }] } : {})');
  });

  it("a workflow's start rings the meeting's own conversation too, the one ring key", () => {
    const step = fnOf('startMeetingStep');
    expect(step).toContain('const ringIn = started.meetingConversationArn || args.channelArn;');
    expect(step).toContain('ChannelArn: ringIn,');
  });

  it("sends a person who took the running meeting a ring-off addressed to them alone, as the meeting conversation's primary", () => {
    const attended = fn.slice(fn.indexOf("if (h.event === 'person-attended')"), fn.indexOf('A MEETING THAT STARTED IS WATCHED'));
    expect(attended).toContain('record?.activeMeeting?.meetingId !== h.meetingId');
    expect(attended).toContain("primaryAssistantOf(h.channelArn, chimeClient, '[Router][meeting]')");
    expect(attended).toContain('ringTheRoom(h.channelArn, speaker.botArn, RING_OFF, userArnFor(app, h.personId))');
  });

  it("gives the meeting's own conversation its started and ended cards, naming the room, so a person added to it alone hears it end", () => {
    expect(fn).toContain('if (room !== h.channelArn) {');
    expect(fn).toContain('target: h.channelArn,');
    expect(fn).toContain('roomConversationId: conversationKey(room)');
  });
});

describe('a person who took the meeting is named in the handoff, and only by an id', () => {
  const base = { channelArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/meet-1', meetingId: 'm-1', event: 'person-attended', at: '2026-11-14T10:00:00Z' };

  it('reads the person from a person-attended handoff', () => {
    expect(readLifecycleHandoff({ ...base, personId: 'person-1' })).toEqual({ ...base, personId: 'person-1' });
  });

  it('DENY: refuses a person-attended handoff naming nobody, or anything but an id', () => {
    expect(readLifecycleHandoff(base)).toBeNull();
    expect(readLifecycleHandoff({ ...base, personId: '../user/other' })).toBeNull();
    expect(readLifecycleHandoff({ ...base, personId: 'arn:aws:chime:us-east-1:1:app-instance/i/user/p' })).toBeNull();
  });

  it('names nobody on any other event, whatever it carries', () => {
    expect(readLifecycleHandoff({ ...base, event: 'meeting-ended', personId: 'person-1' })).not.toHaveProperty('personId');
  });
});
