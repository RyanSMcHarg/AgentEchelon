/**
 * A ROUTER INVOKES ONLY ITS OWN CLASSIFICATION'S MEETING ENTRIES (tenets P4, D3, D12; the `meetings` capability).
 *
 * A Lambda invoke carries no caller identity, so the run and summary entries cannot tell which router asked. Each
 * classification therefore has its own run entry and its own summary entry (`CAPABILITY_RESOURCES.meetingRun(c)`,
 * `meetingSummary(c)`), and a classification's router role may invoke its own and no other. The entries refuse a
 * conversation of another classification as the second layer (`meeting-api.test.ts`, `a-meetings-ended-card-gains-its-figures.test.ts`).
 *
 * This synthesizes two classifications' assistant stacks and evaluates every `lambda:InvokeFunction` statement on each
 * router role against the other classification's entries, the way IAM matches a resource.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { assistantsOf } from '../helpers/assistants';
import { CLASSIFICATION_TEST_PROPS } from '../helpers/synth';
import { CAPABILITY_RESOURCES } from '../../lib/stacks/agent-classification-common';

type Statement = { Effect?: string; Action?: string | string[]; Resource?: unknown };
type Resource = { Type: string; Properties?: { Roles?: unknown[]; PolicyDocument?: { Statement: Statement[] }; Policies?: Array<{ PolicyDocument: { Statement: Statement[] } }> } };

const ACCOUNT = '111122223333';
const REGION = 'us-east-1';
const arnOf = (name: string) => `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${name}`;

/** A resource as IAM sees it once the partition, region and account are filled in; a token it cannot read stays unmatched. */
function rendered(r: unknown): string {
  if (typeof r === 'string') return r;
  const join = (r as { 'Fn::Join'?: [string, unknown[]] })['Fn::Join'];
  if (join) {
    return join[1].map((p) => {
      if (typeof p === 'string') return p;
      const ref = (p as { Ref?: string }).Ref;
      if (ref === 'AWS::Partition') return 'aws';
      if (ref === 'AWS::Region') return REGION;
      if (ref === 'AWS::AccountId') return ACCOUNT;
      return '<token>';
    }).join(join[0]);
  }
  return '<token>';
}
const matches = (pattern: string, arn: string) =>
  new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(arn);

/** Every function ARN pattern the classification's router role may invoke. */
function routerInvokes(classification: string): string[] {
  const app = new cdk.App({ context: {} });
  const stack = assistantsOf(classification)(app, `AgentEchelonAssistants-${classification}`, {
    ...CLASSIFICATION_TEST_PROPS, capabilities: ['meetings'], env: { account: ACCOUNT, region: REGION },
  } as never);
  const resources = (Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources;
  const [roleId] = Object.entries(resources).find(([id, r]) => r.Type === 'AWS::IAM::Role' && /^AgentHandlerRole/.test(id))!;
  const onRole = (r: Resource) => JSON.stringify(r.Properties?.Roles ?? []).includes(`"${roleId}"`);
  const statements: Statement[] = [
    ...(resources[roleId].Properties?.Policies ?? []).flatMap((p) => p.PolicyDocument.Statement),
    ...Object.values(resources)
      .filter((r) => (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') && onRole(r))
      .flatMap((r) => r.Properties!.PolicyDocument!.Statement),
  ];
  return statements
    .filter((s) => s.Effect !== 'Deny' && ([] as string[]).concat(s.Action ?? []).some((a) => a === 'lambda:InvokeFunction' || a === 'lambda:*' || a === '*'))
    .flatMap((s) => ([] as unknown[]).concat(s.Resource ?? []).map(rendered));
}

describe("a classification's router and the meeting entries", () => {
  const premium = routerInvokes('premium');
  const standard = routerInvokes('standard');
  const may = (patterns: string[], name: string) => patterns.some((p) => matches(p, arnOf(name)));

  it('may invoke its own classification\'s run and summary entries', () => {
    expect(may(premium, CAPABILITY_RESOURCES.meetingRun('premium'))).toBe(true);
    expect(may(premium, CAPABILITY_RESOURCES.meetingSummary('premium'))).toBe(true);
    expect(may(standard, CAPABILITY_RESOURCES.meetingRun('standard'))).toBe(true);
    expect(may(standard, CAPABILITY_RESOURCES.meetingSummary('standard'))).toBe(true);
  });

  it("REFUSED: another classification's run entry or summary entry", () => {
    expect(may(premium, CAPABILITY_RESOURCES.meetingRun('standard'))).toBe(false);
    expect(may(premium, CAPABILITY_RESOURCES.meetingSummary('standard'))).toBe(false);
    expect(may(standard, CAPABILITY_RESOURCES.meetingRun('premium'))).toBe(false);
    expect(may(standard, CAPABILITY_RESOURCES.meetingSummary('premium'))).toBe(false);
  });

  it('the evaluation bites: a wildcard over every run entry would be admitted', () => {
    expect(may([arnOf(CAPABILITY_RESOURCES.meetingRun('*'))], CAPABILITY_RESOURCES.meetingRun('standard'))).toBe(true);
  });
});
