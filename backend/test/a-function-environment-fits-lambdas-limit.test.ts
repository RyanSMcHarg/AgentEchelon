/**
 * EVERY FUNCTION'S ENVIRONMENT FITS AWS LAMBDA'S 4 KB, WITH ROOM TO GROW.
 *
 * Lambda refuses a function whose environment variables exceed 4 KB (4,096 bytes, measured over the variables as
 * JSON), and only at deploy: synth, the build and every other test pass, and CloudFormation rolls the stack back.
 * A router carries the most (every table, service and setting a turn reaches), so one more variable on it is enough.
 *
 * Every stack of the real app is synthesized (`synthesizeApp`) in each variant the API contract synthesizes (both
 * analytics modes, every built capability, every shipped classification, each issuer shape, sleep mode), and in one
 * more: the shape that puts the most into a router, Aurora with live drift, two issuers, the premium ops assistant,
 * the turn queue and the meeting settings. Each `AWS::Lambda::Function` environment is measured with every token
 * resolved at its longest realistic deployed length (`helpers/lambda-env-size.ts`), and must stay under 3,800 bytes,
 * which leaves room for the next variable before Lambda's limit.
 *
 * NEAR THE LIMIT names the functions that still sit between 3,800 bytes and the limit, each with what takes it back
 * under. The list only shrinks: an entry that fits the margin again fails this test until it is removed.
 */
import * as path from 'path';
import { SYNTH_CAPABILITIES, SYNTH_SECOND_ISSUERS, SYNTH_VARIANTS, synthesizeApp, type SynthVariant } from '../lib/docs/api-contract';
import { environmentSizes, type EnvTemplate } from './helpers/lambda-env-size';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNTH_TIMEOUT_MS = 600_000;

/** Lambda's limit on a function's environment. */
const LAMBDA_LIMIT_BYTES = 4096;
/** The most a function's environment may hold here, leaving room for the next variable. */
const MARGIN_BYTES = 3800;

/** The configuration that puts the most into a router's environment. */
const FULLEST: SynthVariant = {
  id: 'aurora+live-drift+second-issuer',
  context: {
    analyticsMode: 'aurora',
    capabilities: [...SYNTH_CAPABILITIES],
    issuers: SYNTH_SECOND_ISSUERS,
    profiles: ['basic', 'standard', 'premium', 'ops-premium'],
    enableLiveDrift: true,
    turnQueue: true,
    turnQueueMax: '50',
    meetingRingSeconds: '30',
    meetingMaxMinutes: '240',
    meetingExperienceThresholds: '{"packetLossPct":5,"jitterMs":40,"roundTripMs":400,"sustainedSeconds":45}',
    meetingTranscription: 'true',
    meetingMediaRecording: 'true',
  },
};

/**
 * NEAR THE LIMIT: `<stack>/<function logical id>` of each function still above the margin, and what takes it under.
 * Each is under Lambda's limit; this list only shrinks.
 */
const NEAR_THE_LIMIT: Record<string, string> = {
  'AgentEchelonAssistants-standard/AgentHandler': 'the router: its per-classification SSM parameter paths derived from SSM_ROOT and CLASSIFICATION rather than carried',
  'AgentEchelonAssistants-premium/AgentHandler': 'the router: its per-classification SSM parameter paths derived from SSM_ROOT and CLASSIFICATION rather than carried',
};

type Measured = { variant: string; key: string; bytes: number; largest: string };

const measured: Measured[] = [];

/** `AgentHandlerB0E92DE7` -> `AgentHandler`: the construct id without CDK's uniqueness suffix. */
const constructId = (logicalId: string): string => logicalId.replace(/[0-9A-F]{8}$/, '');

describe('every function environment fits Lambda\'s 4 KB', () => {
  beforeAll(() => {
    for (const variant of [...SYNTH_VARIANTS, FULLEST]) {
      const { templates } = synthesizeApp(REPO_ROOT, variant);
      for (const [stack, template] of Object.entries(templates)) {
        for (const s of environmentSizes(template as EnvTemplate)) {
          measured.push({
            variant: variant.id,
            key: `${stack}/${constructId(s.logicalId)}`,
            bytes: s.bytes,
            largest: s.largest.map(([k, n]) => `${k} ${n}`).join(', '),
          });
        }
      }
    }
  }, SYNTH_TIMEOUT_MS);

  const describeRow = (m: Measured): string => `${m.key} (${m.variant}): ${m.bytes} bytes; largest ${m.largest}`;

  it('measures every function of every variant, the routers among them (the check is not vacuous)', () => {
    const variants = new Set(measured.map((m) => m.variant));
    expect(variants.size).toBe(SYNTH_VARIANTS.length + 1);
    for (const c of ['basic', 'standard', 'premium']) {
      expect(measured.some((m) => m.key === `AgentEchelonAssistants-${c}/AgentHandler`)).toBe(true);
    }
    expect(Math.max(...measured.map((m) => m.bytes))).toBeGreaterThan(MARGIN_BYTES / 2);
  });

  it('holds every function under Lambda\'s limit', () => {
    expect(measured.filter((m) => m.bytes >= LAMBDA_LIMIT_BYTES).map(describeRow)).toEqual([]);
  });

  it(`holds every function under ${MARGIN_BYTES} bytes, but the ones named near the limit`, () => {
    expect(measured.filter((m) => m.bytes >= MARGIN_BYTES && !(m.key in NEAR_THE_LIMIT)).map(describeRow)).toEqual([]);
  });

  it('names near the limit only a function that is still there', () => {
    const stale = Object.keys(NEAR_THE_LIMIT).filter((key) => !measured.some((m) => m.key === key && m.bytes >= MARGIN_BYTES));
    expect(stale).toEqual([]);
  });
});
