/**
 * The HTTP surface, extracted from the CDK app that deploys it.
 *
 * WHY THIS EXISTS. A developer building their own client needs the method, the path, the authorizer
 * and the throttle that applies. Those facts live in the route tables of a dozen stacks, several built
 * inside loops and behind deployment flags, and a hand-written table of that size drifts: the numbers
 * stay in the document after the code has moved, and nothing fails. This repo has already paid for
 * that twice (the README's e2e headline, the spec-to-test mapping), and the answer both times was the
 * same - render the document from the source and fail the build when the committed copy stops
 * matching. `api-contract-reference.test.ts` is that guard.
 *
 * ── THE EXTRACTION, AND WHY IT IS A SYNTHESIS ────────────────────────────────────────────────────
 *
 * The routes are read from the SYNTHESIZED CloudFormation templates (`AWS::ApiGatewayV2::Api`,
 * `Route`, `Integration`, `Authorizer` and `Stage`), not from the TypeScript that declares them. A regex
 * over the route tables would be cheaper and would be wrong in the ways that matter most to a reader:
 *
 *   - Several routes are declared in a loop, so a source scan counts one route where four are served.
 *   - Which API a route lands on, and which authorizer it takes, is decided by the API stack from the
 *     route's entry (`lib/constructs/http-api.ts`). The template says what a real deployment gets.
 *   - Whether a route exists at all follows from the declared capabilities and deployment flags.
 *
 * Synthesis is the same operation `cdk synth` performs, so what this reads is what CloudFormation
 * would create. It costs a few seconds per variant with asset bundling switched off
 * (`BUNDLING_STACKS` set to an empty list - no Lambda is bundled because no Lambda CODE is read here,
 * only the gateway wiring).
 *
 * ── WHY THE APP IS RUN AS A CHILD PROCESS ────────────────────────────────────────────────────────
 *
 * `bin/backend.ts` is the authority on how the stacks are wired together, and it is a script: it
 * builds one `cdk.App` from context and synthesizes it. Re-implementing that wiring here would create
 * a second, quieter copy of the deployment graph - a new route would be added to the app and silently
 * missing from this reference, which is exactly the drift the file exists to prevent. So the real app
 * is executed, once per variant, with `CDK_CONTEXT_JSON` carrying the variant's context and
 * `CDK_OUTDIR` pointing at a temporary directory, and the templates are read back from there.
 *
 * It runs through `ts-node` in transpile-only mode so the extraction needs no build step for the
 * stacks. `TS_NODE_PREFER_TS_EXTS` makes Node's resolver prefer the sources over any compiled sibling,
 * so this module reads the same app in a developer's tree (where `lib/**\/*.js` exists) as in CI.
 *
 * ── WHAT THE VARIANTS ARE FOR ────────────────────────────────────────────────────────────────────
 *
 * Three deployment choices change the surface, and a table that reports only the default would be
 * wrong for every deployment that made a different one. So each is synthesized and the difference is
 * reported as a derived fact rather than as prose someone has to maintain:
 *
 *   - `analyticsMode` decides which analytics routes are served.
 *   - `issuers` declaring a second issuer (a host app's pool with the one-conversation session) adds no
 *     route: every person route is behind the one edge authorizer for every issuer.
 *   - `sleepMode` adds the paused-deployment probe and the admin sleep and wake routes.
 *
 * A route's `availability` is then computed from the set of variants it appears in, so a route that
 * exists only in one mode says so and a route added tomorrow inherits the same treatment.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BUNDLING_STACKS, OUTDIR_ENV, CONTEXT_ENV } from 'aws-cdk-lib/cx-api';
import { CAPABILITIES } from '../config/capabilities';

/** The generated reference, relative to the repo root. */
export const API_CONTRACT_PATH = path.join('docs', 'reference', 'api-contract.md');

/** The command that rewrites it. Named in the document, and in the guard's failure message. */
export const GEN_COMMAND = 'cd backend && npm run gen-api-contract';

/**
 * Placeholder account and region for the synthesis. Any values work - nothing in the extraction reads
 * them - but they must be CONCRETE, because an environment-agnostic stack renders tokens where a
 * region-bound resource expects a literal.
 */
const SYNTH_ACCOUNT = '123456789012';
const SYNTH_REGION = 'us-east-1';

