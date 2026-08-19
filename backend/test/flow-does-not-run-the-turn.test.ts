/**
 * Nothing that bypasses Lex runs the turn. It decides WHO responds.
 *
 * MESSAGE-FLOW §3.1: bypassing Lex is the only sanctioned difference between an `@all` or `/battle`
 * turn and an ordinary one. Classification, profile resolution, variant resolution, delivery
 * selection, task creation and model selection belong to the handler (`router-agent-handler.ts`),
 * which is the same code Lex fulfills into.
 *
 * WHY A RATCHET RATHER THAN A REVIEW NOTE. A decision duplicated on a bypass side diverges SILENTLY:
 * the turn still answers, so nothing errors and no test fails. That is how a profile configured for
 * keyword classification ended up still paying for a model call on battle turns, and how an image
 * duel ran as a text duel with nothing in any log to explain it. A rule nobody can enforce is a rule
 * that decays.
 *
 * EVERY PATH, NOT ONE. This scanned only the channel flow, so a duel's SECOND round - dispatched by
 * `battle-orchestrator.ts` - was never measured, and the flow's count read as the whole remaining
 * distance when it was not. Round 2 is a third way into the worker and it makes the same kind of
 * decision the flow does. Post-processing (ADR-032) is the fourth, and it is listed here while its
 * list is still EMPTY: a component added to the guard only once it has decisions to argue about is a
 * component that has already drifted, which is exactly how the flow read as converged before it was.
 *
 * This ratchets BOTH ways, like `single-entry-point.test.ts`: adding a turn decision to either path
 * fails, and once a decision moves to the handler its entry must be removed here, so the list can
 * only shrink.
 */
import { stripComments } from './helpers/strip-comments';
import * as fs from 'fs';
import * as path from 'path';

/**
 * One turn-path reference a bypass path must not make. `sanctioned` is the count that is currently
 * allowed and `reason` says WHY it is still there - `0` means that path has converged for it.
 */
interface Entry {
  symbol: string;
  sanctioned: number;
  reason: string;
}

interface BypassPath {
  label: string;
  file: string;
  entries: Entry[];
}

const SRC = path.join(__dirname, '../lambda/src');

const PATHS: BypassPath[] = [
  {
    label: 'the channel flow',
    file: 'channel-flow-processor.ts',
    // CONVERGED, and as of 2026-08-10 that is finally true of EVERY path through this file.
    //
    // It read as converged before it was. This list went empty when round 1 handed off, but the
    // BATTLE CONTINUATION was still deciding a delivery option (`planBattleResume`), hardcoding an
    // intent and invoking the worker directly - inside this same file. The guard missed it because it
    // matches SYMBOLS, and none of the continuation's were on either list. A resumed side therefore
    // carried no variant and archived with no experiment attribution, undetected.
    //
    // Every one of those symbols is now in FORBIDDEN_ANYWHERE, which is the ratchet closing: a
    // converged symbol may not return at ANY count.
    entries: [],
  },
  {
    label: 'the battle orchestrator (round 2)',
    file: 'battle-orchestrator.ts',
    entries: [
      {
        symbol: 'resolveBattleVariantBySlotArn',
        sanctioned: 3,
        reason:
          'Round 2 resolves the treatment side itself, the same divergence as the round-1 fan-out and for '
          + 'the same reason: the rebuttal is an ordinary turn, so its variant resolves on the turn path.',
      },
      {
        symbol: 'resolveBattleControlVariantByAltSlotArn',
        sanctioned: 2,
        reason: 'Round 2 resolves the control side itself. Belongs on the turn path.',
      },
      {
        symbol: 'PLACEHOLDER_UPDATE',
        sanctioned: 1,
        reason:
          'Round 2 hardcodes its delivery option (and `intent: \'general\'` beside it) rather than letting '
          + 'the handler classify and select. That is the same pair the `@all` handoff deleted from the '
          + 'flow, and it is why a rebuttal cannot currently be anything but a placeholder update.',
      },
      {
        symbol: 'InvokeCommand',
        sanctioned: 2,
        reason:
          'The import plus the direct worker invoke - a THIRD entry point into the processor, after the '
          + 'router and the flow. Goes when round 2 dispatches through the handler (ADR-023).',
      },
      {
        symbol: 'getProcessorArnForClassification',
        sanctioned: 2,
        reason:
          'Round 2 now resolves its worker from the DUEL\'S classification, with the same fail-safe rules '
          + 'the flow uses. It is listed rather than forbidden because round 2 still dispatches a worker '
          + 'at all; that goes when it dispatches through the handler (ADR-023). Pinning the worker to '
          + 'premium was an escalation for any duel a battleEligible profile enabled below premium.',
      },
    ],
  },
  {
    // POST-PROCESSING (ADR-032) is the FOURTH component that can put a turn on the worker without Lex,
    // after the router, the flow and the orchestrator. It is listed while it is still EMPTY, which is
    // the whole point: the flow read as converged before it was, because the guard was pointed at it
    // only after it had accumulated decisions to argue about. A component measured from its first
    // commit cannot repeat that.
    label: 'post-processing (the stream consumer)',
    file: 'message-post-processing.ts',
    entries: [],
  },
  {
    // The one rule post-processing composes today. It is scanned SEPARATELY rather than trusted to the
    // consumer's own file, because the consumer is a dispatcher: a turn decision added here would be
    // invisible to a scan of `message-post-processing.ts`, which names the rule and nothing it does.
    // ADR-023's B-stream would be a second rule module and a second entry, not a second consumer.
    label: 'post-processing rule: task-answer repair',
    file: 'lib/task-answer-repair.ts',
    entries: [],
  },
];

