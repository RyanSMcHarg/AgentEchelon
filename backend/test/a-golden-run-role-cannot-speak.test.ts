/**
 * A GOLDEN RUN'S ROLE REACHES ONE CLASSIFICATION AND CANNOT SPEAK (ADR-065 Option A, tenets D12 and P4).
 *
 * A draft answers the golden set on its classification's GoldenRun function, beside the classifier replay and built the
 * same way. Its role invokes that classification's models and the utility model the relevance judge runs on, applies the
 * classification's provisioned guardrails, reads version bodies under `profiles/` and reads and removes its own classification's
 * upload hand-over under `golden-uploads/<classification>/`. It holds no Amazon Chime SDK
 * action, no Lambda invoke (so no vend), no DynamoDB (so no routing table) and no SSM: nothing that speaks or mints an
 * assistant's session. This pins that from the synthesized template, so it is proven rather than reviewed.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { getModelCatalog, utilityModelArns, type Classification } from '../lib/config/model-strategy';
import { modelArnsForClassification, SHARED_SSM } from '../lib/stacks/agent-classification-common';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';
import { CLASSIFICATION_TEST_PROPS } from './helpers/synth';
import { assistantsOf } from './helpers/assistants';

const env = { account: '123456789012', region: 'us-east-1' };

type Resource = { Type: string; Properties: Record<string, any> };
type Statement = { Action: string | string[]; Resource: unknown; Effect?: string };

describe("a golden run's role reaches one classification and cannot speak", () => {
  const conversational = profiles.classificationValues().filter((c) => profiles.isConversational(c));
  const templates: Template[] = [];
  beforeAll(() => {
    const app = new cdk.App({ context: { adminAppUrl: 'https://admin.example.com', appUrl: 'https://chat.example.com' } });
    // Every stack is built before any is synthesized: synthesis freezes the app's construct tree.
    const stacks = conversational.map((c) => assistantsOf(c)(app, `TestGoldenRun-${c}`, {
      ...CLASSIFICATION_TEST_PROPS, env, auroraDriftHookup: { rdsProxy: false, liveDrift: false },
    } as never));
    for (const st of stacks) templates.push(Template.fromStack(st));
  }, 600_000);

  /** Each golden run function with its template, by the classification its environment pins. */
  function goldenRuns(): Array<{ c: string; fn: Resource; t: Template }> {
    const out: Array<{ c: string; fn: Resource; t: Template }> = [];
    for (const t of templates) {
      for (const fn of Object.values(t.findResources('AWS::Lambda::Function')) as Resource[]) {
        const c = fn.Properties?.Environment?.Variables?.GOLDEN_RUN_CLASSIFICATION;
        if (typeof c === 'string') out.push({ c, fn, t });
      }
    }
    return out;
  }

  /** Every statement the function's role carries: its inline policies and any policy attached to it. */
  function statements(fn: Resource, t: Template): Statement[] {
    const roleId = fn.Properties.Role['Fn::GetAtt'][0] as string;
    const role = t.findResources('AWS::IAM::Role')[roleId] as Resource;
    const out: Statement[] = [];
    for (const p of role.Properties.Policies ?? []) out.push(...p.PolicyDocument.Statement);
    for (const p of Object.values(t.findResources('AWS::IAM::Policy')) as Resource[]) {
      if ((p.Properties.Roles ?? []).some((r: { Ref?: string }) => r.Ref === roleId)) out.push(...p.Properties.PolicyDocument.Statement);
    }
    return out;
  }
  const actionsOf = (ss: Statement[]) => ss.flatMap((s) => [s.Action].flat());

  it('there is one golden run per conversational classification', () => {
    expect(goldenRuns().map((g) => g.c).sort()).toEqual([...conversational].sort());
  });

  it('no golden run role holds an Amazon Chime SDK action, a Lambda invoke, DynamoDB or SSM', () => {
    for (const { c, fn, t } of goldenRuns()) {
      const forbidden = actionsOf(statements(fn, t))
        .filter((a) => /^(chime|lambda|dynamodb|ssm|sts):/i.test(a) || a === '*');
      expect({ c, forbidden }).toEqual({ c, forbidden: [] });
    }
  });

  it("each role invokes exactly its classification's models and the utility model", () => {
    const catalog = getModelCatalog(env.region, env.account);
    for (const { c, fn, t } of goldenRuns()) {
      const granted = new Set(statements(fn, t)
        .filter((s) => actionsOf([s]).includes('bedrock:InvokeModel'))
        .flatMap((s) => [s.Resource].flat() as string[]));
      const expected = new Set([
        ...modelArnsForClassification(c as Classification, catalog),
        ...utilityModelArns(env.region, env.account),
      ]);
      expect({ c, granted: [...granted].sort() }).toEqual({ c, granted: [...expected].sort() });
    }
  });

  it("each role applies the clean copy's detector, so an upload is de-identified as a conversation is (decision 7)", () => {
    for (const { c, fn, t } of goldenRuns()) {
      const guardrails = JSON.stringify(statements(fn, t)
        .filter((s) => actionsOf([s]).includes('bedrock:ApplyGuardrail'))
        .map((s) => s.Resource));
      // The detector's ARN is read at deploy from the key Archive publishes it under: the template parameter holding that key.
      const params = (t.toJSON().Parameters ?? {}) as Record<string, { Default?: string }>;
      const detectorParam = Object.entries(params).find(([, p]) => p.Default === SHARED_SSM.deidentifyGuardrailArn)?.[0];
      expect({ c, detector: !!detectorParam && guardrails.includes(`"Ref":"${detectorParam}"`) }).toEqual({ c, detector: true });
      expect(fn.Properties.Environment.Variables.DEIDENTIFY_GUARDRAIL_ID).toBeDefined();
    }
  });

  it("each role reads version bodies, and reads and removes only its own classification's upload hand-over", () => {
    for (const { c, fn, t } of goldenRuns()) {
      const s3 = statements(fn, t).filter((s) => actionsOf([s]).some((a) => a.startsWith('s3:')));
      const byResource = s3.map((s) => ({ actions: actionsOf([s]).sort(), resource: JSON.stringify(s.Resource) }));
      expect(byResource).toHaveLength(2);
      expect(byResource.find((r) => r.resource.includes('/profiles/*'))?.actions).toEqual(['s3:GetObject']);
      // An upload's entries are read once and removed with their version, under this classification's prefix alone.
      expect(byResource.find((r) => r.resource.includes(`/golden-uploads/${c}/*`))?.actions)
        .toEqual(['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:GetObject', 's3:GetObjectVersion']);
      expect(fn.Properties.Environment.Variables.GOLDEN_RUN_CLASSIFICATION).toBe(c);
    }
  });

  it('how each Event ended goes to EventBridge from the Lambda service, so the VPC needs no route to tell the console', () => {
    for (const { c, t } of goldenRuns()) {
      const configs = Object.values(t.findResources('AWS::Lambda::EventInvokeConfig')) as Resource[];
      const mine = configs.find((cfg) => JSON.stringify(cfg.Properties.FunctionName).includes('GoldenRun'));
      expect({ c, retries: mine?.Properties.MaximumRetryAttempts }).toEqual({ c, retries: 0 });
      expect(JSON.stringify(mine?.Properties.DestinationConfig)).toMatch(/event-bus\/default/);
    }
  });
});