/** A second issuer: a host app's pool, shaped like a real one, with the one-conversation session. */
const SYNTH_SECOND_ISSUERS = [
  { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true },
  { id: 'host', kind: 'cognito-pool', pool: 'us-east-1_SecondIssuer', audience: 'second-issuer-client', clearance: { oneChannel: 'standard', classifications: ['standard'] } },
];

/**
 * The guest issuer beside the deployment's own pool. Its guest start and guest refresh routes exist only
 * when it is declared: they are its two unauthenticated entry points, not a second path to a feature. So
 * do path B's registration and claim routes, and a customers' pool beside it is what reaches their target.
 * It declares registration approval `admin`, the one value that adds routes: the console's registrations
 * and their approval, on `AdminApi`.
 */
export const SYNTH_GUEST_ISSUERS = [
  SYNTH_SECOND_ISSUERS[0],
  { id: 'guest', kind: 'guest', clearance: { fixed: ['guest'], classifications: ['guest'] }, guest: { registration: { approval: 'admin' } } },
  // Path B's target: a customers' pool reaching the outside customer classification alone.
  { id: 'customers', kind: 'cognito-pool', pool: 'us-east-1_Customers', audience: 'customers-client', clearance: { fixed: ['customer'], classifications: ['customer'] } },
];

/** The console's registration routes, which the guest issuer adds only when it declares approval `admin`. */
const REGISTRATION_APPROVAL_PATH = '/users/guest/registrations';

/** The classifications the guest variant declares: the shipped member ones and the two outside ones the guest issuer needs. */
export const SYNTH_GUEST_PROFILES = ['basic', 'standard', 'premium', 'guest', 'customer'] as const;

/**
 * An invitation-link issuer beside the deployment's own pool (M-10): a `link` invitation's redemption is its
 * one unauthenticated route, and it exists only when this issuer is declared.
 */
export const SYNTH_LINK_ISSUERS = [
  SYNTH_SECOND_ISSUERS[0],
  { id: 'invitation', kind: 'invitation-link', clearance: { fixed: ['basic', 'standard'], classifications: ['basic', 'standard'] } },
];

export interface SynthVariant {
  /** Stable id. Appears in the document only when a route's availability cannot be summarized. */
  id: string;
  /** CDK context, merged over `cdk.json`'s. */
  context: Record<string, unknown>;
}

/**
 * Every capability the registry builds (`lib/config/capabilities.ts`), declared in every variant, so the
 * inventory covers every route a deployment can stand up. A capability adds its own stacks and their
 * routes and re-authorizes no other route, so one synthesis with all of them declared lists each route
 * once; a capability that is NOT BUILT has no routes and is refused at synth.
 */
export const SYNTH_CAPABILITIES: readonly string[] = CAPABILITIES.filter((c) => !c.notBuilt).map((c) => c.name);

/**
 * The connectors a synthesis declares when it declares the `connectors` capability and names none
 * (`connectors` in `deploy.config.json`, `lib/config/connectors.ts`): the capability is refused without one.
 * One of each shape: a connector that subscribes to vendor events (an EventBridge rule on its partner
 * event bus, and no route: no vendor calls an HTTP API) and one that takes per-person grants (the grant
 * routes on `PersonApi`). A synthesis that names its own connectors gets exactly those.
 */
export const SYNTH_CONNECTORS: readonly Record<string, unknown>[] = [
  {
    id: 'pagerduty', vendor: 'pagerduty', subscribes: ['incident.trigger', 'incident.resolve'], classification: 'standard',
    eventSource: 'aws.partner/pagerduty.com/example-agent-echelon',
  },
  { id: 'salesforce', vendor: 'salesforce', grants: { redirectUris: ['http://localhost:5173/connectors/callback'] } },
];

/** A variant's context with `SYNTH_CONNECTORS` filled in when it declares `connectors` and names none. */
export function withDefaultConnectors(context: Record<string, unknown>): Record<string, unknown> {
  const caps = context.capabilities;
  const declares = Array.isArray(caps) ? caps.includes('connectors') : typeof caps === 'string' && caps.split(',').map((s) => s.trim()).includes('connectors');
  return declares && context.connectors === undefined ? { ...context, connectors: SYNTH_CONNECTORS } : context;
}

