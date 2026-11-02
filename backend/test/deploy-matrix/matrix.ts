/**
 * THE CHECKS EVERY CONFIGURATION FILE RUNS. One file per configuration calls `describeConfiguration`,
 * so the test sharder spreads the synthesis across shards rather than running all of it in one.
 *
 * Synthesis is memoized per (configuration, mode) within a file: the configuration's own app is built
 * once per mode in `beforeAll`, and the previous configuration's app is built only by the additivity
 * check, only after this configuration's own stack set is right (an additivity diff against the wrong
 * stack set says nothing).
 *
 * Read from the synthesized app and its manifest, so the deploy order is the one `cdk deploy --all`
 * uses rather than a copy of `bin/backend.ts`.
 */
import { isDeepStrictEqual } from 'util';
import * as path from 'path';
import { synthesizeApp, type SynthesizedApp } from '../../lib/docs/api-contract';
import {
  ADMIN_BACKEND_STACKS,
  ADMIN_INTERFACE_STACK,
  ANALYTICS_MODES,
  CHAT_INTERFACE_STACK,
  CORE_NOT_BUILT,
  CORE_STACKS,
  INTERFACE_STACKS,
  attachKindOf,
  OUTSIDE_CLASSIFICATIONS,
  configuration,
  contextFor,
  expectedStacks,
  isCoreStack,
  type AnalyticsMode,
  type Configuration,
} from './configurations';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const SYNTH_TIMEOUT_MS = 600_000;

type Resource = { Type: string; Properties?: Record<string, unknown>; Metadata?: unknown };
type Template = {
  Parameters?: Record<string, { Type?: string; Default?: unknown }>;
  Resources?: Record<string, Resource>;
  Outputs?: Record<string, unknown>;
  Conditions?: Record<string, unknown>;
};

/** A synthesized configuration, with stack names as the configurations name them (no instance prefix). */
export interface Synthesized {
  /** Stack name -> template. */
  templates: Record<string, Template>;
  /** Stack name -> the stacks it depends on directly. */
  dependencies: Record<string, string[]>;
}

const memo = new Map<string, Synthesized>();

/**
 * The instance prefix, read from the app rather than assumed: `PostProcessing` is a stack in every
 * configuration and in the layout the app builds today, so whatever precedes it is the prefix.
 */
function prefixOf(app: SynthesizedApp): string {
  const anchor = Object.keys(app.dependencies).find((s) => s.endsWith('PostProcessing'));
  if (!anchor) throw new Error('the synthesized app has no PostProcessing stack to read the instance prefix from');
  return anchor.slice(0, -'PostProcessing'.length);
}

export function synthesize(config: Configuration, mode: AnalyticsMode): Synthesized {
  const key = `${config.id}|${mode}`;
  const cached = memo.get(key);
  if (cached) return cached;
  const app = synthesizeApp(REPO_ROOT, { id: key, context: contextFor(config, mode) });
  const prefix = prefixOf(app);
  const strip = (s: string): string => (s.startsWith(prefix) ? s.slice(prefix.length) : s);
  const out: Synthesized = { templates: {}, dependencies: {} };
  for (const [stack, t] of Object.entries(app.templates)) out.templates[strip(stack)] = t as Template;
  for (const [stack, deps] of Object.entries(app.dependencies)) out.dependencies[strip(stack)] = deps.map(strip);
  memo.set(key, out);
  return out;
}

/* ─── the stack set ─────────────────────────────────────────────────────────────────────────── */

/** Stack names compare case-insensitively: a classification's casing in a stack id is the builder's choice. */
const norm = (s: string): string => s.toLowerCase();

/** The synthesized stack names, `ImageGuardrail-*` excluded (one per image-model region, derived, not declared). */
export function stackSet(app: Synthesized): string[] {
  return Object.keys(app.dependencies).filter((s) => !/^ImageGuardrail-/.test(s)).sort();
}

function expectStackSet(app: Synthesized, config: Configuration): void {
  expect(stackSet(app).map(norm).sort()).toEqual(expectedStacks(config).map(norm).sort());
}

