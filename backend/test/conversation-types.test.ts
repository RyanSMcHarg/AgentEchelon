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
  resolveWelcomeConfig,
  type ConversationTypeConfig,
} from '../lib/config/conversation-types';

describe('conversation-types registry', () => {
  it('ships the three classification types, each carrying a matching classification', () => {
    for (const classification of ['basic', 'standard', 'premium'] as const) {
      expect(CONVERSATION_TYPES[classification]).toBeDefined();
      // type ≡ classification today: the shipped types map to the same classification.
      expect(CONVERSATION_TYPES[classification].classification).toBe(classification);
    }
  });

  it('has drift ON by default for every shipped type (all-classification, on-by-default)', () => {
    for (const key of Object.keys(CONVERSATION_TYPES)) {
      expect(CONVERSATION_TYPES[key].driftEnabled).toBe(true);
    }
  });

  it('the default conversation type exists in the registry', () => {
    expect(CONVERSATION_TYPES[DEFAULT_CONVERSATION_TYPE]).toBeDefined();
  });
});

describe('resolveConversationTypeKey', () => {
  it('prefers an explicit, registered type over the classification', () => {
    expect(resolveConversationTypeKey({ explicitType: 'premium', classification: 'basic' })).toBe('premium');
  });

  it('falls back to the classification when no explicit type is given (non-breaking: type ≡ classification)', () => {
    expect(resolveConversationTypeKey({ classification: 'standard' })).toBe('standard');
  });

  it('ignores an explicit type that is not in the registry (typo cannot silently disable policy)', () => {
    expect(resolveConversationTypeKey({ explicitType: 'engagment', classification: 'premium' })).toBe('premium');
  });

  it('falls back to the default type when even the classification is unknown', () => {
    expect(resolveConversationTypeKey({ classification: 'enterprise' })).toBe(DEFAULT_CONVERSATION_TYPE);
  });
});

describe('getConversationTypeConfig / isDriftEnabledForType', () => {
  it('returns the default type config for an unknown key (never undefined)', () => {
    expect(getConversationTypeConfig('nope')).toBe(CONVERSATION_TYPES[DEFAULT_CONVERSATION_TYPE]);
  });

  it('reports drift enabled for the shipped classification types', () => {
    expect(isDriftEnabledForType('basic')).toBe(true);
    expect(isDriftEnabledForType('premium')).toBe(true);
  });

  it('honours a driftEnabled:false override (drift is a per-type property, not per-classification)', () => {
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

describe('resolveWelcomeConfig', () => {
  /** Register a temporary type so a test never mutates a shipped one. */
  function withType(key: string, config: ConversationTypeConfig, run: () => void): void {
    CONVERSATION_TYPES[key] = config;
    try {
      run();
    } finally {
      delete CONVERSATION_TYPES[key];
    }
  }

  it('defaults every shipped type to the interpolated built-in assembly', () => {
    // THE LOAD-BEARING TEST FOR THIS FIELD. Adding `welcome` must not change a single existing
    // deployment's welcome, and "no welcome config" is the state every shipped type is in. If this
    // regresses, every conversation on every deployment silently changes its opening copy - or starts
    // spending a Bedrock call it never used to.
    for (const key of Object.keys(CONVERSATION_TYPES)) {
      expect(resolveWelcomeConfig(key)).toEqual({
        mode: 'interpolated',
        template: undefined,
        contextKeys: [],
      });
    }
  });

  it('defaults an unknown type the same way, rather than throwing', () => {
    expect(resolveWelcomeConfig('no-such-type').mode).toBe('interpolated');
  });

  it('honours a generated mode with a template and context keys', () => {
    withType('incident', {
      classification: 'standard',
      driftEnabled: false,
      welcome: {
        mode: 'generated',
        template: 'Open with the incident state, then who is here.',
        contextKeys: ['x-incident', 'user-profile'],
      },
    }, () => {
      expect(resolveWelcomeConfig('incident')).toEqual({
        mode: 'generated',
        template: 'Open with the incident state, then who is here.',
        contextKeys: ['x-incident', 'user-profile'],
      });
    });
  });

  it('degrades an unrecognised mode to interpolated rather than to generated', () => {
    // Failing towards the deterministic path costs richness. Failing towards `generated` would spend a
    // Bedrock call on every new conversation because of a typo in a config file.
    withType('typo', {
      classification: 'basic',
      driftEnabled: false,
      welcome: { mode: 'genrated' as unknown as 'generated' },
    }, () => {
      expect(resolveWelcomeConfig('typo').mode).toBe('interpolated');
    });
  });

  it('treats a blank template as absent, so it falls back to the built-in assembly', () => {
    // A blank template must not render a blank welcome. "Welcome always lands" outranks honouring
    // whitespace an operator left in a config file.
    withType('blank', {
      classification: 'basic',
      driftEnabled: false,
      welcome: { template: '   ' },
    }, () => {
      expect(resolveWelcomeConfig('blank').template).toBeUndefined();
    });
  });

  it('drops blank context keys instead of asking the catalog for an empty key', () => {
    withType('sloppy', {
      classification: 'basic',
      driftEnabled: false,
      welcome: { contextKeys: ['  user-profile  ', '', '   '] },
    }, () => {
      expect(resolveWelcomeConfig('sloppy').contextKeys).toEqual(['user-profile']);
    });
  });
});
