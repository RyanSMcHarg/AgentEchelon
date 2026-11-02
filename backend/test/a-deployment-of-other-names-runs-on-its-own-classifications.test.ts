/**
 * A DEPLOYMENT WHOSE CLASSIFICATIONS SHARE NO NAME WITH THE SAMPLE RUNS ON ITS OWN. Each
 * classification is independent of the others.
 *
 * `internal`, `partner` and `customer`, with disjoint grants: nothing one holds reaches another. Each path
 * below used to name the sample's classifications in code, and each now reads the deployment's registry:
 *
 *  - company context labels a document by the declared classification its key is filed under, and refuses a
 *    document under a prefix the deployment does not declare (`classificationFromKey`);
 *  - the turn's model is read under the classification's declared selection key, and a classification the
 *    deployment does not declare has none (`ProfileRegistry.modelsOf`, `resolveModelForIntent`), which is what the
 *    router's typing rests on now that it carries the classification as a declared string;
 *  - the channel's classification tag resolves to a declared value or to nothing (`readChannelClassificationTag`);
 *  - the proactive briefing is held at the classification the deployment declares for it, or is not built;
 *  - the clients are told this set and no other (`clientClassifications`), which the offer computation in
 *    `frontend/packages/shared/src/config/classifications.ts` reads (its own test runs the same set).
 *
 * `no-code-names-a-sample-classification.test.ts` is the guard that keeps the literals out.
 */
const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  ListObjectsV2Command: jest.fn().mockImplementation((input) => ({ __type: 'List', input })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ __type: 'Get', input })),
}));

import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_PROFILES_CONFIG,
  clientClassifications,
  resolveDeploymentProfiles,
  type ProfilesConfig,
} from '../lib/config/profiles';
import { ProfileRegistry, useDeploymentProfiles, defaultProfileRegistry } from '../lib/profile-registry';
import { INTENT_ROUTE_STRATEGY, getModelCatalog } from '../lib/config/model-strategy';
import { classificationFromKey, loadCompanyContext, __clearCompanyContextCache } from '../lambda/src/lib/company-context';
import { resolveModelForIntent } from '../lambda/src/lib/model-resolver';
import { readChannelClassificationTag } from '../lambda/src/lib/channel-classification';

const topology = () => ({
  timeoutSeconds: 30, memorySize: 512, reservedConcurrency: 5, maxTokens: 1024,
  streaming: false, contextRouting: false, systemPromptParam: false, intentPackParam: true,
  richProcessor: false, handlerExperimentsIndex: false,
});

/** What `internal` selects from the instance's catalog: the sample's standard models. */
const INTERNAL_MODELS = { selected: ['haiku', 'sonnet', 'titan', 'gpt_oss_20b', 'deepseek_v3'], default: 'sonnet' };

/** A deployment's own set: three classifications, no name shared with the sample, no grant shared between them. */
export const OTHER_NAMES: ProfilesConfig = {
  classifications: [
    { value: 'internal', profile: 'colleague', grants: ['internal'], displayName: 'Internal', topology: topology(), holdsBriefing: true, models: INTERNAL_MODELS },
    { value: 'partner', profile: 'envoy', grants: ['partner'], displayName: 'Partner', topology: topology(), models: { selected: ['haiku'], default: 'haiku' } },
    { value: 'customer', profile: 'host', grants: ['customer'], displayName: 'Customer', audience: 'outside', topology: topology(), models: { selected: ['haiku'], default: 'haiku' } },
  ],
  profiles: [
    { name: 'colleague', modelKey: 'sonnet', classifierMode: 'llm', timeoutSeconds: 30, contextScope: 'granted' },
    { name: 'envoy', modelKey: 'haiku', classifierMode: 'llm', timeoutSeconds: 30, contextScope: 'granted' },
    { name: 'host', modelKey: 'haiku', classifierMode: 'llm', timeoutSeconds: 30, contextScope: 'granted' },
  ],
  groupClearance: { staff: 'internal', partners: 'partner' },
};

