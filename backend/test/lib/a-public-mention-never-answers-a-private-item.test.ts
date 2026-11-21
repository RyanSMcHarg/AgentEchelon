/**
 * A PUBLIC MENTION IS A PUBLIC TURN (ADR-034): addressing is not privacy.
 *
 * Measured on dev 2026-11-19: "@Ops update the draft for current status", sent openly in a customer messaging conversation,
 * was taken as the answer to the sender's private approval card, so Ops answered privately and left the room "I have
 * replied to you privately." for a question everyone saw. The rule pinned here: a turn the channel flow dispatched for an
 * untargeted message never resolves to a private item it did not name, either as the waiting candidate the router applies
 * the message to or as a candidate the model may redirect to. A private item is answered from its card (which names it)
 * or with `.<assistant>` (targeted), and both keep their private path.
 *
 * Only a turn established as public, in a room someone else saw: a reply in a one-to-one conversation, or a turn nobody marked
 * public or private, still answers the private item waiting on the person (a short "ok" to an assistant's question).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const router = readFileSync(join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');

describe('a public mention never answers a private item it did not name', () => {
  it('reads an open mention as a flow turn established as public, in a room with someone else in it', () => {
    expect(router).toMatch(/const publicTurn = isFlowEntry\(event\) && event\.requestAttributes\?\.\[BYPASS_TARGETED_ATTR\] === '0';/);
    expect(router).toMatch(/const openMention = publicTurn && roomCandidates\.some\(\(t\) => isPrivateVisibility\(t\.visibility\)\) && channelArn/);
  });

  it('DENY: a room whose members cannot be read counts as shared, so an unread room never exposes a private item', () => {
    expect(router).toMatch(/resolveChannelSize\(chimeClient, channelArn, botArn\)\.then\(\(s\) => s\.refused \|\| s\.unknown \|\| !s\.isOneToOne, \(\) => true\)/);
  });

  it('keeps private items out of the model\'s candidates for an open mention', () => {
    const rows = router.slice(router.indexOf('const roomCandidates = ['), router.indexOf('const referents = rankReferentCandidates('));
    expect(rows).toMatch(/!\(openMention && isPrivateVisibility\(t\.visibility\)\)/);
  });

  it('keeps private items out of the waiting candidates an open mention is applied to', () => {
    const waiting = router.slice(router.indexOf('const waitingCandidates = ['), router.indexOf('const firstCandidate = waitingCandidates[0]'));
    expect(waiting).toMatch(/\.filter\(\(t\) => !\(openMention && isPrivateVisibility\(t\.visibility\)\)\)/);
  });

  it('leaves a named item to its own path: the referenced branch is untouched by the rule', () => {
    const named = router.slice(router.indexOf('if (referenced) {'), router.indexOf("taskResolution = declaredTaskId ? 'id' : 'reference';"));
    expect(named).not.toMatch(/openMention/);
  });
});
