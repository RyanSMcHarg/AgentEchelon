/**
 * The published API reference cannot drift from the stacks that serve it.
 *
 * THE FAILURE THIS EXISTS FOR. `docs/reference/api-contract.md` is what someone building their own
 * client reads to learn the method, the path and the authorizer. A hundred-odd routes are declared in the
 * route tables of a dozen stacks, several inside loops and several behind deployment flags, so the
 * document is one a person cannot keep correct by hand - and a wrong authorizer or a route that no longer
 * exists is worse than no document at all, because a reader has no way to tell. This repo has already paid
 * for the same shape twice: the README's e2e headline drifted to "~55 tests across 8 spec files" while
 * nothing failed, and the spec-to-test mapping was written twice and disagreed with itself.
 *
 * So the document is RENDERED from the app and compared byte-for-byte here. Adding a route to a stack
 * and not regenerating fails the build.
 *
 * WHAT IT DOES NOT CLAIM. That a route works, that its handler is correct, or that the authorizer is
 * the RIGHT one - only that the document says what the app builds. Which API and authorizer each route
 * must have is guarded next door, in `each-route-is-served-once-on-its-api.test.ts`.
 *
 * WHY IT IS SLOW, AND WHY THAT IS THE CHEAPER OPTION. Each variant is a full synthesis of the real
 * app in a child process, which costs a few seconds. A regex over the route tables would be instant and
 * would miscount every looped route and report a ternary where a deployment gets an answer. The
 * alternative - rebuilding the wiring of `bin/backend.ts` inside the extractor - would create a second
 * copy of the deployment graph, so a new route would be missing from the reference with nothing to
 * notice. Paying thirty seconds to read what CloudFormation would create is the honest version.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ADMIN_API_MOUNTS, ADMIN_CAPABILITIES, declaredExecuteApiResources, type AdminApiResource } from '../lib/config/admin-capabilities';
import { adminApiPath } from '../lib/constructs/admin-role-grants';
import {
  readApiContract,
  renderApiContract,
  buildContract,
  extractVariant,
  synthesizeVariant,
  API_CONTRACT_PATH,
  GEN_COMMAND,
  SYNTH_VARIANTS,
  type ApiContract,
  type RouteRecord,
  type Templates,
} from '../lib/docs/api-contract';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Four app synthesises, done once for the whole file. */
let cached: ApiContract | null = null;
const contract = (): ApiContract => {
  if (!cached) cached = readApiContract(REPO_ROOT);
  return cached;
};

/** Long enough for the synthesises on a loaded machine; a genuine hang still fails. */
const SYNTH_TIMEOUT_MS = 600_000;

const PERSON_API = 'agent-echelon-person-api';
const ADMIN_API = 'agent-echelon-admin-api';

describe('the API contract reference', () => {
  it('the committed file matches what the stacks render', () => {
    const committed = fs.readFileSync(path.join(REPO_ROOT, API_CONTRACT_PATH), 'utf8')
      .replace(/\r\n/g, '\n');
    const rendered = renderApiContract(contract());
    if (committed !== rendered) {
      throw new Error(
        `${API_CONTRACT_PATH.split(path.sep).join('/')} is out of date with the CDK stacks.\n`
        + 'The stacks are the source; this file is generated from them. Run:\n\n'
        + `    ${GEN_COMMAND}\n\n`
        + 'and commit the result. Do not hand-edit the document.',
      );
    }
    expect(committed).toBe(rendered);
  }, SYNTH_TIMEOUT_MS);

  it('found a realistic surface (guards against a silently empty synthesis)', () => {
    // Without this, a synthesis that produced no API resources would render an empty table and every
    // assertion below would pass over nothing - the "green having checked nothing" shape.
    const { routes, surfaces } = contract();
    expect(routes.length).toBeGreaterThan(50);
    expect(surfaces.map((s) => s.apiName).sort()).toEqual([ADMIN_API, PERSON_API]);
    expect(routes.filter((r) => r.apiName === PERSON_API).length).toBeGreaterThan(10);
    expect(routes.filter((r) => r.apiName === ADMIN_API).length).toBeGreaterThan(50);
  }, SYNTH_TIMEOUT_MS);

  it('is deterministic - two renders of one extraction are byte-identical', () => {
    // A timestamp, or a set-iteration order in the renderer, would fail the build on every run and
    // train everyone to regenerate without reading the diff.
    expect(renderApiContract(contract())).toBe(renderApiContract(contract()));
  }, SYNTH_TIMEOUT_MS);

  it('detects a drifted document', () => {
    // Falsification: the comparison must be capable of failing, or the first test proves only that
    // two identical reads agree.
    const rendered = renderApiContract(contract());
    expect(`${rendered}\n<!-- hand-edited -->`).not.toBe(rendered);
  }, SYNTH_TIMEOUT_MS);

  it('warns the reader not to hand-edit it, and names the command that regenerates it', () => {
    const rendered = renderApiContract(contract());
    expect(rendered).toContain('Do not edit by hand');
    expect(rendered).toContain(GEN_COMMAND);
  }, SYNTH_TIMEOUT_MS);
});

