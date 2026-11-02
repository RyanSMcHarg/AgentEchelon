/**
 * TWO WAYS A TARGETED REQUEST REACHED THE ROOM, both by failing OPEN where the rest of this design
 * fails closed. The pattern is the same in each: something knows a message was private, something
 * else does not, and the path between them resolved the disagreement in favor of publishing.
 *
 * Note the fixtures carry THREE subjects. `topicsForOffer` returns nothing at all unless more than
 * one subject survives ("one subject is not a split"), so a two-subject fixture cannot tell a
 * DROPPED private subject from an offer that was suppressed for being single - the assertion would
 * pass without the fix.
 */
import * as fs from 'fs';
import * as path from 'path';
import { topicsForOffer } from '../../lambda/src/lib/turn-triage-proposal';

const ROOT = path.resolve(__dirname, '..', '..');
const ALICE = 'arn:aws:chime:us-east-1:1:app-instance/i/user/alice';

/** Two ordinary subjects, so something always survives, plus the one under test. */
const OTHERS = [
  { label: 'the onboarding report', messageIds: ['m8'] },
  { label: 'the pricing page', messageIds: ['m9'] },
];
const SECRET = { label: 'my salary band', messageIds: ['m1'] };
const labels = (out: ReturnType<typeof topicsForOffer>) => out.map((t) => t.label);

describe('a subject nobody can attribute is not offered', () => {
  it('offers every subject when none of them is targeted', () => {
    expect(labels(topicsForOffer({ topics: [SECRET, ...OTHERS] })))
      .toEqual(['my salary band', 'the onboarding report', 'the pricing page']);
  });

  it('offers a targeted subject as PRIVATE when the sender is known', () => {
    const out = topicsForOffer({
      topics: [SECRET, ...OTHERS], targetedIds: ['m1'], sendersById: { m1: ALICE },
    });
    const secret = out.find((t) => t.label === 'my salary band');
    expect(secret?.private).toBe(true);
    expect(secret?.requestorId).toBe('alice');
  });

  it('DROPS the subject when a targeted message has no known sender', () => {
    // `sendersById` is optional and the dispatcher omits an entry for a message whose Sender.Arn it
    // could not read, while still listing the id in `targetedIds`. That id used to be dropped, which
    // left the topic looking ordinary: published to the room, and - if chosen - turned into a
    // conversation NAMED for the private request, with the room carried in.
    const out = topicsForOffer({ topics: [SECRET, ...OTHERS], targetedIds: ['m1'] });

    expect(labels(out)).toEqual(['the onboarding report', 'the pricing page']);
    // The label is the part that cannot be taken back once it becomes a channel name.
    expect(JSON.stringify(out)).not.toContain('salary');
    expect(JSON.stringify(out)).not.toContain('m1');
  });

  it('drops a MIXED subject too, rather than offering the public half', () => {
    // Half a thread is not something anybody can consent to move on the strength of a label that
    // described the whole, and the label here is still the private one.
    const out = topicsForOffer({
      topics: [{ label: 'my salary band', messageIds: ['m1', 'm2'] }, ...OTHERS],
      targetedIds: ['m1'],
      sendersById: { m2: ALICE },
    });
    expect(labels(out)).toEqual(['the onboarding report', 'the pricing page']);
  });
});

describe('the clarifying exit does not speak the model prose over a mixed batch', () => {
  const CORE = path.resolve(ROOT, 'lambda/src/lib/async-processor-core.ts');

  it('gates the spoken half on there being no targeted message in the batch', () => {
    const src = fs.readFileSync(CORE, 'utf8');
    // The reading was shown every queued message including the targeted ones, and nothing in its
    // contract tells it which the room may not see. `buildProposalMessage` already refuses its prose
    // on a mixed batch; this exit posts to the same untargeted placeholder and did not.
    expect(src).toContain('const targetedInBatch = (event.triage.targetedIds ?? []).length;');
    expect(src).toContain("(targetedInBatch ? '' : longResponseResult.content.split(/^PROPOSAL:/m)[1]?.trim())");
  });
});