/**
 * Every deployment shape that changes the HTTP surface.
 *
 * Kept deliberately small. Each entry costs a full app synthesis, and a variant earns its place only
 * by adding, removing or re-authorizing a route: a flag that changes what runs BEHIND the surface
 * rather than the surface is not synthesized here.
 *
 * A flag that gates a route DOES earn a variant, and missing one is invisible - the document renders a
 * complete-looking inventory of whatever was synthesized. `sleepMode` is the only such flag today;
 * `backend/test/api-contract-reference.test.ts` checks that claim against the stack sources rather
 * than leaving it to this comment.
 */
export const SYNTH_VARIANTS: readonly SynthVariant[] = [
  { id: 'athena', context: { analyticsMode: 'athena', capabilities: [...SYNTH_CAPABILITIES] } },
  { id: 'aurora', context: { analyticsMode: 'aurora', capabilities: [...SYNTH_CAPABILITIES] } },
  { id: 'athena+second-issuer', context: { analyticsMode: 'athena', capabilities: [...SYNTH_CAPABILITIES], issuers: SYNTH_SECOND_ISSUERS } },
  // A guest issuer is declared beside the outside classifications it needs (`profiles`, guest and customer).
  { id: 'athena+guest', context: { analyticsMode: 'athena', capabilities: [...SYNTH_CAPABILITIES], issuers: SYNTH_GUEST_ISSUERS, profiles: [...SYNTH_GUEST_PROFILES] } },
  { id: 'athena+invitation-link', context: { analyticsMode: 'athena', capabilities: [...SYNTH_CAPABILITIES], issuers: SYNTH_LINK_ISSUERS } },
  // `sleepMode` is the only flag in the app that gates routes, and it is Aurora-only (the app
  // refuses the combination with Athena). Without this variant the inventory silently omits three
  // routes, one of them unauthenticated, which is precisely the kind of row a reader checks a security
  // claim against.
  { id: 'aurora+sleep', context: { analyticsMode: 'aurora', capabilities: [...SYNTH_CAPABILITIES], sleepMode: true } },
];

/** The variants a deployment gets by taking every default. The `Authorizer` column reports these. */
const DEFAULT_VARIANT_IDS = ['athena', 'aurora'];

export interface RouteRecord {
  /** Stack name as CloudFormation sees it, e.g. `AgentEchelonPersonApi`. */
  stack: string;
  /** The `AWS::ApiGatewayV2::Api` `Name` property. */
  apiName: string;
  method: string;
  /** Full path from the API root, e.g. `/admin/tasks/channel/{channelId}`. */
  path: string;
  /** `AWS_IAM`, `CUSTOM` (a Lambda authorizer) or `NONE`. */
  authorizationType: string;
  /** For a `CUSTOM` route, how long the gateway caches the authorizer's answer, in seconds. Else null. */
  authorizerCacheSeconds: number | null;
  /** The route's own throttle, or the stage's when it has none, or null for the account's limit. */
  throttleRate: number | null;
  throttleBurst: number | null;
  /** The construct id of the Lambda behind the route. */
  integration: string;
  /** The integration's payload format version (`1.0`: the `APIGatewayProxyEvent` shape). */
  payloadFormat: string;
}

export interface SurfaceRecord {
  stack: string;
  apiName: string;
  stage: string;
  /** The stage-wide throttle every route without its own shares. Null for the account's limit. */
  throttleRate: number | null;
  throttleBurst: number | null;
  /** The origins the API's CORS configuration allows, sorted. The gateway answers every preflight. */
  corsOrigins: string[];
}

/** One route, with the variants it appears in and the authorizer each of them serves. */
export interface MergedRoute extends RouteRecord {
  /** Variant ids this route appears in. */
  presentIn: string[];
  /** Availability in a form a reader can act on, e.g. `Aurora analytics mode`. */
  availability: string;
}

export interface ApiContract {
  surfaces: MergedSurface[];
  routes: MergedRoute[];
}

export interface MergedSurface extends SurfaceRecord {
  presentIn: string[];
  availability: string;
}

type Template = { Resources?: Record<string, { Type: string; Properties?: Record<string, unknown> }> };
export type Templates = Record<string, Template>;

/* ─── synthesis ──────────────────────────────────────────────────────────────────────────────── */

/** `cdk.json`'s context, which carries the feature flags the stacks synthesize against. */
function baseContext(backendDir: string): Record<string, unknown> {
  const cdkJson = JSON.parse(fs.readFileSync(path.join(backendDir, 'cdk.json'), 'utf8')) as {
    context?: Record<string, unknown>;
  };
  return { ...(cdkJson.context ?? {}) };
}

