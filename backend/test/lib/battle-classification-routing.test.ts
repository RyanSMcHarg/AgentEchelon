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
 * behavioral test cannot see a literal that was reintroduced on a path the fixture does not drive.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const flowSrc = fs.readFileSync(path.join(SRC, 'channel-flow-processor.ts'), 'utf8');
const battleSrc = fs.readFileSync(path.join(SRC, 'channel-battle.ts'), 'utf8');
const battleStackSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'stacks', 'battle-stack.ts'), 'utf8');
const capabilitiesSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'stacks', 'classification-capabilities.ts'), 'utf8');
const profileStackSrc =fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'stacks', 'assistant-profile-stack.ts'), 'utf8');

describe('battle eligibility is profile-driven, on every path', () => {
  it('the INVOCATION gate asks the capability, not a hardcoded premium literal', () => {
    // THIS PINNED THE PREVIOUS SHAPE and failed on a deliberate improvement. The gate used to read
    // `profiles.requireProfileFor(channelClassification).battleEligible` directly. ADR-049 split
    // that single flag into TWO questions asked together - has the deployment WIRED battle for this
    // classification, and has an operator TURNED IT ON - because the old flag answered true for
    // basic, whose stack wires no battle plumbing, so the surface promised what the role could not
    // back. `canRunBattle` asks capability first and is now the one gate.
    expect(flowSrc).toContain('await canRunBattle(channelClassification)');
    // The property that has not changed: the gate is resolved, never a literal comparison.
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
    // Round-1 fan-out and `@all`. Both resolve from the channel's own
    // classification rather than a hardwired ARN - that is the rule, and it is unchanged.
    //
    // WHAT round 1 resolves changed, which is why this counts both resolvers. It hands the turn to
    // the ROUTER now instead of dispatching a processor itself, so it uses the router table. Both
    // resolve a declared classification to its own target and nothing else to any (ADR-046), so a
    // battle can never be routed to one classification's router and another's processor.
    const processors = flowSrc.match(/asyncProcessorArnForClassification\(/g) || [];
    const routers = flowSrc.match(/resolveRouterArn\(/g) || [];
    expect(processors.length + routers.length).toBeGreaterThanOrEqual(2);
    // The fan-out specifically: it must resolve a router, not a processor - dispatching a worker
    // directly is the second entry point the handoff removes.
    expect(flowSrc).toMatch(/const battleRouterArn = await resolveRouterArn\(channelClassification\)/);
  });

  it('does not label a non-premium battle turn as premium in analytics', () => {
    // `classification` is attribution only - the tier is fixed by WHICH processor is invoked - but a
    // hardcoded 'premium' misattributed every non-premium battle turn.
    expect(flowSrc).not.toMatch(/(userType|classification):\s*'premium'/);
  });
});

describe('a reply targeted at the alt reaches its own classification\'s router, never a premium one', () => {
  // A person's reply TARGETED at the alt arrives on the alt's own Amazon Lex bot. That Lex bot is built
  // by the classification stack's own provisioner, whose fulfillment is that classification's router, so
  // a below-premium duel's reply cannot run on the premium router (premium model, guardrail and context
  // scope) - the failing-open shape this file was written about.

  it('the alt\'s Lex bot is built by its classification\'s own seed, fulfilled by that classification\'s router', () => {
    // The alt is declared in the classification's own stack, to its own seed (ADR-048, amended 2026-10-23), whose
    // Amazon Lex fulfillment is that stack's router, and the Battle stack declares and builds nothing of it.
    expect(profileStackSrc).toContain("declarations.push(seed.declare(this, 'DeclaredDuelAlts', alts));");
    expect(profileStackSrc).toMatch(/new DeclaredAssistantsSeed\(this, 'DeclaredAssistants', \{[\s\S]{0,400}fulfillmentArn: handlerArn,/);
    expect(battleStackSrc).not.toMatch(/DeclaredAssistantsSeed|CreateLexBot/);
    expect(capabilitiesSrc).not.toMatch(/CustomResource/);
  });

  it('no premium router parameter is hardwired', () => {
    expect(profileStackSrc).not.toContain('/assistant/premium/router-arn');
  });
});
