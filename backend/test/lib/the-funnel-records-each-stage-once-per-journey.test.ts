/**
 * B12: THE GUEST-TO-CUSTOMER FUNNEL, ONE ROW PER STAGE UNDER UPGRADE PATH A AND PATH B.
 *
 * Every stage the plan names is declared (`FUNNEL_STAGES`), each either recorded by the component that owns
 * the transition or declared **NOT BUILT** with the reason, so its absence in the console reads as not built
 * and never as zero. A recorded stage is an archive event (`SERVER_EVENT_TYPES`, so the Athena projection
 * enumerates it), keyed by the AppInstanceUser it is about, carrying the visitor's conversation as its
 * journey, and nothing that names a person by an address.
 *
 * The rows below drive the journey for both paths through the one recorder; the handlers' own stages are
 * asserted where each handler is driven whole (`the-guest-session-fails-closed`, `binding-a-guest-ends-the-
 * guest-credential` for path A, `a-claim-opens-a-tagged-customer-conversation` for path B).
 */
import { FUNNEL_STAGES, RECORDED_FUNNEL_STAGES, journeyOf, recordFunnelStage, type RecordedFunnelStage } from '../../lambda/src/lib/funnel';
import { SERVER_EVENT_TYPES, VALID_EVENT_TYPES } from '../../lambda/src/lib/client-event-types';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/i';
const VISITOR = `${APP}/user/0192f0e0-0000-7000-8000-0000000000a1`;
const ACCOUNT = `${APP}/user/0192f0e0-0000-7000-8000-0000000000b2`;
const VISIT = `${APP}/channel/guest-visitor-1`;

/** The stages each path passes through, in order, and who each one is about. */
const PATHS: Record<'A' | 'B', Array<{ stage: string; person: string }>> = {
  A: [
    { stage: 'guest_started', person: VISITOR },
    { stage: 'registration_offered', person: VISITOR },
    { stage: 'registration_started', person: VISITOR },
    { stage: 'guest_bound', person: VISITOR },
    { stage: 'rep_added', person: VISITOR },
    { stage: 'rep_first_reply', person: VISITOR },
  ],
  B: [
    { stage: 'guest_started', person: VISITOR },
    { stage: 'registration_offered', person: VISITOR },
    { stage: 'registration_started', person: VISITOR },
    { stage: 'claim_sent', person: VISITOR },
    { stage: 'claim_redeemed', person: ACCOUNT },
    { stage: 'rep_added', person: ACCOUNT },
    { stage: 'rep_first_reply', person: ACCOUNT },
  ],
};

const ROWS = (['A', 'B'] as const).flatMap((path) => PATHS[path].map((s) => [path, s.stage, s.person] as const));

describe('the declared stages', () => {
  it('names every stage the plan names, in funnel order', () => {
    expect(FUNNEL_STAGES.map((s) => s.stage)).toEqual([
      'guest_started', 'guest_refused', 'registration_offered', 'registration_started', 'claim_sent', 'claim_redeemed',
      'guest_bound', 'rep_added', 'rep_first_reply', 'handoff_unassigned',
    ]);
  });

  it('every recorded stage is an archive event no browser can send, and every built stage is recorded', () => {
    for (const stage of RECORDED_FUNNEL_STAGES) {
      expect((SERVER_EVENT_TYPES as readonly string[]).includes(stage)).toBe(true);
      expect((VALID_EVENT_TYPES as readonly string[]).includes(stage)).toBe(false);
    }
    const built = FUNNEL_STAGES.filter((s) => s.built).map((s) => s.stage).sort();
    expect(built).toEqual([...RECORDED_FUNNEL_STAGES].sort());
    for (const s of FUNNEL_STAGES.filter((x) => !x.built)) expect(s.recordedBy).toMatch(/NOT BUILT/);
  });
});

