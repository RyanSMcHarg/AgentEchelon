/**
 * THE EMPTY-STATE WELCOME IS THE CLASSIFICATION'S OWN COPY (`newConversation.class.<value>.greeting`), and a
 * classification whose copy declares none is welcomed by nothing rather than by another classification's words.
 */
import { describe, it, expect } from 'vitest';
import i18n from '@ae/shared/i18n';
import { emptyConversationGreeting, getModelGreeting } from './greeting';

const t = i18n.t.bind(i18n) as unknown as Parameters<typeof getModelGreeting>[1];

describe('getModelGreeting', () => {
  it('is the sample classification\'s welcome from the locale', () => {
    expect(getModelGreeting('premium', t)).toMatch(/^Welcome to Agent Echelon\./);
  });

  it('is null for a classification whose copy declares no welcome, and for none', () => {
    expect(getModelGreeting('internal', t)).toBeNull();
    expect(getModelGreeting('', t)).toBeNull();
  });
});

describe('emptyConversationGreeting', () => {
  it("opens a meeting's own conversation with the meeting's line, never the classification's welcome", () => {
    const meetingChat = t('meeting.chatEmpty');
    expect(emptyConversationGreeting({ modelTier: 'premium', meetingOf: 'room-1' }, false, t)).toBe(meetingChat);
    expect(emptyConversationGreeting({ modelTier: 'premium' }, true, t)).toBe(meetingChat);
    expect(meetingChat).not.toMatch(/Welcome/);
  });

  it("opens any other conversation with its classification's welcome", () => {
    expect(emptyConversationGreeting({ modelTier: 'premium' }, false, t)).toMatch(/^Welcome to Agent Echelon\./);
    expect(emptyConversationGreeting(null, false, t)).toBeNull();
  });
});