/**
 * Run the real CDK app for one variant and return its templates by stack name.
 *
 * The output directory is temporary and removed on the way out: the app runs in a child process, so
 * nothing here holds a synthesizer that would want to write to it again.
 */
export function synthesizeVariant(repoRoot: string, variant: SynthVariant): Templates {
  return synthesizeApp(repoRoot, variant).templates;
}

/** A synthesized app: its templates, and each stack's direct dependencies on other stacks, by stack name. */
export interface SynthesizedApp {
  templates: Templates;
  dependencies: Record<string, string[]>;
}

/**
 * The same synthesis, with the deploy order read from the cloud assembly's manifest. A stack's
 * dependencies there are what `cdk deploy --all` orders by, so a test that asks "does this stack deploy
 * after that one" reads the real graph rather than a copy of `bin/backend.ts`'s `addDependency` calls.
 */
export function synthesizeApp(repoRoot: string, variant: SynthVariant): SynthesizedApp {
  const backendDir = path.join(repoRoot, 'backend');
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-api-contract-'));
  try {
    const context = withDefaultConnectors({
      ...baseContext(backendDir),
      // No Lambda code is read here, only the gateway wiring, so bundling every function would be
      // minutes spent producing bytes nothing looks at.
      [BUNDLING_STACKS]: [],
      ...variant.context,
    });
    execFileSync(process.execPath, ['-r', 'ts-node/register', path.join('bin', 'backend.ts')], {
      cwd: backendDir,
      env: {
        ...process.env,
        TS_NODE_TRANSPILE_ONLY: '1',
        // Prefer the SOURCE over any compiled sibling, so this reads the same app in a developer's
        // tree (where `lib/**/*.js` exists) as in CI (where it does not).
        TS_NODE_PREFER_TS_EXTS: '1',
        [CONTEXT_ENV]: JSON.stringify(context),
        [OUTDIR_ENV]: outdir,
        CDK_DEFAULT_ACCOUNT: SYNTH_ACCOUNT,
        CDK_DEFAULT_REGION: SYNTH_REGION,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });

    const templates: Templates = {};
    for (const file of fs.readdirSync(outdir)) {
      if (!file.endsWith('.template.json')) continue;
      templates[file.replace(/\.template\.json$/, '')] = JSON.parse(
        fs.readFileSync(path.join(outdir, file), 'utf8'),
      ) as Template;
    }
    if (Object.keys(templates).length === 0) {
      throw new Error(`variant "${variant.id}" synthesized no templates`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(outdir, 'manifest.json'), 'utf8')) as {
      artifacts?: Record<string, { type?: string; dependencies?: string[] }>;
    };
    const artifacts = manifest.artifacts ?? {};
    const isStack = (id: string): boolean => artifacts[id]?.type === 'aws:cloudformation:stack';
    const dependencies: Record<string, string[]> = {};
    for (const [id, artifact] of Object.entries(artifacts)) {
      if (isStack(id)) dependencies[id] = (artifact.dependencies ?? []).filter(isStack);
    }
    return { templates, dependencies };
  } finally {
    fs.rmSync(outdir, { recursive: true, force: true });
  }
}


/* ─── extraction ─────────────────────────────────────────────────────────────────────────────── */

function isRef(v: unknown): v is { Ref: string } {
  return typeof v === 'object' && v !== null && typeof (v as { Ref?: unknown }).Ref === 'string';
}

/** Strip CDK's eight-hex-character uniqueness suffix, leaving the construct id a person wrote. */
function constructId(logicalId: string): string {
  return logicalId.replace(/[0-9A-F]{8}$/, '');
}

/** The integration a route targets: `integrations/<id>`, as a `Fn::Join` over a `Ref`. */
function targetIntegration(target: unknown): string | null {
  const text = JSON.stringify(target ?? '');
  const m = /"Ref":"([A-Za-z0-9]+)"/.exec(text);
  return m ? m[1] : null;
}

/** The handler an integration names: its description (`RouteTableApi` writes the construct id), else the URI's. */
function integrationTarget(integration: Record<string, unknown> | undefined): string {
  if (!integration) return '(none)';
  if (typeof integration.Description === 'string' && integration.Description) return integration.Description;
  const uri = JSON.stringify(integration.IntegrationUri ?? '');
  const getAtt = uri.match(/"Fn::GetAtt":\["([A-Za-z0-9]+)","Arn"\]/);
  if (getAtt) return constructId(getAtt[1]);
  return String(integration.IntegrationType ?? '(none)');
}

export interface ExtractedVariant {
  routes: RouteRecord[];
  surfaces: SurfaceRecord[];
}

/**
 * The name a template is reported under. A nested stack's template file is `<parent><construct id><hash>.nested`;
 * it is reported as `<parent>/<construct id>`, which reads as where it is declared and does not move with the hash.
 */
function stackLabel(stack: string, all: readonly string[]): string {
  if (!stack.endsWith('.nested')) return stack;
  const parent = all.filter((p) => !p.endsWith('.nested') && stack.startsWith(p)).sort((x, y) => y.length - x.length)[0];
  if (!parent) return stack;
  return `${parent}/${stack.slice(parent.length, -'.nested'.length).replace(/[0-9A-F]{8}$/, '')}`;
}

type Throttle = { ThrottlingRateLimit?: number; ThrottlingBurstLimit?: number };

/** Every HTTP API route and surface in one variant's templates. */
export function extractVariant(templates: Templates): ExtractedVariant {
  const routes: RouteRecord[] = [];
  const surfaces: SurfaceRecord[] = [];

  for (const file of Object.keys(templates).sort()) {
    const stack = stackLabel(file, Object.keys(templates));
    const resources = templates[file].Resources ?? {};
    const apis = new Map<string, SurfaceRecord>();
    const routeThrottles = new Map<string, Record<string, Throttle>>();

    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type !== 'AWS::ApiGatewayV2::Api') continue;
      const props = (resource.Properties ?? {}) as { Name?: string; CorsConfiguration?: { AllowOrigins?: string[] } };
      apis.set(logicalId, {
        stack,
        apiName: props.Name ?? constructId(logicalId),
        stage: '(none)',
        throttleRate: null,
        throttleBurst: null,
        corsOrigins: [...(props.CorsConfiguration?.AllowOrigins ?? [])].sort(),
      });
    }

    for (const resource of Object.values(resources)) {
      if (resource.Type !== 'AWS::ApiGatewayV2::Stage') continue;
      const props = (resource.Properties ?? {}) as {
        ApiId?: unknown;
        StageName?: string;
        DefaultRouteSettings?: Throttle;
        RouteSettings?: Record<string, Throttle>;
      };
      if (!isRef(props.ApiId)) continue;
      const surface = apis.get(props.ApiId.Ref);
      if (!surface) continue;
      surface.stage = props.StageName ?? '(none)';
      surface.throttleRate = props.DefaultRouteSettings?.ThrottlingRateLimit ?? null;
      surface.throttleBurst = props.DefaultRouteSettings?.ThrottlingBurstLimit ?? null;
      routeThrottles.set(props.ApiId.Ref, props.RouteSettings ?? {});
    }

    const authorizerTtl = new Map<string, number>();
    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type !== 'AWS::ApiGatewayV2::Authorizer') continue;
      const props = (resource.Properties ?? {}) as { AuthorizerResultTtlInSeconds?: number };
      authorizerTtl.set(logicalId, props.AuthorizerResultTtlInSeconds ?? 0);
    }

    for (const resource of Object.values(resources)) {
      if (resource.Type !== 'AWS::ApiGatewayV2::Route') continue;
      const props = (resource.Properties ?? {}) as {
        ApiId?: unknown;
        RouteKey?: string;
        AuthorizationType?: string;
        AuthorizerId?: unknown;
        Target?: unknown;
      };
      if (!isRef(props.ApiId)) continue;
      const surface = apis.get(props.ApiId.Ref);
      if (!surface) continue;
      const key = props.RouteKey ?? '(none) /';
      const [method, ...rest] = key.split(' ');
      const integrationId = targetIntegration(props.Target);
      const integration = integrationId ? resources[integrationId]?.Properties : undefined;
      const own = routeThrottles.get(props.ApiId.Ref)?.[key];
      routes.push({
        stack,
        apiName: surface.apiName,
        method,
        path: rest.join(' '),
        authorizationType: props.AuthorizationType ?? 'NONE',
        authorizerCacheSeconds: isRef(props.AuthorizerId) ? authorizerTtl.get(props.AuthorizerId.Ref) ?? null : null,
        throttleRate: own?.ThrottlingRateLimit ?? surface.throttleRate,
        throttleBurst: own?.ThrottlingBurstLimit ?? surface.throttleBurst,
        integration: integrationTarget(integration),
        payloadFormat: String((integration as { PayloadFormatVersion?: string } | undefined)?.PayloadFormatVersion ?? '(none)'),
      });
    }

    surfaces.push(...apis.values());
  }

  return { routes, surfaces };
}

