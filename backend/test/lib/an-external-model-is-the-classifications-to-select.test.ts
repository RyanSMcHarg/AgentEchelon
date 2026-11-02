/**
 * A MODEL OUTSIDE AWS IS THE CLASSIFICATION'S TO SELECT, AND A PROFILE ENABLES NOTHING. The
 * platform allows, the classification selects, the profile uses.
 *
 * Context routing's external path (rule 2b in `resolveModelPlan`) and an image model hosted outside AWS send
 * conversation content to a non-AWS endpoint. Whether a classification may is whether it selects that model from
 * the instance's catalog (`models` on its registry entry), which is also exactly where its stack holds the
 * provider's key (`test/image-gen-iam-parity.test.ts`). The removed version switch, `models.externalProviderAllowed`,
 * is dropped from every write and read as absent.
 */
import { getModelCatalog, INTENT_ROUTE_STRATEGY } from '../../lib/config/model-strategy';
import { EXTERNAL_MODELS } from '../../lib/config/model-catalog';
import { resolveModelPlan } from '../../lambda/src/lib/resolve-model-plan';
import { PutParameterCommand, LabelParameterVersionCommand } from '@aws-sdk/client-ssm';
import {
  validateDefinitionBody, bodyFrom, definitionParamName, resolveActiveProfile, resolveProfileVersion,
  __clearActiveProfileCache, type ProfileDefinitionBody,
} from '../../lambda/src/lib/active-profile';
import { createDraft, editDraft, activateDraft, activateExistingVersion } from '../../lambda/src/lib/profile-lifecycle';
import { fakeSsmStore } from '../helpers/fake-ssm-store';
import { defaultProfileRegistry as profiles, useDeploymentProfiles } from '../../lib/profile-registry';
import { validateProfilesConfig, DEFAULT_PROFILES_CONFIG, type ProfilesConfig } from '../../lib/config/profiles';
import { validateBody } from '../../lambda/src/lib/profile-lifecycle';

/**
 * `standard` reaching China through the external adapter alone: it routes by context and selects `deepseek_api` in
 * place of DeepSeek on Bedrock, the one shape where the adapter is reachable.
 */
const STANDARD_EXTERNAL: ProfilesConfig = {
  ...DEFAULT_PROFILES_CONFIG,
  classifications: DEFAULT_PROFILES_CONFIG.classifications.map((c) => (c.value === 'standard'
    ? { ...c, models: { selected: [...c.models!.selected.filter((k) => !k.startsWith('deepseek')), 'deepseek_api'], default: 'sonnet' } }
    : c)),
};

// The stack stamps the serving profile on every processor; the module refuses to load without one.
process.env.PROFILE_NAME = process.env.PROFILE_NAME || 'concierge';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { externalProviderSelected } = require('../../lambda/src/assistant-async-processor');

const catalog = getModelCatalog('us-east-1', '123456789012');
const ROOT = '/agent-echelon';

describe('the classification selects the external model, and only it decides', () => {
  it('lists the external adapter in the catalog, naming no classification', () => {
    expect(Object.keys(EXTERNAL_MODELS)).toContain('deepseek_api');
    expect(JSON.stringify(EXTERNAL_MODELS)).not.toMatch(/standard|premium|basic/);
  });

  it('allows the external provider where the classification selects it, and withholds it elsewhere', () => {
    useDeploymentProfiles(STANDARD_EXTERNAL);
    try {
      expect(profiles.selectsModel('standard', 'deepseek_api')).toBe(true);
      expect(externalProviderSelected('standard', 'deepseek')).toEqual({ allowed: true });
      const premium = externalProviderSelected('premium', 'deepseek');
      expect(premium.allowed).toBe(false);
      expect(premium.withheldReason).toMatch(/premium classification does not select deepseek_api/);
      expect(externalProviderSelected('standard', 'qwen').withheldReason).toMatch(/lists no external qwen model/);
    } finally {
      useDeploymentProfiles(DEFAULT_PROFILES_CONFIG);
    }
  });

  it('ships standard on the in-AWS Chinese path, holding no external key it would never use', () => {
    expect(profiles.selectsModel('standard', 'deepseek_v3')).toBe(true);
    expect(profiles.selectsModel('standard', 'deepseek_api')).toBe(false);
  });

  it('routes a Chinese-language turn to the external provider exactly when it is selected', () => {
    const configured = {
      catalog,
      strategy: INTENT_ROUTE_STRATEGY,
      models: profiles.modelsOf('standard'),
      enabled: true,
      cnProvider: { provider: 'deepseek' as const, modelId: 'deepseek-chat' },
    };
    const turn = { classification: 'standard', intent: 'general', userLanguage: 'zh' };
    expect(resolveModelPlan(turn, { ...configured, externalProviderSelected: true }).ref.provider).toBe('deepseek');
    const withheld = resolveModelPlan(turn, { ...configured, externalProviderSelected: false });
    expect(withheld.ref.provider).toBe('bedrock');
    expect(withheld.externalProviderWithheld).toBe(true);
  });
});

