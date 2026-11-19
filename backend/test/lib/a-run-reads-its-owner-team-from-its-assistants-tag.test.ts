/**
 * A RUN READS ITS OWNER TEAM FROM ITS ASSISTANT'S TAG (SPEC-PROCESSES P8; DESIGN-PROCESSES O16), unit and synth.
 *
 * What it proves: the team a process run records is the `owner-team` tag on its assistant's bot, read live as every other
 * reader reads it, with no registry fallback; a cleared tag names no team; and the router's role reads the tags of its own
 * classification's assistants only, pinned by the bot's `classification` tag, never another classification's or a channel's.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Template } from 'aws-cdk-lib/assertions';
import { ownerTeamOf, OWNER_TEAM_CLEARED, OWNER_TEAM_TAG } from '../../lambda/src/lib/assistant-ownership';
import { readOwnAssistantsTagsStatement } from '../../lib/stacks/agent-classification-common';

const BOT = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai/bot/ops-1';
const client = (tags: Array<{ Key: string; Value: string }>) => ({ send: async () => ({ Tags: tags }) }) as never;

describe('the owner team is the bot\'s own tag', () => {
  it('read live', async () => {
    expect(await ownerTeamOf(client([{ Key: OWNER_TEAM_TAG, Value: 'ops' }]), BOT)).toBe('ops');
  });
  it('a cleared or missing tag names no team', async () => {
    expect(await ownerTeamOf(client([{ Key: OWNER_TEAM_TAG, Value: OWNER_TEAM_CLEARED }]), BOT)).toBeUndefined();
    expect(await ownerTeamOf(client([]), BOT)).toBeUndefined();
  });
  it('the router reads it, with no registry fallback', () => {
    const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    const fn = router.slice(router.indexOf('async function runProcessFor('), router.indexOf('let identityClient'));
    expect(fn).toMatch(/await ownerTeamOf\(identityClient, who\.botArn\)/);
    expect(fn).not.toMatch(/profileByName|ownerTeam\s*\?\?/);
  });
});

describe('the router\'s grant: its own classification\'s assistants only (synth and deny)', () => {
  const statements = () => {
    const stack = new cdk.Stack(new cdk.App(), 'S', { env: { account: '111122223333', region: 'us-east-1' } });
    const role = new iam.Role(stack, 'Router', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    role.addToPrincipalPolicy(readOwnAssistantsTagsStatement('arn:aws:chime:us-east-1:111122223333:app-instance/ai', 'premium'));
    return Object.values(Template.fromStack(stack).findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
  };

  it('ListTagsForResource on the app instance\'s bots, pinned to this classification\'s tag', () => {
    expect(statements()).toEqual([{
      Sid: 'ReadItsOwnAssistantsOwnerTeam', Effect: 'Allow', Action: 'chime:ListTagsForResource',
      Resource: 'arn:aws:chime:us-east-1:111122223333:app-instance/ai/bot/*',
      Condition: { StringEquals: { 'aws:ResourceTag/classification': 'premium' } },
    }]);
  });

  it('DENY: no channel, no other classification, no wildcard classification', () => {
    const [s] = statements();
    expect(String(s.Resource)).not.toMatch(/channel/);
    expect(s.Condition.StringEquals['aws:ResourceTag/classification']).toBe('premium');
  });

  it('is on the router\'s own role', () => {
    const stack = readFileSync(resolve(__dirname, '../../lib/stacks/assistant-profile-stack.ts'), 'utf8');
    expect(stack).toMatch(/handlerRole\.addToPrincipalPolicy\(readOwnAssistantsTagsStatement\(props\.appInstanceArn, classification\)\);/);
  });
});