/**
 * The core under its target names, less the stacks no work has built yet (`CORE_NOT_BUILT`), so the
 * component rule is read over the real core rather than vacuously over none. A not-built stack that
 * exists is refused, so its entry is deleted by the work that builds it.
 */
function expectTargetCore(app: Synthesized): void {
  const present = stackSet(app).map(norm);
  const missing = CORE_STACKS.filter((s) => !CORE_NOT_BUILT[s] && !present.includes(norm(s)));
  expect({ missingCore: missing }).toEqual({ missingCore: [] });
  const stale = Object.keys(CORE_NOT_BUILT).filter((s) => present.includes(norm(s)));
  expect({ builtButListedAsNotBuilt: stale }).toEqual({ builtButListedAsNotBuilt: [] });
  expect(stackSet(app).some((s) => ASSISTANT_STACK.test(s))).toBe(true);
}

/* ─── the component rule ────────────────────────────────────────────────────────────────────── */

function dependsOnTransitively(app: Synthesized, stack: string): Set<string> {
  const seen = new Set<string>();
  const walk = (s: string): void => {
    for (const d of app.dependencies[s] ?? []) if (!seen.has(d)) { seen.add(d); walk(d); }
  };
  walk(stack);
  return seen;
}

/** Every way the synthesized app breaks the component rule, as one line each. */
export function componentRuleViolations(app: Synthesized): string[] {
  const stacks = Object.keys(app.dependencies);
  const has = (name: string): boolean => stacks.some((s) => norm(s) === norm(name));
  const isAdminBackend = (s: string): boolean => (ADMIN_BACKEND_STACKS as readonly string[]).some((a) => norm(a) === norm(s));
  const isInterface = (s: string): boolean => (INTERFACE_STACKS as readonly string[]).some((i) => norm(i) === norm(s));
  const violations: string[] = [];

  for (const s of stacks.filter(isCoreStack)) {
    for (const d of dependsOnTransitively(app, s)) {
      if (isAdminBackend(d) || isInterface(d)) violations.push(`core stack ${s} depends on ${d}`);
    }
  }
  for (const s of stacks.filter((x) => norm(x) === norm(CHAT_INTERFACE_STACK))) {
    for (const d of dependsOnTransitively(app, s)) {
      if (!isCoreStack(d)) violations.push(`${s} depends on ${d}, which is not in the core`);
    }
  }
  // The admin backend sits on the core and on the capabilities it administers (the experiment routes on
  // the Experiments stack's table), never on an interface.
  for (const s of stacks.filter(isAdminBackend)) {
    for (const d of dependsOnTransitively(app, s)) {
      if (isInterface(d)) violations.push(`admin backend stack ${s} depends on ${d}, which is an interface stack`);
    }
  }
  // The admin interface sits on the admin backend: what it deploys on directly is the core or the admin
  // backend. What the admin backend sits on in turn (a capability it administers) is its own business.
  for (const s of stacks.filter((x) => norm(x) === norm(ADMIN_INTERFACE_STACK))) {
    for (const d of app.dependencies[s] ?? []) {
      if (!isCoreStack(d) && !isAdminBackend(d)) violations.push(`${s} depends on ${d}, which is neither the core nor the admin backend`);
    }
  }
  const backendPresent = ADMIN_BACKEND_STACKS.map(has);
  if (backendPresent.some(Boolean) && !backendPresent.every(Boolean)) {
    violations.push(`the admin backend is partly present: ${ADMIN_BACKEND_STACKS.filter((_, i) => backendPresent[i]).join(', ')} without the rest`);
  }
  if (has(ADMIN_INTERFACE_STACK) && !backendPresent.every(Boolean)) {
    violations.push(`${ADMIN_INTERFACE_STACK} is present without the admin backend`);
  }
  return violations;
}

/* ─── additivity ────────────────────────────────────────────────────────────────────────────── */

