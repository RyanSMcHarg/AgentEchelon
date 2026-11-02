/**
 * A DEPLOYMENT STANDS UP THE REQUIRED CORE AND EXACTLY THE CAPABILITIES IT DECLARES (D12, tenet D10).
 *
 * `capabilities` in `deploy.config.json` is the one declaration; `lib/config/capabilities.ts` says what
 * each name stands up and what it requires. Synthesized through the real CDK app (`synthesizeApp`), so
 * the stack set is the one `cdk deploy --all` would create:
 *
 *  - nothing declared is the core: Messaging, Identity, Conversations, Archive (one stack name in either
 *    mode), the channel flow, post-processing, and one `Assistants-<classification>` stack per
 *    classification the profile registry declares with a topology, and no other stack;
 *  - each built capability adds its own stacks and the stacks of what it requires, and nothing else;
 *  - the core learns at synth that battle and experiments are absent: no stack resolves their
 *    parameters, so a core-only first install has nothing to fetch that nothing publishes;
 *  - synth refuses an unknown name, a capability that is NOT BUILT, and one missing a prerequisite;
 *  - the four retired switches are refused with the capability that replaced them.
 */
import * as path from 'path';
import { synthesizeApp, type SynthesizedApp } from '../lib/docs/api-contract';
import {
  CAPABILITIES, capabilityDefinition, capabilityErrors, parseCapabilities, resolveCapabilities,
} from '../lib/config/capabilities';
import { DESTRUCTIVE_IF_ABSENT, RETIRED_CONTEXT_KEYS, retiredContextKeyErrors } from '../lib/config/deploy-context';
import { assistantClassifications, DEFAULT_PROFILES_CONFIG, deployedAssistantClassifications, resolveDeploymentProfiles } from '../lib/config/profiles';
import { assistantsStackName } from '../lib/stacks/assistant-profile-stack';
import { assistantParameterViolations, ssmEdgeViolations, type Synthesized } from './deploy-matrix/matrix';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNTH_TIMEOUT_MS = 600_000;

/** The required core: `PersonApi` serves every person route the core and the capabilities declare. */
const CORE = ['Messaging', 'Identity', 'Conversations', 'Archive', 'ChannelFlow', 'PostProcessing', 'PersonApi'];
// The assistant stacks of a deployment that declares no `profiles`: the shipped catalog minus guest and customer.
const ASSISTANTS = deployedAssistantClassifications(resolveDeploymentProfiles(undefined)).map(assistantsStackName);

type Template = { Parameters?: Record<string, { Type?: string; Default?: unknown }> };

const memo = new Map<string, SynthesizedApp>();
function synth(mode: 'athena' | 'aurora', capabilities: string[]): SynthesizedApp {
  const key = `${mode}|${capabilities.join(',')}`;
  if (!memo.has(key)) memo.set(key, synthesizeApp(REPO_ROOT, { id: key, context: { analyticsMode: mode, capabilities } }));
  return memo.get(key)!;
}

/** The stack names without the instance prefix, `ImageGuardrail-*` excluded (one per image-model region). */
function stacksOf(app: SynthesizedApp): string[] {
  const names = Object.keys(app.dependencies);
  const anchor = names.find((s) => s.endsWith('PostProcessing'))!;
  const prefix = anchor.slice(0, -'PostProcessing'.length);
  return names.map((s) => s.slice(prefix.length)).filter((s) => !s.startsWith('ImageGuardrail-')).sort();
}

/** Every SSM parameter any stack resolves at deploy. */
function resolvedParameters(app: SynthesizedApp): string[] {
  return Object.values(app.templates).flatMap((t) => Object.values((t as Template).Parameters ?? {})
    .filter((p) => String(p.Type ?? '').startsWith('AWS::SSM::Parameter::Value') && typeof p.Default === 'string')
    .map((p) => p.Default as string));
}

