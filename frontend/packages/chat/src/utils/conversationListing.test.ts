import { describe, expect, it } from 'vitest';
import type { Conversation } from '@ae/shared';
import { conversationListing, meetingRoomsFrom } from './conversationListing';
import { meetingOfFromMetadata } from '../services/chimeService';

const conv = (id: string, extra: Partial<Conversation> = {}): Conversation => ({
  id, conversationArn: `arn:aws:chime:us-east-1:1:app-instance/i/channel/${id}`, title: id, modelId: '', modelName: '',
  createdAt: new Date(0), updatedAt: new Date(0), ...extra,
});

describe('a meeting\'s conversation is listed with its room', () => {
  const room = conv('conv-ops-1');
  const meeting = conv('conv-meeting-1', { meetingOf: 'conv-ops-1' });
  const other = conv('conv-2');
  const rooms = new Map([['conv-meeting-1', 'conv-ops-1']]);

  it('is left out of the list beside ordinary conversations, and kept on its room', () => {
    const { listed, meetingsOf } = conversationListing([meeting, room, other], undefined, rooms);
    expect(listed.map((c) => c.id)).toEqual(['conv-ops-1', 'conv-2']);
    expect(meetingsOf.get('conv-ops-1')?.map((c) => c.id)).toEqual(['conv-meeting-1']);
  });

  it('is listed while it is the one open, so the person sees where they are', () => {
    expect(conversationListing([meeting, room], 'conv-meeting-1', rooms).listed.map((c) => c.id)).toEqual(['conv-meeting-1', 'conv-ops-1']);
  });

  it('is listed on its own where its room is not in the list, so it is never out of reach', () => {
    expect(conversationListing([meeting, other], undefined, rooms).listed.map((c) => c.id)).toEqual(['conv-meeting-1', 'conv-2']);
  });

  it('DENY: Metadata alone files nothing under a room: a moderator cannot hide a shared conversation from the list', () => {
    const hijacked = conv('conv-shared', { meetingOf: 'conv-ops-1' });
    expect(conversationListing([hijacked, room]).listed.map((c) => c.id)).toEqual(['conv-shared', 'conv-ops-1']);
    expect(conversationListing([hijacked, room], undefined, rooms).listed.map((c) => c.id)).toEqual(['conv-shared', 'conv-ops-1']);
  });

  it("files an ended meeting's conversation under the room the server's rooms answer names, beside the running ones", () => {
    const ended = conv('conv-meeting-0');
    const both = meetingRoomsFrom([{ conversationId: 'conv-meeting-0', roomConversationId: 'conv-ops-1' }], [{ conversationId: 'conv-meeting-1', roomConversationId: 'conv-ops-1' }]);
    const { listed, meetingsOf } = conversationListing([ended, meeting, room], undefined, both);
    expect(listed.map((c) => c.id)).toEqual(['conv-ops-1']);
    expect(meetingsOf.get('conv-ops-1')?.map((c) => c.id)).toEqual(['conv-meeting-0', 'conv-meeting-1']);
  });

  it('reads the room from Metadata only as a conversation id', () => {
    expect(meetingOfFromMetadata({ meetingOf: 'conv-ops-1' })).toEqual({ meetingOf: 'conv-ops-1' });
    expect(meetingOfFromMetadata({ meetingOf: '../x' })).toEqual({});
    expect(meetingOfFromMetadata({})).toEqual({});
  });
});
