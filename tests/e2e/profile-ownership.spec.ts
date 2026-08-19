/**
 * Per-profile ownership E2E — the DEPLOYED topology matches the ownership model.
 *
 * WHY THIS EXISTS WHEN SYNTH ALREADY PROVES IT. `SPEC-PER-PROFILE-OWNERSHIP.md` guarantees stack
 * topology and deploy isolation, and its own Coverage line argued - correctly - that this is
 * structural and provable at synth rather than from a browser. `cdk-synth.test.ts` does instantiate
 * the three per-profile stacks, so the shape CDK WOULD emit is covered.
 *
 * What synth cannot tell you is what is actually deployed. Synth passes against a green tree while
 * the account has drifted: a stack deleted, a partial deploy that left one classification behind, or
 * an SSM parameter renamed so the cross-stack seam silently no longer resolves. The promise this
 * spec makes to a team is "you can ship your profile without touching or breaking the others", and
 * that promise is about a running account, not a synthesized template.
 *
 * So this asserts the deployed account, from AWS APIs rather than a browser: one handler per
 * classification, each in its OWN CloudFormation stack (that separation IS the blast radius), and
 * the SSM parameters each handler is wired through actually resolving - because "wired across stacks
 * by SSM only" is what allows the independent deploy cadence, and a dangling parameter breaks it in
 * a way nothing else reports.
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { hasTestCredentials } from './helpers/test-credentials';
import { guardBackendErrors } from './helpers/turn-guards';

const E2E_RUNNABLE = hasTestCredentials();
const REGION = process.env.AWS_REGION || 'us-east-1';
const EXPECTED = ['basic', 'standard', 'premium'];

function aws(args: string): any {
  const out = execSync(`aws ${args} --region ${REGION} --output json`, {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  }).trim();
  return out ? JSON.parse(out) : null;
}

interface Handler {
  fn: string;
  classification: string;
  stack: string;
  ssmParams: Record<string, string>;
  ssmRoot: string;
}

/** Discover the deployed per-classification handlers. Parsed as JSON, never shell-split: the
 *  function names come back with trailing whitespace under Git Bash and silently fail validation. */
function discoverHandlers(): Handler[] {
  const names: string[] = aws(
    `lambda list-functions --query "Functions[?contains(FunctionName,'AgentEchelonClassification') `
    + `&& contains(FunctionName,'AgentHandler')].FunctionName"`,
  ) || [];

  return names.map((raw) => {
    const fn = raw.trim();
    const cfg = aws(`lambda get-function-configuration --function-name ${fn}`);
    const env: Record<string, string> = cfg?.Environment?.Variables ?? {};
    const detail = aws(`lambda get-function --function-name ${fn}`);
    const ssmParams = Object.fromEntries(
      Object.entries(env).filter(([k]) => k.endsWith('_PARAM')),
    ) as Record<string, string>;
    return {
      fn,
      classification: env.CLASSIFICATION || '',
      stack: detail?.Tags?.['aws:cloudformation:stack-name'] || '',
      ssmParams,
      ssmRoot: env.SSM_ROOT || '',
    };
  });
}