/* ─── merge across variants ──────────────────────────────────────────────────────────────────── */

const routeKey = (r: RouteRecord): string => `${r.stack}|${r.apiName}|${r.path}|${r.method}`;
const surfaceKey = (s: SurfaceRecord): string => `${s.stack}|${s.apiName}`;

/** Variant ids sharing one context value, e.g. every `analyticsMode: 'athena'` variant. */
function variantsWhere(predicate: (v: SynthVariant) => boolean): string[] {
  return SYNTH_VARIANTS.filter(predicate).map((v) => v.id);
}

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

/**
 * Turn "the variants this appeared in" into something a reader can act on.
 *
 * Falls back to naming the variants when the set matches no known deployment choice, which is the
 * honest answer: a new flag that gates a route will read as an unexplained set here rather than as a
 * confident label that happens to be wrong.
 */
function availabilityOf(presentIn: string[]): string {
  const all = SYNTH_VARIANTS.map((v) => v.id);
  if (sameSet(presentIn, all)) return 'every deployment';
  const athena = variantsWhere((v) => v.context.analyticsMode === 'athena');
  const aurora = variantsWhere((v) => v.context.analyticsMode === 'aurora');
  const declares = (kind: string) => (v: SynthVariant) => Array.isArray(v.context.issuers) && (v.context.issuers as Array<{ kind?: string }>).some((e) => e.kind === kind);
  const declaresGuest = declares('guest');
  const declaresLink = declares('invitation-link');
  const secondIssuer = variantsWhere((v) => v.context.issuers !== undefined && !declaresGuest(v) && !declaresLink(v));
  const guest = variantsWhere(declaresGuest);
  const link = variantsWhere(declaresLink);
  const sleep = variantsWhere((v) => v.context.sleepMode === true);
  if (sameSet(presentIn, athena)) return 'Athena analytics mode';
  if (sameSet(presentIn, aurora)) return 'Aurora analytics mode';
  if (sameSet(presentIn, secondIssuer)) return '`issuers` declares a second issuer';
  if (sameSet(presentIn, guest)) return '`issuers` declares a guest issuer';
  if (sameSet(presentIn, link)) return '`issuers` declares an invitation-link issuer';
  if (sameSet(presentIn, sleep)) return '`sleepMode` set (Aurora mode only)';
  return presentIn.join(', ');
}

