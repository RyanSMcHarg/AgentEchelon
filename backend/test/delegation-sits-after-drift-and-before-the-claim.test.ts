/**
 * WHERE DELEGATION SITS AND WHAT IT COSTS, asserted against the handler's source.
 *
 * Four orderings carry the design and none is visible from any one function:
 *
 *   ROOMMATES ARE RESOLVED BEFORE CLASSIFICATION, because their advertised lines are categories in the
 *   ONE classification this turn makes. Resolved after it, the turn would need a second model call - which
 *   is the shape this replaced, measured at 757 ms plus 795 ms on a single turn.
 *
 *   THE DECISION IS ACTED ON AFTER CLASSIFICATION, since the classification IS the decision.
 *
 *   AFTER DRIFT, so a person changing subject is offered their own conversation before the platform
 *   offers them a different assistant.
 *
 *   BEFORE THE TURN CLAIM AND THE PLACEHOLDER, so a handed-over turn is claimed by the assistant that
 *   will answer it rather than by this one standing down afterwards - one responder per turn decided
 *   before anybody speaks, which matters because nothing enforces the standing down.
 *
 * SOURCE TEXT, with real limits: this catches a check being moved, deleted or widened. It does not execute
 * the handler, so it cannot catch a wrong comparison. The decision itself is behavior-tested in
 * `lib/a-turn-goes-to-the-assistant-that-advertises-it`.
 */
import * as fs from 'fs';
import * as path from 'path';

import { inboundMessageId } from '../lambda/src/router-agent-handler';

const router = fs.readFileSync(
  path.join(__dirname, '../lambda/src/router-agent-handler.ts'),
  'utf8',
);

const at = (needle: string): number => {
  const i = router.indexOf(needle);
  expect(i).toBeGreaterThan(-1);
  return i;
};

const resolver = router.slice(
  at('async function resolveRoommatesForTurn('),
  at('async function actOnDelegation('),
);
const actor = router.slice(
  at('async function actOnDelegation('),
  at('function handedToRoommateAcknowledgement('),
);
const dispatch = router.slice(
  at('async function dispatchTurnToRoommate('),
  at('async function handOverToOwningAssistant('),
);

describe('one classification decides it, which is where the cost went', () => {
  it('resolves roommates BEFORE the turn classifies', () => {
    expect(at('await resolveRoommatesForTurn({')).toBeLessThan(at("markRouterStep('classified')"));
  });

  it('feeds the merged pack to the one classification the turn makes', () => {
    expect(router).toContain('withRoommateCategories(profileIntentPack, roommates)');
    expect(router).toContain('pack: packForClassification');
  });

  it('acts on the decision after classification, after drift, and before the claim', () => {
    expect(at("markRouterStep('classified')")).toBeLessThan(at('await actOnDelegation({'));
    expect(at("markRouterStep('drift_checked')")).toBeLessThan(at('await actOnDelegation({'));
    expect(at('await actOnDelegation({')).toBeLessThan(at("markRouterStep('turn_claimed')"));
  });

  it('makes NO model call while acting on the decision', () => {
    // The guard against the two-pass shape returning: the actor reads a key and dispatches. A classifier
    // call here would be the second pass by another name.
    expect(actor).not.toContain('classifyIntent');
    expect(actor).not.toContain('classifyIntentByKeyword');
  });

  it('no longer carries the fall-through gate it replaced', () => {
    // Asserted rather than merely deleted: the old gate read as a sensible cost control and is the obvious
    // thing for a later reader to reinstate. It cannot work - a classifier returns the nearest category it
    // was shown, so an assistant whose pack advertises "a figure like ARR or churn" claims "error rate"
    // with high confidence and never falls through.
    expect(router).not.toContain('looksLikeAFallThrough');
  });
});