/** A template with what changes between two identical syntheses removed: CDK metadata. */
function comparable(t: Template): Template {
  const resources: Record<string, Resource> = {};
  for (const [id, r] of Object.entries(t.Resources ?? {})) {
    if (r.Type === 'AWS::CDK::Metadata') continue;
    // A custom resource stamped with the synthesis time (the Aurora archive's schema and IAM-auth setup,
    // `Timestamp: Date.now()`, so each deploy re-runs them) differs between any two syntheses; the stamp
    // is not a change in what the stack holds.
    const stamped = (r.Type === 'AWS::CloudFormation::CustomResource' || r.Type.startsWith('Custom::')) && r.Properties && 'Timestamp' in r.Properties;
    const properties = stamped ? (({ Timestamp: _stamp, ...rest }) => rest)(r.Properties as Record<string, unknown>) : r.Properties;
    resources[id] = { Type: r.Type, Properties: properties };
  }
  return { Parameters: t.Parameters ?? {}, Resources: resources, Outputs: t.Outputs ?? {}, Conditions: t.Conditions ?? {} };
}

function withoutEnvironment(r: Resource): Resource {
  if (r.Type !== 'AWS::Lambda::Function' || !r.Properties) return r;
  const { Environment: _environment, ...rest } = r.Properties;
  return { ...r, Properties: rest };
}

/** A CDK cross-stack reference's export: `<stack>:ExportsOutput...`, written when another stack reads a value. */
const CROSS_STACK_EXPORT = /:ExportsOutput/;

/**
 * `next` without the cross-stack exports `prev` lacks. A capability whose new stack reads a core value (the
 * admin backend reading the message stream) makes CDK add an export to the core stack that owns it. That
 * changes no resource of the core and is how the new stack depends on it, so it is not a change to the core.
 * An export that is removed, or one that changes, still is.
 */
function withoutAddedCrossStackExports(prev: Template, next: Template): Template {
  const outputs: Record<string, unknown> = {};
  for (const [id, o] of Object.entries(next.Outputs ?? {})) {
    const name = (o as { Export?: { Name?: unknown } })?.Export?.Name;
    const added = !(id in (prev.Outputs ?? {})) && typeof name === 'string' && CROSS_STACK_EXPORT.test(name);
    if (!added) outputs[id] = o;
  }
  return { ...next, Outputs: outputs };
}

/** A nested stack's template, which CDK names `<parent><construct id><hash>.nested`. */
const NESTED = /\.nested$/;

/**
 * The stack a template belongs to: itself, or for a nested stack's template the top-level stack whose name it
 * starts with (the longest, so `AdminServices` and not a shorter stack it happens to begin with). A nested
 * stack is part of its parent, so it may change exactly as its parent may.
 */
export function owningStackOf(template: string, stacks: readonly string[]): string {
  if (!NESTED.test(template)) return template;
  const parents = stacks.filter((s) => !NESTED.test(s) && template.startsWith(s)).sort((a, b) => b.length - a.length);
  return parents[0] ?? template;
}

