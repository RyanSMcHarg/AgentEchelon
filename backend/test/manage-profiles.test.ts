/**
 * SPEC-PORTABLE-PROFILES P1 — the manage-profiles API handler (gating + routing).
 * The lifecycle/manifest logic is unit-tested separately; here we prove the capability gate and route
 * dispatch, since this is the WRITE surface (§7).
 */
const send = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send })) };
});
/** Premium's published context source catalog, so a version selecting the seeded `user-profile` verifies. */
async function publishPremiumCatalog(client: { send: (cmd: never) => Promise<unknown> }): Promise<void> {
  const { PutParameterCommand } = jest.requireActual('@aws-sdk/client-ssm');
  await client.send(new PutParameterCommand({
    Name: '/agent-echelon/assistant/premium/context-sources', Value: JSON.stringify([{ key: 'user-profile' }]), Type: 'String',
  }) as never);
}
// The experiment a candidate is derived for (ADR-050).
const ddbSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return { ...actual, DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) } };
});
process.env.EXPERIMENTS_TABLE = 'experiments';
// The name appliers: every invoke is recorded and answers that the name was applied.
const lambdaInvokes: Array<{ FunctionName?: string; payload: unknown }> = [];
jest.mock('@aws-sdk/client-lambda', () => {
  const actual = jest.requireActual('@aws-sdk/client-lambda');
  return {
    ...actual,
    LambdaClient: jest.fn(() => ({
      send: async (cmd: { constructor: { name: string }; input: { FunctionName?: string; Payload?: Uint8Array } }) => {
        if (cmd.constructor.name !== 'InvokeCommand') throw Object.assign(new Error('nf'), { name: 'ResourceNotFoundException' });
        lambdaInvokes.push({ FunctionName: cmd.input.FunctionName, payload: JSON.parse(Buffer.from(cmd.input.Payload ?? []).toString() || '{}') });
        return { Payload: Buffer.from(JSON.stringify({ applied: true })) };
      },
    })),
  };
});
// A team route's scope. Null, as an admin route resolves, unless a test names one.
const mockScope = jest.fn();
jest.mock('../lambda/src/lib/assistant-scope', () => {
  const actual = jest.requireActual('../lambda/src/lib/assistant-scope');
  return { ...actual, requireOwnedAssistant: (...a: unknown[]) => mockScope(...a) };
});

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler, candidateRefusal, variantDeltaOf, battleSideOfVariant, controlMismatch } from '../lambda/src/manage-profiles';
import { edgeContext } from './helpers/edge-context';