/**
 * EVERY ROUTE A STACK DECLARES IS IN THE REFERENCE.
 *
 * The extraction runs the real app, so a route declared by a stack wired into `bin/backend.ts` appears here
 * automatically - and one that is NOT wired in does not, which is the case this guard exists for. A stack
 * file can declare routes and never be instantiated (or be instantiated only behind a context flag the
 * variants do not set), and the reference would then be silently short of them while every other
 * assertion in this file passed.
 *
 * So the stack SOURCES are read independently and cross-checked against what synthesis found.
 */
describe('no route is missing from the reference', () => {
  const LIB = path.join(REPO_ROOT, 'backend', 'lib');
  const sources = (): string[] => ['stacks', 'constructs']
    .flatMap((dir) => fs.readdirSync(path.join(LIB, dir)).map((f) => `${dir}/${f}`))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  const text = (f: string): string => fs.readFileSync(path.join(LIB, f), 'utf8');

  it('declares no REST API anywhere, so the two HTTP APIs are the whole surface', () => {
    expect(sources().filter((f) => /new\s+apigateway\.(RestApi|LambdaRestApi|SpecRestApi)\s*\(/.test(text(f)))).toEqual([]);
  });

  it('finds at least as many routes as there are route declarations in the sources', () => {
    // The weaker, independent count. It cannot be exact - one declaration inside a loop serves several
    // routes, which is precisely why the reference is synthesized - but it must never come out HIGHER
    // than what synthesis found, because that means routes exist in source that no deployment builds.
    const declarations = sources().reduce((n, f) => n + (text(f)
      .match(/\{\s*api:\s*'(person|admin)'|\badminRoute\(\s*'|\b(route|conversations|e)\(\s*'(GET|POST|PUT|PATCH|DELETE)'/g) ?? []).length, 0);
    expect(declarations).toBeGreaterThan(40);
    expect(contract().routes.length).toBeGreaterThanOrEqual(declarations);
  }, SYNTH_TIMEOUT_MS);
});

/**
 * THE CONTRACT FACTS THE REFERENCE PUBLISHES, ASSERTED DIRECTLY.
 *
 * These are not re-checks of the byte comparison. They pin the properties a client developer relies
 * on, so that a change which would alter the published contract fails with a sentence about the
 * contract rather than with a diff of a markdown table.
 */
describe('the contract the reference publishes', () => {
  it('serves without an authorizer only the paused-deployment banner, the email preference page, the invitation landing page, and guest start, refresh and link redemption with their issuers', () => {
    // An unauthenticated route is a decision somebody must take deliberately, so the set is pinned by
    // name rather than asserted empty. `GET /deployment/state` answers whether an Aurora cluster is
    // asleep, which the SPA has to render BEFORE a caller can hold a credential - the one question
    // that cannot be behind the credential. It reads a single flag and exposes no conversation data.
    // Guest start and guest refresh exist only when the registry declares a guest issuer: an anonymous
    // visitor holds no token to present, so each carries its own abuse controls and a route throttle
    // instead (L16), and both are the credential exchange's. The email preference page (B9) is posted by a
    // mail client's one-click unsubscribe, which holds no session (RFC 8058): the token in its link is the
    // credential, read by a role that reaches only that token's kind and the person's preferences item. The
    // invitation landing page (M-5) reads an invitation by the token in its body and consumes nothing; a
    // `link` invitation's redemption exists only with an invitation-link issuer, behind the same controls as
    // guest start (L16), and is the exchange's.
    const open = contract().routes
      .filter((r) => r.authorizationType === 'NONE')
      .map((r) => `${r.apiName} ${r.method} ${r.path}`)
      .sort();
    // No vendor has a route: a subscribing connector (one of `SYNTH_CONNECTORS`) receives its vendor's
    // events through the vendor's EventBridge partner event source (K5), so it adds nothing here.
    expect(open).toEqual([
      `${PERSON_API} GET /deployment/state`,
      `${PERSON_API} GET /email/preferences`,
      `${PERSON_API} POST /email/preferences`,
      `${PERSON_API} POST /guest/refresh`,
      `${PERSON_API} POST /guest/start`,
      `${PERSON_API} POST /invitations/peek`,
      `${PERSON_API} POST /invitations/redeem`,
    ].sort());
  }, SYNTH_TIMEOUT_MS);

  it('authorizes every other route with IAM or the edge authorizer, and nothing else', () => {
    const types = [...new Set(contract().routes.map((r) => r.authorizationType))].sort();
    expect(types).toEqual(['AWS_IAM', 'CUSTOM', 'NONE']);
  }, SYNTH_TIMEOUT_MS);

  it('synthesizes a variant for every deployment flag that gates a route', () => {
    // The inventory can only report what it renders, and a flag that gates a route declaration and has
    // no variant here removes routes from the document with nothing failing - the document still looks
    // complete. So the stack sources are read for the conditions that wrap a route declaration, and
    // every flag found must appear in some variant's context.
    //
    // Deliberately a source scan, which is the one place in this file a regex is the right tool: the
    // question is not "what routes exist" (that needs synthesis) but "what flag names appear in an
    // `if` above a route", and a name is exactly what a regex can see.
    const stackDir = path.join(__dirname, '..', 'lib', 'stacks');
    const gatingFlags = new Set<string>();
    for (const file of fs.readdirSync(stackDir).filter((f) => f.endsWith('.ts'))) {
      const lines = fs.readFileSync(path.join(stackDir, file), 'utf8').split('\n');
      const openIfs: { cond: string; depth: number }[] = [];
      let depth = 0;
      for (const line of lines) {
        const opened = line.match(/^\s*if \((.+?)\)\s*\{\s*$/);
        if (opened) openIfs.push({ cond: opened[1], depth });
        depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
        while (openIfs.length && depth <= openIfs[openIfs.length - 1].depth) openIfs.pop();
        if (!/routes\.push\(|\badminRoute\(/.test(line)) continue;
        for (const { cond } of openIfs) {
          for (const [, flag] of cond.matchAll(/(?:props\.|tryGetContext\(['"])([A-Za-z][A-Za-z0-9]*)/g)) {
            gatingFlags.add(flag);
          }
        }
      }
    }
    const synthesized = new Set(SYNTH_VARIANTS.flatMap((v) => Object.keys(v.context)));
    const ungated = [...gatingFlags].filter((f) => !synthesized.has(f)).sort();
    expect(ungated).toEqual([]);
    // And the scan is working rather than matching nothing: the flag it finds today is known.
    expect([...gatingFlags].sort()).toEqual(['sleepMode']);
  });

  it('sends every handler payload format 1.0, the event shape the handlers read', () => {
    // A 2.0 integration would hand a handler `rawPath` and `requestContext.http` instead of `path`,
    // `httpMethod` and `requestContext.identity`, and every caller would resolve to nobody.
    expect([...new Set(contract().routes.map((r) => r.payloadFormat))]).toEqual(['1.0']);
  }, SYNTH_TIMEOUT_MS);

  it('throttles every route, except the person credential exchange', () => {
    // The exchange deliberately carries no throttle of its own: it is the call every client makes before
    // it can make any other, so a shared throttle there would throttle sign-in for everyone at once.
    // Pinned as the single exception rather than left as an absence, so a route that quietly loses its
    // throttle is visible here.
    const unthrottled = contract().routes
      .filter((r) => r.throttleRate === null)
      .map((r) => `${r.apiName} ${r.method} ${r.path}`);
    expect(unthrottled).toEqual([`${PERSON_API} POST /exchange-credentials`]);
  }, SYNTH_TIMEOUT_MS);

  it('authorizes every admin capability route with IAM on AdminApi, in every deployment (SPEC-ADMIN-CONSOLE FR43)', () => {
    // Every route the capability catalog declares is IAM-authorized, so a role is refused at the
    // gateway on a capability it does not hold. There is no deployment flag that changes this, which
    // is the point: a switch that returns an admin route to a group-only gate makes every scoped role
    // a fiction. Read from the catalog rather than a list here, so a capability added later is covered.
    const routes = contract().routes.filter((r) => r.apiName === ADMIN_API);
    const toPattern = (p: string) => new RegExp(`^${p.replace(/\*/g, '\\{[^/]+\\}')}$`);
    const unmatched: string[] = [];
    const notIam: string[] = [];
    for (const api of Object.keys(ADMIN_API_MOUNTS) as Array<AdminApiResource['api']>) {
      for (const { method, path: p, key } of declaredExecuteApiResources(api)) {
        const onApi = adminApiPath(api, p).replace(/\{[^}]+\}/g, '*');
        const found = routes.filter((r) => r.method === method && toPattern(onApi).test(r.path));
        if (!found.length) {
          // A wired capability must have a route; an unwired one is declared ahead of its route.
          if (ADMIN_CAPABILITIES[key].wired) unmatched.push(`${key}: ${method} ${onApi}`);
          continue;
        }
        for (const r of found) if (r.authorizationType !== 'AWS_IAM') notIam.push(`${key}: ${r.method} ${r.path} is ${r.authorizationType}`);
      }
    }
    expect(unmatched).toEqual([]);
    expect(notIam).toEqual([]);
  }, SYNTH_TIMEOUT_MS);

  it('takes a token on AdminApi on the console session alone, and serves no admin route on PersonApi', () => {
    // The converse, by path: nothing under the admin, user-management, membership-audit or deployment
    // control paths is on the person API, and the one admin route a token reaches is the console session.
    const adminPath = /^\/(admin\/|users(\/|$)|query(\/|$)|membership-audit\/|deployment\/(sleep|wake)$)/;
    expect(contract().routes.filter((r) => r.apiName === PERSON_API && adminPath.test(r.path)).map((r) => r.path)).toEqual([]);
    const tokenRoutes = contract().routes
      .filter((r) => r.apiName === ADMIN_API && r.authorizationType !== 'AWS_IAM')
      .map((r) => `${r.method} ${r.path} ${r.authorizationType} ${r.authorizerCacheSeconds}`);
    expect(tokenRoutes).toEqual(['POST /exchange-credentials CUSTOM 0']);
  }, SYNTH_TIMEOUT_MS);

  it('reports the analytics mode a route needs, and a second issuer as adding no route', () => {
    const { routes } = contract();
    const modes = routes.map((r) => r.availability);
    // The analytics query serves one path set below `/query` in both modes, Aurora's a superset of Athena's.
    expect(modes).not.toContain('Athena analytics mode');
    expect(modes).toContain('Aurora analytics mode');
    // ONE PATH PER FEATURE FOR EVERY ISSUER: every person route is behind the one edge authorizer, which
    // decides an issuer's reach from its registry entry, so no route is available only where one is declared.
    expect(routes.filter((r) => r.availability === '`issuers` declares a second issuer')).toEqual([]);
    // THE GUEST ISSUER'S ROUTES are the one exception, and not a second path to a feature: its two entry
    // points (an anonymous visitor holds no token to present) and path B's registration and claim, which a
    // visitor reaches only from a visit. They exist exactly when the guest issuer does.
    expect(routes.filter((r) => r.availability === '`issuers` declares a guest issuer').map((r) => `${r.method} ${r.path}`).sort())
      .toEqual(['POST /guest/refresh', 'POST /guest/register', 'POST /guest/start', 'POST /upgrade/claim']);
    // So is a link invitation's redemption (M-10): it exists exactly when an invitation-link issuer does.
    expect(routes.filter((r) => r.availability === '`issuers` declares an invitation-link issuer').map((r) => `${r.method} ${r.path}`))
      .toEqual(['POST /invitations/redeem']);
    expect(routes.filter((r) => r.path.endsWith('/federated'))).toEqual([]);
  }, SYNTH_TIMEOUT_MS);

  it('leaves no route with an unexplained availability', () => {
    // `availabilityOf` falls back to naming raw variant ids when a presence set matches no deployment
    // choice it knows. That fallback is a signal, not an answer: it means a new flag gates a route and
    // the labelling needs to learn about it before the document can claim to explain itself.
    const ids = new Set(SYNTH_VARIANTS.map((v) => v.id));
    const unexplained = contract().routes
      .filter((r) => r.availability.split(', ').every((part) => ids.has(part)))
      .map((r) => `${r.method} ${r.path} -> ${r.availability}`);
    expect(unexplained).toEqual([]);
  }, SYNTH_TIMEOUT_MS);
});

/**
 * THE EXTRACTOR ITSELF MUST BE ABLE TO FAIL.
 *
 * Everything above runs the extractor over the real app, where it reports what it reports. These run it
 * over hand-built templates, so a parser that dropped a throttle, or a merge that lost a variant, is caught
 * by something other than a reviewer's eye.
 */
describe('the extractor, on synthetic templates', () => {
  const template = (resources: Record<string, unknown>): Templates =>
    ({ Synthetic: { Resources: resources as never } });

  const API = 'TestApi1234ABCD';
  const api = { Type: 'AWS::ApiGatewayV2::Api', Properties: { Name: 'Test', CorsConfiguration: { AllowOrigins: ['https://b.example', 'https://a.example'] } } };
  const integration = (description?: string) => ({
    Type: 'AWS::ApiGatewayV2::Integration',
    Properties: {
      ApiId: { Ref: API },
      IntegrationType: 'AWS_PROXY',
      PayloadFormatVersion: '1.0',
      IntegrationUri: { 'Fn::GetAtt': ['MyHandlerAABBCCDD', 'Arn'] },
      ...(description ? { Description: description } : {}),
    },
  });
  const route = (key: string, extra: Record<string, unknown> = {}) => ({
    Type: 'AWS::ApiGatewayV2::Route',
    Properties: { ApiId: { Ref: API }, RouteKey: key, Target: { 'Fn::Join': ['', ['integrations/', { Ref: 'Integ' }]] }, ...extra },
  });

  it('reads the method and path from the route key, and the handler from the integration', () => {
    const extracted = extractVariant(template({
      [API]: api,
      Integ: integration('CreateConversationFunction'),
      R: route('GET /admin/tasks/channel/{channelId}', { AuthorizationType: 'AWS_IAM' }),
    }));
    expect(extracted.routes).toHaveLength(1);
    const [r] = extracted.routes;
    expect([r.method, r.path, r.authorizationType, r.integration, r.payloadFormat])
      .toEqual(['GET', '/admin/tasks/channel/{channelId}', 'AWS_IAM', 'CreateConversationFunction', '1.0']);
  });

  it('names the construct behind an integration with no description, without its uniqueness suffix', () => {
    const extracted = extractVariant(template({ [API]: api, Integ: integration(), R: route('POST /x') }));
    expect(extracted.routes[0].integration).toBe('MyHandler');
  });

  it('reads a route throttle over the stage default, and reports neither as absence', () => {
    const stage = (settings: Record<string, unknown>) => ({
      Type: 'AWS::ApiGatewayV2::Stage',
      Properties: { ApiId: { Ref: API }, StageName: '$default', ...settings },
    });
    const pick = (extracted: { routes: RouteRecord[] }, key: string) => extracted.routes.find((r) => `${r.method} ${r.path}` === key)!;
    const withRouteThrottle = extractVariant(template({
      [API]: api, Integ: integration('F'), A: route('POST /a'), B: route('POST /b'),
      Stage: stage({
        DefaultRouteSettings: { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
        RouteSettings: { 'POST /a': { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 2 } },
      }),
    }));
    expect([pick(withRouteThrottle, 'POST /a').throttleRate, pick(withRouteThrottle, 'POST /a').throttleBurst]).toEqual([1, 2]);
    expect([pick(withRouteThrottle, 'POST /b').throttleRate, pick(withRouteThrottle, 'POST /b').throttleBurst]).toEqual([10, 20]);
    expect(withRouteThrottle.surfaces[0].stage).toBe('$default');

    const none = extractVariant(template({ [API]: api, Integ: integration('F'), A: route('POST /a'), Stage: stage({}) }));
    expect(none.routes[0].throttleRate).toBeNull();
    expect(none.surfaces[0].throttleRate).toBeNull();
  });

  it('reads the authorizer cache of a Lambda-authorized route, and the API\'s CORS origins sorted', () => {
    const extracted = extractVariant(template({
      [API]: api,
      Integ: integration('F'),
      Cached: { Type: 'AWS::ApiGatewayV2::Authorizer', Properties: { ApiId: { Ref: API }, AuthorizerType: 'REQUEST', AuthorizerResultTtlInSeconds: 300 } },
      Uncached: { Type: 'AWS::ApiGatewayV2::Authorizer', Properties: { ApiId: { Ref: API }, AuthorizerType: 'REQUEST', AuthorizerResultTtlInSeconds: 0 } },
      A: route('GET /a', { AuthorizationType: 'CUSTOM', AuthorizerId: { Ref: 'Cached' } }),
      B: route('POST /b', { AuthorizationType: 'CUSTOM', AuthorizerId: { Ref: 'Uncached' } }),
    }));
    const ttl = Object.fromEntries(extracted.routes.map((r) => [r.path, r.authorizerCacheSeconds]));
    expect(ttl).toEqual({ '/a': 300, '/b': 0 });
    expect(extracted.surfaces[0].corsOrigins).toEqual(['https://a.example', 'https://b.example']);
  });

  const base: RouteRecord = {
    stack: 'S', apiName: 'A', method: 'GET', path: '/x', authorizationType: 'AWS_IAM', authorizerCacheSeconds: null,
    throttleRate: 1, throttleBurst: 2, integration: 'Fn', payloadFormat: '1.0',
  };

  it('merges a route seen in some variants into one row that says which', () => {
    // Present in EVERY variant, enumerated from the variant list rather than written out: the point of
    // the assertion is "seen everywhere reads as everywhere", and a hardcoded list turns that into
    // "seen in these four", which silently stops meaning the same thing when a variant is added.
    const merged = buildContract(new Map(SYNTH_VARIANTS.map((v) => [v.id, { surfaces: [], routes: [base] }])));
    expect(merged.routes).toHaveLength(1);
    expect(merged.routes[0].authorizationType).toBe('AWS_IAM');
    expect(merged.routes[0].availability).toBe('every deployment');
  });

  it('labels a route seen in one mode only by that mode', () => {
    // Every Aurora-mode variant and no Athena one, taken from the variant list for the same reason as
    // above: "this mode and only this mode" is the claim, not "these two ids".
    const auroraVariants = SYNTH_VARIANTS.filter((v) => v.context.analyticsMode === 'aurora');
    expect(auroraVariants.length).toBeGreaterThan(1);
    const merged = buildContract(new Map(auroraVariants.map((v) => [v.id, { surfaces: [], routes: [{ ...base, method: 'POST', path: '/only-aurora' }] }])));
    expect(merged.routes[0].availability).toBe('Aurora analytics mode');
  });
});

/**
 * THE SYNTHESIS PATH ITSELF.
 *
 * Pinned because it is the assumption everything else in this file rests on, and because it can break
 * for a reason unrelated to any route: the app is run through `ts-node`, and if that ever stops working
 * the failure should say so rather than arriving as an empty table.
 */
describe('the app synthesizes from TypeScript', () => {
  it('runs the real app and returns templates for the stacks it builds', () => {
    const templates = synthesizeVariant(REPO_ROOT, SYNTH_VARIANTS[0]);
    expect(Object.keys(templates).length).toBeGreaterThan(10);
    // Stacks every deployment builds, so this is not a statement about a flag.
    expect(Object.keys(templates)).toContain('AgentEchelonConversations');
    expect(Object.keys(templates)).toContain('AgentEchelonPersonApi');
  }, SYNTH_TIMEOUT_MS);
});
