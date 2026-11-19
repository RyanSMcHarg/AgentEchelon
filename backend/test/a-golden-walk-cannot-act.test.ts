/**
 * A GOLDEN WALK IS STILL A RUN THAT CHANGES NOTHING (ADR-066 decision 7 and its security posture, tenets D1 and P4).
 *
 * A walk of a multi-step entry runs on the classification's GoldenRun function. Its tools are replayed from the entry's
 * recorded results and its task is held in memory, and that is the first layer. The second is IAM: the function's role
 * grants no Amazon Chime SDK action, so nothing it runs can post or act in a conversation, and no write to a task table,
 * directly (DynamoDB) or through the task service (a Lambda invoke). This synthesizes one classification's stack and
 * reads the role from the template, so the denial is proven rather than reviewed.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';
import { CLASSIFICATION_TEST_PROPS } from './helpers/synth';
import { assistantsOf } from './helpers/assistants';

const env = { account: '123456789012', region: 'us-east-1' };

type Resource = { Type: string; Properties: Record<string, any> };
type Statement = { Action: string | string[]; Resource: unknown; Effect?: string; NotAction?: unknown };

/** Actions that write a DynamoDB item: what writing a task row takes. */
const TABLE_WRITE = /^dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem|TransactWriteItems|PartiQLInsert|PartiQLUpdate|PartiQLDelete|\*)$/i;

describe('a golden walk cannot act: no Amazon Chime SDK and no task-table write on the run role', () => {
  const classification = profiles.classificationValues().find((c) => profiles.isConversational(c))!;
  let template: Template;
  beforeAll(() => {
    const app = new cdk.App({ context: { adminAppUrl: 'https://admin.example.com', appUrl: 'https://chat.example.com' } });
    const stack = assistantsOf(classification)(app, `TestGoldenWalk-${classification}`, {
      ...CLASSIFICATION_TEST_PROPS, env, auroraDriftHookup: { rdsProxy: false, liveDrift: false },
    } as never);
    template = Template.fromStack(stack);
  }, 600_000);

  /** The golden run function and every statement its role carries, inline or attached. */
  function goldenRole(): { fn: Resource; statements: Statement[] } {
    const fn = (Object.values(template.findResources('AWS::Lambda::Function')) as Resource[])
      .find((f) => f.Properties?.Environment?.Variables?.GOLDEN_RUN_CLASSIFICATION === classification)!;
    const roleId = fn.Properties.Role['Fn::GetAtt'][0] as string;
    const role = template.findResources('AWS::IAM::Role')[roleId] as Resource;
    const statements: Statement[] = [];
    for (const p of role.Properties.Policies ?? []) statements.push(...p.PolicyDocument.Statement);
    for (const p of Object.values(template.findResources('AWS::IAM::Policy')) as Resource[]) {
      if ((p.Properties.Roles ?? []).some((r: { Ref?: string }) => r.Ref === roleId)) statements.push(...p.Properties.PolicyDocument.Statement);
    }
    return { fn, statements };
  }

  it('the classification has a golden run to walk on', () => {
    expect(goldenRole().fn).toBeDefined();
  });

  it('DENIED: no Amazon Chime SDK action, so a walk cannot post or act in any conversation', () => {
    const allowed = goldenRole().statements.filter((s) => (s.Effect ?? 'Allow') === 'Allow');
    const chime = allowed.flatMap((s) => [s.Action].flat()).filter((a) => /^chime:/i.test(String(a)) || a === '*');
    expect(chime).toEqual([]);
    // No statement grants by exclusion, which could let a Chime SDK action through unnamed.
    expect(allowed.filter((s) => s.NotAction !== undefined)).toEqual([]);
  });

  it('DENIED: no task-table write, directly or through the task service', () => {
    const actions = goldenRole().statements.filter((s) => (s.Effect ?? 'Allow') === 'Allow').flatMap((s) => [s.Action].flat().map(String));
    expect(actions.filter((a) => TABLE_WRITE.test(a))).toEqual([]);
    // The task service is a Lambda; no invoke means no path to it.
    expect(actions.filter((a) => /^lambda:/i.test(a))).toEqual([]);
  });

  it('the function is told no task table and no task service', () => {
    const vars = Object.keys(goldenRole().fn.Properties.Environment.Variables ?? {});
    expect(vars.filter((v) => /TASK/i.test(v))).toEqual([]);
  });
});
