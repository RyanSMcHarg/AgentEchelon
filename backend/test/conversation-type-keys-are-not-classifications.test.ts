/**
 * A conversation type is never named after a classification.
 *
 * A conversation type never shares a value with a classification, so every call site reads
 * unambiguously. The three shipped types used to be `basic`, `standard` and `premium`, which made one
 * word mean a classification (the closed axis IAM evaluates) and a type (an open policy bundle) at once,
 * and a reader could not tell from a call site which one was meant. A creator that looked a type up by
 * the classification passed every test for as long as the two shared their names.
 *
 * Asserted over the DEPLOYMENT'S declared classifications rather than a literal list, so a deployment
 * that declares `legal` and `finance` cannot add a `legal` type either.
 */

import {
  CONVERSATION_TYPES,
  DEFAULT_CONVERSATION_TYPE,
  resolveConversationTypeKey,
} from '../lib/config/conversation-types';
import { defaultProfileRegistry } from '../lib/profile-registry';

describe('conversation type keys and classification values are disjoint', () => {
  const classifications = defaultProfileRegistry.classificationValues();

  it('reads a non-empty set of declared classifications (the guard is wired to the config)', () => {
    expect(classifications.length).toBeGreaterThan(0);
  });

  it('no registered type key equals a declared classification', () => {
    const collisions = Object.keys(CONVERSATION_TYPES).filter((key) => classifications.includes(key));
    expect(collisions).toEqual([]);
  });

  it('the default type is not a classification either', () => {
    expect(classifications).not.toContain(DEFAULT_CONVERSATION_TYPE);
  });

  it('a classification is never resolved as a type', () => {
    // Even a conversation stamped with a classification name, from before the rename, resolves to the
    // ordinary type rather than to anything chosen by the classification.
    for (const value of classifications) {
      expect(resolveConversationTypeKey({ explicitType: value })).toBe(DEFAULT_CONVERSATION_TYPE);
    }
  });
});