test.describe('Per-profile ownership — deployed topology', () => {
  test.skip(!E2E_RUNNABLE, 'Needs AWS credentials to read the deployed stacks.');
  guardBackendErrors('profile-ownership');

  let handlers: Handler[] = [];

  test.beforeAll(() => {
    handlers = discoverHandlers();
  });

  test('every classification has its own handler, in its own stack', async () => {
    test.setTimeout(180_000);

    const byClassification = new Map(handlers.map((h) => [h.classification, h]));
    console.log(
      `\n--- deployed per-profile handlers ---\n`
      + handlers.map((h) => `  ${h.classification || '(none)'}  stack=${h.stack}`).join('\n'),
    );

    for (const cls of EXPECTED) {
      expect(
        byClassification.get(cls),
        `no deployed handler carries CLASSIFICATION=${cls}. The profile is either not deployed or `
        + 'was rolled into another stack - either way a team no longer owns it independently, and '
        + 'synth would still be green.',
      ).toBeDefined();
    }

    // Deploy isolation IS the separation of stacks. If two classifications share a stack, one
    // team's deploy ships the other's change - the exact blast radius this spec exists to prevent.
    const stacks = EXPECTED.map((c) => byClassification.get(c)!.stack);
    expect(
      stacks.every((s) => s.length > 0),
      `a handler has no CloudFormation stack tag (${stacks.join(', ')}); cannot prove isolation.`,
    ).toBe(true);
    expect(
      new Set(stacks).size,
      `the classifications do not each own a stack (${stacks.join(', ')}). Two profiles sharing a `
      + 'stack cannot deploy on independent cadences.',
    ).toBe(EXPECTED.length);
  });

  test('the cross-stack SSM seam resolves for every profile', async () => {
    test.setTimeout(180_000);

    // "Wired across stacks by SSM only" is what buys the independent cadence. An env var holding a
    // parameter NAME proves nothing; the parameter has to exist. A renamed or never-written
    // parameter leaves the handler falling back at runtime, which is invisible until the fallback
    // is wrong.
    //
    // Two kinds of *_PARAM live in this env and only one of them is the seam:
    //
    //   STRUCTURAL - the sibling-stack ARNs a profile resolves at runtime. These ARE the wiring; a
    //     dangling one means the profile cannot reach a resource another stack owns.
    //   PER-DEPLOYMENT CONTENT - intent pack, welcome copy, onboarding schema. The handler has a
    //     defined fallback and leaving them unset is a legitimate deployment choice, exactly like
    //     the opt-in spend budgets in SPEC-ABUSE-CONTROLS. Asserting these would fail on a correct
    //     deployment, which is how a test gets weakened until it means nothing.
    //
    // Structural parameters are asserted; content parameters are REPORTED. The reporting earns its
    // place: the first run of this test showed onboarding-intake configured for standard only,
    // which is not visible anywhere else.
    const STRUCTURAL = ['BOT_ARN_PARAM', 'CHANNEL_FLOW_ARN_PARAM'];
    const problems: string[] = [];
    const contentState: string[] = [];

    const resolves = (name: string): boolean => {
      if (!name) return false;
      try {
        return Boolean(aws(`ssm get-parameter --name "${name}"`)?.Parameter?.Value);
      } catch {
        return false;
      }
    };

    for (const cls of EXPECTED) {
      const h = handlers.find((x) => x.classification === cls);
      if (!h) continue;
      expect(
        Object.keys(h.ssmParams).length,
        `${cls} handler declares no *_PARAM SSM names, so it is not wired through the SSM seam.`,
      ).toBeGreaterThan(0);

      for (const key of STRUCTURAL) {
        const name = h.ssmParams[key];
        if (!name) problems.push(`${cls}: ${key} is absent from the handler env`);
        else if (!resolves(name)) problems.push(`${cls}: ${key} -> ${name} DOES NOT RESOLVE`);
      }

      for (const [key, name] of Object.entries(h.ssmParams)) {
        if (STRUCTURAL.includes(key)) continue;
        contentState.push(`  ${cls}: ${key} ${resolves(name) ? 'configured' : 'NOT configured (fallback)'}`);
      }
    }

    console.log(`\n--- per-deployment content parameters (reported, not asserted) ---\n${contentState.join('\n')}`);

    console.log(
      `\n--- SSM seam ---\n`
      + EXPECTED.map((c) => {
        const h = handlers.find((x) => x.classification === c);
        return `  ${c}: ${h ? Object.keys(h.ssmParams).length : 0} parameter(s), root=${h?.ssmRoot || '-'}`;
      }).join('\n'),
    );

    expect(
      problems,
      'the SSM seam that wires these stacks together is broken for the entries above. Each profile '
      + 'reads its siblings only through these parameters, so a dangling one means the handler is '
      + 'silently running on a fallback.',
    ).toEqual([]);
  });
});