const BUCKET = 'context-bucket';
let registry: ProfileRegistry;

beforeEach(() => {
  registry = useDeploymentProfiles(resolveDeploymentProfiles(OTHER_NAMES));
  mockS3Send.mockReset();
  __clearCompanyContextCache();
});
afterAll(() => {
  useDeploymentProfiles(DEFAULT_PROFILES_CONFIG);
});

describe('the registry is the deployment\'s set, and only it', () => {
  it('declares its own classifications and the admin plane, and none of the sample\'s', () => {
    expect(registry.classificationValues()).toEqual(['internal', 'partner', 'customer', 'admin']);
    for (const sample of ['basic', 'standard', 'premium']) {
      expect({ sample, known: registry.isKnownClassification(sample) }).toEqual({ sample, known: false });
    }
    expect(registry.grantsFor('internal')).toEqual(['internal']);
    expect(registry.grantsFor('partner')).toEqual(['partner']);
    expect(registry.grantsFor('admin')).toEqual(['admin']);
    expect(registry.briefingClassification()).toBe('internal');
  });

  it('tells its clients this set, with each classification\'s own grants', () => {
    const clients = clientClassifications(resolveDeploymentProfiles(OTHER_NAMES));
    expect(clients.map((c) => [c.value, c.grants])).toEqual([
      ['internal', ['internal']], ['partner', ['partner']], ['customer', ['customer']], ['admin', ['admin']],
    ]);
  });

  it('holds the briefing at one classification of its own people, and at none when none declares it', () => {
    const marking = (value: string) => ({
      ...OTHER_NAMES,
      classifications: OTHER_NAMES.classifications.map((c) => ({ ...c, holdsBriefing: c.value === value || c.holdsBriefing })),
    });
    expect(() => resolveDeploymentProfiles(marking('partner'))).toThrow(/internal and partner both declare holdsBriefing/);
    const only = (value: string) => ({ ...OTHER_NAMES, classifications: OTHER_NAMES.classifications.map((c) => ({ ...c, holdsBriefing: c.value === value })) });
    expect(() => resolveDeploymentProfiles(only('customer'))).toThrow(/'customer' declares holdsBriefing and is an outside classification/);
    expect(new ProfileRegistry(resolveDeploymentProfiles(only('none'))).briefingClassification()).toBeUndefined();
  });

  it('keeps the sample\'s briefing only where the selection keeps its classification', () => {
    expect(new ProfileRegistry(resolveDeploymentProfiles(undefined)).briefingClassification()).toBe('standard');
    expect(new ProfileRegistry(resolveDeploymentProfiles(['basic'])).briefingClassification()).toBeUndefined();
  });
});

describe('company context is labeled by the declared classification its key is filed under', () => {
  it('labels a declared classification\'s context and platform documents', () => {
    expect(classificationFromKey('context/internal/handbook.json')).toBe('internal');
    expect(classificationFromKey('context/partner/price-list.json')).toBe('partner');
    expect(classificationFromKey('platform-knowledge/internal/about.json')).toBe('internal');
  });

  it('refuses a key under a prefix this deployment does not declare, or under no classification at all', () => {
    expect(classificationFromKey('context/basic/company-public.json')).toBeUndefined();
    expect(classificationFromKey('context/premium/financials.json')).toBeUndefined();
    expect(classificationFromKey('context/internal/')).toBeUndefined();
    expect(classificationFromKey('elsewhere/internal/handbook.json')).toBeUndefined();
  });

  it('loads a declared classification\'s documents labeled as it, and drops one under an undeclared prefix', async () => {
    mockS3Send.mockImplementation((cmd: { __type: string; input: { Prefix?: string; Key?: string } }) => {
      if (cmd.__type === 'List') {
        if (cmd.input.Prefix === 'context/internal/') return Promise.resolve({ Contents: [{ Key: 'context/internal/handbook.json' }] });
        if (cmd.input.Prefix === 'context/basic/') return Promise.resolve({ Contents: [{ Key: 'context/basic/company-public.json' }] });
        return Promise.resolve({ Contents: [] });
      }
      return Promise.resolve({ Body: { transformToString: async () => `{"doc":"${cmd.input.Key}"}` } });
    });
    const result = await loadCompanyContext(BUCKET, 'internal', { prefixes: ['context/internal/', 'context/basic/'] });
    expect(result.documents.map((d) => [d.source, d.classification])).toEqual([['context/internal/handbook.json', 'internal']]);
    expect(result.classificationsAccessible).toEqual(['internal']);
  });

  it('reads only the prefixes the classification is granted when no role narrows them', async () => {
    mockS3Send.mockResolvedValue({ Contents: [] });
    await loadCompanyContext(BUCKET, 'partner');
    const listed = mockS3Send.mock.calls.map((c) => c[0]).filter((c) => c.__type === 'List').map((c) => c.input.Prefix);
    expect(listed).toEqual(['context/partner/']);
  });
});