describe('a profile enables nothing', () => {
  const body = (models: Record<string, unknown>) => ({ modelKey: 'sonnet', models } as unknown as ProfileDefinitionBody);

  it('drops the retired switch from every body a write builds, and grants nothing for it', () => {
    expect(validateDefinitionBody(body({ default: 'sonnet', externalProviderAllowed: true }))).toEqual([]);
    const written = bodyFrom({ modelKey: 'sonnet', models: { default: 'sonnet', externalProviderAllowed: true } } as never);
    expect(JSON.stringify(written)).not.toContain('externalProviderAllowed');
  });

  // A version stored while the switch existed. It goes through the real read (`parseDefinition`, behind
  // `resolveActiveProfile`), so a refusal there fails the read closed to the seed and the version can be
  // neither served, edited nor rolled back to.
  async function storedWithTheSwitch() {
    const { client, store } = fakeSsmStore();
    await createDraft(client, ROOT, 'analyst', 'a');
    await editDraft(client, ROOT, 'analyst', { modelKey: 'sonnet' }, 'a');
    await activateDraft(client, ROOT, 'analyst', catalog, 'a');
    const param = definitionParamName(ROOT, 'analyst');
    const def = JSON.parse(store.get(param)!.at(-1)!.value);
    def.models = { ...def.models, externalProviderAllowed: true };
    await client.send(new PutParameterCommand({ Name: param, Value: JSON.stringify(def), Type: 'String', Overwrite: true }));
    await client.send(new LabelParameterVersionCommand({ Name: param, ParameterVersion: 2, Labels: ['active'] }));
    // A later version, so rolling back to the stored one is a real move of the label.
    await createDraft(client, ROOT, 'analyst', 'a');
    await editDraft(client, ROOT, 'analyst', { modelKey: 'haiku' }, 'a');
    await activateDraft(client, ROOT, 'analyst', catalog, 'a');
    return { client, store, param };
  }

  beforeEach(() => __clearActiveProfileCache());

  it('serves a stored version that carries it, as if it did not', async () => {
    const { client } = await storedWithTheSwitch();
    const read = await resolveProfileVersion('analyst', 2, { ssm: client, ssmRoot: ROOT });
    expect(read.configId).not.toBe('seed');
    expect(read.version).toBe(2);
    expect(JSON.stringify(read.models)).not.toContain('externalProviderAllowed');
  });

  it('rolls back to it, and an edit of it writes a version without the switch', async () => {
    const { client, store, param } = await storedWithTheSwitch();
    await activateExistingVersion(client, ROOT, 'analyst', 2, 'a');
    __clearActiveProfileCache();
    const active = await resolveActiveProfile('analyst', { ssm: client, ssmRoot: ROOT });
    expect(active.configId).not.toBe('seed');
    expect(active.version).toBe(2);

    await createDraft(client, ROOT, 'analyst', 'a');
    await editDraft(client, ROOT, 'analyst', { persona: 'terse' }, 'a');
    await activateDraft(client, ROOT, 'analyst', catalog, 'a');
    expect(store.get(param)!.at(-1)!.value).not.toContain('externalProviderAllowed');
  });

  it('refuses a profile whose base model its classification does not select', () => {
    const config = {
      ...DEFAULT_PROFILES_CONFIG,
      profiles: DEFAULT_PROFILES_CONFIG.profiles.map((p) => (p.name === 'concierge' ? { ...p, modelKey: 'opus' } : p)),
    };
    expect(() => validateProfilesConfig(config)).toThrow(/profile 'concierge' uses 'opus', which classification 'basic' does not select/);
  });
});

