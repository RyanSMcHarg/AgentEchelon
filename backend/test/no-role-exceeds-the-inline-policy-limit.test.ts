/**
 * NO ROLE IN A CLASSIFICATION STACK CARRIES MORE INLINE POLICY THAN IAM ALLOWS.
 *
 * IAM caps the inline policies on one role at 10,240 bytes combined (the role's own `Policies` plus every
 * `AWS::IAM::Policy` attached to it). Synthesis does not check this; CloudFormation finds out mid-update
 * and rolls the whole stack back with ServiceLimitExceeded. That happened on 2026-10-06: one action added
 * to the drift statements pushed premium's agent-handler role over, and premium rolled back while basic
 * and standard deployed - so the three classifications briefly ran different code.
 *
 * The stacks are synthesized the way the deployment runs them, at its WORST CASE: live drift wired and the
 * every role the catalog offers declared, the image-generation keys secret and a cross-region image guardrail configured, the
 * owner-team aspect applied, and the cross-stack inputs as tokens rather than literals, because each adds
 * bytes the deploy carries. The same measure also runs on every real synth (`enforceInlinePolicyBudget`). The bound is the IAM limit less a margin, so the next growth fails here
 * rather than in CloudFormation. IAM measures policy text without whitespace; JSON.stringify of the
 * template's document is the same shape, before CloudFormation resolves tokens (resolved ARNs run a little
 * longer, which is what the margin is for).
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ExcludeOwnerTeamTag } from '../lib/constructs/exclude-owner-team-tag';
import { INLINE_POLICY_BOUND, inlinePolicyBytesByRole } from '../lib/constructs/inline-policy-budget';
import { assistantsOf } from './helpers/assistants';

const IAM_INLINE_LIMIT = 10240;
const MARGIN = IAM_INLINE_LIMIT - INLINE_POLICY_BOUND;

const env = { account: '123456789012', region: 'us-east-1' };
const props = {
  env,
  // TOKENS, as the deploy passes them: a cross-stack import renders longer than a literal ARN.
  appInstanceArn: cdk.Fn.importValue('AgentEchelonMessaging:ExportsOutputFnGetAttAppInstanceArn'),
  attachmentsBucketName: cdk.Fn.importValue('AgentEchelonConversations:ExportsOutputRefAttachmentsBucketName'),
  attachmentsBucketArn: cdk.Fn.importValue('AgentEchelonConversations:ExportsOutputFnGetAttAttachmentsBucketArn'),
  imageGuardrailByRegion: { 'us-west-2': { id: 'abcdefghij12', version: '1' } },
  // The largest shape a deployment builds: every capability an assistant stack is wired to, declared.
  battle: true,
  experiments: true,
  auroraDriftHookup: { rdsProxy: false, liveDrift: true },
};

/** Inline-policy bytes per role logical id. */
function inlineBytesByRole(t: Template): Map<string, number> {
  const bytes = new Map<string, number>();
  const add = (role: string, n: number) => bytes.set(role, (bytes.get(role) ?? 0) + n);
  for (const [id, r] of Object.entries(t.findResources('AWS::IAM::Role'))) {
    for (const p of (r.Properties?.Policies ?? []) as Array<{ PolicyDocument: unknown }>) add(id, JSON.stringify(p.PolicyDocument).length);
  }
  for (const p of Object.values(t.findResources('AWS::IAM::Policy'))) {
    const size = JSON.stringify(p.Properties.PolicyDocument).length;
    for (const ref of (p.Properties.Roles ?? []) as Array<{ Ref?: string }>) if (ref.Ref) add(ref.Ref, size);
  }
  return bytes;
}

describe.each([
  ['basic', assistantsOf('basic'), 'AgentEchelonAssistants-basic'],
  ['standard', assistantsOf('standard'), 'AgentEchelonAssistants-standard'],
  ['premium', assistantsOf('premium'), 'AgentEchelonAssistants-premium'],
] as const)('%s', (_name, Stack, id) => {
  it(`keeps every role's inline policies under ${IAM_INLINE_LIMIT - MARGIN} bytes`, () => {
    const app = new cdk.App({ context: { imageGenKeysSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:agent-echelon/image-gen-keys-AbCdEf' } });
    cdk.Aspects.of(app).add(new ExcludeOwnerTeamTag());
    const stack = Stack(app, id, props);
    const t = Template.fromStack(stack);
    const sizes = inlineBytesByRole(t);
    // The synth-time validation measures the same thing, overrides included.
    expect(Math.max(...inlinePolicyBytesByRole(stack).values())).toBe(Math.max(...sizes.values()));
    expect(sizes.size).toBeGreaterThan(0);
    const over = [...sizes].filter(([, n]) => n > IAM_INLINE_LIMIT - MARGIN).map(([r, n]) => `${r}: ${n}`);
    expect(over).toEqual([]);

    // AND THE MANAGED-POLICY CAP. Moving a grant from inline to managed trades one IAM limit for another: a role
    // holds at most 10 managed policies by default, and each is at most 6,144 bytes.
    const managedPerRole = new Map<string, number>();
    for (const p of Object.values(t.findResources('AWS::IAM::ManagedPolicy'))) {
      expect(JSON.stringify(p.Properties.PolicyDocument).length).toBeLessThan(6144 - MARGIN / 2);
      for (const ref of (p.Properties.Roles ?? []) as Array<{ Ref?: string }>) if (ref.Ref) managedPerRole.set(ref.Ref, (managedPerRole.get(ref.Ref) ?? 0) + 1);
    }
    for (const [id, r] of Object.entries(t.findResources('AWS::IAM::Role'))) {
      const total = (managedPerRole.get(id) ?? 0) + ((r.Properties?.ManagedPolicyArns ?? []) as unknown[]).length;
      expect([id, total <= 10]).toEqual([id, true]);
    }
  });
});
