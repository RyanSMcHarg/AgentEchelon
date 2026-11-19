/**
 * A PROCESSOR RUN CARD STAYS WITHIN THE METADATA CAP (SPEC-MESSAGE-METADATA-CODEBOOK; the 32-step bound of SPEC-WORKFLOWS-AND-TASKS WT129).
 *
 * What it proves: the run messages the processor sends (an agent step's reply and a voiced send) hold their Amazon Chime
 * SDK Metadata within the service's 1024-character cap through the same guard the router's run sends use, so a run at the
 * step bound sheds its oldest moves and its message is still sent, keeping its newest move and every other field. The
 * router's run cards are held the same way, the intake's offer, the welcome's opening and a moved subject's notice among them.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { withinMetadataCap } from '../../lambda/src/lib/notify-directive';
import { CHIME_METADATA_MAX } from '../../lambda/src/lib/chime/send';
import { MAX_EVENT_RUN_STEPS } from '../../lambda/src/lib/event-workflow';
import { botMessageMetadata } from '../../lambda/src/lib/bot-message-attribution';

const size = (m: Record<string, unknown>) => encodeURIComponent(JSON.stringify(m)).length;
const processor = readFileSync(resolve(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');
const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');

/** The agent step's card as the processor writes it, at field bounds that are realistic for a long run. */
function card(moves: number): Record<string, unknown> {
  return {
    botResponse: true, respPhase: 'final', agentType: 'ops-premium', turnKind: 'event_step',
    eventStep: { workflow: 'ops-room', step: 'post-incident-review', event: 'conversation-opened', outcome: 'posted' },
    totalMs: 41234, trigger: 'event_step', triggerAtMs: 1763290000000, entry: 'event_step',
    eventRun: {
      runKey: 'conversation-opened#chan-0123456789abcdef0123456789abcdef#ops-premium',
      transitions: Array.from({ length: moves }, (_, i) => ({ step: `runbook-step-${String(i).padStart(2, '0')}`, outcome: 'success' })),
      originConfigId: 'cfg-0123456789ab', workflowHash: 'a1b2c3d4e5f6', trigger: 'event',
    },
    targetedSender: 'arn:aws:chime:us-east-1:111122223333:app-instance/ai/user/oncall-0123',
  };
}

describe('a run at the step bound', () => {
  it('is over the cap before the guard, and within it after', () => {
    const long = card(MAX_EVENT_RUN_STEPS);
    expect(size(long)).toBeGreaterThan(CHIME_METADATA_MAX);
    const held = withinMetadataCap(long, CHIME_METADATA_MAX);
    expect(size(held)).toBeLessThanOrEqual(CHIME_METADATA_MAX);
  });

  it('keeps its newest move and every other field', () => {
    const long = card(MAX_EVENT_RUN_STEPS);
    const held = withinMetadataCap(long, CHIME_METADATA_MAX) as { eventRun: { transitions: Array<{ step: string }> } } & Record<string, unknown>;
    const moves = held.eventRun.transitions;
    expect(moves.length).toBeGreaterThanOrEqual(1);
    expect(moves[moves.length - 1].step).toBe(`runbook-step-${String(MAX_EVENT_RUN_STEPS - 1).padStart(2, '0')}`);
    const { eventRun: _a, ...rest } = held;
    const { eventRun: _b, ...was } = long;
    expect(rest).toEqual(was);
  });
});

