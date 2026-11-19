/**
 * A HOST'S CONTROLS (SPEC-ASSISTANT-MEETINGS FR59) are granted to the person routes' function alone, on meetings alone:
 * listing attendees, changing an attendee's capabilities, and deleting an attendee reach `meeting/*` of this account and
 * region, and the run entry and every other function of the stack hold none of them. The three routes are on the person
 * API under the meetings capability.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { MeetingsStack } from '../../lib/stacks/meetings-stack';

const ARCHIVE_BUCKET = 'test-conversation-archive-111122223333-us-east-1';
const stack = new MeetingsStack(new cdk.App(), 'TestMeetingsHostControls', {
  env: { account: '111122223333', region: 'us-east-1' },
  appInstanceArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/abc',
  selfPoolId: 'us-east-1_test',
  appUrl: 'https://example.test',
  archive: { bucketName: ARCHIVE_BUCKET, bucketArn: `arn:aws:s3:::${ARCHIVE_BUCKET}`, keyArn: 'arn:aws:kms:us-east-1:111122223333:key/archive' },
  classifications: ['standard', 'premium'],
});
const template = Template.fromStack(stack);

type Statement = { Sid?: string; Action: string | string[]; Resource: unknown };
const policies = Object.entries(template.findResources('AWS::IAM::Policy')) as Array<[string, { Properties: { PolicyDocument: { Statement: Statement[] } } }]>;
const CONTROLS = ['chime:ListAttendees', 'chime:UpdateAttendeeCapabilities', 'chime:BatchUpdateAttendeeCapabilitiesExcept', 'chime:DeleteAttendee'];
const holding = (action: string) => policies.filter(([, p]) => p.Properties.PolicyDocument.Statement.some((s) => [s.Action].flat().includes(action)));

describe('a host\'s controls are the person routes\' grant, on meetings only', () => {
  it('grants each control in one statement, on meeting/* of this account and region', () => {
    const statements = policies.flatMap(([, p]) => p.Properties.PolicyDocument.Statement).filter((s) => s.Sid === 'MeetingHostControls');
    expect(statements).toHaveLength(1);
    expect([statements[0].Action].flat().sort()).toEqual([...CONTROLS].sort());
    expect(statements[0].Resource).toEqual({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':chime:us-east-1:111122223333:meeting/*']] });
  });

  it('gives no other function of the stack any of them', () => {
    for (const action of CONTROLS) {
      const holders = holding(action).map(([id]) => id);
      expect(holders).toHaveLength(1);
      expect(holders[0]).toMatch(/^MeetingApi/);
    }
  });

  it('puts the three routes on the person API under the meetings capability', () => {
    const routes = stack.routes.map((r) => `${r.api} ${r.method} ${r.path} ${r.capability}`);
    expect(routes).toEqual(expect.arrayContaining(['person POST /meetings/speaking meetings', 'person POST /meetings/remove meetings', 'person POST /meetings/unmute-request meetings']));
  });
});
