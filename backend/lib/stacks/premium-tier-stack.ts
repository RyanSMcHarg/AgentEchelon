/**
 * PremiumTierStack — the PREMIUM assistant profile. A thin wrapper that supplies the premium
 * ProfileTopology to the shared AssistantProfileStack (SPEC-CAPABILITY-PROFILES).
 *
 * Premium = Opus (with response streaming), full multi-turn tasks, generated docs, experiments,
 * attachment-in, opt-in /battle round participation INCLUDING image generation-out (Titan Image + Nova
 * Canvas) behind a dedicated image-output guardrail. No external/CN routing or persona SSM param —
 * premium ships the built-in persona and routes on-network models only.
 */

import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import { ProfileModelSelection } from '../config/model-strategy';
import { AssistantProfileStack, ProfileTopology } from './assistant-profile-stack';
import { AuroraDriftHookup, MessageAnalyticsWiring } from './agent-classification-common';

const PREMIUM_TOPOLOGY: ProfileTopology = {
  name: 'premium',
  modelSelectionKey: 'premium',
  timeoutSeconds: 90,
  memorySize: 1024,
  reservedConcurrency: 20,
  maxTokens: 4096,
  streaming: true,
  imageGen: true,
  contextRouting: false,
  systemPromptParam: false,
  intentPackParam: false,
  richProcessor: true,
  battleCapable: true,
  handlerExperimentsIndex: false,
  componentTag: 'Tier-Premium',
};

export interface PremiumTierStackProps extends cdk.StackProps {
  appInstanceArn: string;
  attachmentsBucketName: string;
  attachmentsBucketArn: string;
  profileModelSelection: ProfileModelSelection;
  enableBattle?: boolean;
  auroraDriftHookup?: AuroraDriftHookup;
  messageAnalytics?: MessageAnalyticsWiring;
  adminErrorAlertChannelArn?: string;
}

export class PremiumTierStack extends AssistantProfileStack {
  constructor(scope: Construct, id: string, props: PremiumTierStackProps) {
    super(scope, id, { ...props, topology: PREMIUM_TOPOLOGY });
  }
}