/** Merge the per-variant extractions into the contract the document renders. */
export function buildContract(perVariant: Map<string, ExtractedVariant>): ApiContract {
  const routes = new Map<string, MergedRoute>();
  const surfaces = new Map<string, MergedSurface>();

  for (const variantId of SYNTH_VARIANTS.map((v) => v.id)) {
    const extracted = perVariant.get(variantId);
    if (!extracted) continue;

    for (const route of extracted.routes) {
      const key = routeKey(route);
      const existing = routes.get(key);
      if (!existing) {
        routes.set(key, { ...route, presentIn: [variantId], availability: '' });
        continue;
      }
      existing.presentIn.push(variantId);
      // The DEFAULT deployment decides the headline authorizer, whichever variant was seen first.
      if (DEFAULT_VARIANT_IDS.includes(variantId)) {
        existing.authorizationType = route.authorizationType;
        existing.authorizerCacheSeconds = route.authorizerCacheSeconds;
      }
    }

    for (const surface of extracted.surfaces) {
      const key = surfaceKey(surface);
      const existing = surfaces.get(key);
      if (!existing) surfaces.set(key, { ...surface, presentIn: [variantId], availability: '' });
      else existing.presentIn.push(variantId);
    }
  }

  const finish = <T extends { presentIn: string[]; availability: string }>(v: T): T => {
    v.availability = availabilityOf(v.presentIn);
    // A ROUTE A GUEST ISSUER'S SETTING ADDS, which the one guest variant declares, so it reads as the setting.
    const path = (v as { path?: unknown }).path;
    if (typeof path === 'string' && path.startsWith(REGISTRATION_APPROVAL_PATH)) v.availability = '`issuers` declares a guest issuer with `guest.registration.approval: "admin"`';
    return v;
  };

  return {
    surfaces: [...surfaces.values()]
      .map(finish)
      .sort((a, b) => `${a.stack}${a.apiName}`.localeCompare(`${b.stack}${b.apiName}`)),
    routes: [...routes.values()]
      .map(finish)
      .sort((a, b) => routeKey(a).localeCompare(routeKey(b))),
  };
}

