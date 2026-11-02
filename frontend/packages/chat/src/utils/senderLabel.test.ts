/**
 * What a conversation calls the assistant that sent a message.
 *
 * THE DEFECT THIS EXISTS FOR. The per-message header rendered a constant - the translated
 * `tier.assistant`, "Assistant" - for every bot message off a battle path, ignoring the sender name
 * the message already carried. That was survivable while a classification had exactly one assistant,
 * and it stops being survivable the moment it has two: both render as the same word, so a person
 * cannot tell which assistant answered. Renaming an assistant through its profile (and onto its
 * Amazon Chime SDK identity) had no visible effect there either.
 */
import { describe, it, expect } from 'vitest';
import { botMessageLabel } from './senderLabel';

const FALLBACK = 'Assistant';

describe('what a conversation calls the assistant that sent a message', () => {
  it('uses the assistant\'s own name, which is what a profile rename changes', () => {
    expect(botMessageLabel({ senderName: 'Research Desk', fallback: FALLBACK })).toBe('Research Desk');
  });

  it('distinguishes two assistants in one room, which the constant could not', () => {
    // The reason this is a correctness problem and not a cosmetic one.
    const a = botMessageLabel({ senderName: 'Concierge', fallback: FALLBACK });
    const b = botMessageLabel({ senderName: 'Analyst', fallback: FALLBACK });
    expect(a).not.toBe(b);
  });

  it('prefers the battle variant, because a duel must separate the two sides first', () => {
    expect(botMessageLabel({
      battleVariantLabel: 'Atlas',
      senderName: 'Analyst',
      fallback: FALLBACK,
    })).toBe('Atlas');
  });

  it('falls back to the CALLER\'S translated label when the message carries no name', () => {
    // The fallback is passed in rather than written here so it can be localized; a literal would be
    // the one piece of this label nobody could translate.
    expect(botMessageLabel({ senderName: undefined, fallback: 'Asistente' })).toBe('Asistente');
    expect(botMessageLabel({ senderName: '', fallback: FALLBACK })).toBe(FALLBACK);
  });

  it('treats a whitespace-only name as absent rather than rendering a blank', () => {
    expect(botMessageLabel({ senderName: '   ', fallback: FALLBACK })).toBe(FALLBACK);
    expect(botMessageLabel({ battleVariantLabel: '  ', senderName: 'Analyst', fallback: FALLBACK })).toBe('Analyst');
  });
});
