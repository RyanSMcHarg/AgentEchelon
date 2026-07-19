/**
 * StandardTierStack — the STANDARD assistant profile. A thin wrapper that supplies the standard
 * ProfileTopology to the shared AssistantProfileStack (SPEC-CAPABILITY-PROFILES).
 *
 * Standard = Sonnet, full multi-turn tasks, generated docs, experiments, attachment-in, a
 * per-deployment persona + intent pack (SSM), external/CN model routing (DeepSeek), and opt-in
 * /battle round participation. No image generation-out or streaming — those are premium-only.
 */

import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import { ProfileModelSelection } from '../config/model-strategy';
import { AssistantProfileStack, ProfileTopology } from './assistant-profile-stack';
import { AuroraDriftHookup, MessageAnalyticsWiring } from './agent-classification-common';

const STANDARD_TOPOLOGY: ProfileTopology = {
  name: 'standard',
  modelSelectionKey: 'standard',
  timeoutSeconds: 60,
  memorySize: 512,
  reservedConcurrency: 50,
  maxTokens: 4096,
  streaming: false,
  imageGen: false,
  contextRouting: true,
  systemPromptParam: true,
  intentPackParam: true,
  richProcessor: true,
  battleCapable: true,
  handlerExperimentsIndex: false,
  componentTag: 'Tier-Standard',
};

export interface StandardTierStackProps extends cdk.StackProps {
  appInstanceArn: string;
  attachmentsBucketName: string;
  attachmentsBucketArn: string;
  profileModelSelection: ProfileModelSelection;
  enableBattle?: boolean;
  auroraDriftHookup?: AuroraDriftHookup;
  messageAnalytics?: MessageAnalyticsWiring;
  adminErrorAlertChannelArn?: string;
}

export class StandardTierStack extends AssistantProfileStack {
  constructor(scope: Construct, id: string, props: StandardTierStackProps) {
    super(scope, id, { ...props, topology: STANDARD_TOPOLOGY });
  }
}