/** A capability's own stacks plus those of everything it requires, transitively. */
function stacksWith(name: string): string[] {
  const def = capabilityDefinition(name)!;
  return [...def.stacks, ...def.requires.flatMap(stacksWith)];
}

/** Why a synthesis failed: the CDK app's own message. */
function synthFailure(context: Record<string, unknown>): string {
  try {
    synthesizeApp(REPO_ROOT, { id: 'refused', context: { analyticsMode: 'athena', ...context } });
  } catch (err) {
    const e = err as { message?: unknown; stderr?: unknown };
    return `${String(e.message ?? '')}\n${e.stderr ? String(e.stderr) : ''}`;
  }
  throw new Error(`synth succeeded with ${JSON.stringify(context)}, which it must refuse`);
}

describe('the capability registry', () => {
  it('parses the forms the context carries: an array, a comma-separated string, a JSON array, and absent', () => {
    expect(parseCapabilities(['chat', ' admin '])).toEqual(['chat', 'admin']);
    expect(parseCapabilities('chat,admin')).toEqual(['chat', 'admin']);
    expect(parseCapabilities('["chat","admin"]')).toEqual(['chat', 'admin']);
    expect(parseCapabilities(undefined)).toEqual([]);
    expect(parseCapabilities('')).toEqual([]);
  });

  it('refuses an unknown name, a capability that is not built, and a missing prerequisite, each named', () => {
    expect(capabilityErrors(['bogus'])).toEqual([expect.stringMatching(/^"bogus" is not a capability; the registry .* declares /)]);
    expect(capabilityErrors(['battle'])).toEqual(['"battle" requires "experiments", which is not declared']);
    for (const def of CAPABILITIES.filter((c) => c.notBuilt)) {
      expect(capabilityErrors([def.name, ...def.requires])).toEqual([`"${def.name}" cannot be declared: ${def.notBuilt}`]);
      expect(def.notBuilt).toMatch(/NOT BUILT|not in this code base/);
    }
    expect(() => resolveCapabilities(['battle', 'experiments', 'chat'])).not.toThrow();
  });

  it('builds every capability it does not refuse, and names a distinct set of stacks for each', () => {
    for (const def of CAPABILITIES) expect({ name: def.name, factory: !!def.build !== !!def.notBuilt }).toEqual({ name: def.name, factory: true });
    const stacks = CAPABILITIES.flatMap((c) => c.stacks);
    expect(new Set(stacks).size).toBe(stacks.length);
    for (const def of CAPABILITIES) for (const r of def.requires) expect(capabilityDefinition(r)).toBeDefined();
  });

  it('holds meetings as one entry, requiring chat, refused until its stack lands', () => {
    const meetings = capabilityDefinition('meetings')!;
    expect(meetings.requires).toEqual(['chat']);
    expect(meetings.stacks).toEqual(['Meetings']);
    expect(meetings.notBuilt).toBeDefined();
  });

  it('retires the four switches the list replaces, and treats an absent list as destructive', () => {
    for (const key of ['enableBattle', 'enableAdminApp', 'enableAdminNotificationChannel', 'enableMeetings']) {
      expect(RETIRED_CONTEXT_KEYS[key]).toMatch(/capabilit/);
      expect(retiredContextKeyErrors((k) => (k === key ? 'true' : undefined))).toHaveLength(1);
      expect(DESTRUCTIVE_IF_ABSENT).not.toContain(key);
    }
    expect(DESTRUCTIVE_IF_ABSENT).toContain('capabilities');
  });

  it('deploys an assistant stack for every conversational classification the registry declares, and refuses one with no topology', () => {
    expect(deployedAssistantClassifications(DEFAULT_PROFILES_CONFIG)).toEqual(assistantClassifications());
    expect(assistantClassifications()).toEqual(['basic', 'standard', 'premium', 'guest', 'customer']);
    // The outside two deploy only where the deployment declares them (`profiles`).
    expect(deployedAssistantClassifications(resolveDeploymentProfiles(undefined))).toEqual(['basic', 'standard', 'premium']);
    const unserved = {
      ...DEFAULT_PROFILES_CONFIG,
      classifications: DEFAULT_PROFILES_CONFIG.classifications.map((c) => (c.value === 'standard' ? { ...c, topology: undefined } : c)),
    };
    expect(() => deployedAssistantClassifications(unserved)).toThrow(/standard declare no topology/);
  });
});