/** Every change from `before` to `after` outside the attach points, as one line each. */
export function additivityViolations(before: Synthesized, after: Synthesized): string[] {
  const violations: string[] = [];
  const afterByNorm = new Map(Object.keys(after.templates).map((s) => [norm(s), s]));
  const stacks = Object.keys(before.templates);
  for (const stack of stacks) {
    const counterpart = afterByNorm.get(norm(stack));
    if (!counterpart) { violations.push(`${stack} is gone: a capability added must never remove a stack`); continue; }
    const prev = comparable(before.templates[stack]);
    const next = withoutAddedCrossStackExports(prev, comparable(after.templates[counterpart]));
    const kind = attachKindOf(owningStackOf(stack, stacks));
    if (kind === 'any') continue;
    if (kind === 'none') {
      if (!isDeepStrictEqual(prev, next)) violations.push(`${stack} changed, and it is not an attach point`);
      continue;
    }
    const prevResources = prev.Resources ?? {};
    const nextResources = next.Resources ?? {};
    for (const [id, r] of Object.entries(prevResources)) {
      if (!nextResources[id]) violations.push(`${stack}: ${id} (${r.Type}) is removed`);
      else if (nextResources[id].Type !== r.Type) violations.push(`${stack}: ${id} changes type ${r.Type} -> ${nextResources[id].Type}`);
    }
    for (const id of Object.keys(prev.Outputs ?? {})) {
      if (!(id in (next.Outputs ?? {}))) violations.push(`${stack}: output ${id} is removed`);
    }
    if (kind === 'env-only' || kind === 'env-and-add') {
      if (kind === 'env-only') {
        for (const id of Object.keys(nextResources)) {
          if (!prevResources[id]) violations.push(`${stack}: ${id} (${nextResources[id].Type}) is added, and this stack may change only its environment`);
        }
      }
      for (const [id, r] of Object.entries(prevResources)) {
        const n = nextResources[id];
        if (n && n.Type === r.Type && !isDeepStrictEqual(withoutEnvironment(r), withoutEnvironment(n))) {
          violations.push(`${stack}: ${id} (${r.Type}) changes beyond its environment`);
        }
      }
      if (!isDeepStrictEqual(prev.Outputs, next.Outputs)) violations.push(`${stack}: its outputs change, and this stack may change only its environment`);
    }
  }
  return violations;
}

/* ─── a classification deploys on its own ───────────────────────────────────────────────────── */

/** A Lambda function's environment variables, or none. */
function environmentOf(r: Resource | undefined): Record<string, unknown> {
  if (!r || r.Type !== 'AWS::Lambda::Function') return {};
  const env = (r.Properties?.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables;
  return env ?? {};
}

/** True for a CDK cross-stack export: how a new stack reads a core value, not a change in what the core holds. */
function isCrossStackExport(o: unknown): boolean {
  const name = (o as { Export?: { Name?: unknown } })?.Export?.Name;
  return typeof name === 'string' && CROSS_STACK_EXPORT.test(name);
}

/** The stack names, top-level and nested, of the classification's own stacks: its `Assistants-<classification>`. */
function ownsTemplate(template: string, stacks: readonly string[], classification: string): boolean {
  return norm(owningStackOf(template, stacks)) === norm(`Assistants-${classification}`);
}

/**
 * EVERY WAY TWO SYNTHESES THAT DIFFER BY ONE CLASSIFICATION DIFFER OUTSIDE THAT CLASSIFICATION'S OWN STACK,
 * as one line each, in words that do not depend on the direction: the same lines come back whether the
 * classification is added (`before` lacks it) or removed (`after` lacks it).
 *
 *  - a stack, a resource, a parameter, an output or a condition present on one side only;
 *  - a resource that differs beyond a Lambda function's environment;
 *  - a Lambda environment variable that differs, once per stack and variable (`<stack>: environment <VAR>`),
 *    because the variable is the coupling and naming every function that carries it says nothing more;
 *  - a stack that deploys after the classification's own stack (`<stack>: deploys after Assistants-<c>`),
 *    which could not be deployed, or the classification removed, without it.
 *
 * A cross-stack export present on one side only is not a change, as in `additivityViolations`.
 */
export function classificationIndependenceViolations(before: Synthesized, after: Synthesized, classification: string): string[] {
  const out = new Set<string>();
  const own = `Assistants-${classification}`;
  const all = [...new Set([...Object.keys(before.templates), ...Object.keys(after.templates)])].sort();
  for (const stack of all) {
    if (ownsTemplate(stack, all, classification)) continue;
    const a = before.templates[stack];
    const b = after.templates[stack];
    if (!a || !b) { out.add(`${stack}: the stack exists on one side only`); continue; }
    const ca = comparable(a);
    const cb = comparable(b);
    for (const section of ['Parameters', 'Outputs', 'Conditions'] as const) {
      const pa = (ca[section] ?? {}) as Record<string, unknown>;
      const pb = (cb[section] ?? {}) as Record<string, unknown>;
      const singular = section.slice(0, -1).toLowerCase();
      for (const id of [...new Set([...Object.keys(pa), ...Object.keys(pb)])].sort()) {
        if (!(id in pa) || !(id in pb)) {
          if (section === 'Outputs' && isCrossStackExport(pa[id] ?? pb[id])) continue;
          out.add(`${stack}: ${singular} ${id} exists on one side only`);
        } else if (!isDeepStrictEqual(pa[id], pb[id])) {
          out.add(`${stack}: ${singular} ${id} differs`);
        }
      }
    }
    const ra = ca.Resources ?? {};
    const rb = cb.Resources ?? {};
    for (const id of [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort()) {
      const x = ra[id];
      const y = rb[id];
      if (!x || !y) { out.add(`${stack}: ${id} (${(x ?? y).Type}) exists on one side only`); continue; }
      if (isDeepStrictEqual(x, y)) continue;
      if (x.Type !== y.Type || !isDeepStrictEqual(withoutEnvironment(x), withoutEnvironment(y))) {
        out.add(`${stack}: ${id} (${x.Type}) differs`);
      }
      const ex = environmentOf(x);
      const ey = environmentOf(y);
      for (const v of [...new Set([...Object.keys(ex), ...Object.keys(ey)])]) {
        if (!isDeepStrictEqual(ex[v], ey[v])) out.add(`${stack}: environment ${v}`);
      }
    }
  }
  for (const side of [before, after]) {
    for (const [stack, deps] of Object.entries(side.dependencies)) {
      if (norm(stack) === norm(own)) continue;
      if (deps.some((d) => norm(d) === norm(own))) out.add(`${stack}: deploys after ${own}`);
    }
  }
  return [...out].sort();
}

/* ─── every SSM read has an edge to its writer ──────────────────────────────────────────────── */

/** The per-classification parameters a stack that deploys before the assistant stacks must never resolve. */
const CLASSIFICATION_PUBLISHED = /\/assistant\/[^/]+\/(router-arn|task-service-arn|processor-arn)$/;

/** A stack holding a classification's assistants. */
const ASSISTANT_STACK = /^Assistants-.+$/;

/** Parameter name -> the stacks that publish it as an `AWS::SSM::Parameter` with a literal name. */
function publishers(app: Synthesized): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [stack, t] of Object.entries(app.templates)) {
    for (const r of Object.values(t.Resources ?? {})) {
      const name = r.Properties?.Name;
      if (r.Type !== 'AWS::SSM::Parameter' || typeof name !== 'string') continue;
      out.set(name, [...(out.get(name) ?? []), stack]);
    }
  }
  return out;
}

