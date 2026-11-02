/**
 * EVERY MESSAGE A TASK-SHAPED DUEL SIDE WRITES RECORDS HOW ITS TURN ENTERED, AND ITS ANSWER RECORDS THE WORK.
 *
 * A `/battle` that asks for a report opens a task on each side (ADR-026). A side that first confirms the
 * requirements waits for the person, and the person's reply resumes that side's chain: the reply reaches
 * the side through Amazon Lex, whose placeholder is addressed to the person alone, so the side posts its
 * answer as a new public message and closes the private placeholder out as a receipt (ADR-029).
 *
 * Measured on dev through the signed path (2026-10-30): 2 of 137 turns read path "unknown" with intent
 * report_generation, outcome task and no task type, step or model source. Both were that receipt. The
 * turn wrote "Tidying the document before delivering it..." into the placeholder (respPhase progress)
 * before it closed it out, and the pairers took that narration as the placeholder's last word: the
 * receipt got an exchange beside its answer's, its round marker named it the side's answer, and the one
 * turn was counted twice, once with nothing recorded. The answer itself carried entry, task and model.
 *
 * WHAT THIS PINS, from the records the archive is handed:
 *   - the side's answer carries its entry, task type, task step and model source;
 *   - the side's Amazon Lex placeholder declares its entry, and the receipt it becomes says it on the close-out;
 *   - a narration is not the update a placeholder pairs on;
 *   - a declared receipt is named a receipt before its round, and the flow does not count it as a turn.
 */