describe.each(['athena', 'aurora'] as const)('a deployment that declares nothing (%s)', (mode) => {
  let app: SynthesizedApp;
  beforeAll(() => { app = synth(mode, []); }, SYNTH_TIMEOUT_MS);

  it('is the core and one assistant stack per declared classification, and nothing else', () => {
    expect(stacksOf(app)).toEqual([...CORE, ...ASSISTANTS].sort());
  });

  it('deploys every SSM reader after its writer, and nothing before the assistant stacks reads theirs', () => {
    expect(ssmEdgeViolations(app as unknown as Synthesized)).toEqual([]);
    expect(assistantParameterViolations(app as unknown as Synthesized)).toEqual([]);
  });

  it('resolves no battle or experiments parameter: nothing it reads at deploy is published by an undeclared stack', () => {
    const optional = resolvedParameters(app).filter((p) => /\/shared\/(tables\/(experiments|battle|channel-battle)|battle-)/.test(p));
    expect(optional).toEqual([]);
    // Non-vacuity: the core does resolve the shared contract it publishes.
    expect(resolvedParameters(app).some((p) => p.endsWith('/shared/tables/agent-tasks-arn'))).toBe(true);
  });
});

describe.each(['athena', 'aurora'] as const)('a deployment that declares every built capability (%s)', (mode) => {
  let app: SynthesizedApp;
  const built = CAPABILITIES.filter((c) => !c.notBuilt).map((c) => c.name);
  beforeAll(() => { app = synth(mode, built); }, SYNTH_TIMEOUT_MS);

  it('deploys every SSM reader after its writer, and nothing before the assistant stacks reads theirs', () => {
    expect(ssmEdgeViolations(app as unknown as Synthesized)).toEqual([]);
    expect(assistantParameterViolations(app as unknown as Synthesized)).toEqual([]);
  });
});

describe('each built capability adds its own stacks and nothing else (athena)', () => {
  const built = CAPABILITIES.filter((c) => !c.notBuilt);

  it.each(built.map((c) => [c.name]))('%s', (name) => {
    const declared = [name, ...capabilityDefinition(name)!.requires];
    const app = synth('athena', declared);
    expect(stacksOf(app)).toEqual([...CORE, ...ASSISTANTS, ...stacksWith(name)].sort());
  }, SYNTH_TIMEOUT_MS);

  it('every built capability at once', () => {
    const app = synth('athena', built.map((c) => c.name));
    expect(stacksOf(app)).toEqual([...CORE, ...ASSISTANTS, ...built.flatMap((c) => c.stacks)].sort());
  }, SYNTH_TIMEOUT_MS);
});

describe('synth refuses what it cannot build, naming each reason', () => {
  it('an unknown name, a capability that is not built, and a missing prerequisite', () => {
    const text = synthFailure({ capabilities: ['bogus', 'meetings', 'battle'] });
    expect(text).toContain('"bogus" is not a capability');
    expect(text).toContain(`"meetings" cannot be declared: ${capabilityDefinition('meetings')!.notBuilt}`);
    expect(text).toContain('"battle" requires "experiments", which is not declared');
  }, SYNTH_TIMEOUT_MS);

  it('a retired switch, naming the capability that replaced it', () => {
    const text = synthFailure({ enableBattle: 'true', enableAdminApp: 'true' });
    expect(text).toContain(RETIRED_CONTEXT_KEYS.enableBattle);
    expect(text).toContain(RETIRED_CONTEXT_KEYS.enableAdminApp);
  }, SYNTH_TIMEOUT_MS);
});