/** The SSM parameter names a stack's template resolves at deploy. */
function resolvedAtDeploy(t: Template): string[] {
  return Object.values(t.Parameters ?? {})
    .filter((p) => String(p.Type ?? '').startsWith('AWS::SSM::Parameter::Value') && typeof p.Default === 'string')
    .map((p) => p.Default as string);
}

/**
 * A stack that names a parameter published by a stack it does not deploy after deploys against nothing
 * on a first install ("Unable to fetch parameters"), and succeeds on every redeploy after, which is why
 * the defect survives in a development account. A stack that deploys before the parameter's publisher
 * reads it by name at call time instead (`resolveRouterArn` in `lambda/src/lib/router-arn.ts`).
 */
export function ssmEdgeViolations(app: Synthesized): string[] {
  const published = publishers(app);
  const violations: string[] = [];
  for (const [stack, t] of Object.entries(app.templates)) {
    const before = dependsOnTransitively(app, stack);
    for (const name of resolvedAtDeploy(t)) {
      const owners = published.get(name) ?? [];
      if (owners.length && !owners.some((o) => o === stack || before.has(o))) {
        violations.push(`${stack} resolves ${name}, published by ${owners.join(', ')}`);
      }
    }
  }
  return violations;
}

/**
 * Independent of the publisher map, so a parameter whose publisher this synthesis does not see (a name
 * rendered from a token) is still refused when its stack deploys before the assistant stacks.
 */