describe('a turn\'s classification is a declared value, and its model is read under its declared key', () => {
  const catalog = () => getModelCatalog('us-east-1', '111122223333');

  it('reads each classification\'s default model from its own selection', () => {
    expect(defaultProfileRegistry.defaultModelOf('internal')).toBe('sonnet');
    expect(defaultProfileRegistry.defaultModelOf('partner')).toBe('haiku');
  });

  it('has no default model for a classification this deployment does not declare', () => {
    expect(defaultProfileRegistry.modelsOf('premium')).toBeUndefined();
    expect(defaultProfileRegistry.defaultModelOf('premium')).toBeUndefined();
    expect(defaultProfileRegistry.defaultModelOf('')).toBeUndefined();
  });

  it('resolves a declared classification\'s turn on its own selection, and refuses an undeclared one', () => {
    const internal = resolveModelForIntent(undefined, 'internal', catalog(), INTENT_ROUTE_STRATEGY, defaultProfileRegistry.modelsOf('internal'));
    expect(internal.primaryModelKey).toBe('sonnet');
    // A route to a model `internal` selects is served.
    const routed = resolveModelForIntent('code_generation', 'internal', catalog(), INTENT_ROUTE_STRATEGY, defaultProfileRegistry.modelsOf('internal'));
    expect(INTERNAL_MODELS.selected).toContain(routed.primaryModelKey);
    expect(() => resolveModelForIntent(undefined, 'premium', catalog(), INTENT_ROUTE_STRATEGY, defaultProfileRegistry.modelsOf('premium')))
      .toThrow(/classification "premium" has no default model/);
  });

  it('resolves a channel tag to a declared classification, and a sample name to nothing', async () => {
    const reader = (value: string) => ({ send: async () => ({ Tags: [{ Key: 'classification', Value: value }] }) });
    expect(await readChannelClassificationTag(reader('partner') as never, 'arn:channel/c', '[test]')).toBe('partner');
    expect(await readChannelClassificationTag(reader('premium') as never, 'arn:channel/c', '[test]')).toBeUndefined();
    expect(defaultProfileRegistry.isConversational('partner')).toBe(true);
    expect(defaultProfileRegistry.isConversational('admin')).toBe(false);
  });

  it('the router refuses a classification the deployment does not declare before any model work (source)', () => {
    const router = fs.readFileSync(path.join(__dirname, '..', 'lambda', 'src', 'router-agent-handler.ts'), 'utf8');
    const refusal = router.indexOf('if (!profiles.isConversational(channelClassification))');
    expect(refusal).toBeGreaterThan(0);
    expect(router.indexOf('\'channel-classification:undeclared\'')).toBeGreaterThan(refusal);
    // Before the turn is classified and before anything is dispatched.
    expect(refusal).toBeLessThan(router.indexOf('const effectiveClassification = channelClassification;'));
  });
});
