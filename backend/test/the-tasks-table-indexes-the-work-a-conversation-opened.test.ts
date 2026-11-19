/**
 * THE TASKS TABLE INDEXES THE WORK OF THE CONVERSATIONS A CONVERSATION OPENED (WT122).
 *
 * Synthesized, `AgentTasksTable` carries `openedFrom-taskType-index`: keyed by the opener's channel ARN and the task's
 * machine, projecting the whole row, so a team conversation reads every open incident it opened in one query, each held in
 * its own conversation. Sparse by its key: only a task that records an opener is in it. The task service's grant on the
 * table reaches its indexes, so the query needs no grant of its own.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { MessagingStack } from '../lib/stacks/messaging-stack';
import { IdentityStack } from '../lib/stacks/identity-stack';
import { ConversationsStack } from '../lib/stacks/conversations-stack';
import { TEST_ENV } from './helpers/synth';

const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
const messaging = new MessagingStack(app, 'Messaging', { env: TEST_ENV, appInstanceName: 'test' });
const identity = new IdentityStack(app, 'Identity', { env: TEST_ENV, appInstanceArn: messaging.appInstanceArn });
const conversations = new ConversationsStack(app, 'Conversations', {
  env: TEST_ENV,
  appInstanceArn: messaging.appInstanceArn,
  selfPoolId: identity.selfPoolId,
  offboardingRoleArn: identity.offboardingRoleArn,
  credentialExchangeRoleArn: identity.credentialExchangeRoleArn,
  credentialExchangeFunctionArn: identity.credentialExchangeFunction.functionArn,
});
const template = Template.fromStack(conversations);

describe('the tasks table', () => {
  const [table] = Object.entries(template.findResources('AWS::DynamoDB::Table'))
    .filter(([k]) => k.startsWith('AgentTasksTable')).map(([, v]) => v as { Properties: { GlobalSecondaryIndexes: any[]; AttributeDefinitions: any[] } });

  it('keeps the opener\'s index, keyed by the opener and the machine, projecting the whole row', () => {
    const index = table.Properties.GlobalSecondaryIndexes.find((g) => g.IndexName === 'openedFrom-taskType-index');
    expect(index).toEqual(expect.objectContaining({
      KeySchema: [{ AttributeName: 'openedFrom', KeyType: 'HASH' }, { AttributeName: 'taskType', KeyType: 'RANGE' }],
      Projection: { ProjectionType: 'ALL' },
    }));
    expect(table.Properties.AttributeDefinitions).toEqual(expect.arrayContaining([{ AttributeName: 'openedFrom', AttributeType: 'S' }]));
  });

  it('keeps the indexes the other reads depend on beside it', () => {
    expect(table.Properties.GlobalSecondaryIndexes.map((g) => g.IndexName).sort()).toEqual(['channelArn-updatedAt-index', 'contextId-index', 'openedFrom-taskType-index']);
  });
});
