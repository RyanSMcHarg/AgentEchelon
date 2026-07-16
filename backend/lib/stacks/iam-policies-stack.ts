import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { STACK_PREFIX } from './agent-tier-common';

/**
 * ⚠️ STATUS: these per-tier managed policies are **authored but NOT ATTACHED
 * to any principal** and are currently INERT. Two issues block them from being
 * the user-side Layer 1 enforcement, both deferred to the "user-side per-tier
 * Identity Pool roles" follow-up:
 *
 *   1. Wrong IAM action prefix. They use `chime-sdk-messaging:` /
 *      `chime-sdk-identity:`, which are SDK *client* namespaces, NOT IAM action
 *      namespaces. The real Chime SDK messaging IAM prefix is `chime:` (see the
 *      live, working `cognito-auth-stack.ts` AuthenticatedRole + the AWS Service
 *      Authorization Reference for "Amazon Chime"). As written, the Allows match
 *      no real action.
 *   2. They gate every Allow on `aws:PrincipalTag/tier`, which is never
 *      populated — the Identity Pool maps all authenticated users to ONE shared
 *      role with no principal tags. They are not attached to that role either.
 *
 * The chosen user-side substrate is **per-tier Identity Pool roles** keyed on
 * authoritative Cognito *group* membership (not the user-writable `custom:tier`
 * attribute, which is spoofable). That follow-up will rewrite this file to:
 * per-tier roles (no PrincipalTag gating), `chime:` actions, and a
 * `aws:ResourceTag/classification` **Deny** mirroring the assistant-side Deny
 * already live in the tier stacks (`agent-tier-common.crossTierChannelDenyStatement`).
 *
 * Until then, user-side tier enforcement is the LIVE application layer (Layers
 * 2-3: metadata + Cognito-group `min(userTier, channelTier)`), and the
 * assistant-identity half of Layer 1 IS live (per-tier async-processor roles
 * cannot act on a higher-tier-tagged channel). Channels are tagged
 * `classification=<tier>` at creation, so the user-side Deny is ready to land.
 */

export interface IAMPoliciesStackProps extends cdk.StackProps {
  appInstanceArn: string;
  bedrockModelArns: {
    opus: string[];
    sonnet: string[];
    haiku: string[];
    titan: string[];
    gpt_oss_20b: string[];
    gpt_oss_120b: string[];
  };
}

