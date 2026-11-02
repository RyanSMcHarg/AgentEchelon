/**
 * A DISPATCHED TURN CARRIES WHAT IT ANSWERS, AND RECONSTRUCTS NOTHING (ADR-043, "What this owes" 1 and 2).
 *
 * The channel flow hands the router the inbound message id on every dispatch; the router declares it as
 * `AE.message.id`; the processor stamps it as `answersMessageId`. A turn Amazon Lex invokes natively
 * has no id and must find its message by matching text in the channel (`findInboundMessage`). These pin
 * both halves: every dispatch site sets the id, and a turn that carries one never pays for the search.
 */
const mockFind = jest.fn(async () => ({ messageId: 'found-by-search' }));
jest.mock('../lambda/src/lib/inbound-message', () => ({
  ...jest.requireActual('../lambda/src/lib/inbound-message'),
  findInboundMessage: (...a: unknown[]) => mockFind(...(a as [])),
}));

import * as fs from 'fs';
import * as path from 'path';
import { resolveOriginatingMessage } from '../lambda/src/lib/live-drift-flow';

const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'lambda', 'src', rel), 'utf8');
const ARGS = {
  channelArn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1',
  senderArn: 'arn:aws:chime:us-east-1:1:app-instance/i/user/u1',
  botArn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/b1',
  userMessage: 'what is the error rate',
};

beforeEach(() => mockFind.mockClear());

describe('a carried turn reconstructs nothing', () => {
  it('answers from the declared id and targeting, with no channel search', async () => {
    const out = await resolveOriginatingMessage({
      ...ARGS, event: { requestAttributes: { 'AE.message.id': 'm-carried', 'AE.turn.targeted': '1' } } as never,
    });
    expect(out).toEqual({ messageId: 'm-carried', targeted: true });
    const open = await resolveOriginatingMessage({
      ...ARGS, event: { requestAttributes: { 'AE.message.id': 'm-open', 'AE.turn.targeted': '0' } } as never,
    });
    expect(open).toEqual({ messageId: 'm-open', targeted: false });
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('searches only for a turn that arrived with no id, which is a natively invoked Lex turn', async () => {
    const out = await resolveOriginatingMessage({ ...ARGS, event: { requestAttributes: {} } as never });
    expect(out.messageId).toBe('found-by-search');
    expect(mockFind).toHaveBeenCalledTimes(1);
  });

  it('the router and the processor both take the carried id before any search (source)', () => {
    const router = src('router-agent-handler.ts');
    const lookup = router.slice(router.indexOf('const inboundMessage = ()'), router.indexOf('const inboundMessage = ()') + 400);
    expect(lookup).toContain('resolveOriginatingMessage({');
    expect(router).not.toMatch(/findInboundMessage\(/);
    expect(src('assistant-async-processor.ts')).toMatch(/const messageId = event\.userMessageId\s*\|\| \(await findInboundMessage\(/);
  });
});

describe('every dispatch site carries the id', () => {
  const flow = src('channel-flow-processor.ts');

  it('the dispatch type requires it', () => {
    const params = flow.slice(flow.indexOf('interface RouterTurnParams'), flow.indexOf('async function handOffTurnToRouter'));
    expect(params).toMatch(/^\s*messageId: string;$/m);
    expect(params).not.toMatch(/^\s*messageId\?: string;$/m);
  });

  it('the hand-off puts it on the turn, and every call names it', () => {
    expect(flow).toMatch(/const aeTurn: TurnRequest = \{[\s\S]{0,200}userMessageId: messageId,/);
    const calls: string[] = [];
    for (let at = flow.indexOf('await handOffTurnToRouter({'); at >= 0; at = flow.indexOf('await handOffTurnToRouter({', at + 1)) {
      calls.push(flow.slice(at, flow.indexOf('\n    });', at) + 8));
    }
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const call of calls) expect({ call: call.slice(0, 60), carries: /\bmessageId: /.test(call) }).toEqual({ call: call.slice(0, 60), carries: true });
  });

  it('each duel side carries the message that started the duel', () => {
    const fanOut = flow.slice(flow.indexOf('reply = await invokeRouterTurn(battleRouterArn, {'));
    expect(fanOut.slice(0, 600)).toMatch(/\buserMessageId,/);
  });
});

describe('a turn\'s classification is the answering assistant\'s (ADR-043 decision 3)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { defaultProfileRegistry: profiles } = require('../lib/profile-registry');

  it('resolves a primary and a role\'s assistant alike, and nothing for an undeclared name', () => {
    expect(profiles.classificationOfAssistant('advisor')).toBe('premium');
    expect(profiles.classificationOfAssistant(profiles.roleAssistantName('premium', 'ops'))).toBe('premium');
    expect(profiles.roleAssistantName('premium', 'ops')).toBe('ops-premium');
    expect(profiles.classificationOfAssistant('nobody-declared-this')).toBeUndefined();
    expect(profiles.classificationOfAssistant('')).toBeUndefined();
  });

  it('the archival boundary check and the profile lifecycle read it, and the stack names assistants by it (source)', () => {
    expect(src('analytics-aurora/kinesis-archival.ts')).toContain('profiles.classificationOfAssistant(r.assistant)');
    expect(src('lib/profile-lifecycle.ts')).toContain('defaultProfileRegistry.classificationOfAssistant(profileName)');
    const stack = fs.readFileSync(path.join(__dirname, '..', 'lib', 'stacks', 'assistant-profile-stack.ts'), 'utf8');
    expect(stack).not.toContain('`${role}-${classification}`');
    expect(stack).toContain('defaultProfileRegistry.roleAssistantName(classification, role)');
  });
});
