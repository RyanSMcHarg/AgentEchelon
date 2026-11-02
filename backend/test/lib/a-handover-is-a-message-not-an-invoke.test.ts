/**
 * AN ASSISTANT HANDS A PERSON'S MESSAGE TO ANOTHER WITH A MESSAGE, AND THE BOUNDS HOLD ON THE DATA
 * (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.4).
 *
 * The router no longer starts another assistant's turn by invoking itself. It posts a handover targeted at
 * the receiver; the channel flow routes it from the token, post-processing routes one the flow could not,
 * and the receiver verifies it again. These tests drive the shared routing function both callers use, so
 * each bound is asserted once against the code that enforces it:
 *  - a person cannot post a handover (the sender is stamped by Amazon Chime SDK);
 *  - the token is the hint and the stored Target the fact;
 *  - one hop, by data: only a PERSON's message may be handed over;
 *  - one delivery per (person message, receiver), shared by the flow and the backstop;
 *  - text that merely starts with `.Name` is never routed without the marker.
 */
import { routeHandover, type HandoverRoutingDeps, type HandoverDispatch } from '../../lambda/src/lib/handover-routing';
import {
  handoverContent, handoverMetadata, handoverCarriedText, parseHandover, deliveryClaimKey,
} from '../../lambda/src/lib/assistant-handover';

const APP = 'arn:aws:chime:us-east-1:111:app-instance/i';
const CH = `${APP}/channel/c1`;
const ADVISOR = `${APP}/bot/advisor`;
const OPS = `${APP}/bot/ops`;
const PERSON = `${APP}/user/p1`;
const MEMBERS = [
  { arn: ADVISOR, name: 'Advisor', isBot: true },
  { arn: OPS, name: 'Ops', isBot: true },
  { arn: PERSON, name: 'Priya', isBot: false },
];
const MARKER = { personMessageId: 'm-person', personSenderArn: PERSON, kind: 'capability' as const, intent: 'deployment_health' };

function deps(over: Partial<{ handoverTarget: string[]; personSender: string; personTarget: string[]; claimed: Set<string> }> = {}) {
  const claimed = over.claimed ?? new Set<string>();
  const dispatched: HandoverDispatch[] = [];
  const d: HandoverRoutingDeps = {
    readMessage: async (_ch, id) => id === 'h-1'
      ? { Sender: { Arn: ADVISOR }, Target: (over.handoverTarget ?? [OPS]).map((a) => ({ MemberArn: a })) }
      : id === 'm-person'
        ? { Sender: { Arn: over.personSender ?? PERSON }, Target: (over.personTarget ?? []).map((a) => ({ MemberArn: a })) }
        : null,
    listMembers: async () => MEMBERS,
    claim: async (k) => { if (claimed.has(k)) return false; claimed.add(k); return true; },
    dispatch: async (t) => { dispatched.push(t); return true; },
  };
  return { d, dispatched, claimed };
}

const flowInput = (over: Partial<{ senderArn: string; content: string; metadata: string | undefined }> = {}) => ({
  source: 'flow' as const,
  channelArn: CH,
  handoverMessageId: 'h-1',
  senderArn: over.senderArn ?? ADVISOR,
  content: over.content ?? handoverContent({ name: 'Ops', botArn: OPS }),
  metadata: 'metadata' in over ? over.metadata : handoverMetadata(MARKER),
});

beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

describe('the channel flow routes a handover from its token, and the data decides', () => {
  it('dispatches the named assistant when the stored Target agrees and the reference is a person\'s', async () => {
    const { d, dispatched } = deps();
    expect(await routeHandover(flowInput(), d)).toBe('dispatched');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ receiverBotArn: OPS, handoverMessageId: 'h-1', privateToPerson: false });
    expect(dispatched[0].marker.personSenderArn).toBe(PERSON);
  });

  it('answers privately when the person\'s own message was private', async () => {
    const { d, dispatched } = deps({ personTarget: [ADVISOR] });
    await routeHandover(flowInput(), d);
    expect(dispatched[0].privateToPerson).toBe(true);
  });

  it('refuses a handover a PERSON posted: the sender is stamped by Amazon Chime SDK, not claimed', async () => {
    const { d, dispatched } = deps();
    expect(await routeHandover(flowInput({ senderArn: PERSON }), d)).toBe('not-from-an-assistant');
    expect(dispatched).toHaveLength(0);
  });

  it('never routes text that only LOOKS like a handover: no marker, no route', async () => {
    const { d, dispatched } = deps();
    expect(await routeHandover(flowInput({ metadata: undefined, content: '.<Ops|ops> how are throttles?' }), d)).toBe('not-a-handover');
    expect(dispatched).toHaveLength(0);
  });

  it('does not dispatch on the token alone when the stored Target names someone else', async () => {
    const { d, dispatched } = deps({ handoverTarget: [ADVISOR] });
    expect(await routeHandover(flowInput(), d)).toBe('target-mismatch');
    expect(dispatched).toHaveLength(0);
  });

  it('ONE HOP, BY DATA: an assistant\'s own message can never be handed on', async () => {
    const { d, dispatched } = deps({ personSender: OPS });
    expect(await routeHandover(flowInput(), d)).toBe('references-a-non-person');
    expect(dispatched).toHaveLength(0);
  });

  it('delivers once per person message and receiver, however many times it is seen', async () => {
    const shared = deps();
    await routeHandover(flowInput(), shared.d);
    expect(await routeHandover(flowInput(), shared.d)).toBe('already-delivered');
    expect(shared.dispatched).toHaveLength(1);
    expect(shared.claimed.has(deliveryClaimKey('m-person', OPS))).toBe(true);
  });
});

