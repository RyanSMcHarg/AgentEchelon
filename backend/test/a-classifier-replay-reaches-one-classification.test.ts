/**
 * A CLASSIFIER REPLAY RUNS WITH ONE CLASSIFICATION'S REACH (tenet D12, ADR-054 decision 5).
 *
 * The replay used to run on one role granted every catalog model, reading every classification's
 * exchanges, so one principal held several classifications' content and models. Each conversational
 * classification now has its own replay function, pinned by `REPLAY_CLASSIFICATION`, on a role whose
 * Bedrock grant is exactly that classification's models (`modelArnsForClassification`). The function
 * refuses a run of another classification (`classifier-replay.test.ts`); this pins the IAM half from the
 * synthesized template. Each is built by its classification's own stack (`ClassificationArchiveFunctions`), and the
 * admin starter finds it by name at call time and invokes it by the replays' name pattern.
 */
import * as cdk from 'aws-cdk-lib';
import { testMessageStream } from './helpers/synth';
import { Template } from 'aws-cdk-lib/assertions';
import { getModelCatalog, type Classification } from '../lib/config/model-strategy';
import { modelArnsForClassification } from '../lib/stacks/agent-classification-common';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';
import { auroraAppTemplates, CLASSIFICATION_TEST_PROPS } from './helpers/synth';
import { assistantsOf } from './helpers/assistants';

const env = { account: '123456789012', region: 'us-east-1' };

type Resource = { Type: string; Properties: Record<string, any> };

describe('each classification replays on its own role, with only its own models', () => {
  const conversational = profiles.classificationValues().filter((c) => profiles.isConversational(c));
  // Each conversational classification's own stack, in Aurora mode; one template holding their resources.
  let template: Template;
  let archive: Template;
  beforeAll(async () => {
    const { ArchiveStackAurora } = await import('../lib/stacks/archive-stack-aurora');
    const app = new cdk.App({ context: { adminAppUrl: 'https://admin.example.com', appUrl: 'https://chat.example.com' } });
    const archiveStack = new ArchiveStackAurora(app, 'TestReplayReach', {
      env,
      appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
      messageStream: testMessageStream(app),
      userPoolId: 'us-east-1_TestPoolId',
      sleepMode: true,
    } as never);
    const stacks = conversational.map((c) => assistantsOf(c)(app, `TestReplayReach-${c}`, {
      ...CLASSIFICATION_TEST_PROPS, env, auroraDriftHookup: { rdsProxy: false, liveDrift: false },
    } as never));
    archive = Template.fromStack(archiveStack);
    const resources: Record<string, unknown> = {};
    stacks.forEach((st, i) => {
      for (const [id, r] of Object.entries((Template.fromStack(st).toJSON() as { Resources: Record<string, unknown> }).Resources)) resources[`S${i}${id}`] = r;
    });
    template = Template.fromJSON({ Resources: resources });
  }, 600_000);

  it('the archive builds no replay function of any classification', () => {
    const inArchive = (Object.values(archive.findResources('AWS::Lambda::Function')) as Resource[])
      .filter((fn) => fn.Properties?.Environment?.Variables?.REPLAY_CLASSIFICATION !== undefined);
    expect(inArchive).toEqual([]);
  });
  const catalog = getModelCatalog(env.region, env.account);

  /** The replay functions in the template, by the classification their environment pins. */
  function replayFunctions(): Map<string, Resource> {
    const out = new Map<string, Resource>();
    for (const fn of Object.values(template.findResources('AWS::Lambda::Function')) as Resource[]) {
      const vars = fn.Properties?.Environment?.Variables ?? {};
      if (typeof vars.REPLAY_CLASSIFICATION === 'string') out.set(vars.REPLAY_CLASSIFICATION, fn);
    }
    return out;
  }

  /** A role's key in the merged template: the same stack prefix as the function that names it. */
  function roleKey(fn: Resource, roleId: string): string {
    const entry = Object.entries(template.findResources('AWS::Lambda::Function')).find(([, r]) => r === fn)!;
    return `${entry[0].match(/^S\d+/)![0]}${roleId}`;
  }

  /** The Bedrock resources a role's inline policies grant. */
  function bedrockResources(roleLogicalId: string): string[] {
    const role = template.findResources('AWS::IAM::Role')[roleLogicalId] as Resource;
    const out: string[] = [];
    for (const p of role.Properties.Policies ?? []) {
      for (const s of p.PolicyDocument.Statement) {
        const actions = [s.Action].flat();
        if (actions.some((a: string) => a.startsWith('bedrock:'))) out.push(...[s.Resource].flat());
      }
    }
    return out;
  }

  it('there is one replay function per conversational classification', () => {
    expect([...replayFunctions().keys()].sort()).toEqual([...conversational].sort());
  });

  it("each role can invoke exactly its classification's models", () => {
    for (const [c, fn] of replayFunctions()) {
      const roleId = fn.Properties.Role['Fn::GetAtt'][0] as string;
      const granted = new Set(bedrockResources(roleKey(fn, roleId)));
      const expected = new Set(modelArnsForClassification(c as Classification, catalog));
      expect({ c, granted: [...granted].sort() }).toEqual({ c, granted: [...expected].sort() });
    }
  });

  it('no replay role reaches a model its classification does not allow', () => {
    for (const [c, fn] of replayFunctions()) {
      const granted = new Set(bedrockResources(roleKey(fn, fn.Properties.Role['Fn::GetAtt'][0])));
      for (const model of Object.values(catalog)) {
        if (profiles.selectsModel(c, model.key)) continue;
        // An ARN the classification's own models share (an inference profile used by both) is allowed by them.
        const own = new Set(modelArnsForClassification(c as Classification, catalog));
        for (const arn of model.foundationModelArns) if (!own.has(arn)) expect({ c, arn, granted: granted.has(arn) }).toEqual({ c, arn, granted: false });
      }
    }
  });

  it('the starter finds a replay by its classification\'s key and names none in its environment', () => {
    // The starter is the admin backend's (AdminServices' analytics, a nested stack), on the Aurora archive.
    const templates = auroraAppTemplates();
    const analytics = Object.entries(templates).find(([name]) => /^AdminServicesAnalytics.*.nested$/.test(name))![1];
    const starter = (Object.values(analytics.findResources('AWS::Lambda::Function')) as Resource[])
      .find((fn) => fn.Properties?.Environment?.Variables?.CLASSIFIER_REPLAY_PARAM_ROOT !== undefined);
    const vars = starter!.Properties.Environment.Variables;
    expect(Object.keys(vars).filter((k) => k.startsWith('CLASSIFIER_REPLAY_ARN'))).toEqual([]);
    // Its invoke: the replays' name pattern, this instance, any classification, and no list.
    const statements = (Object.values(analytics.findResources('AWS::IAM::Policy')) as Resource[])
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Array<{ Sid?: string; Resource: unknown; Condition?: any }>);
    const invoke = statements.find((s) => s.Sid === 'StartAClassificationsReplay')!;
    expect(JSON.stringify(invoke.Resource)).toContain('Assistants-*-ClassifierReplay');
    expect(invoke.Condition.Null).toEqual({ 'aws:ResourceTag/classification': 'false' });
  }, 600_000);
});
