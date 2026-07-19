/**
 * BasicClassificationStack — the BASIC assistant profile. A thin wrapper that supplies the basic
 * ProfileTopology to the shared AssistantProfileStack (SPEC-CAPABILITY-PROFILES).
 *
 * Basic = Haiku, lightweight tasks (grounds the prompt + stamps task_id), a per-deployment intent
 * pack, and the tightest response ceiling. No /battle, image gen, generated docs, context routing, or
 * persona SSM param — those union code paths in the shared async processor self-gate off because this
 * profile sets none of their env, so execution stays inside basic's narrow IAM role.
 */

import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import { ProfileModelSelection } from '../config/model-strategy';
import { AssistantProfileStack, ProfileTopology } from './assistant-profile-stack';
import { AuroraDriftHookup, MessageAnalyticsWiring } from './agent-classification-common';

const BASIC_TOPOLOGY: ProfileTopology = {
  name: 'basic',
  modelSelectionKey: 'basic',
  timeoutSeconds: 30,
  memorySize: 512,
  reservedConcurrency: 100,
  maxTokens: 1024,
  streaming: false,
  imageGen: false,
  contextRouting: false,
  systemPromptParam: false,
  intentPackParam: true,
  richProcessor: false,
  battleCapable: false,
  handlerExperimentsIndex: true,
  componentTag: 'Classification-Basic',
};

export interface BasicClassificationStackProps extends cdk.StackProps {
  appInstanceArn: string;
  attachmentsBucketName: string;
  attachmentsBucketArn: string;
  profileModelSelection: ProfileModelSelection;
  auroraDriftHookup?: AuroraDriftHookup;
  messageAnalytics?: MessageAnalyticsWiring;
  adminErrorAlertChannelArn?: string;
}

export class BasicClassificationStack extends AssistantProfileStack {
  constructor(scope: Construct, id: string, props: BasicClassificationStackProps) {
    super(scope, id, { ...props, topology: BASIC_TOPOLOGY });
  }
}
