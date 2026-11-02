/**
 * EVERY KIND OF TURN RECORDS HOW IT ENTERED. No turn lands on "Path not recorded".
 *
 * The entry is a latency dimension (migration 054): a turn that came through Amazon Lex, one the channel
 * flow handed to the router, and one the platform started itself have different work in front of their
 * first frame, so a figure that mixes them is not a figure about any of them. A turn with no entry is
 * counted in the Latency tab and the Performance flow under "Path not recorded", which says the
 * platform does not know something it decided.
 *
 * Two producers write it, and this holds both to every kind in `INTERACTION_KINDS`:
 *   - the router declares `lex` or `flow` on every turn a person's message starts, because both doors
 *     converge on it (`workerCommonFields`, and the placeholders it writes);
 *   - every other kind is started by the platform, and `turnEntryOf` names it `platform` from the kind
 *     its dispatcher declared, in the processor that stamps the analytics and in the archive that reads them.
 *
 * A kind added to `INTERACTION_KINDS` fails the first test until it is placed in one of the two.
 */
const mockReadAnalytics = jest.fn();
jest.mock('../lambda/src/lib/message-analytics', () => ({
  readMessageAnalytics: (...args: unknown[]) => mockReadAnalytics(...args),
  writeMessageAnalytics: jest.fn(async () => undefined),
}));
jest.mock('../lambda/src/analytics-aurora/db-client', () => ({
  batchInsert: jest.fn(async () => 0),
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  transaction: jest.fn(),
  ensureSchema: jest.fn(),
  resetConnection: jest.fn(),
  isAuthError: jest.fn(() => false),
}));
jest.mock('../lambda/src/analytics-aurora/drift-detection', () => ({
  detectDrift: jest.fn(),
  recordDriftFire: jest.fn(),
}));
jest.mock('../lambda/src/analytics-aurora/cross-conversation-context', () => ({
  updateConversationContext: jest.fn(),
}));
jest.mock('../lambda/src/lib/sleep-mode', () => ({
  touchActivity: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';
import { INTERACTION_KINDS, isHumanWaiting, type InteractionKind } from '../lambda/src/lib/interaction-kinds';
import { TURN_ENTRIES, turnEntryOf } from '../lambda/src/lib/turn-declaration';
import { transformToMessageRecord } from '../lambda/src/analytics-aurora/kinesis-archival';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const flat = (s: string) => s.replace(/\s+/g, ' ');

const router = read('lambda/src/router-agent-handler.ts');
const routerFlat = flat(router);

/**
 * WHO RECORDS EACH KIND'S ENTRY. `router`: the turn is dispatched by the router's main path, which declares
 * the door on every dispatch it makes. `platform`: the turn is the platform's own and its kind names the path.
 */
const WHO_RECORDS_THE_ENTRY: Record<InteractionKind, 'router' | 'platform'> = {
  // A person's message, through either door.
  user: 'router',
  // Bypass events the router runs on its main path (`handover-backstop.ts`, `task-answer-repair.ts`).
  handover: 'router',
  repair: 'router',
  // The failure announcement re-sends the failed turn's own payload, entry included (`turn-lock-release-on-failure.ts`).
  recovery: 'router',
  // Fired by the battle orchestrator; the router posts its placeholder and dispatches it as the platform's turn.
  rebuttal: 'platform',
  // A bypass the router runs on its main path, so it carries the door it came through.
  join_recap: 'router',
  // Dispatched when the assistant joins (`welcome-prompt-turn.ts`), answering no message.
  welcome: 'platform',
  // An event workflow's agent step or voiced send (`dispatchEventAgentStep`, `dispatchVoiceSend`).
  event_step: 'platform',
  // A ready task taken up by an idle assistant (`takeUpReadyTask`).
  task_step: 'platform',
  // The room's primary naming a room another assistant answered first (`askRoomToBeNamed`), answering no message.
  name_room: 'platform',
};

describe('every interaction kind has a path that records its entry', () => {
  it('places every kind, so a new kind cannot ship without one', () => {
    expect(Object.keys(WHO_RECORDS_THE_ENTRY).sort()).toEqual([...INTERACTION_KINDS].sort());
  });

  it.each([...INTERACTION_KINDS])('%s', (kind) => {
    if (WHO_RECORDS_THE_ENTRY[kind] === 'platform') {
      // Named from the kind alone: no producer of it has to remember to say so.
      expect(turnEntryOf(undefined, kind)).toBe('platform');
    } else {
      // The router's declaration is carried as it is, whatever the kind.
      for (const door of ['lex', 'flow'] as const) expect(turnEntryOf(door, kind)).toBe(door);
    }
  });

  it('names a kind no message starts `platform`, and never guesses a door for one a person started', () => {
    for (const kind of INTERACTION_KINDS) {
      expect(turnEntryOf(undefined, kind)).toBe(isHumanWaiting(kind) ? undefined : 'platform');
    }
    // The retired dispatcher name is the rebuttal it was.
    expect(turnEntryOf(undefined, 'orchestrator')).toBe('platform');
    // A value nothing declares is not an entry.
    expect(turnEntryOf('telepathy', 'user')).toBeUndefined();
  });

  it('keeps every entry inside the column it is written to', () => {
    // messages.turn_entry is VARCHAR(8) (migration 054); a longer value aborts the archival batch.
    for (const entry of TURN_ENTRIES) expect(entry.length).toBeLessThanOrEqual(8);
  });
});

describe('the router declares the door on every turn it dispatches from a message', () => {
  it('on the fields every main-path dispatch carries', () => {
    expect(routerFlat).toContain("entry: isFlowEntry(event) ? 'flow' : 'lex',");
    const common = routerFlat.indexOf('const workerCommonFields = {');
    expect(common).toBeGreaterThan(-1);
    expect(routerFlat.slice(common, routerFlat.indexOf('};', common))).toContain("entry: isFlowEntry(event) ? 'flow' : 'lex',");
  });

  /**
   * Every literal payload the router hands the processor either spreads the main-path fields, declares
   * an entry, or declares a kind the platform starts. A payload passed by name is checked where it is built.
   */
  it('on every literal processor payload it builds', () => {
    const payloads = router.split(/invokeAsync\([A-Za-z]+, \{/).slice(1).map((rest) => {
      let depth = 1;
      let i = 0;
      for (; i < rest.length && depth > 0; i++) {
        if (rest[i] === '{') depth++;
        else if (rest[i] === '}') depth--;
      }
      return rest.slice(0, i);
    });
    expect(payloads.length).toBeGreaterThanOrEqual(6);
    for (const payload of payloads) {
      const declaredKind = /\btrigger: '([a-z_]+)'/.exec(payload)?.[1];
      const recorded = payload.includes('...workerCommonFields')
        || /\bentry: /.test(payload)
        || (declaredKind !== undefined && turnEntryOf(undefined, declaredKind) === 'platform');
      expect({ payload: payload.slice(0, 160), recorded }).toEqual({ payload: payload.slice(0, 160), recorded: true });
    }
  });

  it('on the payloads it hands on by name', () => {
    // The rebuttal round is the orchestrator's payload, which declares the kind.
    expect(read('lambda/src/battle-orchestrator.ts')).toContain("trigger: 'rebuttal' as InteractionKind,");
    // The prompt welcome declares its kind.
    expect(flat(read('lambda/src/lib/welcome-prompt-turn.ts'))).toContain("trigger: 'welcome',");
    // The room's naming run posts no message, so it is in no turn population at all.
    const naming = flat(read('lambda/src/assistant-async-processor.ts'));
    const run = naming.slice(naming.indexOf('if (event.nameRoom) {'), naming.indexOf('return; }', naming.indexOf('if (event.nameRoom) {')));
    expect(run).not.toMatch(/sendChannelMessage|updateMessage/);
  });
});

describe('the processor records the entry on every message of the turn', () => {
  const core = flat(read('lambda/src/lib/async-processor-core.ts'));
  const processor = flat(read('lambda/src/assistant-async-processor.ts'));

  it('stamps it from one value on the analytics record and the update that carries it', () => {
    expect(core).toContain('const turnEntry = turnEntryOf(event.entry, event.trigger);');
    expect(core.split('...(turnEntry && { entry: turnEntry }),')).toHaveLength(3);
    expect(core).not.toContain('...(event.entry && { entry: event.entry })');
  });

  it('says it on a receipt and on the queue notice a turn settles', () => {
    expect(core).toContain('...(turnEntry ? { entry: turnEntry } : {}), }) ?? {}), turnKind: RECEIPT_TURN_KIND },');
    expect(processor).toContain('...(turnEntryOf(event.entry, event.trigger) ? { entry: turnEntryOf(event.entry, event.trigger) } : {}),');
  });

  it('says it on the messages the platform posts without a model answer of the ordinary kind', () => {
    // An event step's post and a voiced send.
    expect(processor.split("entry: turnEntryOf(event.entry, 'event_step'),")).toHaveLength(3);
    // A prompt welcome.
    expect(processor).toContain("entry: turnEntryOf(event.entry, 'welcome'),");
  });
});

describe('the archive records the entry a producer left out, from the kind it declared', () => {
  const APP = 'arn:aws:chime:us-east-1:1:app-instance/i';
  const update = (metadata: Record<string, unknown>) => ({
    EventType: 'UPDATE_CHANNEL_MESSAGE',
    Payload: {
      MessageId: 'm-1', ChannelArn: `${APP}/channel/c1`, Content: 'A rebuttal.',
      Sender: { Arn: `${APP}/bot/advisor`, Name: 'Advisor' },
      CreatedTimestamp: '2026-10-30T10:00:00.000Z', LastUpdatedTimestamp: '2026-10-30T10:00:05.000Z',
      Persistence: 'PERSISTENT', Metadata: JSON.stringify({ respPhase: 'final', ...metadata }),
    },
  });

  beforeEach(() => mockReadAnalytics.mockResolvedValue(null));

  it.each([
    ['a rebuttal written without an entry', { trigger: 'rebuttal' }, 'platform'],
    ['an event step written without an entry', { trigger: 'event_step', turnKind: 'event_step' }, 'platform'],
    ['a platform turn that declared it', { trigger: 'task_step', entry: 'platform' }, 'platform'],
    ['a person-started turn that declared its door', { trigger: 'user', entry: 'lex' }, 'lex'],
    ['a person-started turn that declared nothing', {}, null],
    ['an entry nothing declares', { entry: 'telepathy' }, null],
  ] as const)('%s', async (_label, metadata, expected) => {
    const rec = await transformToMessageRecord(update(metadata) as never);
    expect(rec?.turn_entry).toBe(expected);
  });
});