describe('the post-processing backstop delivers by the stored Target', () => {
  it('dispatches the assistant actually targeted, privately, when the flow could not route it', async () => {
    const { d, dispatched } = deps();
    const outcome = await routeHandover({
      source: 'backstop', channelArn: CH, handoverMessageId: 'h-1', senderArn: ADVISOR, content: '',
      metadata: handoverMetadata(MARKER), streamTarget: [{ MemberArn: OPS }],
    }, d);
    expect(outcome).toBe('dispatched');
    expect(dispatched[0]).toMatchObject({ receiverBotArn: OPS, privateToPerson: true });
  });

  it('shares the flow\'s claim, so the two never deliver the same handover twice', async () => {
    const shared = deps();
    await routeHandover(flowInput(), shared.d);
    const outcome = await routeHandover({
      source: 'backstop', channelArn: CH, handoverMessageId: 'h-1', senderArn: ADVISOR, content: '',
      metadata: handoverMetadata(MARKER), streamTarget: [{ MemberArn: OPS }],
    }, shared.d);
    expect(outcome).toBe('already-delivered');
    expect(shared.dispatched).toHaveLength(1);
  });
});

describe('the marker and the body', () => {
  it('requires a person as the referenced sender, so a marker cannot point a handover at an assistant', () => {
    expect(parseHandover(handoverMetadata({ ...MARKER, personSenderArn: OPS }))).toBeNull();
    expect(parseHandover(handoverMetadata(MARKER))).toMatchObject({ personMessageId: 'm-person', kind: 'capability' });
  });

  it('addresses the receiver by id, so the name shown and the name that resolves cannot disagree', () => {
    expect(handoverContent({ name: 'Ops', botArn: OPS })).toMatch(/^\.<Ops\|ops> /);
  });

  it('carries a task handover\'s words and nothing for a capability handover', () => {
    expect(handoverCarriedText(handoverContent({ name: 'Ops', botArn: OPS }, 'the audience is leadership'))).toBe('the audience is leadership');
    expect(handoverCarriedText(handoverContent({ name: 'Ops', botArn: OPS }))).toBe('');
  });
});

describe('analytics counts a handover as itself, and the receiver measures from it', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path') as typeof import('path');
  const src = (p: string) => fs.readFileSync(path.join(__dirname, '../../lambda/src', p), 'utf8');
  const analytics = src('analytics-aurora/analytics-query.ts');
  const router = src('router-agent-handler.ts');

  it('reads a handover from its marker, once, counts it as a message and shows it as its own turn kind', () => {
    expect(analytics).toContain("COALESCE(${alias}.metadata, '{}'::jsonb) ? 'aeHandover'");
    expect(analytics).toContain("AS handover_count");
    // Counted in the totals, never subtracted from them.
    expect(analytics).not.toContain("NOT ${handoverSql(");
    expect(analytics).toContain("CASE WHEN ${handoverSql('m')} THEN 'handover' ELSE COALESCE(d.kind, 'answer') END AS turn_kind");
  });

  it('reports handovers sent, answered and the gap, from the archive and the turn ledger', () => {
    expect(analytics).toContain('handovers: { fn: getHandovers');
    expect(analytics).toContain("t.trigger_kind = 'handover'");
    expect(analytics).toContain('t.responder = h.targeted_to');
  });

  it('declares the HANDOVER as what the receiving turn answers, and keeps the person\'s message for everything else', () => {
    expect(router).toContain('const declaredAnswerId = (): string => handoverMessageIdForTurn || knownInboundMessageId;');
    // A join recap adds its own kind beside the entry (`recapKind`); what the turn answers is still the declared id.
    expect(router).toContain('{ answers: declaredAnswerId(), entry: turnEntry, ...recapKind }');
    expect(router).toContain('...(knownInboundMessageId ? { userMessageId: knownInboundMessageId } : {}),');
  });
});