describe('the processor holds both of its run cards to the cap', () => {
  it('the agent step\'s reply and the voiced send', () => {
    expect(processor.match(/Metadata: JSON\.stringify\(withinMetadataCap\(\{/g)?.length).toBe(2);
    expect(processor.match(/\}, CHIME_METADATA_MAX\)\),/g)?.length).toBe(2);
    // Every processor Metadata that carries a run card is one of the two.
    const cards = processor.match(/eventRun: \{/g)?.length;
    expect(cards).toBe(2);
  });
});

describe('the router holds its intake offer, welcome opening and moved-subject notice to the cap', () => {
  const moves = (n: number) => Array.from({ length: n }, (_, i) => ({ step: `runbook-step-${String(i).padStart(2, '0')}`, outcome: 'task:success:acknowledged' }));
  const person = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai/user/oncall-0123456789abcdef';
  const runKey = 'conversation-opened#chan-0123456789abcdef0123456789abcdef#ops-premium';
  /** Each card as the router builds it, at the step bound. */
  const cards: Record<string, (n: number) => Record<string, unknown>> = {
    'the intake offer': (n) => ({
      ...JSON.parse(botMessageMetadata({ agentType: 'ops-premium', classification: 'premium', turnKind: 'notification' }, { targetedSender: person })),
      eventStep: { workflow: 'opening-and-subject', step: 'intake', event: 'assistant-joined', outcome: 'posted' },
      eventRun: { runKey, transitions: moves(n) },
    }),
    'the welcome opening': (n) => JSON.parse(botMessageMetadata({ agentType: 'ops-premium', classification: 'premium' }, {
      turnKind: 'welcome',
      eventStep: { workflow: 'welcome', step: 'opening', event: 'assistant-joined', outcome: 'posted' },
      eventRun: { runKey, transitions: moves(n) },
    })),
    'the moved subject\'s notice': (n) => ({
      ...JSON.parse(botMessageMetadata({ agentType: 'ops-premium', classification: 'premium', turnKind: 'notification' }, { targetedSender: person })),
      eventStep: { workflow: 'drift', step: 'move', event: 'subject-changed', outcome: 'opened' },
      eventRun: { runKey, transitions: moves(n), originConfigId: 'cfg-0123456789ab', workflowHash: 'a1b2c3d4e5f6', trigger: 'event' },
    }),
  };

  it.each(Object.keys(cards))('%s at the step bound is over the cap before the guard, and within it after, keeping its newest move', (name) => {
    const long = cards[name](MAX_EVENT_RUN_STEPS);
    expect(size(long)).toBeGreaterThan(CHIME_METADATA_MAX);
    const held = withinMetadataCap(long, CHIME_METADATA_MAX) as { eventRun: { transitions: Array<{ step: string }> } } & Record<string, unknown>;
    expect(size(held)).toBeLessThanOrEqual(CHIME_METADATA_MAX);
    const kept = held.eventRun.transitions;
    expect(kept[kept.length - 1].step).toBe(`runbook-step-${String(MAX_EVENT_RUN_STEPS - 1).padStart(2, '0')}`);
    const { eventRun: _a, ...rest } = held;
    const { eventRun: _b, ...was } = long;
    expect(rest).toEqual(was);
  });

  it.each(Object.keys(cards))('%s within the cap is sent as it is', (name) => {
    const short = cards[name](2);
    expect(size(short)).toBeLessThanOrEqual(CHIME_METADATA_MAX);
    expect(withinMetadataCap(short, CHIME_METADATA_MAX)).toEqual(short);
  });

  it.each([
    ['offerIntakeStep', 'async function postWelcomeOpening('],
    ['postWelcomeOpening', 'export function taskStepDeadline('],
    ['openMovedSubject', 'async function offerAnswerOf('],
  ])('%s sends its card through the guard', (fn, next) => {
    const at = router.indexOf(`async function ${fn}(`);
    expect(at).toBeGreaterThan(-1);
    const body = router.slice(at, router.indexOf(next, at));
    expect(body).toMatch(/Metadata: JSON\.stringify\(withinMetadataCap\(/);
    expect(body).toMatch(/[})], CHIME_METADATA_MAX\)\),/);
    expect(body.split('eventRun: {').length - 1).toBe(1);
  });

  it('every router Metadata that carries a run card goes through the guard', () => {
    const sites = router.split('eventRun: {').length - 1;
    expect(sites).toBe(4);
    // Three are the cards above, and the run's own send builds its card first and holds it on the send (`sayWorkflowSend`).
    expect(router).toContain('Metadata: JSON.stringify(withinMetadataCap(metadata, CHIME_METADATA_MAX)),');
  });
});
