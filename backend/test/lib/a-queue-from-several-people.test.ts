/**
 * A QUEUE IS NOT ALWAYS ONE PERSON (DESIGN 2.4.2, and 1.5 for why this is the case that matters).
 *
 * Several people share a room with the same assistant, and two of them typing at nearly the same
 * moment is ordinary rather than a race worth engineering around. So the subjects a reading finds can
 * belong to different people, and some of them are nobody else's business.
 *
 * THE PATTERN IS SHARED FIRST, IN THE OPEN, THEN EACH PERSON PRIVATELY. That splits the work across
 * two places, and the split is the point:
 *
 *   RECORDING  keeps EVERY subject that may be acted on, with whose it is. Narrowing to one person
 *              here would mean everybody else was never asked about their own.
 *   READING    narrows to what the person in front of it may see: the shared subjects, which are
 *              anybody's to answer about, plus their own private ones and nobody else's.
 */

import { topicsForOffer } from '../../lambda/src/lib/turn-triage-proposal';

const ALICE = 'arn:aws:chime:us-east-1:1:app-instance/i/user/alice';
const BOB = 'arn:aws:chime:us-east-1:1:app-instance/i/user/bob';

const TOPICS = [
  { label: 'the billing question', messageIds: ['m1', 'm4'] },
  { label: 'the failed deploy', messageIds: ['m2'] },
  { label: 'the pricing page copy', messageIds: ['m3'] },
];

const SENDERS = { m1: ALICE, m2: BOB, m3: ALICE, m4: BOB };

describe('what gets recorded when a queue came from several people', () => {
  it('records every subject, and marks none private when nothing was targeted', () => {
    const offer = topicsForOffer({ topics: TOPICS, sendersById: SENDERS });

    // Whose message it was does not make a subject private. Only TARGETING does, and marking these
    // private would strip the room out of conversations they were entitled to keep.
    expect(offer).toHaveLength(3);
    expect(offer.every((t) => !t.private)).toBe(true);
  });

  it('keeps a subject built from two different people messages whole', () => {
    // Billing is m1 from Alice and m4 from Bob: one subject, two askers, and still the room's. A
    // thread is a thread whoever typed which half, so it is not divided by author.
    const offer = topicsForOffer({ topics: TOPICS, sendersById: SENDERS });

    expect(offer.find((t) => t.label === 'the billing question')?.messageIds).toEqual(['m1', 'm4']);
  });

  it('marks a targeted subject private, and records whose it is BOTH ways', () => {
    const offer = topicsForOffer({ topics: TOPICS, sendersById: SENDERS, targetedIds: ['m3'] });

    // The ARN addresses a message to somebody; the principal id is what the rest of the design
    // compares identities by. Recording only the ARN made a private subject invisible to its OWN
    // requester, because the read compares principals.
    expect(offer.find((t) => t.label === 'the pricing page copy')).toEqual({
      label: 'the pricing page copy',
      messageIds: ['m3'],
      private: true,
      requestorId: 'alice',
    });
  });

  it('makes ONE subject private, not the whole offer', () => {
    const offer = topicsForOffer({ topics: TOPICS, sendersById: SENDERS, targetedIds: ['m3'] });

    // Treating the batch as private is the safe-looking mistake: it would quietly take the room out
    // of two conversations that were always theirs.
    expect(offer.find((t) => t.label === 'the failed deploy')?.private).toBeUndefined();
    expect(offer.find((t) => t.label === 'the billing question')?.private).toBeUndefined();
  });
  it('partitions a subject whose targeted messages name two senders', () => {
    const offer = topicsForOffer({ topics: TOPICS, sendersById: SENDERS, targetedIds: ['m1', 'm4'] });

    // NOT DROPPED, which was the earlier behavior and lost both requests silently. A message has
    // one sender, so this is two private requests that share a subject, and each keeps its own.
    const billing = offer.filter((t) => t.label === 'the billing question');
    expect(billing).toHaveLength(2);
    expect(billing.map((t) => t.requestorId)).toEqual(['alice', 'bob']);
  });

  it('records nothing when the conversation is only covering one subject', () => {
    expect(topicsForOffer({ topics: [TOPICS[0]], sendersById: SENDERS })).toEqual([]);
  });
});

/**
 * TWO PEOPLE'S TARGETED MESSAGES ON ONE SUBJECT ARE TWO REQUESTS, NOT ONE.
 *
 * A message has exactly one sender. So a subject holding targeted messages from two people is never
 * one request that two people made - it is two private requests that happen to be about the same
 * thing, which the reading grouped by their subject because that is what it groups by.
 *
 * Merging them would put two people's private requests into one room on the authority of whichever
 * answered first. Dropping the subject would silently lose both. Each becomes its own private
 * request, belonging to its own sender.
 */
describe('one subject, two people, both targeted', () => {
  it('makes one private request per sender, carrying only their own messages', () => {
    const offer = topicsForOffer({
      topics: TOPICS, sendersById: SENDERS, targetedIds: ['m1', 'm4'],
    });

    const billing = offer.filter((t) => t.label === 'the billing question');
    expect(billing).toEqual([
      {
        label: 'the billing question',
        messageIds: ['m1'],
        private: true,
        requestorId: 'alice',
      },
      {
        label: 'the billing question',
        messageIds: ['m4'],
        private: true,
        requestorId: 'bob',
      },
    ]);
  });

  it('loses neither of them', () => {
    const offer = topicsForOffer({
      topics: TOPICS, sendersById: SENDERS, targetedIds: ['m1', 'm4'],
    });

    // Dropping the subject was the earlier behavior and it was wrong: two people had each asked for
    // something privately, and neither would have been carried anywhere.
    const carried = offer.filter((t) => t.label === 'the billing question')
      .flatMap((t) => t.messageIds);
    expect(carried.sort()).toEqual(['m1', 'm4']);
  });

  it('leaves the untargeted remainder of a divided subject where it is', () => {
    // m1 targeted by Alice, m4 untargeted. Once a subject has been divided by privacy, what is left
    // is half a thread, and nobody can meaningfully consent to moving half a thread on the strength
    // of a label that described the whole.
    const offer = topicsForOffer({ topics: TOPICS, sendersById: SENDERS, targetedIds: ['m1'] });

    const billing = offer.filter((t) => t.label === 'the billing question');
    expect(billing).toHaveLength(1);
    expect(billing[0]).toEqual(expect.objectContaining({ private: true, messageIds: ['m1'] }));
  });

  it('keeps each private request separately answerable by its own sender', () => {
    const offer = topicsForOffer({
      topics: TOPICS, sendersById: SENDERS, targetedIds: ['m1', 'm4'],
    });

    // The read narrows by principal id, so the two must carry DIFFERENT ones or one person would be
    // able to move the other's request.
    const owners = offer.filter((t) => t.private).map((t) => t.requestorId);
    expect(new Set(owners).size).toBe(owners.length);
  });
});