export function assistantParameterViolations(app: Synthesized): string[] {
  const published = publishers(app);
  const assistantStacks = Object.keys(app.dependencies).filter((s) => ASSISTANT_STACK.test(s));
  const violations: string[] = [];
  for (const [stack, t] of Object.entries(app.templates)) {
    const before = dependsOnTransitively(app, stack);
    if (assistantStacks.every((c) => c === stack || before.has(c))) continue;
    for (const name of resolvedAtDeploy(t)) {
      if (!CLASSIFICATION_PUBLISHED.test(name)) continue;
      if ((published.get(name) ?? []).some((o) => o === stack || before.has(o))) continue;
      violations.push(`${stack} resolves ${name}`);
    }
  }
  return violations;
}

/** The logical ids a parameter's value names by `Ref`, whether a single `Ref` or a joined group. */
function refsIn(value: unknown): string[] {
  return (JSON.stringify(value ?? null).match(/"Ref":"([^"]+)"/g) ?? []).map((m) => m.slice(7, -1));
}

/**
 * EVERY ALARM THE APP CREATES IS PUBLISHED BY NAME, IN ITS OWN TEMPLATE (`publishAlarmNames`). The ops
 * assistant reads alarm state by name only, so an alarm missing from the published list is one it never
 * reports; a template whose alarms another template publishes would name them across a stack boundary.
 * Nested stacks are their own templates and are held to the same rule.
 */
