/**
 * A FIELD ADDED TO THE DISPATCHER AND NOT TO THE PARSER IS A FEATURE THAT DOES NOT EXIST.
 *
 * `parseTriageTurnContext` is the boundary a serialized triage payload crosses, and it is built field
 * by field on purpose: a field it does not name cannot arrive, which is what stops a caller inventing
 * one. The cost is that adding a field on the sending side and forgetting this one drops it silently -
 * and every unit test around the feature still passes, because they exercise the two halves and never
 * the hop between them.
 *
 * That is not hypothetical. THREE fields were added to the dispatcher during one session and none
 * reached the processor: the per-message targeting that decides whether a queued request is private,
 * the senders that decide whose private request it is, and the user content the input guardrail is
 * supposed to score instead of the contract. All three were live in unit tests and inert on the
 * deployment.
 *
 * So this file tests the HOP. It is deliberately about the parser rather than about any feature.
 */

import { parseTriageTurnContext } from '../../lambda/src/lib/turn-triage-proposal';

const BASE = {
  ids: ['m1', 'm2'],
  visibility: 'conversation' as const,
  inFlight: false,
  pass: 1,
};
const parse = (o: unknown) => parseTriageTurnContext(JSON.stringify(o));

describe('every field the dispatcher sends arrives', () => {
  it('carries the targeting, the senders, and the user content', () => {
    const ctx = parse({
      ...BASE,
      targetedIds: ['m2'],
      sendersById: { m1: 'arn:alice', m2: 'arn:bob' },
      userContent: 'keep it to one page\n\nwhat was Q3 headcount',
    });

    expect(ctx?.targetedIds).toEqual(['m2']);
    expect(ctx?.sendersById).toEqual({ m1: 'arn:alice', m2: 'arn:bob' });
    expect(ctx?.userContent).toContain('Q3 headcount');
  });

  it('still parses a payload from a dispatcher that sends none of them', () => {
    // An older dispatcher, mid-deploy. It degrades to the behavior it always had rather than
    // refusing a turn over a field it was never going to send.
    const ctx = parse(BASE);

    expect(ctx?.ids).toEqual(['m1', 'm2']);
    expect(ctx?.targetedIds).toBeUndefined();
    expect(ctx?.userContent).toBeUndefined();
  });
});

describe('targeting fails closed, because the failure direction is disclosure', () => {
  it('refuses the whole context when the targeting is malformed', () => {
    // Dropping it and carrying on would treat a message somebody sent privately as ordinary, and the
    // work opened from it would be visible to the room. Refusing means the turn behaves as an
    // ordinary one and the queue waits for the next notice, which loses nothing.
    expect(parse({ ...BASE, targetedIds: 'm2' })).toBeUndefined();
    expect(parse({ ...BASE, targetedIds: [''] })).toBeUndefined();
    expect(parse({ ...BASE, targetedIds: [1, 2] })).toBeUndefined();
  });

  it('refuses targeting that names a message this turn is not reading', () => {
    // A payload describing a different queue. Acting on it would mark the wrong message private, or
    // miss the one that was.
    expect(parse({ ...BASE, targetedIds: ['m9'] })).toBeUndefined();
  });

  it('refuses senders that are malformed or name an unknown message', () => {
    // A wrong sender attributes one person's private request to another - which decides who is asked
    // about it, and who a spawned conversation would belong to.
    expect(parse({ ...BASE, sendersById: ['arn:alice'] })).toBeUndefined();
    expect(parse({ ...BASE, sendersById: { m1: 42 } })).toBeUndefined();
    expect(parse({ ...BASE, sendersById: { m9: 'arn:alice' } })).toBeUndefined();
  });

  it('drops only the user content when THAT is malformed', () => {
    // The asymmetry is deliberate. This one is not a disclosure decision: losing it costs the
    // guardrail its narrow input, which degrades to screening the whole prompt - the old behavior -
    // rather than costing the turn or leaking anything.
    const ctx = parse({ ...BASE, targetedIds: ['m2'], userContent: 42 });

    expect(ctx).not.toBeUndefined();
    expect(ctx?.userContent).toBeUndefined();
    expect(ctx?.targetedIds).toEqual(['m2']);
  });
});
