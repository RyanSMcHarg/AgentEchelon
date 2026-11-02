/**
 * Unit tests for the conversation-type config registry
 * (lib/config/conversation-types.ts).
 *
 * Conversation type is a configurable policy bundle (drift on/off, default agents, membership,
 * retention) that may CONSTRAIN the security classification but is never one: the classification is
 * an input at creation and the only axis IAM evaluates, while types proliferate. These tests pin that.
 */

import {
  CONVERSATION_TYPES,
  DEFAULT_CONVERSATION_TYPE,
  resolveConversationTypeKey,
  getConversationTypeConfig,
  isDriftEnabledForType,
  resolveMessageFlowKey,
  DEFAULT_MESSAGE_FLOW,
  classificationAllowedForType,
  membershipSourceFor,
  membershipSourceStamp,
  membershipSourceGroups,
  typesSourcedFromGroup,
  type ConversationTypeConfig,
} from '../lib/config/conversation-types';

describe('conversation-types registry', () => {
  it('ships the ordinary type, the ops types, the guest visitor type and the customer engagement type, none named after a classification', () => {
    // A type never shares a value with a classification. The full guard, over the
    // deployment's declared classifications, is conversation-type-keys-are-not-classifications.test.ts.
    expect(Object.keys(CONVERSATION_TYPES).sort()).toEqual(['customer-engagement', 'general', 'guest-visitor', 'ops', 'ops-team']);
  });

  it('the ordinary type takes any classification as input, keeps drift on, and has manual membership', () => {
    const general = CONVERSATION_TYPES.general;
    expect(general.classifications).toBeUndefined();
    expect(general.driftEnabled).toBe(true);
    expect(membershipSourceFor('general')).toBeUndefined();
    for (const classification of ['basic', 'standard', 'premium']) {
      expect(classificationAllowedForType('general', classification)).toBe(true);
    }
  });

  it('ops and the ops team permit premium only, and take their people from the ops group', () => {
    for (const key of ['ops', 'ops-team']) {
      expect(classificationAllowedForType(key, 'premium')).toBe(true);
      expect(classificationAllowedForType(key, 'basic')).toBe(false);
      expect(membershipSourceFor(key)).toEqual({ group: 'ops' });
      expect(membershipSourceStamp(key)).toBe('group:ops');
    }
  });

  it('knows which groups are sourced at a classification, and which types each one feeds', () => {
    expect(membershipSourceGroups('premium')).toEqual(['ops']);
    expect(membershipSourceGroups('basic')).toEqual([]);
    expect(typesSourcedFromGroup('ops', 'premium').sort()).toEqual(['ops', 'ops-team']);
    expect(typesSourcedFromGroup('ops', 'basic')).toEqual([]);
  });

  it('stamps a list source, and a group plus a list, distinctly', () => {
    CONVERSATION_TYPES['tmp-list'] = { driftEnabled: true, membershipSource: { list: ['a'] } };
    CONVERSATION_TYPES['tmp-both'] = { driftEnabled: true, membershipSource: { group: 'g', list: ['a'] } };
    try {
      expect(membershipSourceStamp('tmp-list')).toBe('list');
      expect(membershipSourceStamp('tmp-both')).toBe('group:g+list');
    } finally {
      delete CONVERSATION_TYPES['tmp-list'];
      delete CONVERSATION_TYPES['tmp-both'];
    }
  });

  it('an unknown type permits no classification', () => {
    // A policy read degrades to the default type; an authorization check must not.
    expect(classificationAllowedForType('nothing-registered', 'basic')).toBe(false);
  });

  it('a type that declares no source, an empty source, or an unknown key is manual', () => {
    CONVERSATION_TYPES['tmp-no-membership'] = { driftEnabled: true };
    CONVERSATION_TYPES['tmp-empty'] = { driftEnabled: true, membershipSource: { group: ' ', list: [] } };
    try {
      expect(membershipSourceFor('tmp-no-membership')).toBeUndefined();
      expect(membershipSourceFor('tmp-empty')).toBeUndefined();
      // A typo must never make a conversation start removing its members.
      expect(membershipSourceFor('nothing-registered')).toBeUndefined();
    } finally {
      delete CONVERSATION_TYPES['tmp-no-membership'];
      delete CONVERSATION_TYPES['tmp-empty'];
    }
  });

  it('names which message flow it associates, and every shipped type names the same one', () => {
    // The dimension is a SELECTOR, never a switch: there is no value meaning "no flow", because a
    // conversation nobody can address is broken rather than configured. Every type naming the same flow is
    // the expected state today - the dimension exists so a deployment can carry two later without a
    // creator learning about it.
    for (const key of Object.keys(CONVERSATION_TYPES)) {
      expect(resolveMessageFlowKey(key)).toBe(DEFAULT_MESSAGE_FLOW);
    }
  });

  it('resolves the project default for a type nobody registered', () => {
    // An unknown type must not resolve to "no routing". It degrades to the default conversation type,
    // which names the default flow - so an unregistered key produces an addressable conversation.
    expect(resolveMessageFlowKey('nothing-registered-under-this-name')).toBe(DEFAULT_MESSAGE_FLOW);
  });

  it('the default conversation type is the ordinary one, and exists in the registry', () => {
    expect(DEFAULT_CONVERSATION_TYPE).toBe('general');
    expect(CONVERSATION_TYPES[DEFAULT_CONVERSATION_TYPE]).toBeDefined();
  });
});

describe('resolveConversationTypeKey', () => {
  it('returns a stamped, registered type', () => {
    expect(resolveConversationTypeKey({ explicitType: 'ops' })).toBe('ops');
  });

  it('returns the ordinary type when nothing is stamped', () => {
    expect(resolveConversationTypeKey({})).toBe('general');
  });

  it('degrades an unregistered stamp to the ordinary type (a typo cannot silently disable policy)', () => {
    expect(resolveConversationTypeKey({ explicitType: 'engagment' })).toBe('general');
  });

  it('reads a stamp from before the rename (a classification name) as the ordinary type it was', () => {
    // Conversations stamped basic, standard or premium were all ordinary conversations. None of those
    // keys is registered, so they resolve to general with no migration - and never to a type chosen by
    // the classification.
    for (const legacy of ['basic', 'standard', 'premium']) {
      expect(resolveConversationTypeKey({ explicitType: legacy })).toBe('general');
    }
  });
});

describe('getConversationTypeConfig / isDriftEnabledForType', () => {
  it('returns the default type config for an unknown key (never undefined)', () => {
    expect(getConversationTypeConfig('nope')).toBe(CONVERSATION_TYPES[DEFAULT_CONVERSATION_TYPE]);
  });

  it('reports drift on for the ordinary type and off for ops', () => {
    expect(isDriftEnabledForType('general')).toBe(true);
    expect(isDriftEnabledForType('ops')).toBe(false);
  });

  it('honours a driftEnabled:false override (drift is a per-type property, not per-classification)', () => {
    const original = CONVERSATION_TYPES.general.driftEnabled;
    try {
      CONVERSATION_TYPES.general.driftEnabled = false;
      expect(isDriftEnabledForType('general')).toBe(false);
    } finally {
      CONVERSATION_TYPES.general.driftEnabled = original;
    }
  });
});

describe('a welcome is the assistant\'s, never the conversation type\'s (ADR-061)', () => {
  it('no conversation type declares a welcome: the designed and uncalled WelcomeConfig is retired', () => {
    for (const [key, config] of Object.entries(CONVERSATION_TYPES)) {
      expect({ key, welcome: (config as unknown as Record<string, unknown>).welcome }).toEqual({ key, welcome: undefined });
    }
  });
});