describe.each(ROWS)('path %s, stage %s', (path, stage, person) => {
  const def = FUNNEL_STAGES.find((s) => s.stage === stage)!;

  it(def.built ? 'is recorded once, on the person it is about, on the visit\'s journey' : 'is declared NOT BUILT, so it reads as not built and never as zero', async () => {
    expect(def).toBeDefined();
    if (!def.built) {
      expect(def.recordedBy).toMatch(/NOT BUILT/);
      return;
    }
    // A stage of one path only belongs to that path.
    if (def.path) expect(def.path).toBe(path);
    const events: Array<{ eventType: string; personId: string; properties: Record<string, unknown> }> = [];
    const ok = await recordFunnelStage({ stage: stage as RecordedFunnelStage, personArn: person, journeyChannelArn: VISIT }, async (e) => { events.push(e); });
    expect(ok).toBe(true);
    expect(events).toEqual([{
      eventType: stage,
      personId: person.split('/user/')[1],
      properties: { journey: 'guest-visitor-1', ...(def.path ? { path: def.path } : {}) },
    }]);
  });
});

describe('a journey is the visitor\'s conversation, and joins the two paths without an address', () => {
  it('path A keeps one person and one journey; path B keeps one journey across two people', async () => {
    const record = async (path: 'A' | 'B') => {
      const events: Array<{ personId: string; properties: Record<string, unknown> }> = [];
      for (const { stage, person } of PATHS[path]) {
        if (!(RECORDED_FUNNEL_STAGES as readonly string[]).includes(stage)) continue;
        await recordFunnelStage({ stage: stage as RecordedFunnelStage, personArn: person, journeyChannelArn: VISIT }, async (e) => { events.push(e); });
      }
      return events;
    };
    const a = await record('A');
    expect(new Set(a.map((e) => e.personId)).size).toBe(1);
    expect(new Set(a.map((e) => e.properties.journey))).toEqual(new Set(['guest-visitor-1']));
    const b = await record('B');
    expect(new Set(b.map((e) => e.personId)).size).toBe(2);
    expect(new Set(b.map((e) => e.properties.journey))).toEqual(new Set(['guest-visitor-1']));
    expect(JSON.stringify([...a, ...b])).not.toContain('@');
  });

  it('a journey is a channel id, and anything else names no journey', () => {
    expect(journeyOf(VISIT)).toBe('guest-visitor-1');
    expect(journeyOf('ada@example.com')).toBe('');
    expect(journeyOf(undefined)).toBe('');
  });

  it('a refusal names nobody and carries only its reason code', async () => {
    const events: Array<{ personId: string; properties: Record<string, unknown> }> = [];
    await recordFunnelStage({ stage: 'guest_refused', reason: 'rate_limited' }, async (e) => { events.push(e); });
    await recordFunnelStage({ stage: 'guest_refused', reason: 'not a code; drop table' }, async (e) => { events.push(e); });
    expect(events).toEqual([
      { eventType: 'guest_refused', personId: '', properties: { reason: 'rate_limited' } },
      { eventType: 'guest_refused', personId: '', properties: {} },
    ]);
  });

  it('a stage the archive cannot take is reported, never thrown', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(recordFunnelStage({ stage: 'guest_started', personArn: VISITOR, journeyChannelArn: VISIT }, async () => { throw new Error('down'); })).resolves.toBe(false);
    warn.mockRestore();
  });
});

describe('the console mirrors the stages', () => {
  it('GuestFunnelPanel lists every stage, with the same built flag', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../../../frontend/packages/admin/src/components/admin/GuestFunnelPanel.tsx'), 'utf8');
    const mirrored = [...source.matchAll(/\{ stage: '([a-z_]+)', built: (true|false) \}/g)].map((m) => ({ stage: m[1], built: m[2] === 'true' }));
    expect(mirrored).toEqual(FUNNEL_STAGES.map((s) => ({ stage: s.stage, built: s.built })));
  });
});
