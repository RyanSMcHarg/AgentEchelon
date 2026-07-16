/**
 * Tagging invariants (cost attribution).
 *
 * Locks in the rule that `Project` is DERIVED from the deployment identity and applied ONCE
 * at the app root — never a hardcoded literal, never overridden per-stack — so the same
 * platform code deployed as different instances self-attributes to its own cost bucket.
 * See lib/tagging.ts and docs/TAGGING.md.
 */

import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { applyStandardTags, collectProjectTagValues } from '../lib/tagging';
import { ChimeMessagingStack } from '../lib/stacks/chime-messaging-stack';
import { CognitoAuthStack } from '../lib/stacks/cognito-auth-stack';
import { IAMPoliciesStack } from '../lib/stacks/iam-policies-stack';

const env = { account: '123456789012', region: 'us-east-1' };

/** App with standard tags applied at the root + one taggable resource. */
function templateFor(project: string) {
  const app = new cdk.App();
  applyStandardTags(app, { project, codebase: 'AgentEchelon', instance: 'acme', environment: 'Production' });
  const stack = new cdk.Stack(app, 'T', { env });
  new sqs.Queue(stack, 'Q');
  return Template.fromStack(stack);
}

/** The three real stacks that previously carried a hardcoded/overridden Project. */
function realStackTemplates(project: string) {
  const app = new cdk.App();
  applyStandardTags(app, { project, codebase: 'AgentEchelon', instance: 'acme', environment: 'Production' });
  const chime = new ChimeMessagingStack(app, 'Chime', { env, appInstanceName: 'test' });
  const cog = new CognitoAuthStack(app, 'Cog', { env, appInstanceArn: chime.appInstanceArn });
  const arn = ['arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude'];
  const iam = new IAMPoliciesStack(app, 'Iam', {
    env,
    appInstanceArn: chime.appInstanceArn,
    bedrockModelArns: { opus: arn, sonnet: arn, haiku: arn, titan: arn, gpt_oss_20b: arn, gpt_oss_120b: arn },
  });
  return [chime, cog, iam].map((s) => Template.fromStack(s).toJSON());
}

describe('Tagging standard', () => {
  it('derives Project from the deployment identity + applies the full standard set', () => {
    const t = templateFor('Acme');
    for (const tag of [
      { Key: 'Project', Value: 'Acme' },
      { Key: 'Codebase', Value: 'AgentEchelon' },
      { Key: 'Environment', Value: 'Production' },
      { Key: 'ManagedBy', Value: 'CDK' },
      { Key: 'Instance', Value: 'acme' },
    ]) {
      t.hasResourceProperties('AWS::SQS::Queue', { Tags: Match.arrayWith([tag]) });
    }
  });

  it('is reuse-safe: a different instance self-tags with its own Project (no code change)', () => {
    templateFor('AcmeBot').hasResourceProperties('AWS::SQS::Queue', {
      Tags: Match.arrayWith([{ Key: 'Project', Value: 'AcmeBot' }]),
    });
  });

  it('GUARDRAIL: no stack carries a Project value other than the derived one', () => {
    // Format-agnostic scan across the real stacks — catches AI-Assistant-Hub or any other
    // stray per-stack override, regardless of how the resource renders its tags.
    for (const template of realStackTemplates('Acme')) {
      const projects = collectProjectTagValues(template);
      // No FOREIGN value (a stack of only untaggable resources may legitimately have none).
      expect([...projects].filter((v) => v !== 'Acme')).toEqual([]);
      const json = JSON.stringify(template);
      expect(json).not.toContain('AI-Assistant-Hub');
      expect(json).not.toContain('AI-Agent-Interface');
    }
    // And the taggable Cognito stack DOES pick up the derived Project.
    const [, cog] = realStackTemplates('Acme');
    expect(collectProjectTagValues(cog).has('Acme')).toBe(true);
  });
});
