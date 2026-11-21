/**
 * A PATTERN NAMES A TYPE'S STANDING CONVERSATIONS (DESIGN-EVENT-TARGETS 11.2, phase 6).
 *
 * A type the platform opens may declare `conversationPattern`, for example `ticket:{key}`: an event a trigger attaches for it
 * runs in the conversation the pattern names for that event. What this proves:
 *  - the pattern is checked at synth: only the declared variables, literals in the id alphabet, on a type the platform opens;
 *  - a pattern resolves only where every variable has a value in the id alphabet, so nothing is created for an event it cannot name;
 *  - the id is derived under the pattern's own namespace, within 64 characters, and never equals a host context conversation's,
 *    whose ids are unchanged;
 *  - DENY: a host's create-or-get never joins a conversation of another type found at its id.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { conversationPatternErrors, resolveConversationPattern, patternVariables, isTeamRoomType, isPatternType } from '../../lib/config/conversation-types';
import { contextChannelId, patternChannelId } from '../../lambda/src/lib/channel-creation';

describe('the pattern a type declares', () => {
  it('names only the declared variables and id-alphabet literals', () => {
    expect(patternVariables('ticket:{key}')).toEqual(['key']);
    expect(patternVariables('alarm-{resource}.{key}')).toEqual(['resource', 'key']);
    expect(patternVariables('standing')).toEqual([]);
    expect(patternVariables('main:{person}')).toEqual(['person']);
    expect(patternVariables('x:{who}')).toBeNull();
    expect(patternVariables('a b')).toBeNull();
  });

  it('DENY: synth refuses a pattern on a type the platform does not open, a meeting\'s, an undeclared variable, or an overlong one', () => {
    const errs = conversationPatternErrors({
      ok: { conversationPattern: 'ticket:{key}', initiation: 'system' },
      user: { conversationPattern: 'x:{key}', initiation: 'user' },
      meet: { conversationPattern: 'x:{key}', initiation: 'system', meeting: {} as never },
      person: { conversationPattern: 'main:{who}', initiation: 'system' },
      long: { conversationPattern: 'x'.repeat(65), initiation: 'system' },
    }).join('\n');
    expect(errs).not.toMatch(/^ok\./m);
    expect(errs).toMatch(/user\.conversationPattern is on a type the platform opens/);
    expect(errs).toMatch(/meet\.conversationPattern is on a type the platform opens/);
    expect(errs).toMatch(/person\.conversationPattern names only \{key\}, \{resource\}, \{person\}/);
    expect(errs).toMatch(/long\.conversationPattern is 1 to 64 characters/);
  });

  it('a pattern type has no single team room, and the shipped types\' patterns are all valid', () => {
    const { CONVERSATION_TYPES } = jest.requireActual('../../lib/config/conversation-types') as typeof import('../../lib/config/conversation-types');
    expect(conversationPatternErrors(CONVERSATION_TYPES)).toEqual([]);
    for (const key of Object.keys(CONVERSATION_TYPES)) expect(isTeamRoomType(key) && isPatternType(key)).toBe(false);
  });
});

describe('the value a pattern resolves to for one event', () => {
  it('fills each variable from the event', () => {
    expect(resolveConversationPattern('ticket:{key}', { key: 'INC-123' })).toBe('ticket:INC-123');
    expect(resolveConversationPattern('alarm:{resource}', { resource: 'Customer-API-availability' })).toBe('alarm:Customer-API-availability');
  });

  it('DENY: a missing value, or one outside the id alphabet, resolves to nothing', () => {
    expect(resolveConversationPattern('ticket:{key}', {})).toBeUndefined();
    expect(resolveConversationPattern('ticket:{key}', { key: '../../x' })).toBeUndefined();
    expect(resolveConversationPattern('ticket:{key}', { key: 'a b' })).toBeUndefined();
    expect(resolveConversationPattern('ticket:{key}', { key: 'x'.repeat(129) })).toBeUndefined();
  });
});

describe('the id a pattern conversation is created at', () => {
  it('is derived under its own namespace, within the Amazon Chime SDK\'s 64 characters, and one event names one id', () => {
    const id = patternChannelId('premium', 'support', 'ticket:INC-123');
    expect(id).toMatch(/^pat-premium-support-ticket-INC-123-[a-f0-9]{16}$/);
    expect(patternChannelId('premium', 'support', 'ticket:INC-123')).toBe(id);
    expect(patternChannelId('premium', 'a-very-long-conversation-type-name', 'ticket:' + 'X'.repeat(120)).length).toBeLessThanOrEqual(64);
    expect(patternChannelId('standard', 'support', 'ticket:INC-123')).not.toBe(id);
    expect(patternChannelId('premium', 'support2', 'ticket:INC-123')).not.toBe(id);
  });

  it('DENY: a host context conversation can never produce a pattern conversation\'s id', () => {
    expect(contextChannelId('premium', 'support', 'ticket:INC-123')).not.toBe(patternChannelId('premium', 'support', 'ticket:INC-123'));
    expect(contextChannelId('premium', 'support', 'ticket:INC-123').startsWith('ctx-')).toBe(true);
  });

  it('every context conversation that exists keeps its id', () => {
    const before = (c: string, t: string, i: string) => {
      const digest = createHash('sha256').update(JSON.stringify([c, t, i])).digest('hex').slice(0, 16);
      return `${`ctx-${c}-${t}-${i}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64 - 16 - 1)}-${digest}`;
    };
    for (const [c, t, i] of [['premium', 'order', 'A-1'], ['standard', 'case', 'x'.repeat(90)], ['basic', 'a b', 'ü']]) {
      expect(contextChannelId(c, t, i)).toBe(before(c, t, i));
    }
  });
});

describe('a host\'s create-or-get', () => {
  it('DENY: never joins a conversation of another type found at its id', () => {
    const src = readFileSync(join(__dirname, '../../lambda/src/conversation-management.ts'), 'utf8');
    expect(src).toMatch(/const existingType = existingTags\[CONVERSATION_TYPE_TAG\];\n\s+if \(existingType && existingType !== DEFAULT_CONVERSATION_TYPE\) \{/);
  });
});