export class IAMPoliciesStack extends cdk.Stack {
  public readonly basicTierPolicy: iam.ManagedPolicy;
  public readonly standardTierPolicy: iam.ManagedPolicy;
  public readonly premiumTierPolicy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: IAMPoliciesStackProps) {
    super(scope, id, props);

    // Basic Tier Policy - Haiku only
    this.basicTierPolicy = new iam.ManagedPolicy(this, 'BasicTierPolicy', {
      managedPolicyName: `${STACK_PREFIX}BasicTier`,
      description: 'Basic tier users - Claude Haiku access only',
      statements: [
        // Chime SDK Messaging - Basic operations
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'chime-sdk-messaging:CreateChannel',
            'chime-sdk-messaging:ListChannels',
            'chime-sdk-messaging:DescribeChannel',
            'chime-sdk-messaging:SendChannelMessage',
            'chime-sdk-messaging:GetChannelMessage',
            'chime-sdk-messaging:ListChannelMessages',
            'chime-sdk-messaging:CreateChannelMembership',
            'chime-sdk-messaging:ListChannelMembershipsForAppInstanceUser',
          ],
          resources: [`${props.appInstanceArn}/*`],
          conditions: {
            StringEquals: {
              'aws:PrincipalTag/tier': 'basic',
            },
          },
        }),
        // Chime SDK Identity
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'chime-sdk-identity:CreateAppInstanceUser',
            'chime-sdk-identity:DescribeAppInstanceUser',
            'chime-sdk-identity:UpdateAppInstanceUser',
          ],
          resources: [`${props.appInstanceArn}/user/*`],
          conditions: {
            StringEquals: {
              'aws:PrincipalTag/tier': 'basic',
            },
          },
        }),
        // Bedrock - Haiku only
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['bedrock:InvokeModel'],
          resources: props.bedrockModelArns.haiku,
          conditions: {
            StringEquals: {
              'aws:PrincipalTag/tier': 'basic',
            },
          },
        }),
      ],
    });

    // Standard Tier Policy - standard-tier Bedrock models
    this.standardTierPolicy = new iam.ManagedPolicy(this, 'StandardTierPolicy', {
      managedPolicyName: `${STACK_PREFIX}StandardTier`,
      description: 'Standard tier users - Sonnet, Haiku, and Titan access',
      statements: [
        // Chime SDK Messaging
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'chime-sdk-messaging:CreateChannel',
            'chime-sdk-messaging:ListChannels',
            'chime-sdk-messaging:DescribeChannel',
            'chime-sdk-messaging:SendChannelMessage',
            'chime-sdk-messaging:GetChannelMessage',
            'chime-sdk-messaging:ListChannelMessages',
            'chime-sdk-messaging:CreateChannelMembership',
            'chime-sdk-messaging:ListChannelMembershipsForAppInstanceUser',
            'chime-sdk-messaging:UpdateChannel',
            'chime-sdk-messaging:DeleteChannel',
          ],
          resources: [`${props.appInstanceArn}/*`],
          conditions: {
            StringEquals: {
              'aws:PrincipalTag/tier': 'standard',
            },
          },
        }),
        // Chime SDK Identity
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'chime-sdk-identity:CreateAppInstanceUser',
            'chime-sdk-identity:DescribeAppInstanceUser',
            'chime-sdk-identity:UpdateAppInstanceUser',
          ],
          resources: [`${props.appInstanceArn}/user/*`],
          conditions: {
            StringEquals: {
              'aws:PrincipalTag/tier': 'standard',
            },
          },
        }),
        // Bedrock - Sonnet, Haiku, Titan, OpenAI GPT-OSS 20B
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['bedrock:InvokeModel'],
          resources: [
            ...props.bedrockModelArns.sonnet,
            ...props.bedrockModelArns.haiku,
            ...props.bedrockModelArns.titan,
            ...props.bedrockModelArns.gpt_oss_20b,
          ],
          conditions: {
            StringEquals: {
              'aws:PrincipalTag/tier': 'standard',
            },
          },
        }),
      ],
    });

    // Premium Tier Policy - All models including Opus
    this.premiumTierPolicy = new iam.ManagedPolicy(this, 'PremiumTierPolicy', {
      managedPolicyName: `${STACK_PREFIX}PremiumTier`,
      description: 'Premium tier users - Access to all models including Opus',
      statements: [
        // Chime SDK Messaging - Full access
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'chime-sdk-messaging:CreateChannel',
            'chime-sdk-messaging:ListChannels',
            'chime-sdk-messaging:DescribeChannel',
            'chime-sdk-messaging:SendChannelMessage',
            'chime-sdk-messaging:GetChannelMessage',
            'chime-sdk-messaging:ListChannelMessages',
            'chime-sdk-messaging:CreateChannelMembership',
            'chime-sdk-messaging:ListChannelMembershipsForAppInstanceUser',
            'chime-sdk-messaging:UpdateChannel',
            'chime-sdk-messaging:DeleteChannel',
            'chime-sdk-messaging:RedactChannelMessage',
          ],
          resources: [`${props.appInstanceArn}/*`],
          conditions: {
            StringEquals: {
              'aws:PrincipalTag/tier': 'premium',
            },
          },
        }),
        // Chime SDK Identity
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'chime-sdk-identity:CreateAppInstanceUser',
            'chime-sdk-identity:DescribeAppInstanceUser',
            'chime-sdk-identity:UpdateAppInstanceUser',
          ],
          resources: [`${props.appInstanceArn}/user/*`],
          conditions: {
            StringEquals: {
              'aws:PrincipalTag/tier': 'premium',
            },
          },
        }),
        // Bedrock - All configured models
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: [
            ...props.bedrockModelArns.opus,
            ...props.bedrockModelArns.sonnet,
            ...props.bedrockModelArns.haiku,
            ...props.bedrockModelArns.titan,
            ...props.bedrockModelArns.gpt_oss_20b,
            ...props.bedrockModelArns.gpt_oss_120b,
          ],
          conditions: {
            StringEquals: {
              'aws:PrincipalTag/tier': 'premium',
            },
          },
        }),
      ],
    });

    // Outputs
    new cdk.CfnOutput(this, 'BasicTierPolicyArn', {
      value: this.basicTierPolicy.managedPolicyArn,
      description: 'IAM policy ARN for basic tier users',
      exportName: `${this.stackName}-BasicTierPolicyArn`,
    });

    new cdk.CfnOutput(this, 'StandardTierPolicyArn', {
      value: this.standardTierPolicy.managedPolicyArn,
      description: 'IAM policy ARN for standard tier users',
      exportName: `${this.stackName}-StandardTierPolicyArn`,
    });

    new cdk.CfnOutput(this, 'PremiumTierPolicyArn', {
      value: this.premiumTierPolicy.managedPolicyArn,
      description: 'IAM policy ARN for premium tier users',
      exportName: `${this.stackName}-PremiumTierPolicyArn`,
    });

    // Project is set once at the app root (derived from the instance); do NOT override it
    // per-stack or every instance mis-attributes. Only add the stack-specific Component.
    cdk.Tags.of(this).add('Component', 'IAMPolicies');
  }
}