function evt(over: Partial<APIGatewayProxyEvent> & { groups?: string; sub?: string; path?: string; method?: string }): APIGatewayProxyEvent {
  const { groups = 'admins', sub = 'u-1', path = '/admin/profiles', method = 'GET', ...rest } = over;
  return {
    httpMethod: method,
    path,
    headers: { origin: 'http://localhost:5173' },
    requestContext: { authorizer: edgeContext({ claims: { sub, 'cognito:groups': groups } }) },
    ...rest,
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => { send.mockReset(); ddbSend.mockReset(); mockScope.mockReset(); mockScope.mockResolvedValue(null); });

describe('manage-profiles handler', () => {
  it('OPTIONS → 200 (CORS preflight)', async () => {
    const res = await handler(evt({ method: 'OPTIONS' }));
    expect(res.statusCode).toBe(200);
  });

  it('no sub → 401', async () => {
    const res = await handler(evt({ sub: '' }));
    expect(res.statusCode).toBe(401);
  });

  it('non-admin (lacks the manage-profiles capability) → 403, never reaches SSM', async () => {
    const res = await handler(evt({ groups: 'basic' }));
    expect(res.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('admin GET /profiles → 200 listing every shipped profile', async () => {
    // Every SSM read (history/draft) → ParameterNotFound ⇒ seed-only listing.
    send.mockImplementation(async () => {
      const e = new Error('nf') as Error & { name: string };
      e.name = 'ParameterNotFound';
      throw e;
    });
    const res = await handler(evt({ method: 'GET' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.profiles)).toBe(true);
    expect(body.profiles.length).toBeGreaterThanOrEqual(3);
    expect(body.profiles.every((p: { activeVersion: number | null }) => p.activeVersion === null)).toBe(true);
  });

  // ── THE TOOL REGISTRY IS SERVED, NOT MIRRORED ──────────────────────────────────────────────────
  //
  // `tool-registry.ts` claims to be the single source of the descriptions that "render the admin
  // console's per-tool surface", and the console could not read it - it is a Lambda module and the
  // console is a separate browser build. So the console kept a hand-written copy, and the copy went two
  // tools stale: `read_deployment_health` and `open_work_summary` were absent, so the ops assistant's
  // only tool rendered with no description and neither tool could be switched off in the draft editor.
  it('admin GET /profiles serves the tool registry alongside the listing', async () => {
    send.mockImplementation(async () => {
      const e = new Error('nf') as Error & { name: string };
      e.name = 'ParameterNotFound';
      throw e;
    });
    const res = await handler(evt({ method: 'GET' }));
    const body = JSON.parse(res.body) as { tools?: Array<{ name: string; description: string; requires: string }> };
    const { TOOL_REGISTRY } = await import('../lambda/src/lib/tool-registry');
    // EVERY tool, compared against the registry rather than a list written here - a fixture of names
    // would be the same second copy this replaced.
    expect(body.tools?.map((t) => t.name)).toEqual(TOOL_REGISTRY.map((t) => t.name));
    // And the two fields the console renders, so serving a listing of bare names would fail this.
    for (const t of body.tools ?? []) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.requires.length).toBeGreaterThan(0);
    }
    expect(body.tools?.some((t) => t.name === 'read_deployment_health')).toBe(true);
  });

  it('POST /profiles/version for an unknown profile → 400', async () => {
    const res = await handler(evt({ method: 'POST', path: '/admin/profiles/version', body: JSON.stringify({ profileName: 'ghost' }) }));
    expect(res.statusCode).toBe(400);
  });

  // ── /variant-version: the experiment's door into the profile namespace ──────────────────────────
  //
  // The write §3.7 needs is a profile write, so it lives behind THIS handler's capability check rather
  // than behind a second writer granted to the experiments admin. These assert the
  // two properties that makes true: the gate applies, and a caller must say what produced the candidate.
  const variantBody = (over: Record<string, unknown> = {}) => JSON.stringify({
    profileName: 'advisor', patch: { modelKey: 'sonnet' }, experimentId: 'exp-1', variantId: 'treatment', ...over,
  });
  const variantEvt = (over: Record<string, unknown> = {}, groups = 'admins') =>
    evt({ method: 'POST', path: '/admin/profiles/variant-version', body: variantBody(over), groups });

  it('POST /profiles/preview-run WITHOUT the manage-profiles capability → 403, never reaches SSM (ADR-061 decision 7)', async () => {
    const res = await handler(evt({ method: 'POST', path: '/admin/profiles/preview-run', body: JSON.stringify({ profileName: 'advisor', workflow: 'w' }), groups: 'basic' }));
    expect(res.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('POST /profiles/variant-version WITHOUT the manage-profiles capability → 403, never reaches SSM', async () => {
    // THE POINT OF PUTTING THE WRITE HERE. Arming an experiment with a derived variant requires the
    // operator to hold manage-profiles in their own right; the experiments door does not grant it.
    const res = await handler(variantEvt({}, 'basic'));
    expect(res.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('POST /profiles/variant-version without experimentId/variantId → 400 (a candidate records what produced it)', async () => {
    // Refused rather than defaulted: a candidate with no provenance is indistinguishable in the version
    // history from a version that really served, which is what `derivedFrom` exists to prevent.
    const res = await handler(variantEvt({ experimentId: '' }));
    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('POST /profiles/variant-version with a non-version pin → 400', async () => {
    const res = await handler(variantEvt({ existingVersion: 0 }));
    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  // ── THE ALT IS EDITED THROUGH ITS EXPERIMENT (ADR-050) ─────────────────────────────────────────
  it("refuses every ordinary edit of an alt's profile, and leaves export open for promotion", async () => {
    for (const route of ['version', 'draft', 'validate', 'activate', 'rollback']) {
      const res = await handler(evt({ method: 'POST', path: `/admin/profiles/${route}`, body: JSON.stringify({ profileName: 'alt-primary-premium', version: 1 }) }));
      expect({ route, status: res.statusCode, code: JSON.parse(res.body).code })
        .toEqual({ route, status: 409, code: 'ALT_PROFILE_IS_EDITED_THROUGH_ITS_EXPERIMENT' });
    }
    const imported = await handler(evt({ method: 'POST', path: '/admin/profiles/import', body: JSON.stringify({ manifest: {}, targetProfileName: 'alt-primary-premium' }) }));
    expect(imported.statusCode).toBe(409);
    const exported = await handler(evt({ method: 'POST', path: '/admin/profiles/export', body: JSON.stringify({ profileName: 'alt-primary-premium' }) }));
    expect(exported.statusCode).not.toBe(409);
    expect(exported.statusCode).not.toBe(400);
  });

  it('derives a candidate only for an experiment that exists, runs here, and has the variant', async () => {
    ddbSend.mockResolvedValue({});
    const missing = await handler(variantEvt());
    expect(JSON.parse(missing.body).code).toBe('EXPERIMENT_NOT_FOUND');
    expect(send).not.toHaveBeenCalled();
  });

  it("a battle's candidate is for its classification's primary role, read from the experiment and not from SSM", async () => {
    // A duel's alt is the alt of its one classification's primary role (§3.7), so the experiment row
    // names the role: a team route scoped to another assistant is refused before anything is read.
    mockScope.mockResolvedValue({ assistant: 'ops-premium', bots: [] });
    ddbSend.mockResolvedValue({ Item: {
      experimentId: 'exp-1', status: 'draft', experimentType: 'base_model', tiers: ['premium'],
      battleEnabled: true, challengerAssistant: 'alt-primary-premium',
      variants: [{ variantId: 'control' }, { variantId: 'treatment' }],
    } });
    const res = await handler(variantEvt());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('ASSISTANT_MISMATCH');
    expect(send).not.toHaveBeenCalled();
  });

  it('a battle that names no single classification has no alt to derive for', async () => {
    ddbSend.mockResolvedValue({ Item: {
      experimentId: 'exp-1', status: 'draft', experimentType: 'base_model', tiers: ['standard', 'premium'],
      battleEnabled: true, challengerAssistant: 'alt-primary-premium',
      variants: [{ variantId: 'control' }, { variantId: 'treatment' }],
    } });
    const res = await handler(variantEvt());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('NO_ALT_FOR_ROLE');
  });

  // ── AN IMPORT NAMES ITS TARGET; THE MANIFEST'S OWN NAME NEVER DECIDES ─────────────────────────────
  it.each([
    ['no target', {}],
    ['a blank target', { targetProfileName: '  ' }],
    ['a target that is not a name', { targetProfileName: 7 }],
  ])('an import with %s is refused 400 TARGET_REQUIRED, and reads nothing', async (_what, extra) => {
    const res = await handler(evt({ method: 'POST', path: '/admin/profiles/import', body: JSON.stringify({ manifest: { kind: 'assistant-profile', profileName: 'advisor', body: {} }, ...extra }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('TARGET_REQUIRED');
    expect(send).not.toHaveBeenCalled();
  });

  it("a team route refuses an import that names another assistant as its target, and reads nothing", async () => {
    mockScope.mockResolvedValue({ assistant: 'ops-premium', bots: [] });
    const res = await handler(evt({ method: 'POST', path: '/admin/assistants/ops-premium/profiles/import', body: JSON.stringify({ manifest: {}, targetProfileName: 'advisor' }) }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('ASSISTANT_MISMATCH');
    expect(send).not.toHaveBeenCalled();
  });

  it("a team route cannot hand over another team's assistant version as its treatment", async () => {
    mockScope.mockResolvedValue({ assistant: 'advisor', bots: [] });
    ddbSend.mockResolvedValue({ Item: {
      experimentId: 'exp-1', status: 'draft', experimentType: 'profile', tiers: ['premium'],
      variants: [{ variantId: 'control' }, { variantId: 'treatment' }],
    } });
    const res = await handler(variantEvt({ fromProfileRef: { profileName: 'ops-premium', version: 3 } }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('ASSISTANT_MISMATCH');
    // Refused before the version is read, so nothing of the other assistant's definition is loaded.
    expect(send).not.toHaveBeenCalled();
  });
});

describe('what a variant may change (candidateRefusal)', () => {
  const exp = (over: Record<string, unknown> = {}) => ({
    experimentId: 'exp-1', status: 'draft', experimentType: 'base_model', tiers: ['premium'],
    variants: [{ variantId: 'control' }, { variantId: 'treatment' }], ...over,
  });

  it('a model experiment varies the model and the addendum, never the name (a duel side is named from its profile)', () => {
    expect(candidateRefusal(exp(), 'treatment', 'premium', { models: { default: 'sonnet' } } as never)).toBeNull();
    expect(candidateRefusal(exp(), 'treatment', 'premium', { displayName: 'Challenger' } as never)?.code).toBe('PATCH_OUTSIDE_EXPERIMENT_TYPE');
    expect(candidateRefusal(exp(), 'treatment', 'premium', { persona: 'warmer' } as never)?.code).toBe('PATCH_OUTSIDE_EXPERIMENT_TYPE');
    expect(candidateRefusal(exp(), 'treatment', 'premium', { tools: [] } as never)?.code).toBe('PATCH_OUTSIDE_EXPERIMENT_TYPE');
  });

  it('a profile experiment may vary the whole definition', () => {
    expect(candidateRefusal(exp({ experimentType: 'profile' }), 'treatment', 'premium', { persona: 'warmer', tools: [] } as never)).toBeNull();
  });

  it('refuses an ended experiment, a missing variant, and another classification', () => {
    expect(candidateRefusal(exp({ status: 'completed' }), 'treatment', 'premium', {})?.code).toBe('EXPERIMENT_ENDED');
    expect(candidateRefusal(exp(), 'nope', 'premium', {})?.code).toBe('VARIANT_NOT_FOUND');
    expect(candidateRefusal(exp(), 'treatment', 'standard', {})?.code).toBe('EXPERIMENT_NOT_IN_CLASSIFICATION');
    expect(candidateRefusal(null, 'treatment', 'premium', {})?.code).toBe('EXPERIMENT_NOT_FOUND');
  });
});

describe("each type's recipe changes only what the type varies (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5)", () => {
  const row = (experimentType: string, treatment: Record<string, unknown>, intent = 'code_generation') => ({
    experimentId: 'exp-1', status: 'active', experimentType, intent, tiers: ['premium'], battleEnabled: true, challengerAssistant: 'alt-primary-premium',
    variants: [{ variantId: 'control' }, { variantId: 'treatment', ...treatment }],
  });

  it('intent: only models.byIntent[<intent>].primary, with the addendum and image model; never a variant name an older row still carries', () => {
    expect(variantDeltaOf(row('intent', {
      modelKey: 'opus', systemPromptAddendum: 'be terse', imageGenModelKey: 'nova_canvas', displayName: 'Echo',
    }), 'treatment')).toEqual({
      patch: { models: { byIntent: { code_generation: { primary: 'opus' }, image_generation: { image: { primary: 'nova_canvas' } } } }, systemPromptAddendum: 'be terse' },
    });
    // The route key is the resolver's: the classifier's `general` is the `general` route.
    expect(variantDeltaOf(row('intent', { modelKey: 'opus' }, 'general'), 'treatment'))
      .toEqual({ patch: { models: { byIntent: { general: { primary: 'opus' } } } } });
  });

  it('intent on an image intent: the text model and the image part of the one route (ADR-064)', () => {
    expect(variantDeltaOf(row('intent', { modelKey: 'opus', imageGenModelKey: 'nova_canvas' }, 'image_generation'), 'treatment'))
      .toEqual({ patch: { models: { byIntent: { image_generation: { primary: 'opus', image: { primary: 'nova_canvas' } } } } } });
  });

  it('base_model: the base model, with the addendum and image model; never a variant name an older row still carries', () => {
    expect(variantDeltaOf(row('base_model', {
      modelKey: 'opus', systemPromptAddendum: 'be terse', imageGenModelKey: 'nova_canvas', displayName: 'Echo',
    }), 'treatment')).toEqual({
      patch: { modelKey: 'opus', models: { byIntent: { image_generation: { image: { primary: 'nova_canvas' } } } }, systemPromptAddendum: 'be terse' },
    });
  });

  it('classification: the model is the CLASSIFIER, and the base model is left to the live body', () => {
    expect(variantDeltaOf(row('classification', { modelKey: 'haiku', displayName: 'Echo' }), 'treatment')).toEqual({
      patch: { models: { classifier: 'haiku' } },
    });
  });

  it('profile: the whole referenced version, pinned to the version the ref names or tracks', () => {
    expect(variantDeltaOf(row('profile', { profileRef: { profileName: 'advisor', version: 4 }, displayName: 'Echo' }), 'treatment'))
      .toEqual({ patch: {}, fromProfileRef: { profileName: 'advisor', version: 4 } });
    expect(variantDeltaOf(row('profile', { profileRef: { profileName: 'advisor' } }), 'treatment'))
      .toEqual({ patch: {}, fromProfileRef: { profileName: 'advisor' } });
  });

  it('names the side a variant is in a battle, and none outside one', () => {
    expect(battleSideOfVariant(row('base_model', {}), 'control')).toBe('control');
    expect(battleSideOfVariant(row('base_model', {}), 'treatment')).toBe('treatment');
    expect(battleSideOfVariant({ ...row('base_model', {}), battleEnabled: false }, 'treatment')).toBeUndefined();
  });

  it('a model experiment may carry the persona addendum, and still nothing else', () => {
    const exp = row('base_model', {});
    expect(candidateRefusal(exp, 'treatment', 'premium', { systemPromptAddendum: 'be terse' } as never)).toBeNull();
    expect(candidateRefusal(exp, 'treatment', 'premium', { persona: 'warmer' } as never)?.code).toBe('PATCH_OUTSIDE_EXPERIMENT_TYPE');
  });
});

describe('the control is the live version unless it says otherwise (controlMismatch)', () => {
  const live = { modelKey: 'opus', models: { default: 'opus', classifier: 'haiku', byIntent: { code_generation: { primary: 'sonnet', fallback: 'gpt_oss_20b' }, image_generation: { image: { primary: 'nova_canvas' } } } } } as never;
  const exp = (experimentType: string, control: Record<string, unknown>) => ({
    experimentType, intent: 'code_generation', variants: [{ variantId: 'control', ...control }, { variantId: 'treatment' }],
  });

  it('accepts a control that names nothing, or names what the live version serves for the type', () => {
    expect(controlMismatch(exp('intent', {}), live, 'premium')).toBeNull();
    expect(controlMismatch(exp('intent', { modelKey: 'sonnet' }), live, 'premium')).toBeNull();
    expect(controlMismatch(exp('base_model', { modelKey: 'opus' }), live, 'premium')).toBeNull();
    expect(controlMismatch(exp('classification', { modelKey: 'haiku' }), live, 'premium')).toBeNull();
    expect(controlMismatch(exp('base_model', { imageGenModelKey: 'nova_canvas' }), live, 'premium')).toBeNull();
  });

  it('refuses a control that names a model, addendum or image model the live version does not serve', () => {
    expect(controlMismatch(exp('intent', { modelKey: 'opus' }), live, 'premium')).toMatch(/code_generation/);
    expect(controlMismatch(exp('base_model', { modelKey: 'sonnet' }), live, 'premium')).toMatch(/base model/);
    expect(controlMismatch(exp('classification', { modelKey: 'titan' }), live, 'premium')).toMatch(/classifier/);
    expect(controlMismatch(exp('base_model', { systemPromptAddendum: 'be warm' }), live, 'premium')).toMatch(/addendum/);
    expect(controlMismatch(exp('base_model', { imageGenModelKey: 'titan_image' }), live, 'premium')).toMatch(/image model/);
  });

  it('a profile experiment references its control, so nothing is compared', () => {
    expect(controlMismatch(exp('profile', { modelKey: 'sonnet' }), live, 'premium')).toBeNull();
  });
});

describe('arming pins two versions: the live active one as the control, a candidate in the alt as the treatment (§3.5)', () => {
  const live = 'advisor';
  const alt = 'alt-primary-premium';
  const experiment = (experimentType: string, variants: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({
    experimentId: 'exp-arm', status: 'active', experimentType, intent: 'code_generation', tiers: ['premium'], variants, ...over,
  });
  const battle = (experimentType: string, variants: Array<Record<string, unknown>>) =>
    experiment(experimentType, variants, { battleEnabled: true, challengerAssistant: alt });
  type Derived = { ok: boolean; controlPin: { profileName: string; version: number }; altPin: { profileName: string; version: number }; code?: string };
  const derive = async (exp: Record<string, unknown>) => (await handler(
    { aeDeriveExperimentVersions: { experiment: exp, actor: 'arn:admin' } } as never,
  )) as unknown as Derived;
  let store: ReturnType<typeof import('./helpers/fake-ssm-store').fakeSsmStore>;
  let liveVersion: number;

  beforeEach(async () => {
    const { fakeSsmStore } = await import('./helpers/fake-ssm-store');
    store = fakeSsmStore();
    send.mockImplementation((cmd: unknown) => store.client.send(cmd as never));
    await publishPremiumCatalog(store.client);
    // THE LIVE ASSISTANT HAS AN ACTIVE VERSION: the seed, activated.
    const { createDraft, activateDraft } = await import('../lambda/src/lib/profile-lifecycle');
    const { getModelCatalog } = await import('../lib/config/model-strategy');
    await createDraft(store.client, '/agent-echelon', live, 'arn:admin');
    liveVersion = (await activateDraft(store.client, '/agent-echelon', live, getModelCatalog('us-east-1', '123456789012'), 'arn:admin')).version;
  });
  const versionOf = async (pin: { profileName: string; version: number }) => {
    const { lookupProfileVersion } = await import('../lambda/src/lib/profile-version-lookup');
    return lookupProfileVersion(store.client, '/agent-echelon', pin);
  };
  const liveBody = async () => versionOf({ profileName: live, version: liveVersion });

  it('intent: the control pins the live active version (nothing published under the live name); the candidate changes only its route', async () => {
    const r = await derive(battle('intent', [
      { variantId: 'control' },
      { variantId: 'treatment', modelKey: 'gpt_oss_120b', systemPromptAddendum: 'be terse' },
    ]));
    expect(r.ok).toBe(true);
    expect(r.controlPin).toMatchObject({ profileName: live, version: liveVersion });
    // Nothing new in the live history.
    await expect(versionOf({ profileName: live, version: liveVersion + 1 })).resolves.toBeNull();
    expect(r.altPin.profileName).toBe(alt);
    const base = await liveBody();
    const candidate = await versionOf(r.altPin);
    // ONE ROUTE'S PRIMARY: the route's fallback, every other route, the base model and the classifier are the control's.
    expect(candidate?.models?.byIntent).toEqual({
      ...base?.models?.byIntent,
      code_generation: { ...base?.models?.byIntent?.code_generation, primary: 'gpt_oss_120b' },
    });
    expect(candidate?.models?.default).toBe(base?.models?.default);
    expect(candidate?.models?.classifier).toBe(base?.models?.classifier);
    expect(candidate?.systemPromptAddendum).toBe('be terse');
    // THE ALIAS NEVER REACHES A VERSION: the candidate carries the live assistant's own name.
    expect(candidate?.displayName).toBe(base?.displayName);
    expect(candidate?.derivedFrom).toMatchObject({ experimentId: 'exp-arm', variantId: 'treatment', baseProfile: live, baseVersion: liveVersion });
  });

  it('intent: a candidate cheaper than the base model is a candidate like any other, and its route says it', async () => {
    // A simple model for a simple intent while the base stays higher: the route is served as written.
    const r = await derive(experiment('intent', [{ variantId: 'control' }, { variantId: 'treatment', modelKey: 'haiku' }]));
    expect(r.ok).toBe(true);
    const candidate = await versionOf(r.altPin);
    expect(candidate?.models?.byIntent?.code_generation?.primary).toBe('haiku');
    expect(candidate?.models?.default).toBe((await liveBody())?.models?.default);
  });

  it('base_model, not a battle: the control is the live version and the candidate changes only the base model', async () => {
    const r = await derive(experiment('base_model', [{ variantId: 'control', modelKey: 'opus' }, { variantId: 'treatment', modelKey: 'sonnet' }]));
    expect(r.ok).toBe(true);
    expect(r.controlPin).toMatchObject({ profileName: live, version: liveVersion });
    const base = await liveBody();
    const candidate = await versionOf(r.altPin);
    expect(candidate).toMatchObject({ modelKey: 'sonnet', models: { default: 'sonnet' } });
    expect(candidate?.models?.byIntent).toEqual(base?.models?.byIntent);
    expect(candidate?.models?.classifier).toBe(base?.models?.classifier);
  });

  it('classification: the candidate changes only the classifier', async () => {
    const r = await derive(battle('classification', [
      { variantId: 'control' },
      { variantId: 'treatment', modelKey: 'titan' },
    ]));
    expect(r.ok).toBe(true);
    const base = await liveBody();
    const candidate = await versionOf(r.altPin);
    expect(candidate?.models?.classifier).toBe('titan');
    expect(candidate?.models?.default).toBe(base?.models?.default);
    expect(candidate?.models?.byIntent).toEqual(base?.models?.byIntent);
  });

  it('a control that differs from the live version is refused, and so is one with no live version to pin', async () => {
    const r = await derive(experiment('base_model', [{ variantId: 'control', modelKey: 'sonnet' }, { variantId: 'treatment', modelKey: 'opus' }]));
    expect(r).toMatchObject({ ok: false, code: 'CONTROL_DIFFERS_FROM_LIVE' });
    const { fakeSsmStore } = await import('./helpers/fake-ssm-store');
    const empty = fakeSsmStore();
    send.mockImplementation((cmd: unknown) => empty.client.send(cmd as never));
    const none = await derive(experiment('base_model', [{ variantId: 'control' }, { variantId: 'treatment', modelKey: 'sonnet' }]));
    expect(none).toMatchObject({ ok: false, code: 'CONTROL_HAS_NO_ACTIVE_VERSION' });
  });

  it('profile: the control references its version; the candidate is a copy of the referenced one, intents excepted', async () => {
    const { PutParameterCommand } = jest.requireActual('@aws-sdk/client-ssm');
    const base = await liveBody();
    const res = await store.client.send(new PutParameterCommand({
      Name: `/agent-echelon/assistant/${live}/definition`, Type: 'String', Overwrite: true,
      Value: JSON.stringify({ ...base, persona: 'the second persona', configId: 'cfg-second', derivedFrom: undefined }),
    }));
    const v2 = (res as { Version?: number }).Version as number;
    const r = await derive(battle('profile', [
      { variantId: 'control', profileRef: { profileName: live, version: liveVersion } },
      { variantId: 'treatment', profileRef: { profileName: live, version: v2 }, systemPromptAddendum: 'be terse' },
    ]));
    expect(r.ok).toBe(true);
    expect(r.controlPin).toMatchObject({ profileName: live, version: liveVersion });
    const candidate = await versionOf(r.altPin);
    expect(candidate).toMatchObject({ persona: 'the second persona', systemPromptAddendum: 'be terse' });
    expect(candidate?.displayName).toBe(base?.displayName);
  });

  it('a re-arm that says the same thing reuses the candidate rather than publishing again', async () => {
    const exp = battle('base_model', [
      { variantId: 'control' },
      { variantId: 'treatment', modelKey: 'sonnet' },
    ]);
    const first = await derive(exp);
    const again = await derive({ ...exp, variants: [{ ...exp.variants[0], controlPin: first.controlPin }, { ...exp.variants[1], altPin: first.altPin }] });
    expect(again.controlPin).toEqual(first.controlPin);
    expect(again.altPin).toEqual(first.altPin);
  });

  it('two versions of one assistant: refuses a third variant and a second classification', async () => {
    const three = await derive(experiment('base_model', [{ variantId: 'a' }, { variantId: 'b', modelKey: 'sonnet' }, { variantId: 'c', modelKey: 'haiku' }]));
    expect(three.code).toBe('EXPERIMENT_TWO_VERSIONS');
    const two = await derive(experiment('base_model', [{ variantId: 'a' }, { variantId: 'b', modelKey: 'sonnet' }], { tiers: ['standard', 'premium'] }));
    expect(two.code).toBe('EXPERIMENT_ONE_CLASSIFICATION');
  });

  it('accepts the request under its earlier name, and a direct API Gateway request never reaches it', async () => {
    const legacy = (await handler({ aeDeriveBattleSides: { experiment: battle('base_model', [
      { variantId: 'control' }, { variantId: 'treatment', modelKey: 'sonnet' },
    ]), actor: 'arn:admin' } } as never)) as unknown as Derived;
    expect(legacy.ok).toBe(true);
    // An API request carries a method, so the internal shape in its body is just an unknown route.
    const res = await handler(evt({ method: 'POST', path: '/admin/profiles/derive', body: JSON.stringify({ aeDeriveExperimentVersions: {} }) }));
    expect(res.statusCode).not.toBe(200);
  });

  it('the variant-version route refuses to derive for the control: it is the live version', async () => {
    ddbSend.mockResolvedValue({ Item: battle('base_model', [{ variantId: 'control' }, { variantId: 'treatment', modelKey: 'sonnet' }]) });
    const res = await handler(evt({
      method: 'POST', path: '/admin/profiles/variant-version',
      body: JSON.stringify({ experimentId: 'exp-arm', variantId: 'control' }),
    }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('CONTROL_IS_THE_LIVE_VERSION');
  });
});

describe('promotion copies the measured candidate into the live assistant (§3.6)', () => {
  const live = 'advisor';
  const alt = 'alt-primary-premium';
  let store: ReturnType<typeof import('./helpers/fake-ssm-store').fakeSsmStore>;
  let liveVersion: number;
  const CATALOG = () => jest.requireActual('../lib/config/model-strategy').getModelCatalog('us-east-1', '123456789012');

  beforeEach(async () => {
    const { fakeSsmStore } = await import('./helpers/fake-ssm-store');
    store = fakeSsmStore();
    send.mockImplementation((cmd: unknown) => store.client.send(cmd as never));
    await publishPremiumCatalog(store.client);
    const { createDraft, activateDraft } = await import('../lambda/src/lib/profile-lifecycle');
    await createDraft(store.client, '/agent-echelon', live, 'arn:admin');
    liveVersion = (await activateDraft(store.client, '/agent-echelon', live, CATALOG(), 'arn:admin')).version;
  });
  const armed = async () => {
    const exp = {
      experimentId: 'exp-p', status: 'active', experimentType: 'base_model', tiers: ['premium'], servesVersions: true,
      variants: [{ variantId: 'control', weight: 50 }, { variantId: 'treatment', modelKey: 'sonnet', weight: 50 }],
    };
    const r = (await handler({ aeDeriveExperimentVersions: { experiment: exp, actor: 'arn:admin' } } as never)) as unknown as {
      controlPin: { profileName: string; version: number }; altPin: { profileName: string; version: number };
    };
    type Pin = { profileName: string; version: number };
    return { ...exp, variants: [{ ...exp.variants[0], controlPin: r.controlPin }, { ...exp.variants[1], altPin: r.altPin }] } as Record<string, unknown> & {
      variants: [Record<string, unknown> & { controlPin: Pin }, Record<string, unknown> & { altPin: Pin }];
    };
  };
  const promote = async (experiment: Record<string, unknown>) => (await handler(
    { aePromoteCandidate: { experiment, actor: 'arn:admin' } } as never,
  )) as unknown as { ok: boolean; code?: string; version: number; configId: string; promotedFrom: Record<string, unknown> };

  it('activates a copy that hashes to the candidate, recording promotedFrom', async () => {
    const exp = await armed();
    const pin = exp.variants[1].altPin;
    const { lookupProfileVersion } = await import('../lambda/src/lib/profile-version-lookup');
    const candidate = await lookupProfileVersion(store.client, '/agent-echelon', pin);
    const r = await promote(exp);
    expect(r.ok).toBe(true);
    expect(r.configId).toBe(candidate?.configId);
    expect(r.promotedFrom).toEqual({ profileName: alt, version: pin.version, experimentId: 'exp-p' });
    const { listProfile } = await import('../lambda/src/lib/profile-lifecycle');
    const listing = await listProfile(store.client, '/agent-echelon', live);
    expect(listing.activeVersion).toBe(r.version);
    expect(listing.versions.find((v) => v.version === r.version)).toMatchObject({
      configId: candidate?.configId, promotedFrom: { profileName: alt, version: pin.version, experimentId: 'exp-p' },
    });
    // The promoted version is an ordinary version of the live assistant: no candidate provenance on it.
    const promoted = await lookupProfileVersion(store.client, '/agent-echelon', { profileName: live, version: r.version });
    expect(promoted?.derivedFrom).toBeUndefined();
    expect(promoted?.modelKey).toBe('sonnet');
  });

  it('refuses when the live active version moved since the experiment started, and writes nothing', async () => {
    const exp = await armed();
    const { createDraft, editDraft, activateDraft, listProfile } = await import('../lambda/src/lib/profile-lifecycle');
    await createDraft(store.client, '/agent-echelon', live, 'arn:admin');
    await editDraft(store.client, '/agent-echelon', live, { persona: 'a newer persona' }, 'arn:admin');
    const moved = await activateDraft(store.client, '/agent-echelon', live, CATALOG(), 'arn:admin');
    const r = await promote(exp);
    expect(r).toMatchObject({ ok: false, code: 'LIVE_VERSION_MOVED' });
    const listing = await listProfile(store.client, '/agent-echelon', live);
    expect(listing.activeVersion).toBe(moved.version);
    expect(listing.versions.map((v) => v.version)).toEqual([moved.version, liveVersion]);
  });

  it('refuses a copy that does not hash to what was measured, and writes nothing', async () => {
    const exp = await armed();
    // The candidate's stored configId no longer matches its body (a tampered or corrupted record).
    const { PutParameterCommand } = jest.requireActual('@aws-sdk/client-ssm');
    const { lookupProfileVersion } = await import('../lambda/src/lib/profile-version-lookup');
    const candidate = await lookupProfileVersion(store.client, '/agent-echelon', exp.variants[1].altPin);
    const res = await store.client.send(new PutParameterCommand({
      Name: `/agent-echelon/assistant/${alt}/definition`, Type: 'String', Overwrite: true,
      Value: JSON.stringify({ ...candidate, configId: 'not-the-hash' }),
    }));
    const tampered = { ...exp, variants: [exp.variants[0], { ...exp.variants[1], altPin: { profileName: alt, version: (res as { Version?: number }).Version as number } }] };
    const r = await promote(tampered);
    expect(r).toMatchObject({ ok: false, code: 'PROMOTION_HASH_MISMATCH' });
    const { listProfile } = await import('../lambda/src/lib/profile-lifecycle');
    expect((await listProfile(store.client, '/agent-echelon', live)).activeVersion).toBe(liveVersion);
  });

  it('refuses an experiment with no pinned versions, or whose control is not the live assistant', async () => {
    expect((await promote({ experimentId: 'x', tiers: ['premium'], variants: [{ variantId: 'a' }, { variantId: 'b' }] })).code).toBe('PROMOTION_NEEDS_TWO_VERSIONS');
    const exp = await armed();
    // A profile experiment whose control references no assistant this deployment declares has no live control.
    const other = { ...exp, experimentType: 'profile', variants: [{ ...exp.variants[0], profileRef: { profileName: 'not-declared' }, controlPin: { profileName: 'not-declared', version: 1 } }, exp.variants[1]] };
    expect((await promote(other)).code).toBe('PROMOTION_CONTROL_NOT_LIVE');
    // One whose control is a version of the live assistant that is not active is refused as a moved base.
    const stale = { ...exp, variants: [{ ...exp.variants[0], controlPin: { profileName: live, version: liveVersion + 7 } }, exp.variants[1]] };
    expect((await promote(stale)).code).toBe('LIVE_VERSION_MOVED');
  });

  it('the rollback refusal of a derived version names the Promote action', async () => {
    const exp = await armed();
    const { activateExistingVersion } = await import('../lambda/src/lib/profile-lifecycle');
    await expect(activateExistingVersion(store.client, '/agent-echelon', alt, exp.variants[1].altPin.version, 'arn:admin'))
      .rejects.toThrow(/Promote action/);
  });
});

describe('a runtime assistant is managed here while the directory says it is active (ADR-048)', () => {
  const ROOT = '/agent-echelon';
  const entry = (status: string) => JSON.stringify({ classification: 'premium', role: 'primary', status });
  const record = JSON.stringify({
    classification: 'premium', role: 'primary', occupancy: 'live', assistant: 'finance-advisor',
    botArn: 'arn:aws:chime:us-east-1:111:app-instance/a/bot/b-fin', source: 'runtime', status: 'active',
    descriptor: { modelKey: 'sonnet', classifierMode: 'llm' },
  });
  const notFound = () => Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
  function store(params: Record<string, string>) {
    send.mockImplementation(async (cmd: { constructor: { name: string }; input: { Name?: string; Path?: string } }) => {
      if (cmd.constructor.name === 'GetParametersByPathCommand') {
        if (cmd.input.Path !== `${ROOT}/assistant-directory`) return { Parameters: [] };
        return { Parameters: Object.entries(params)
          .filter(([n]) => n.startsWith(`${ROOT}/assistant-directory/`))
          .map(([Name, Value]) => ({ Name, Value })) };
      }
      // Writes land (the tests read them back off the mock's calls); reads answer from `params`.
      if (['PutParameterCommand', 'LabelParameterVersionCommand', 'DeleteParameterCommand'].includes(cmd.constructor.name)) return { Version: 1 };
      const value = cmd.input.Name ? params[cmd.input.Name] : undefined;
      if (value === undefined) throw notFound();
      return { Parameter: { Value: value, Version: 1 } };
    });
  }
  const post = (path: string, body: Record<string, unknown>) =>
    handler(evt({ method: 'POST', path, body: JSON.stringify(body) }));

  it('lists a declared assistant as one kind of assistant: retire offered by the guards, not by how it was asked for', async () => {
    // ADR-048, amended 2026-10-23: every assistant has a directory entry; `origin` is a detail on its row.
    const declared = (role: string, status = 'active') => JSON.stringify({ classification: 'premium', role, status, origin: 'declared', botArn: 'arn:x/bot/y' });
    store({
      [`${ROOT}/assistant-directory/advisor`]: declared('primary'),
      [`${ROOT}/assistant-directory/ops-premium`]: declared('ops', 'retired'),
      [`${ROOT}/assistant-directory/alt-primary-premium`]: JSON.stringify({ classification: 'premium', role: 'primary', status: 'active', origin: 'declared', occupancy: 'alt' }),
      [`${ROOT}/assistant-directory/finance-advisor`]: entry('active'),
      [`${ROOT}/assistant-assignments/premium/primary/assistants/finance-advisor`]: record,
    });
    const body = JSON.parse((await handler(evt({ method: 'GET' }))).body);
    const rows = Object.fromEntries((body.profiles as Array<{ profileName: string }>).map((p) => [p.profileName, p as Record<string, unknown>]));
    // A classification's primary is listed as declared and is not retirable; a console-created one is.
    expect(rows.advisor).toMatchObject({ origin: 'deployed', retirable: false });
    expect(rows['finance-advisor']).toMatchObject({ origin: 'console', retirable: true });
    // A declared assistant RETIRED IN THE CONSOLE is not a profile to open: it is a retired row, like any other.
    expect(rows['ops-premium']).toBeUndefined();
    const roster = Object.fromEntries((body.runtimeAssistants as Array<{ assistant: string }>).map((r) => [r.assistant, r as Record<string, unknown>]));
    expect(roster['ops-premium']).toMatchObject({ status: 'retired', origin: 'declared', retirable: true });
    // A duel's alt is not a row.
    expect(roster['alt-primary-premium']).toBeUndefined();
  });

  it('lists an active runtime assistant beside the declared ones, and never a retired one', async () => {
    store({
      [`${ROOT}/assistant-directory/finance-advisor`]: entry('active'),
      [`${ROOT}/assistant-assignments/premium/primary/assistants/finance-advisor`]: record,
      [`${ROOT}/assistant-directory/old-advisor`]: entry('retired'),
    });
    const res = await handler(evt({ method: 'GET' }));
    const names = (JSON.parse(res.body).profiles as Array<{ profileName?: string; name?: string }>).map((p) => p.profileName ?? p.name);
    expect(names).toContain('finance-advisor');
    expect(names).not.toContain('old-advisor');
  });

  it('reports every runtime assistant\'s state for the roster, one being built and a failed one included', async () => {
    store({
      [`${ROOT}/assistant-directory/finance-advisor`]: entry('active'),
      [`${ROOT}/assistant-assignments/premium/primary/assistants/finance-advisor`]: record,
      [`${ROOT}/assistant-directory/new-advisor`]: entry('provisioning'),
      [`${ROOT}/assistant-directory/bad-advisor`]: JSON.stringify({ classification: 'premium', role: 'primary', status: 'failed', error: 'denied', leftover: ['Lex bot X'] }),
    });
    const body = JSON.parse((await handler(evt({ method: 'GET' }))).body);
    const byName = Object.fromEntries((body.runtimeAssistants as Array<{ assistant: string }>).map((r) => [r.assistant, r]));
    expect(byName['new-advisor']).toMatchObject({ status: 'provisioning', classification: 'premium', role: 'primary' });
    expect(byName['bad-advisor']).toMatchObject({ status: 'failed', error: 'denied', leftover: ['Lex bot X'] });
    // Only an active one is a profile to edit.
    const names = (body.profiles as Array<{ profileName?: string; name?: string }>).map((p) => p.profileName ?? p.name);
    expect(names).not.toContain('new-advisor');
    // Where one may be created: the deployment's own conversational classifications and the roles their stacks
    // DEPLOY (the registry rows), which is what a create accepts. No record decides it.
    const targets = Object.fromEntries((body.rosterTargets as Array<{ classification: string; roles: string[] }>).map((t) => [t.classification, t.roles]));
    expect(targets.premium).toEqual(['primary', 'ops']);
    expect(targets.basic).toEqual(['primary']);
    expect(targets.admin).toBeUndefined();
  });

  it('says so when the directory cannot be read, rather than presenting the declared set as complete', async () => {
    send.mockImplementation(async (cmd: { constructor: { name: string }; input: { Path?: string } }) => {
      if (cmd.constructor.name === 'GetParametersByPathCommand' && cmd.input.Path === `${ROOT}/assistant-directory`) {
        throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      }
      throw notFound();
    });
    const res = await handler(evt({ method: 'GET' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).runtimeDirectoryUnreadable).toBe(true);
  });

  it('a runtime assistant never activated starts its new version from the classification defaults', async () => {
    const pack = { extends: 'default', intents: [{ key: 'finance_question', description: 'A finance question.' }] };
    store({
      [`${ROOT}/assistant-directory/finance-advisor`]: entry('active'),
      [`${ROOT}/assistant-assignments/premium/primary/assistants/finance-advisor`]: record,
      [`${ROOT}/assistant/premium/assistant-intent-pack`]: JSON.stringify(pack),
      [`${ROOT}/assistant/premium/assistant-system-prompt`]: 'You are the premium assistant.',
    });
    const res = await post('/admin/profiles/version', { profileName: 'finance-advisor' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ profileName: 'finance-advisor', firstDraft: true });
    const put = send.mock.calls.map(([c]) => c).find((c: { constructor: { name: string }; input: { Name?: string } }) =>
      c.constructor.name === 'PutParameterCommand' && c.input.Name === `${ROOT}/assistant/finance-advisor/draft`);
    const draft = JSON.parse(put.input.Value);
    expect(draft.intentPack).toEqual(pack);
    expect(draft.persona).toBe('You are the premium assistant.');
    expect(draft.modelKey).toBe('sonnet');
  });

  it('the build asks for the first draft directly, and an assistant with a draft is left alone', async () => {
    store({
      [`${ROOT}/assistant-directory/finance-advisor`]: entry('active'),
      [`${ROOT}/assistant-assignments/premium/primary/assistants/finance-advisor`]: record,
      [`${ROOT}/assistant/premium/assistant-intent-pack`]: JSON.stringify({ extends: 'default', intents: [] }),
    });
    const seeded = await handler({ aeSeedFirstDraft: { assistant: 'finance-advisor', actor: 'admin-1' } } as never) as unknown as { seeded: boolean };
    expect(seeded.seeded).toBe(true);
    store({
      [`${ROOT}/assistant-directory/finance-advisor`]: entry('active'),
      [`${ROOT}/assistant-assignments/premium/primary/assistants/finance-advisor`]: record,
      [`${ROOT}/assistant/finance-advisor/draft`]: JSON.stringify({ schemaVersion: 1, profileName: 'finance-advisor', modelKey: 'sonnet', configId: 'c1' }),
    });
    const again = await handler({ aeSeedFirstDraft: { assistant: 'finance-advisor' } } as never) as unknown as { seeded: boolean; reason: string };
    expect(again).toMatchObject({ seeded: false, reason: 'it already has a draft' });
    const declared = await handler({ aeSeedFirstDraft: { assistant: 'advisor' } } as never) as unknown as { seeded: boolean };
    expect(declared.seeded).toBe(false);
  });

  it('refuses a rename to a name another assistant in the classification shows, on the edit and at activation', async () => {
    store({
      [`${ROOT}/assistant-directory/finance-advisor`]: entry('active'),
      [`${ROOT}/assistant-assignments/premium/primary/assistants/finance-advisor`]: record,
      [`${ROOT}/assistant-directory/tax-advisor`]: JSON.stringify({ classification: 'premium', role: 'primary', status: 'active', displayName: 'Tax Desk' }),
      [`${ROOT}/assistant/finance-advisor/draft`]: JSON.stringify({ schemaVersion: 1, profileName: 'finance-advisor', modelKey: 'sonnet', displayName: 'tax desk', configId: 'c1' }),
    });
    const edit = await post('/admin/profiles/draft', { profileName: 'finance-advisor', patch: { displayName: ' TAX DESK ' } });
    expect(edit.statusCode).toBe(409);
    expect(JSON.parse(edit.body).code).toBe('ASSISTANT_DISPLAY_NAME_TAKEN');
    const activate = await post('/admin/profiles/activate', { profileName: 'finance-advisor' });
    expect(activate.statusCode).toBe(409);
    expect(JSON.parse(activate.body).code).toBe('ASSISTANT_DISPLAY_NAME_TAKEN');
    const writes = send.mock.calls.map(([c]) => c.constructor.name).filter((n: string) => n === 'PutParameterCommand' || n === 'LabelParameterVersionCommand');
    expect(writes).toEqual([]);
  });

  const PACK = { extends: 'default', intents: [{ key: 'finance_question', description: 'A finance question.', keywords: ['ledger'], delivery: 'DIRECT' }] };
  it("puts a runtime assistant's activated name on its identity through the runtime applier", async () => {
    process.env.RUNTIME_NAME_APPLIER_ARN = 'arn:aws:lambda:us-east-1:111:function:RuntimeApplyAssistantName';
    lambdaInvokes.length = 0;
    store({
      [`${ROOT}/assistant-directory/finance-advisor`]: entry('active'),
      [`${ROOT}/assistant-assignments/premium/primary/assistants/finance-advisor`]: record,
      [`${ROOT}/assistant/premium/assistant-intent-pack`]: JSON.stringify(PACK),
    });
    await post('/admin/profiles/version', { profileName: 'finance-advisor' });
    const draft = send.mock.calls.map(([c]) => c).filter((c: { constructor: { name: string }; input: { Name?: string } }) =>
      c.constructor.name === 'PutParameterCommand' && c.input.Name === `${ROOT}/assistant/finance-advisor/draft`).pop();
    store({
      [`${ROOT}/assistant-directory/finance-advisor`]: entry('active'),
      [`${ROOT}/assistant-assignments/premium/primary/assistants/finance-advisor`]: record,
      [`${ROOT}/assistant/premium/assistant-intent-pack`]: JSON.stringify(PACK),
      [`${ROOT}/assistant/finance-advisor/draft`]: JSON.stringify({ ...JSON.parse(draft.input.Value), displayName: 'Penny' }),
      [`${ROOT}/assistant/premium/context-sources`]: JSON.stringify([{ key: 'user-profile' }]),
    });
    const res = await post('/admin/profiles/activate', { profileName: 'finance-advisor' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).identityRename).toBe('applied');
    expect(lambdaInvokes).toEqual([{ FunctionName: process.env.RUNTIME_NAME_APPLIER_ARN, payload: { assistant: 'finance-advisor', displayName: 'Penny' } }]);
    delete process.env.RUNTIME_NAME_APPLIER_ARN;
  });

  // A manifest exported from the declared `advisor`, imported into the console-created `finance-advisor`.
  const advisorManifest = {
    schemaVersion: 1, kind: 'assistant-profile', profileName: 'advisor',
    body: { modelKey: 'sonnet', persona: 'You advise.', intentPack: PACK },
    provenance: { sourceProfileName: 'advisor', sourceVersion: 4, exportedConfigId: 'cfg-advisor' },
  };
  const draftWrites = () => send.mock.calls.map(([c]) => c)
    .filter((c: { constructor: { name: string } }) => c.constructor.name === 'PutParameterCommand')
    .map((c: { input: { Name: string } }) => c.input.Name)
    .filter((n: string) => n.endsWith('/draft'));

  it("lands an import on the target it names, whatever the manifest's own name", async () => {
    store({
      [`${ROOT}/assistant-directory/finance-advisor`]: entry('active'),
      [`${ROOT}/assistant-assignments/premium/primary/assistants/finance-advisor`]: record,
    });
    const res = await post('/admin/profiles/import', { manifest: advisorManifest, targetProfileName: 'finance-advisor' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ imported: 'finance-advisor', landedAs: 'draft' });
    // finance-advisor's draft, and nothing written under the manifest's own name.
    expect(draftWrites()).toEqual([`${ROOT}/assistant/finance-advisor/draft`]);
  });

  it('a team route lands an import on its own assistant without a target in the body', async () => {
    mockScope.mockResolvedValue({ assistant: 'finance-advisor', bots: [] });
    store({
      [`${ROOT}/assistant-directory/finance-advisor`]: entry('active'),
      [`${ROOT}/assistant-assignments/premium/primary/assistants/finance-advisor`]: record,
    });
    const res = await post('/admin/assistants/finance-advisor/profiles/import', { manifest: advisorManifest });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).imported).toBe('finance-advisor');
    expect(draftWrites()).toEqual([`${ROOT}/assistant/finance-advisor/draft`]);
  });

  it('does not know a retired one at all', async () => {
    store({
      [`${ROOT}/assistant-directory/finance-advisor`]: entry('retired'),
      [`${ROOT}/assistant-assignments/premium/primary/assistants/finance-advisor`]: record,
    });
    const res = await post('/admin/profiles/version', { profileName: 'finance-advisor' });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to activate a version that does not carry its own intent pack', async () => {
    store({
      [`${ROOT}/assistant-directory/finance-advisor`]: entry('active'),
      [`${ROOT}/assistant-assignments/premium/primary/assistants/finance-advisor`]: record,
      [`${ROOT}/assistant/finance-advisor/draft`]: JSON.stringify({
        profileName: 'finance-advisor', modelKey: 'sonnet', persona: 'You help with finance.', configId: 'c1',
      }),
    });
    const res = await post('/admin/profiles/activate', { profileName: 'finance-advisor' });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).errors).toEqual(expect.arrayContaining([expect.stringMatching(/must carry its own intentPack/)]));
  });

  // ── WHERE A NEW ASSISTANT'S FIRST DRAFT STARTS (owner decision, 2026-10-24) ──────────────────────────
  //
  // The create flow chooses the classification's defaults, a profile file, or a copy of another assistant, and
  // its own name and models are written over whichever it chose. A file or a copy is checked before the name is
  // taken (`aeCheckStartingPoint`), with the import's own rules, and lands when the build finishes.
  const created = JSON.stringify({
    classification: 'premium', role: 'primary', status: 'active', displayName: 'Penny',
    descriptor: { modelKey: 'sonnet', classifierMode: 'llm', classifierModelKey: 'haiku' },
  });
  const draftWritten = () => {
    const put = send.mock.calls.map(([c]) => c).find((c: { constructor: { name: string }; input: { Name?: string } }) =>
      c.constructor.name === 'PutParameterCommand' && c.input.Name === `${ROOT}/assistant/finance-advisor/draft`);
    return put ? JSON.parse(put.input.Value) : undefined;
  };
  const advisorActive = JSON.stringify({
    schemaVersion: 1, profileName: 'advisor', modelKey: 'opus', persona: 'You advise.', intentPack: PACK,
    welcome: { title: 'Welcome to Advisor' }, displayName: 'Advisor', configId: 'cfg-adv',
  });

  it('seeds the defaults with the name and both models the create chose', async () => {
    store({
      [`${ROOT}/assistant-directory/finance-advisor`]: created,
      [`${ROOT}/assistant-assignments/premium/primary/assistants/finance-advisor`]: record,
      [`${ROOT}/assistant/premium/assistant-intent-pack`]: JSON.stringify(PACK),
    });
    const out = await handler({ aeSeedFirstDraft: { assistant: 'finance-advisor', actor: 'admin-1' } } as never) as unknown as { seeded: boolean };
    expect(out.seeded).toBe(true);
    expect(draftWritten()).toMatchObject({
      displayName: 'Penny', modelKey: 'sonnet', intentPack: PACK, models: { default: 'sonnet', classifier: 'haiku' },
    });
    // The defaults start from the same seed every declared assistant does, so the person's profile is in context.
    expect(draftWritten().contextSources).toEqual(['user-profile']);
  });

  it("leaves the classification's task graphs out of a first draft from its defaults, so the draft can be activated", async () => {
    // Measured on a deployment: the premium pack declares `machines`, the seed copied the pack whole, and
    // activation refused the draft (`intentPack.machines is not read from a profile version`).
    const withMachines = { ...PACK, machines: { quarterly_report: { initial: 'gather', states: { gather: { transitions: [] } } } } };
    store({
      [`${ROOT}/assistant-directory/finance-advisor`]: created,
      [`${ROOT}/assistant-assignments/premium/primary/assistants/finance-advisor`]: record,
      [`${ROOT}/assistant/premium/assistant-intent-pack`]: JSON.stringify(withMachines),
    });
    const out = await handler({ aeSeedFirstDraft: { assistant: 'finance-advisor' } } as never) as unknown as { seeded: boolean };
    expect(out.seeded).toBe(true);
    const draft = draftWritten();
    expect(draft.intentPack).toEqual(PACK);
    expect(draft.intentPack).not.toHaveProperty('machines');
  });

  it('lands a profile file as the first draft, with the create\'s name and models written over the file\'s', async () => {
    store({
      [`${ROOT}/assistant-directory/finance-advisor`]: created,
      [`${ROOT}/assistant-assignments/premium/primary/assistants/finance-advisor`]: record,
    });
    const manifest = { ...advisorManifest, body: { ...advisorManifest.body, displayName: 'Advisor', models: { default: 'opus', classifier: 'opus' } } };
    const out = await handler({ aeSeedFirstDraft: { assistant: 'finance-advisor', startingPoint: { kind: 'manifest', manifest } } } as never) as unknown as { seeded: boolean };
    expect(out.seeded).toBe(true);
    const draft = draftWritten();
    expect(draft).toMatchObject({ profileName: 'finance-advisor', displayName: 'Penny', modelKey: 'sonnet', persona: 'You advise.', intentPack: PACK });
    expect(draft.models).toMatchObject({ default: 'sonnet', classifier: 'haiku' });
    // A file keeps the context sources it carries.
    expect(draft.contextSources).toBeUndefined();
  });

  it("copies another assistant's active version in the same classification, and records where it came from", async () => {
    store({
      [`${ROOT}/assistant-directory/finance-advisor`]: created,
      [`${ROOT}/assistant-assignments/premium/primary/assistants/finance-advisor`]: record,
      [`${ROOT}/assistant/advisor/definition:active`]: advisorActive,
    });
    const out = await handler({ aeSeedFirstDraft: { assistant: 'finance-advisor', startingPoint: { kind: 'copy', from: 'advisor' } } } as never) as unknown as { seeded: boolean };
    expect(out.seeded).toBe(true);
    const draft = draftWritten();
    expect(draft).toMatchObject({
      profileName: 'finance-advisor', displayName: 'Penny', modelKey: 'sonnet', persona: 'You advise.', intentPack: PACK,
      provenance: { createdFrom: { profileName: 'advisor', version: 1 } },
    });
    // The source's retired welcome is copied as the welcome workflows it becomes (W1), never as a welcome. This one
    // carries no field an opening says, so it says what the platform's welcome says and needs no workflow.
    expect(draft.welcome).toBeUndefined();
    expect(draft.eventWorkflows).toBeUndefined();
    // A copy keeps the context sources of the version it copies.
    expect(draft.contextSources).toBeUndefined();
  });

  it.each([
    ['an assistant in another classification', 'concierge', /answers in basic, not premium/],
    ["a duel's alt", 'alt-primary-premium', /alt's profile/],
    ['an assistant with no active version', 'ops-premium', /no active version/],
    ['a name that is no assistant', 'nobody-here', /not an assistant/],
  ])('refuses to copy %s, before the name is taken', async (_what, from, reason) => {
    store({ [`${ROOT}/assistant/concierge/definition:active`]: advisorActive });
    const out = await handler({
      aeCheckStartingPoint: { assistant: 'finance-advisor', classification: 'premium', startingPoint: { kind: 'copy', from } },
    } as never) as unknown as { errors: string[] };
    expect(out.errors).toEqual([expect.stringMatching(reason)]);
  });

  it('checks a file against the classification the create names, and writes nothing', async () => {
    store({});
    const check = (manifest: unknown, choices: Record<string, string> = {}) => handler({
      aeCheckStartingPoint: { assistant: 'new-advisor', classification: 'basic', startingPoint: { kind: 'manifest', manifest }, choices },
    } as never) as unknown as Promise<{ errors: string[] }>;
    // The create's own model is checked, not the file's: basic selects haiku, not sonnet.
    expect((await check(advisorManifest, { modelKey: 'haiku', classifierModelKey: 'default' })).errors).toEqual([]);
    expect((await check(advisorManifest, { modelKey: 'sonnet' })).errors).toEqual(expect.arrayContaining([expect.stringMatching(/'sonnet' is not available to the target classification 'basic'/)]));
    // A file that names where it answers is refused, as any import is.
    expect((await check({ ...advisorManifest, body: { ...advisorManifest.body, classification: 'premium' } }, { modelKey: 'haiku' })).errors)
      .toEqual([expect.stringMatching(/classification is not part of a profile/)]);
    expect(send.mock.calls.map(([c]) => c.constructor.name)).not.toContain('PutParameterCommand');
    // The name it was checked under is not left behind as an assistant.
    const after = await post('/admin/profiles/version', { profileName: 'new-advisor' });
    expect(after.statusCode).toBe(400);
  });

  it('exports the draft when asked, so the console shows and edits what the draft holds', async () => {
    store({
      [`${ROOT}/assistant-directory/finance-advisor`]: created,
      [`${ROOT}/assistant-assignments/premium/primary/assistants/finance-advisor`]: record,
      [`${ROOT}/assistant/finance-advisor/draft`]: JSON.stringify({ schemaVersion: 1, profileName: 'finance-advisor', modelKey: 'sonnet', persona: 'From the draft.', configId: 'd1' }),
    });
    const res = await post('/admin/profiles/export', { profileName: 'finance-advisor', draft: true });
    expect(res.statusCode).toBe(200);
    const manifest = JSON.parse(res.body).manifest;
    expect(manifest.body.persona).toBe('From the draft.');
    expect(manifest.provenance.sourceVersion).toBe('draft');
    // An assistant with no draft says so, rather than exporting something else in its place.
    store({
      [`${ROOT}/assistant-directory/finance-advisor`]: created,
      [`${ROOT}/assistant-assignments/premium/primary/assistants/finance-advisor`]: record,
    });
    const none = await post('/admin/profiles/export', { profileName: 'finance-advisor', draft: true });
    expect(none.statusCode).toBe(422);
    expect(JSON.parse(none.body).error).toMatch(/has no draft/);
  });

  it('refuses a starting point that is not one, by shape', async () => {
    const out = await handler({
      aeCheckStartingPoint: { assistant: 'new-advisor', classification: 'premium', startingPoint: { kind: 'clone' } },
    } as never) as unknown as { errors: string[] };
    expect(out.errors).toEqual([expect.stringMatching(/startingPoint.kind must be/)]);
  });
});