/** Synthesize every variant and merge. The whole extraction, for a caller that wants one call. */
export function readApiContract(repoRoot: string): ApiContract {
  const perVariant = new Map<string, ExtractedVariant>();
  for (const variant of SYNTH_VARIANTS) {
    perVariant.set(variant.id, extractVariant(synthesizeVariant(repoRoot, variant)));
  }
  return buildContract(perVariant);
}

/* ─── render ─────────────────────────────────────────────────────────────────────────────────── */

function authorizerCell(route: MergedRoute): string {
  if (route.authorizationType === 'AWS_IAM') return '`AWS_IAM` (SigV4)';
  if (route.authorizationType === 'CUSTOM') {
    return route.authorizerCacheSeconds ? `edge authorizer (cached ${route.authorizerCacheSeconds} s)` : 'edge authorizer (uncached)';
  }
  return `\`${route.authorizationType}\``;
}

function throttleCell(t: { throttleRate: number | null; throttleBurst: number | null }): string {
  if (t.throttleRate === null) return 'account default';
  return `${t.throttleRate} req/s, burst ${t.throttleBurst}`;
}

function corsCell(surface: MergedSurface): string {
  if (surface.corsOrigins.length === 0) return 'none';
  return surface.corsOrigins.map((o) => `\`${o}\``).join(', ');
}

/**
 * Render the reference.
 *
 * Carries NO timestamp and no value that varies between two runs of the same source: the committed
 * file is compared byte-for-byte against a fresh render, so anything run-specific would fail the
 * build every time and teach everyone to regenerate without reading the diff.
 */
