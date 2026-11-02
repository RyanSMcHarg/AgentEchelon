/**
 * A TURN AN EVENT RUN HANDS TO THE PROCESSOR IS KEYED BY ITS EVENT, AND A FANNED-OUT SEND BY ITS GROUP (ADR-061 decision 5,
 * ADR-062 decision 4).
 *
 * The router records a turn's routing under its correlation id before it invokes the processor, so two turns that share
 * an id share one routing record. What it proves:
 *  - an agent step's id names the event, so `invitation-sent` and `invitation-unredeemed`, which share an invitation's
 *    natural key, and `assistant-joined` and `conversation-opened`, which share a room's, are two turns;
 *  - a `voice` send's id names the event and the template group, so a `fromRole: template` send that says one template
 *    to each group of people hands each group its own turn;
 *  - an id longer than the routing table's 120 characters keeps a digest of every part, and a hyphen inside a part never
 *    merges two ids.
 */
import * as fs from 'fs';
import * as path from 'path';
import { EVENT_DISPATCH_ID_MAX, eventDispatchId } from '../../lambda/src/lib/event-dispatch-id';
import { conversationKey, eventNaturalKey } from '../../lambda/src/lib/event-workflow';

const router = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'router-agent-handler.ts'), 'utf8');
const APP = 'arn:aws:chime:us-east-1:1:app-instance/ai';
const CHANNEL = `${APP}/channel/ch-1`;
const ID = '0b7f2a52-0000-4000-8000-000000000001';

describe('an agent step\'s turn is keyed by its event', () => {
  it('the two events of one invitation are two turns', () => {
    const sent = eventDispatchId('event', ['invitation-sent', eventNaturalKey('invitation-sent', CHANNEL, undefined, ID), 'look', 'bot-1']);
    const unredeemed = eventDispatchId('event', ['invitation-unredeemed', eventNaturalKey('invitation-unredeemed', CHANNEL, undefined, ID), 'look', 'bot-1']);
    expect(eventNaturalKey('invitation-sent', CHANNEL, undefined, ID)).toBe(eventNaturalKey('invitation-unredeemed', CHANNEL, undefined, ID));
    expect(sent).not.toBe(unredeemed);
  });

  it('a room\'s assistant-joined and conversation-opened are two turns', () => {
    const joined = eventDispatchId('event', ['assistant-joined', conversationKey(CHANNEL), 'look', 'bot-1']);
    const opened = eventDispatchId('event', ['conversation-opened', conversationKey(CHANNEL), 'look', 'bot-1']);
    expect(joined).not.toBe(opened);
  });

  it('the router keys the agent step\'s dispatch by the event', () => {
    const fn = router.slice(router.indexOf('async function dispatchEventAgentStep('), router.indexOf('export interface EventNaming'));
    expect(fn).toMatch(/correlationId: eventDispatchId\('event', \[args\.event, eventNaturalKey\(/);
  });
});

describe('a voice send\'s turn is keyed by its event and its template group', () => {
  const runKey = `invitation-sent#invitation-${ID}#advisor`;
  const id = (event: string, template: string) => eventDispatchId('voice', [event, runKey.split('#').slice(1, -1).join('-'), 'tell', template, 'bot-1']);

  it('each group a fromRole: template send fans out to is its own turn', () => {
    expect(id('invitation-sent', 'lead-brief')).not.toBe(id('invitation-sent', 'responder-brief'));
  });

  it('two events sharing a natural key are two turns', () => {
    expect(id('invitation-sent', 'm')).not.toBe(id('invitation-unredeemed', 'm'));
  });

  it('the router keys the voice dispatch by the event and the template', () => {
    const fn = router.slice(router.indexOf('async function dispatchVoiceSend('), router.indexOf('async function stepTaker('));
    expect(fn).toMatch(/correlationId: eventDispatchId\('voice', \[args\.event, [^\]]*args\.step, args\.template, botIdFromArn\(args\.botArn\)\]\)/);
  });
});

describe('an id stays within the routing table and never merges two', () => {
  it('a long id is cut to the maximum and still tells its parts apart', () => {
    const long = 'x'.repeat(200);
    const a = eventDispatchId('event', ['person-joined', long, 'step-a', 'bot']);
    const b = eventDispatchId('event', ['person-joined', long, 'step-b', 'bot']);
    expect(a.length).toBeLessThanOrEqual(EVENT_DISPATCH_ID_MAX);
    expect(b.length).toBeLessThanOrEqual(EVENT_DISPATCH_ID_MAX);
    expect(a).not.toBe(b);
  });

  it('a hyphen inside a part does not merge two ids that read the same', () => {
    expect(eventDispatchId('voice', ['e', 'k', 'a-b', 'c', 'bot'])).not.toBe(eventDispatchId('voice', ['e', 'k', 'a', 'b-c', 'bot']));
  });

  it('the same parts are the same id, so a redelivered dispatch collapses on the processor\'s claim', () => {
    expect(eventDispatchId('event', ['assistant-joined', 'ch-1', 'look', 'bot'])).toBe(eventDispatchId('event', ['assistant-joined', 'ch-1', 'look', 'bot']));
  });
});