const mockReadAnalytics = jest.fn();
jest.mock('../../lambda/src/lib/message-analytics', () => ({
  readMessageAnalytics: (...args: unknown[]) => mockReadAnalytics(...args),
  writeMessageAnalytics: jest.fn(async () => undefined),
}));
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  batchInsert: jest.fn(async () => 0),
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  transaction: jest.fn(),
  ensureSchema: jest.fn(),
  resetConnection: jest.fn(),
  isAuthError: jest.fn(() => false),
}));
jest.mock('../../lambda/src/analytics-aurora/drift-detection', () => ({
  detectDrift: jest.fn(),
  recordDriftFire: jest.fn(),
}));
jest.mock('../../lambda/src/analytics-aurora/cross-conversation-context', () => ({
  updateConversationContext: jest.fn(),
}));
jest.mock('../../lambda/src/lib/sleep-mode', () => ({
  touchActivity: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';
import { transformToMessageRecord, updateSaysWhatItBecame } from '../../lambda/src/analytics-aurora/kinesis-archival';
import { battlePlaceholderContent } from '../../lambda/src/lib/battle-turn';
import { closeOutAttribution } from '../../lambda/src/lib/turn-attribution';
import { RECEIPT_TURN_KIND } from '../../lambda/src/lib/turn-declaration';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
const flat = (s: string) => s.replace(/\s+/g, ' ');

const APP = 'arn:aws:chime:us-east-1:1:app-instance/i';
const CHANNEL = `${APP}/channel/conv-duel`;
const SIDE = `${APP}/bot/advisor`;
const PERSON = `${APP}/user/p-1`;

/** One stream event of the side, as Amazon Chime SDK archives it. */
const sideEvent = (args: {
  eventType: 'CREATE_CHANNEL_MESSAGE' | 'UPDATE_CHANNEL_MESSAGE'; messageId: string; content: string;
  metadata?: Record<string, unknown>; target?: string;
}) => ({
  EventType: args.eventType,
  Payload: {
    MessageId: args.messageId, ChannelArn: CHANNEL, Content: args.content,
    Sender: { Arn: SIDE, Name: 'Advisor' },
    CreatedTimestamp: '2026-10-30T16:54:51.450Z', LastUpdatedTimestamp: '2026-10-30T16:55:06.373Z',
    Persistence: 'PERSISTENT', Type: 'STANDARD',
    ...(args.target ? { Target: [{ MemberArn: args.target }] } : {}),
    ...(args.metadata ? { Metadata: JSON.stringify(args.metadata) } : {}),
  },
});

/** What the processor records out of band for a task-shaped side's answer (ADR-064 decision 4). */
const SIDE_ANALYTICS = {
  intent: 'report_generation', deliveryOption: 'TASK_MULTI_STEP', taskType: 'report_generation',
  turnStep: 'collecting_requirements', modelKind: 'text', modelFrom: 'route', bedrockModel: 'model-x',
};

beforeEach(() => {
  mockReadAnalytics.mockReset();
});

describe("a task-shaped duel side's answer records its path and its work", () => {
  it.each([
    ['the round-1 answer to the /battle message', 'flow'],
    ['the answer of a side the person resumed', 'lex'],
  ] as const)('%s carries entry, task type, task step and model source', async (_label, entry) => {
    mockReadAnalytics.mockResolvedValue({ ...SIDE_ANALYTICS, entry });
    const rec = await transformToMessageRecord(sideEvent({
      eventType: 'UPDATE_CHANNEL_MESSAGE', messageId: 'answer-1', content: 'The requirements, confirmed.',
      metadata: { battleId: 'b-1', battleRound: 1, assignmentMode: 'battle', entry, respPhase: 'final', answersMessageId: 'u-1' },
    }) as never);
    expect(rec).toMatchObject({
      turn_entry: entry, task_type: 'report_generation', task_step: 'collecting_requirements', model_from: 'route',
    });
  });
});

describe('the placeholder a resumed side closes out as a receipt records the same path', () => {
  it("declares the entry on the side's Amazon Lex placeholder, which carries no analytics of its own", async () => {
    mockReadAnalytics.mockResolvedValue(null);
    const content = battlePlaceholderContent({
      correlationId: 'c0af770555f57980', battleId: 'b-1', round: 1, totalRounds: 2, rivalBotArn: '__round1__',
      displayName: 'Advisor', lead: 'Understanding your report needs...', entry: 'lex',
    });
    const rec = await transformToMessageRecord(sideEvent({
      eventType: 'CREATE_CHANNEL_MESSAGE', messageId: 'placeholder-1', content, target: PERSON,
    }) as never);
    expect(rec).toMatchObject({ turn_entry: 'lex', battle_round: 1 });
  });

  it('says the entry again on the close-out, so the receipt row is never left without a path', async () => {
    mockReadAnalytics.mockResolvedValue(null);
    const closeOut = {
      ...closeOutAttribution({
        userMessageId: 'u-2', intent: 'report_generation', intentConfidence: 'high',
        deliveryOption: 'TASK_MULTI_STEP', taskId: 'task-1', entry: 'lex',
      }),
      turnKind: RECEIPT_TURN_KIND, respPhase: 'final',
    };
    const rec = await transformToMessageRecord(sideEvent({
      eventType: 'UPDATE_CHANNEL_MESSAGE', messageId: 'placeholder-1', target: PERSON,
      content: 'Thanks - picking that back up. My answer is in the conversation.', metadata: closeOut,
    }) as never);
    expect(rec).toMatchObject({ turn_entry: 'lex', turn_kind: 'receipt', answers_message_id: 'u-2' });
  });

  it('is closed out with the turn entry by the processor, from the one value the answer records', () => {
    const core = flat(read('lambda/src/lib/async-processor-core.ts'));
    expect(core).toContain('const turnEntry = turnEntryOf(event.entry, event.trigger);');
    const at = core.indexOf('const closeOutAcknowledgement = async');
    const body = core.slice(at, core.indexOf('const isReadingTurn', at));
    expect(body).toContain('...(turnEntry ? { entry: turnEntry } : {}), }) ?? {}), turnKind: RECEIPT_TURN_KIND },');
  });

  it("is declared on both Amazon Lex placeholders the router writes for a duel side", () => {
    const router = read('lambda/src/router-agent-handler.ts');
    const sites = router.split('content: battlePlaceholderContent({').slice(1).map((s) => s.slice(0, s.indexOf('}),')));
    expect(sites).toHaveLength(2);
    for (const site of sites) expect(site).toContain('entry: turnEntry,');
  });
});

describe('a narration is not what a placeholder became', () => {
  it('leaves the placeholder waiting for the update that says it, in the batch and in the sweep', () => {
    expect(updateSaysWhatItBecame({ resp_phase: 'progress' })).toBe(false);
    expect(updateSaysWhatItBecame(undefined)).toBe(false);
    expect(updateSaysWhatItBecame({ resp_phase: 'final' })).toBe(true);
    // An update that declares nothing is still the turn's word on the placeholder.
    expect(updateSaysWhatItBecame({ resp_phase: null })).toBe(true);
    const archival = flat(read('lambda/src/analytics-aurora/kinesis-archival.ts'));
    expect(archival).toContain('if (!updateSaysWhatItBecame(updateRecord) && isOpenPlaceholder(botRecord)) break;');
    expect(archival).toContain("OR (am_upd.id IS NOT NULL AND COALESCE(am_upd.metadata->>'respPhase', '') <> '${NARRATION_PHASE}')");
  });
});

describe('a receipt is counted once, as its answer', () => {
  const query = flat(read('lambda/src/analytics-aurora/analytics-query.ts'));

  it('is named a receipt before its round marker can name it a duel side', () => {
    const receipt = query.indexOf("WHEN ${declaredKind} = 'receipt' THEN 'receipt'");
    const round = query.indexOf("WHEN ${round} IS NOT NULL THEN 'battle_round_'");
    expect(receipt).toBeGreaterThan(-1);
    expect(round).toBeGreaterThan(receipt);
  });

  it('is left out of the flow population, whose turns each record a path', () => {
    expect(query).toContain("AND (e.id IS NOT NULL OR lbl.delivery_option = 'REFUSED' OR lbl.kind = 'handover') AND lbl.kind IS DISTINCT FROM 'receipt'");
  });
});
