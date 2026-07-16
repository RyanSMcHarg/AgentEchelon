/**
 * Unit tests for the conversation-type config registry
 * (lib/config/conversation-types.ts).
 *
 * Conversation type is a configurable policy bundle (drift on/off, default
 * agents, available channels) that CARRIES a security classification rather
 * than being one — the classification axis stays a small total order for the
 * IAM Layer-1 boundary while types proliferate. These tests pin that contract.
 */

import {
  CONVERSATION_TYPES,
  DEFAULT_CONVERSATION_TYPE,
  resolveConversationTypeKey,
  getConversationTypeConfig,
  isDriftEnabledForType,
} from '../lib/config/conversation-types';

describe('conversation-types registry', () => {
  it('ships the three tier types, each carrying a matching classification', () => {
    for (const tier of ['basic', 'standard', 'premium'] as const) {
      expect(CONVERSATION_TYPES[tier]).toBeDefined();
      // type ≡ tier today: the shipped types map to the same classification.
      expect(CONVERSATION_TYPES[tier].classification).toBe(tier);
    }
  });

  it('has drift ON by default for every shipped type (all-tier, on-by-default)', () => {
    for (const key of Object.keys(CONVERSATION_TYPES)) {
      expect(CONVERSATION_TYPES[key].driftEnabled).toBe(true);
    }
  });

  it('the default conversation type exists in the registry', () => {
    expect(CONVERSATION_TYPES[DEFAULT_CONVERSATION_TYPE]).toBeDefined();
  });
});

describe('resolveConversationTypeKey', () => {
  it('prefers an explicit, registered type over the tier', () => {
    expect(resolveConversationTypeKey({ explicitType: 'premium', tier: 'basic' })).toBe('premium');
  });

  it('falls back to the tier when no explicit type is given (non-breaking: type ≡ tier)', () => {
    expect(resolveConversationTypeKey({ tier: 'standard' })).toBe('standard');
  });

  it('ignores an explicit type that is not in the registry (typo cannot silently disable policy)', () => {
    expect(resolveConversationTypeKey({ explicitType: 'engagment', tier: 'premium' })).toBe('premium');
  });

  it('falls back to the default type when even the tier is unknown', () => {
    expect(resolveConversationTypeKey({ tier: 'enterprise' })).toBe(DEFAULT_CONVERSATION_TYPE);
  });
});

describe('getConversationTypeConfig / isDriftEnabledForType', () => {
  it('returns the default type config for an unknown key (never undefined)', () => {
    expect(getConversationTypeConfig('nope')).toBe(CONVERSATION_TYPES[DEFAULT_CONVERSATION_TYPE]);
  });

  it('reports drift enabled for the shipped tier types', () => {
    expect(isDriftEnabledForType('basic')).toBe(true);
    expect(isDriftEnabledForType('premium')).toBe(true);
  });

  it('honours a driftEnabled:false override (drift is a per-type property, not per-tier)', () => {
    const original = CONVERSATION_TYPES['basic'].driftEnabled;
    try {
      CONVERSATION_TYPES['basic'].driftEnabled = false;
      expect(isDriftEnabledForType('basic')).toBe(false);
      // The classification axis is independent of the drift toggle.
      expect(getConversationTypeConfig('basic').classification).toBe('basic');
    } finally {
      CONVERSATION_TYPES['basic'].driftEnabled = original;
    }
  });
});