describe('what bounds the cost, now that the fall-through does not', () => {
  it('asks the cached live assistants first, before any roster read or advertisement', () => {
    expect(resolver).toContain('liveAssistants.filter((s) => s.botArn !== selfBotArn).length === 0) return { roommates: [] };');
    expect(resolver.indexOf('liveAssistantsForClassification')).toBeLessThan(resolver.indexOf('resolveChannelSize'));
    expect(resolver.indexOf('liveAssistantsForClassification')).toBeLessThan(resolver.indexOf('roommatesInConversation'));
  });

  it('resolves no roommates at all on a turn that arrived by handover', () => {
    // Such a turn may not delegate onward, so offering it roommate categories would spend prompt tokens on
    // choices it cannot act on - and risk it classifying as a roommate's key and losing its own route.
    expect(router).toContain('const { roommates, roster: turnRoster } = arrivedByHandover(event)');
    expect(router).toMatch(/arrivedByHandover\(event\)(\s*\|\|\s*bypassBattleContext\(event\))?\s*\n?\s*\?\s*\{ roommates: \[\]/);
  });

  it('resolves no roommates on a duel side, which answers its own prompt and never hands it over', () => {
    // Measured live 2026-10-13: offered the primary as a roommate, the alt classified a duel prompt as the
    // primary's key and handed its side over, so the alt never answered and the primary's side lost its stats.
    expect(router).toMatch(/const \{ roommates, roster: turnRoster \} = arrivedByHandover\(event\) \|\| bypassBattleContext\(event\)\s*\n\s*\?\s*\{ roommates: \[\]/);
  });

  it('classifies against this assistant\'s own pack when there are no roommates', () => {
    expect(router).toContain('roommates.length\n      ? withRoommateCategories(profileIntentPack, roommates)\n      : profileIntentPack');
  });
});

describe('every failure leaves the turn here', () => {
  it('returns no roommates on an unreadable or refused roster', () => {
    expect(resolver).toContain('if (size.unknown || size.refused) return { roommates: [] };');
  });

  it('returns no roommates when this assistant is alone among the bots', () => {
    expect(resolver).toMatch(/botArnsInRoom\.filter\(\(a\) => a !== selfBotArn\)\.length === 0\) return \{ roommates: \[\], roster \};/);
  });

  it('wraps the whole resolution, so no routing failure throws into the reply path', () => {
    expect(resolver).toMatch(/catch \(err\) \{[\s\S]*return \{ roommates: \[\], roster \};/);
  });

  it('answers here when the decision is to keep the turn, or the dispatch fails', () => {
    expect(actor).toContain("if (decision.kind === 'keep') return null;");
    expect(actor).toContain('if (!handedOver) return null;');
  });
});

describe('a handover cannot cycle, which is a cost control before it is a correctness one', () => {
  it('reads the trigger that already travels, rather than a new depth field', () => {
    // Structural rather than a counter: only a turn that did not arrive by handover may create one, so
    // every chain caps at one hop with no depth to pass and no two components agreeing on a number.
    const guard = router.slice(at('function arrivedByHandover('), at('function arrivedByHandover(') + 400);
    expect(guard).toContain('BYPASS_TRIGGER_ATTR');
    expect(guard).toContain("=== 'handover'");
  });

  it('counts a TASK handover as an arrival too, so the cycle has no second door', () => {
    // One check covers both producers because both set the same trigger. Scoped to the guard's own body:
    // a window wide enough to reach the next function would read that function's words instead.
    const start = at('function arrivedByHandover(');
    const body = router.slice(start, router.indexOf('\n}', start) + 2);
    expect(body).not.toContain('roommate');
    expect(body).not.toContain('delegate');
    // Both producers now POST a handover message (kind 'capability' and kind 'task') and the router never
    // builds a handed-over turn itself; the flow and the post-processing backstop do, and both set the
    // same trigger, so the single check covers both arrivals.
    expect(router).toContain("kind: 'capability'");
    expect(router).toContain("kind: 'task'");
    const flow = fs.readFileSync(path.join(__dirname, '../lambda/src/channel-flow-processor.ts'), 'utf8');
    const backstop = fs.readFileSync(path.join(__dirname, '../lambda/src/lib/handover-backstop.ts'), 'utf8');
    expect(flow).toContain("trigger: 'handover' as const, handoverMessageId");
    expect(backstop).toContain("trigger: 'handover'");
  });

  it('gates the TASK handover on any arrival by handover, so a capability-handed turn cannot hand over again', () => {
    expect(router).toContain('!handedOverFrom(event) && !arrivedByHandover(event)');
  });

  it('claims the inbound message BEFORE dispatching, so a redelivery buys no second model turn', () => {
    // Delivery is at-least-once, so a redelivered message arrives as a fresh turn the chain bound cannot
    // see. Without this the person gets two answers and the deployment pays for both.
    const claimAt = actor.indexOf('claimCorrelation(`delegate-');
    const dispatchAt = actor.indexOf('await dispatchTurnToRoommate({');
    expect(claimAt).toBeGreaterThan(-1);
    expect(claimAt).toBeLessThan(dispatchAt);
  });

  it('derives the key through the shared resolver, not a raw attribute read', () => {
    // ORDERING IS NOT DERIVATION, and this is the half that was once wrong: the claim read
    // `CHIME.message.id` directly, which Amazon Chime SDK never sends Lex, so the key was blank, the
    // `if (inboundForDedup && ...)` guard skipped, and the claim was inert on every entry. It sat in
    // exactly the right place and protected nothing.
    expect(actor).toContain('inboundMessageId(args.event)');
    expect(actor).not.toContain("'CHIME.message.id'");
    expect(actor).not.toContain('AE.message.id');
  });

  it('stays silent on a duplicate rather than acknowledging it twice', () => {
    expect(actor).toMatch(/already been handed over[\s\S]{0,300}?formatLexSilentResponse/);
  });
});

describe('THE KEY THE CLAIM IS MADE ON, resolved rather than read about', () => {
  /**
   * A dedup key that comes out blank does not fail, it SKIPS - `if (inboundForDedup && ...)` falls
   * straight through - so the claim sits in the right place, logs nothing, and protects nothing. That
   * is the shape this once had, and no amount of ordering assertion could see it: the only test that
   * catches it is one that looks at the value the resolver returns for each entry's attributes.
   *
   * Which is why `inboundMessageId` is exported. These call it.
   */
  const attrs = (requestAttributes: Record<string, string>) => ({ requestAttributes } as never);

  it('resolves the id on a flow-entry turn, which is the entry the question arrives on', () => {
    // THE CASE THE OLD CODE MISSED. The turn that decides a handover is the person's own message, which
    // reaches the router as a channel-flow bypass carrying `AE.message.id`. Amazon Chime SDK sends Lex
    // only the channel, the sender and the platform - never a message id - so a resolver reading
    // `CHIME.message.id` alone returns undefined on every message that could be handed over.
    expect(inboundMessageId(attrs({
      'AE.entry': 'channel-flow',
      'CHIME.channel.arn': 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c',
      'AE.message.id': 'flow-message-1',
    }))).toBe('flow-message-1');
  });

  it('still resolves the Lex form, so reading both is not a swap', () => {
    expect(inboundMessageId(attrs({ 'CHIME.message.id': 'lex-message-1' }))).toBe('lex-message-1');
  });

  it('gives the SAME key for the same message from either entry, so a redelivery collides', () => {
    // Two deliveries of one message may arrive by different entries. A key that differed by entry would
    // claim twice and dispatch twice, which is the cost this guard exists to bound.
    expect(inboundMessageId(attrs({ 'AE.message.id': 'm-9' })))
      .toBe(inboundMessageId(attrs({ 'CHIME.message.id': 'm-9' })));
  });

  it('is undefined when no entry declares one, which skips the claim rather than claiming ""', () => {
    // FAILING OPEN IS THE CHOICE HERE, recorded so it is not mistaken for this bug returning: a dedup
    // table that cannot answer must not swallow a person's question. A blank key would otherwise collide
    // with every other blank one and silence the second question asked in the deployment.
    expect(inboundMessageId(attrs({ 'AE.entry': 'channel-flow' }))).toBeUndefined();
    expect(inboundMessageId(attrs({ 'AE.message.id': '' }))).toBeUndefined();
  });

  it('is fed by the bypass builder, so the two halves meet', () => {
    // The resolver reading an attribute nothing sets would pass every test above and still be blank in
    // the deployment.
    const builder = router.slice(
      at('function bypassToLexEvent('),
      at('function bypassToLexEvent(') + 2000,
    );
    expect(builder).toContain('[BYPASS_MESSAGE_ID_ATTR]: req.userMessageId');
  });
});

describe('the person is told where their question went', () => {
  it('answers with an acknowledgement naming the assistant, rather than going quiet', () => {
    // A person who asked one assistant and is answered by another cannot tell a handover from a bug, and
    // the one they addressed going quiet is the part that reads as broken.
    expect(actor).toContain('handedToRoommateAcknowledgement(decision.roommate.advertisement.displayName, args.words)');
  });

  it('names the DISPLAY name, never the internal handle', () => {
    expect(actor).not.toContain('handedToRoommateAcknowledgement(decision.roommate.assistant)');
    const copy = router.slice(at('function handedToRoommateAcknowledgement('), at('function handedToRoommateAcknowledgement(') + 400);
    expect(copy).toContain('assistantDisplayName');
  });

  it('uses its own copy rather than the task handover\'s', () => {
    // The two are different events: that one answers work already under way, this is a fresh question that
    // belongs to somebody else. Telling a person their message continued a chain that does not exist would
    // be worse than saying nothing.
    const copy = router.slice(at('function handedToRoommateAcknowledgement('), at('function handedToRoommateAcknowledgement(') + 400);
    expect(copy).not.toContain('that answers work');
    // Each is its own message template (ADR-062), so rewording one never rewords the other.
    expect(copy).toContain("'handed-to-roommate'");
    expect(copy).not.toContain("'handover-receipt'");
  });
});

describe('the hand-over is a message carrying a reference, never an invoke and never the question', () => {
  it('posts a handover referencing the person\'s message and sender - never the text', () => {
    expect(dispatch).toContain('channelArn: args.channelArn');
    expect(dispatch).toContain('inboundMessageId(args.event)');
    expect(dispatch).toContain('personMessageId: inboundId');
    expect(dispatch).toContain('personSenderArn');
    // The capability sender ONLY, not the shared poster below it, which carries a task handover's words.
    const capability = router.slice(at('async function dispatchTurnToRoommate('), at('async function postHandover('));
    expect(capability).not.toContain('personText');
    expect(capability).not.toContain('inputTranscript');
  });

  it('addresses the roommate by Target, and starts no turn itself', () => {
    expect(dispatch).toContain('botArn: args.roommate.botArn');
    expect(dispatch).toContain('Target: [{ MemberArn: args.receiver.botArn }]');
    // THE CLOSED DOOR: neither sender invokes a Lambda. An assistant reaches another only through a
    // stored conversation message, which the receiver verifies before it acts.
    const taskStart = at('async function handOverToOwningAssistant(');
    const task = router.slice(taskStart, router.indexOf('\n}\n', taskStart));
    for (const body of [dispatch, task]) {
      expect(body).not.toContain('InvokeCommand');
      expect(body).not.toContain('AWS_LAMBDA_FUNCTION_NAME');
    }
  });

  it('hands back the receiver\'s own advertised key so it does not classify an empty transcript', () => {
    expect(dispatch).toContain('intent: args.intentKey');
  });

  it('refuses a handed-over turn the conversation does not back with a verified handover message', () => {
    const gate = router.slice(
      at('A HANDED-OVER TURN STARTS ONLY FROM A REAL HANDOVER MESSAGE'),
      at('A HANDED-OVER TURN RESOLVES THE MESSAGE ITSELF'),
    );
    expect(gate).toContain('verifyHandover(');
    expect(gate).toContain('return formatLexSilentResponse(event)');
    const verifyStart = at('async function verifyHandover(');
    const verify = router.slice(verifyStart, router.indexOf('\n}\n', verifyStart));
    for (const check of [
      "'not-a-handover'", "'references-another-message'", "'sender-not-another-assistant'",
      "'not-targeted-at-this-assistant'", "'sender-not-sanctioned-in-this-classification'",
    ]) {
      expect(verify).toContain(check);
    }
  });
});

describe('the receiver resolves what it was asked', () => {
  it('reads the referenced message by id as its own bearer', () => {
    // The whole point of carrying a reference: the boundary is what this assistant may read, not what the
    // sender chose to repeat. Without it the specialist answered "your message came through empty".
    expect(router).toContain('await readMessageText(channelArn, referencedId, botArn)');
    const reader = router.slice(at('async function readMessageText('), at('async function readMessageText(') + 1200);
    expect(reader).toContain('GetChannelMessageCommand');
    expect(reader).toContain('ChimeBearer: bearerArn');
    expect(reader).toMatch(/catch[\s\S]{0,300}return '';/);
  });

  it('SAYS SO when it cannot resolve what it was handed, rather than going quiet', () => {
    // THE WINDOW THIS CLOSES. The sender answered "I have passed it along, and their reply will follow
    // here" and returned before the turn claim, and the dispatch is fire-and-forget - so a receiver that
    // cannot resolve the reference and says nothing leaves a person promised a reply that never comes.
    // That is worse than the silence the promise replaced, because the room shows a handover that looks
    // successful and a question never answered again.
    const guardAt = router.indexOf('if (!userMessage && arrivedByHandover(event))');
    expect(guardAt).toBeGreaterThan(-1);
    const block = router.slice(guardAt, guardAt + 1400);
    // It speaks rather than throwing: an async invoke's exception is retried and then dropped, with
    // nobody in the room told either time.
    expect(block).toContain('formatLexResponse(event');
    expect(block).not.toContain('throw');
    // And it runs AFTER the attempt to resolve, or it would fire on every handover.
    expect(router.indexOf('await readMessageText(channelArn, referencedId, botArn)')).toBeLessThan(guardAt);
  });

  it('cannot fire on an ordinary turn, only on a handed-over one', () => {
    // A direct Lex turn always carries its text, so the empty-transcript branch is unreachable there - but
    // the `arrivedByHandover` half is what guarantees it rather than the emptiness alone.
    const guardAt = router.indexOf('if (!userMessage && arrivedByHandover(event))');
    expect(router.slice(guardAt, guardAt + 60)).toContain('arrivedByHandover(event)');
  });

  it('never hands the string "undefined" to a turn as a person\'s message', () => {
    // `encodeURIComponent(undefined)` is the four-character word, which satisfied every downstream check
    // that tests for a non-empty string.
    expect(router).toContain('encodeURIComponent(req.userMessage ?? \'\')');
  });
});