/**
 * Resolution and selection entry points a turn uses. No bypass path should reach for any of them, so
 * these need no per-path count: the catch-all is for the symbol nobody thought to list.
 */
const FORBIDDEN_ANYWHERE = [
  // Converged out of the channel flow when round 1 moved to the handler. Listed here rather than at
  // count 0, so they cannot return at count 1.
  'classifyIntent',
  'planBattleTaskDelivery',
  'createBattleTask',
  // Converged out of the battle CONTINUATION, 2026-08-10. Each was a turn decision made in the flow:
  // `planBattleResume` chose a delivery option; `asyncProcessorArnForClassification` chose a worker;
  // `getActiveTaskForOwner` asked which chain to continue. All three now belong to the handler, which
  // resolves them on the one turn path along with the variant the continuation used to lose.
  'planBattleResume',
  'asyncProcessorArnForClassification',
  'getActiveTaskForOwner',
  // Round 2 no longer names a premium worker at all. Forbidden rather than counted, so a
  // classification-blind dispatch cannot return: it was an escalation, not a shortcut.
  'premiumProcessorArn',
  'getPremiumProcessorArn',
  'createTask',
  'advanceTaskStateTo',
  'resolveActiveProfile',
  'resolveModelForIntent',
  'resolveModelPlan',
  'buildIntentStrategy',
  'lookupProfileVersion',
  'resolveExperimentForChannel',
];

/**
 * Count real references, ignoring comments so the rationale above does not count as a call.
 *
 * Stripping is SHARED (`helpers/strip-comments`) rather than inlined. The naive form used here treated a
 * `/*`-terminated ARN glob as a comment opener and blanked everything to the next close-comment - which,
 * in a FORBIDDEN_ANYWHERE list, means a banned symbol inside the blanked region reads as absent. This
 * guard's expected count for those is zero, so blanking is the one direction that turns red into green.
 */
function referenceCount(src: string, symbol: string): number {
  const withoutComments = stripComments(src);
  return (withoutComments.match(new RegExp(`\\b${symbol}\\b`, 'g')) || []).length;
}

describe('no bypass path runs the turn', () => {
  for (const { label, file, entries } of PATHS) {
    describe(label, () => {
      const src = fs.readFileSync(path.join(SRC, file), 'utf8');

      for (const { symbol, sanctioned, reason } of entries) {
        it(`${symbol}: exactly ${sanctioned} sanctioned reference(s)`, () => {
          expect(referenceCount(src, symbol)).toBe(sanctioned);
          // A stale allow-list is as misleading as a missing one: when the count drops to 0, the
          // entry has to go, so this file always describes the real remaining distance.
          if (sanctioned === 0) {
            expect(reason).toBe('');
          }
        });
      }

      it('adds no NEW turn-path symbol', () => {
        const present = FORBIDDEN_ANYWHERE.filter((s) => referenceCount(src, s) > 0);
        expect(present).toEqual([]);
      });
    });
  }

  it('measures every path that reaches the worker without Lex', () => {
    // The distance is only honest if nothing is missing from the list. All four are here - the flow,
    // round 2, the post-processing consumer and the one rule it composes; a fifth is a new entry, not
    // a silent omission. This assertion is what makes omission fail rather than simply go unmeasured.
    expect(PATHS.map((p) => p.file).sort()).toEqual(
      [
        'battle-orchestrator.ts',
        'channel-flow-processor.ts',
        'lib/task-answer-repair.ts',
        'message-post-processing.ts',
      ],
    );
  });
});