export function renderApiContract(contract: ApiContract): string {
  const lines: string[] = [];
  const { routes, surfaces } = contract;

  lines.push('# API contract reference');
  lines.push('');
  lines.push('Do not edit by hand. Generated by synthesizing the CDK app in `backend/bin/backend.ts` and');
  lines.push('reading every `AWS::ApiGatewayV2::Route` out of the resulting CloudFormation templates.');
  lines.push('Regenerate with:');
  lines.push('');
  lines.push('```');
  lines.push(GEN_COMMAND);
  lines.push('```');
  lines.push('');
  lines.push('`api-contract-reference.test.ts` fails the build when this file stops matching a fresh render,');
  lines.push('so a route added to a stack is a route added here.');
  lines.push('');
  lines.push('For what a client must DO with these routes - how to authenticate, which limits apply, what a');
  lines.push('refusal looks like - read [the API guide](../guides/developer/API-GUIDE.md). This file is the');
  lines.push('inventory, not the instructions.');
  lines.push('');
  lines.push('**What a row proves, exactly:** that the deployed gateway serves this method at this path with');
  lines.push('this authorizer. It does not describe the request or response body. No route declares a request');
  lines.push('model, so the shape of a request is enforced by the handler behind it and cannot be read off the');
  lines.push('template.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Routes | ${routes.length} |`);
  lines.push(`| HTTP APIs | ${surfaces.length} |`);
  for (const authorizationType of [...new Set(routes.map((r) => r.authorizationType))].sort()) {
    const n = routes.filter((r) => r.authorizationType === authorizationType).length;
    lines.push(`| ...authorized \`${authorizationType}\` by default | ${n} |`);
  }
  lines.push(`| ...behind the edge authorizer with no result cache | ${
    routes.filter((r) => r.authorizationType === 'CUSTOM' && !r.authorizerCacheSeconds).length} |`);
  lines.push(`| Routes served in every deployment | ${
    routes.filter((r) => r.availability === 'every deployment').length} |`);
  // Called out on its own line rather than left as one authorizationType row among several. An
  // unauthenticated route is the fact a reader is most likely to be checking for and least likely
  // to reconstruct from a count, so the document names them.
  const unauthenticated = routes.filter((r) => r.authorizationType === 'NONE');
  lines.push(`| Routes served with **no authorizer** | ${unauthenticated.length}${
    unauthenticated.length ? ` (${unauthenticated.map((r) => `\`${r.method} ${r.path}\``).join(', ')})` : ''} |`);
  lines.push(`| Payload format sent to every handler | ${[...new Set(routes.map((r) => r.payloadFormat))].sort().join(', ')} |`);
  lines.push('');
  lines.push('**CORS is the API\'s own.** Each API answers every preflight and adds its configured headers to the');
  lines.push('responses it returns, echoing the one allowed origin a request names; a handler\'s own CORS headers');
  lines.push('are not what a browser sees. Whether a refusal the gateway answers itself (an authorizer\'s 401 or');
  lines.push('403, a throttle\'s 429) carries them is a property of the deployed API rather than of the template,');
  lines.push('and is checked against the deployed APIs. These variants set neither `appUrl` nor `adminAppUrl`,');
  lines.push('so the origins below are the development defaults; a deployment lists its own.');
  lines.push('');
  lines.push('Deployment shapes synthesized to produce this file: '
    + `${SYNTH_VARIANTS.map((v) => `\`${v.id}\``).join(', ')}.`);
  lines.push('');
  lines.push('## APIs');
  lines.push('');
  lines.push('One row per HTTP API. The stage throttle is shared by every caller of a route that has no');
  lines.push('throttle of its own, so it bounds the deployment rather than the person.');
  lines.push('');
  lines.push('| API | Stack | Stage | Stage throttle | CORS origins | Served in |');
  lines.push('|---|---|---|---|---|---|');
  for (const s of surfaces) {
    lines.push(`| ${s.apiName} | \`${s.stack}\` | \`${s.stage}\` | ${throttleCell(s)} | ${corsCell(s)} | ${s.availability} |`);
  }
  lines.push('');
  lines.push('## Routes');
  lines.push('');
  lines.push('Grouped by API. `Authorizer` is what a deployment taking every default serves: `AWS_IAM` is a');
  lines.push('SigV4-signed call, and the edge authorizer verifies a bearer token from a trusted issuer.');
  lines.push('`Throttle` is the route\'s own limit, or the stage\'s. `Integration` is the construct id of the');
  lines.push('Lambda behind the route, which is how to find the handler in `backend/lambda/src/`.');
  lines.push('');

  const byApi = new Map<string, MergedRoute[]>();
  for (const route of routes) {
    const key = `${route.stack}|${route.apiName}`;
    if (!byApi.has(key)) byApi.set(key, []);
    byApi.get(key)!.push(route);
  }

  for (const s of surfaces) {
    const key = `${s.stack}|${s.apiName}`;
    const apiRoutes = byApi.get(key) ?? [];
    lines.push(`### ${s.apiName}`);
    lines.push('');
    lines.push(`Declared by \`${s.stack}\`. Served in ${s.availability}.`);
    lines.push('');
    if (apiRoutes.length === 0) {
      lines.push('_No routes._');
      lines.push('');
      continue;
    }
    lines.push('| Method | Path | Authorizer | Throttle | Integration | Served in |');
    lines.push('|---|---|---|---|---|---|');
    for (const r of apiRoutes) {
      lines.push(`| \`${r.method}\` | \`${r.path}\` | ${authorizerCell(r)} | ${throttleCell(r)} | `
        + `\`${r.integration}\` | ${r.availability} |`);
    }
    lines.push('');
  }

  lines.push('## What this reference does not carry');
  lines.push('');
  lines.push('- **Base URLs.** Each API\'s invoke URL is minted at deploy time and published as a stack output');
  lines.push('  (`PersonApiUrl`, `AdminApiUrl`). Resolve them from the deployed stacks, never by composing an id.');
  lines.push('- **Request and response bodies.** No route declares a request model, so nothing in the template');
  lines.push('  describes a body. The guide documents the shapes that were read from the handlers, and says');
  lines.push('  which ones were not.');
  lines.push('- **The per-user limits.** The throttles above are per route and per second. The hourly request');
  lines.push('  limit and the spend budgets are enforced behind the gateway, in the assistant path, and are');
  lines.push('  described in the guide.');
  lines.push('');
  return lines.join('\n');
}