export function alarmPublicationViolations(app: Synthesized): string[] {
  const violations: string[] = [];
  for (const [stack, t] of Object.entries(app.templates)) {
    const resources = t.Resources ?? {};
    const alarms = Object.entries(resources).filter(([, r]) => r.Type === 'AWS::CloudWatch::Alarm').map(([id]) => id);
    const published = new Set(Object.values(resources)
      .filter((r) => r.Type === 'AWS::SSM::Parameter' && /\/alarms\//.test(String(r.Properties?.Name ?? '')))
      .flatMap((r) => refsIn(r.Properties?.Value)));
    for (const id of alarms) if (!published.has(id)) violations.push(`${stack} does not publish alarm ${id}`);
    for (const id of published) if (!alarms.includes(id)) violations.push(`${stack} publishes ${id}, which is not an alarm of its own`);
  }
  return violations;
}

/* ─── the suite each configuration file runs ────────────────────────────────────────────────── */

/** Why a synthesis failed: the CDK app's own message, from the child process's stderr. */
function failureText(err: unknown): Error {
  const e = err as { stderr?: unknown; message?: unknown };
  return new Error(`${String(e?.message ?? '')}\n${e?.stderr ? String(e.stderr) : ''}`);
}

/**
 * EVERY CHECK BINDS. A configuration declares only built capabilities (`the-matrix-covers-every-configuration`
 * refuses one that declares another), so its synthesis, its stack set, the component rule, its SSM edges and
 * its additivity against the configuration before it are ordinary tests, none an expected failure.
 */
export function describeConfiguration(id: string): void {
  const config = configuration(id);

  describe.each(ANALYTICS_MODES)(`deploy matrix ${config.id}: ${config.summary} (%s)`, (mode) => {
    let app: Synthesized;
    let failure: unknown;
    beforeAll(() => {
      try {
        app = synthesize(config, mode);
      } catch (err) {
        failure = err;
      }
    }, SYNTH_TIMEOUT_MS);

    // The app synthesizes, and its deploy order holds every SSM read.
    it('reads a deploy order from the manifest', () => {
      if (failure) throw failureText(failure);
      // Non-vacuity: the edge checks below pass over an empty graph.
      expect(Object.keys(app.dependencies).length).toBeGreaterThan(1);
      expect(Object.values(app.dependencies).some((deps) => deps.length > 0)).toBe(true);
      expect(Object.keys(app.dependencies).some((s) => ASSISTANT_STACK.test(s))).toBe(true);
    });

    it('every SSM parameter a stack resolves at deploy is published by a stack it deploys after', () => {
      if (failure) throw failureText(failure);
      expect(ssmEdgeViolations(app)).toEqual([]);
    });

    it('a stack that deploys before an assistant stack resolves none of its router, task service or processor', () => {
      if (failure) throw failureText(failure);
      expect(assistantParameterViolations(app)).toEqual([]);
    });

    it('publishes every alarm it creates by name, in the template that owns it', () => {
      if (failure) throw failureText(failure);
      // Non-vacuity: every configuration declares alarms (the channel flow's at least).
      expect(Object.values(app.templates).some((t) => Object.values(t.Resources ?? {})
        .some((r) => r.Type === 'AWS::CloudWatch::Alarm'))).toBe(true);
      expect(alarmPublicationViolations(app)).toEqual([]);
    });

    // The stack set is exactly the configuration's.
    it('stands up exactly the stacks it declares', () => {
      if (failure) throw failureText(failure);
      expectStackSet(app, config);
    });

    // An outside classification deploys only where the configuration declares it.
    it('stands up an outside classification\'s assistants only where it declares it', () => {
      if (failure) throw failureText(failure);
      const outside = OUTSIDE_CLASSIFICATIONS.map((c) => `Assistants-${c}`);
      const declared = outside.filter((s) => config.classifications.some((c) => `Assistants-${c}` === s));
      expect(stackSet(app).filter((s) => outside.map(norm).includes(norm(s))).map(norm).sort()).toEqual(declared.map(norm).sort());
    });

    // The core carries its target names, and nothing in it depends on the admin backend or an interface stack.
    it('keeps the component rule over the core it has', () => {
      if (failure) throw failureText(failure);
      expectTargetCore(app);
      expect(componentRuleViolations(app)).toEqual([]);
    });

    if (config.previous) {
      const previous = configuration(config.previous);
      it(`changes nothing of ${previous.id} outside its attach points`, () => {
        if (failure) throw failureText(failure);
        expectStackSet(app, config);
        const before = synthesize(previous, mode);
        expectStackSet(before, previous);
        expect(additivityViolations(before, app)).toEqual([]);
      }, SYNTH_TIMEOUT_MS);
    }
  });
}

/**
 * A CLASSIFICATION DEPLOYS AND IS REMOVED ON ITS OWN. For a configuration that adds one classification to
 * another (`addsClassification`), in both analytics modes:
 *
 *  - the stack set is the other configuration's plus `Assistants-<classification>` and nothing else;
 *  - adding it and removing it change nothing outside that stack.
 *
 * There is no list of exceptions, and none is to be added: a line `classificationIndependenceViolations` reports
 * is a coupling to remove, by moving what the classification adds into its own stack or by making the shared
 * stack read it at runtime (ADR-057).
 */
export function describeClassificationIndependence(id: string): void {
  const config = configuration(id);
  if (!config.addsClassification) throw new Error(`${id} declares no addsClassification`);
  const { to, classification } = config.addsClassification;
  const base = configuration(to);
  const own = `Assistants-${classification}`;

  describe.each(ANALYTICS_MODES)(`deploy matrix ${config.id}: ${classification} deploys on its own beside ${base.id} (%s)`, (mode) => {
    it(`stands up ${base.id}'s stacks and ${own}, and nothing else`, () => {
      const withIt = synthesize(config, mode);
      const without = synthesize(base, mode);
      expect(stackSet(withIt).map(norm).sort()).toEqual([...stackSet(without), own].map(norm).sort());
    }, SYNTH_TIMEOUT_MS);

    for (const [direction, from, toConfig] of [['adding', base, config], ['removing', config, base]] as const) {
      it(`${direction} ${classification} changes nothing outside ${own}`, () => {
        const before = synthesize(from, mode);
        const after = synthesize(toConfig, mode);
        // The diff reads the two sides in the order the deploy meets them; its lines do not depend on it.
        const reported = classificationIndependenceViolations(before, after, classification);
        // Non-vacuity: the classification's own stack is there, on the side that has it, to be left out.
        const withIt = direction === 'adding' ? after : before;
        expect(Object.keys(withIt.templates).some((s) => norm(s) === norm(own))).toBe(true);
        expect(reported).toEqual([]);
      }, SYNTH_TIMEOUT_MS);
    }
  });
}
