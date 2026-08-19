/**
 * Battle eligibility and processor routing must move together.
 *
 * Two defects lived here, and they masked each other. The invocation gate hardcoded
 * `channelClassification !== 'premium'` while the ENABLE path gated on the profile's `battleEligible`,
 * so a deployment could mark a non-premium profile eligible, arm Battle Mode, and then have every
 * `/battle` refused. That failed CLOSED, so it was survivable on its own.
 *
 * The round-1 fan-out and the continuation separately hardcoded the PREMIUM async processor. That fails
 * OPEN - a non-premium channel answering on the premium processor gets the premium model, the premium
 * guardrail and the premium `context/` S3 scope, which are IAM-enforced tier boundaries. It was
 * unreachable ONLY because the hardcoded gate refused non-premium first.
 *
 * So fixing the gate alone would have opened the escalation. These assert both halves, together,
 * because that pairing is the actual invariant: the moment eligibility is profile-driven, routing MUST
 * be classification-driven too.
 *
 * SOURCE-LEVEL, in the same spirit as control-parity.test.ts: the risk is a hardcode returning, and a
 * behavioural test cannot see a literal that was reintroduced on a path the fixture does not drive.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const flowSrc = fs.readFileSync(path.join(SRC, 'channel-flow-processor.ts'), 'utf8');
const battleSrc = fs.readFileSync(path.join(SRC, 'channel-battle.ts'), 'utf8');
const altSlotSrc = fs.readFileSync(path.join(SRC, 'battle-alt-slot-handler.ts'), 'utf8');

describe('battle eligibility is profile-driven, on every path', () => {
  it('the INVOCATION gate reads battleEligible, not a hardcoded premium literal', () => {
    expect(flowSrc).toContain('profiles.profileFor(channelClassification).battleEligible');
    // The exact shape of the defect: a classification compared against a tier literal as the gate.
    expect(flowSrc).not.toMatch(/if\s*\(\s*channelClassification\s*!==\s*'premium'\s*\)/);
  });

  it('the ENABLE path still reads the same flag, so the two cannot diverge again', () => {
    expect(battleSrc).toContain('battleEligible');
    expect(battleSrc).not.toMatch(/if\s*\(\s*channelClassification\s*!==\s*'premium'\s*\)/);
  });

  it('the config GET reports eligibility, so the UI gates on capability not on mutable metadata', () => {
    // Without this the frontend has nothing to gate on and falls back to `modelTier === 'premium'`,
    // which reads member-WRITABLE channel metadata and ignores the profile flag entirely.
    expect(battleSrc).toContain('battleEligible');
    expect(battleSrc).toMatch(/battleEligible[,\s]/);
  });
});

describe('battle DISPATCH routes on classification, never a hardwired premium processor', () => {
  it('no invoke hardcodes the premium processor ARN', () => {
    // The escalation this prevents. `PREMIUM_ASYNC_PROCESSOR_ARN` may still be READ (the env const and
    // the classification->ARN resolver legitimately reference it); what must never reappear is an
    // invoke targeting it directly.
    expect(flowSrc).not.toMatch(/FunctionName:\s*PREMIUM_ASYNC_PROCESSOR_ARN/);
  });

  it('every battle dispatch resolves its target from the classification', () => {
    // Round-1 fan-out, the continuation, and `@all`. All three resolve from the channel's own
    // classification rather than a hardwired ARN - that is the rule, and it is unchanged.
    //
    // WHAT round 1 resolves changed, which is why this counts both resolvers. It hands the turn to
    // the ROUTER now instead of dispatching a processor itself, so it uses the router table. The two
    // tables apply identical fail-safe rules on purpose (basic never falls back up), so a battle can
    // never be routed to one classification's router and another's processor.
    const processors = flowSrc.match(/asyncProcessorArnForClassification\(/g) || [];
    const routers = flowSrc.match(/routerArnForClassification\(/g) || [];
    expect(processors.length + routers.length).toBeGreaterThanOrEqual(3);
    // The fan-out specifically: it must resolve a router, not a processor - dispatching a worker
    // directly is the second entry point the handoff removes.
    expect(flowSrc).toMatch(/const battleRouterArn = routerArnForClassification\(channelClassification\)/);
  });

  it('does not label a non-premium battle turn as premium in analytics', () => {
    // `userType` is attribution only - the tier is fixed by WHICH processor is invoked - but a
    // hardcoded 'premium' misattributed every non-premium battle turn.
    expect(flowSrc).not.toMatch(/userType:\s*'premium'/);
  });
});

describe('the alt-slot Lex hook routes on classification too, never a hardwired premium router', () => {
  // The last hardwired-premium survivor. Every other battle path above routes by the channel's
  // classification tag, but a person's reply TARGETED at an alt slot arrives through this slot's own
  // Lex hook - and that hook resolved `/assistant/premium/router-arn` unconditionally. In a
  // below-premium duel (battles are not premium-only by design) the reply then ran on the premium
  // router: premium model, premium guardrail, premium context scope. It failed OPEN - the turn still
  // answered - which is exactly why a behavioural test never saw it.

  it('resolves the router from the channel classification tag, via the shared fail-closed resolver', () => {
    expect(altSlotSrc).toContain("from './lib/channel-classification.js'");
    expect(altSlotSrc).toMatch(/resolveChannelClassificationTag\(messagingClient, channelArn/);
    // The per-classification parameter template, fed by the resolved tag.
    expect(altSlotSrc).toMatch(/\/assistant\/\$\{classification\}\/router-arn/);
  });

  it('no premium router parameter is hardwired', () => {
    expect(altSlotSrc).not.toContain('/assistant/premium/router-arn');
  });
});