describe('the classification selects from what the platform allows', () => {
  const withBasic = (models: unknown) => ({
    ...DEFAULT_PROFILES_CONFIG,
    classifications: DEFAULT_PROFILES_CONFIG.classifications.map((c) => (c.value === 'basic' ? { ...c, models } : c)),
  }) as never;

  it('refuses an empty selection, an unknown key, and a default that is not a Bedrock text model it selects', () => {
    expect(() => validateProfilesConfig(withBasic({ selected: [], default: 'haiku' }))).toThrow(/basic' selects no models/);
    expect(() => validateProfilesConfig(withBasic(undefined))).toThrow(/basic' selects no models/);
    expect(() => validateProfilesConfig(withBasic({ selected: ['haiku', 'gpt-9'], default: 'haiku' }))).toThrow(/selects 'gpt-9', which the instance's model catalog does not list/);
    expect(() => validateProfilesConfig(withBasic({ selected: ['haiku'], default: 'sonnet' }))).toThrow(/default 'sonnet' is not a Bedrock text model it selects/);
    expect(() => validateProfilesConfig(withBasic({ selected: ['haiku', 'deepseek_api'], default: 'deepseek_api' }))).toThrow(/is not a Bedrock text model/);
  });

  const withStandard = (keep: (k: string) => boolean) => ({
    ...DEFAULT_PROFILES_CONFIG,
    classifications: DEFAULT_PROFILES_CONFIG.classifications.map((c) => (c.value === 'standard'
      ? { ...c, models: { selected: c.models!.selected.filter(keep), default: 'sonnet' } } : c)),
  });

  it('refuses context routing on a classification that selects no Chinese path', () => {
    expect(() => validateProfilesConfig(withStandard((k) => !k.startsWith('deepseek'))))
      .toThrow(/standard' routes by context and selects neither deepseek_v3 nor deepseek_api/);
  });

  it('accepts context routing on either Chinese path alone', () => {
    expect(() => validateProfilesConfig(DEFAULT_PROFILES_CONFIG)).not.toThrow();
    expect(() => validateProfilesConfig(STANDARD_EXTERNAL)).not.toThrow();
  });

  it('refuses the external adapter where no turn reaches it', () => {
    const both = {
      ...DEFAULT_PROFILES_CONFIG,
      classifications: DEFAULT_PROFILES_CONFIG.classifications.map((c) => (c.value === 'standard'
        ? { ...c, models: { selected: [...c.models!.selected, 'deepseek_api'], default: 'sonnet' } } : c)),
    };
    expect(() => validateProfilesConfig(both)).toThrow(/standard' selects deepseek_api, which no turn reaches: it also selects deepseek_v3/);
    expect(() => validateProfilesConfig(withBasic({ selected: ['haiku', 'deepseek_api'], default: 'haiku' })))
      .toThrow(/basic' selects deepseek_api, which no turn reaches: the external adapter serves context routing alone/);
  });
});

describe('a base model is a Bedrock text model', () => {
  it('refuses a profile whose base model is the external adapter, at synth', () => {
    const config = {
      ...STANDARD_EXTERNAL,
      profiles: STANDARD_EXTERNAL.profiles.map((p) => (p.name === 'analyst' ? { ...p, modelKey: 'deepseek_api' } : p)),
    };
    expect(() => validateProfilesConfig(config)).toThrow(/profile 'analyst' uses 'deepseek_api', which is not a Bedrock text model/);
  });

  it('refuses a version that names the external adapter, at validation and activation', () => {
    useDeploymentProfiles(STANDARD_EXTERNAL);
    try {
      const errs = validateBody({ modelKey: 'deepseek_api', models: { default: 'deepseek_api' } }, catalog, undefined, 'standard');
      expect(errs).toEqual(expect.arrayContaining([
        expect.stringMatching(/modelKey 'deepseek_api' is an adapter outside AWS, reached only by context routing/),
        expect.stringMatching(/models.default 'deepseek_api' is an adapter outside AWS/),
      ]));
    } finally {
      useDeploymentProfiles(DEFAULT_PROFILES_CONFIG);
    }
  });
});
