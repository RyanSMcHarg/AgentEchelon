/**
 * A FUNCTION WHOSE ROLE ANOTHER STACK BUILT READS THE REGISTRY TOO.
 *
 * Every handler loads the profile registry before it decides anything, and a load it cannot make fails the
 * invocation. The email reply poster runs on a role the Identity stack builds and the Notifications stack
 * imports, so a read attached only to roles the stack builds left it unable to load the registry, and no
 * reply was ever decided. The read is written into the imported role's principal policy instead.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template } from 'aws-cdk-lib/assertions';
import { ProfileRegistryReaders } from '../lib/constructs/profile-registry-readers';

describe('the registry read reaches a function on an imported role', () => {
  it('writes the read into the imported role\'s policy in the function\'s stack', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Notifications', { env: { account: '111122223333', region: 'us-east-1' } });
    const role = iam.Role.fromRoleArn(stack, 'Imported', 'arn:aws:iam::111122223333:role/poster', { mutable: true });
    new lambda.Function(stack, 'Poster', {
      runtime: lambda.Runtime.NODEJS_20_X, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler=async()=>{}'), role,
    });
    cdk.Aspects.of(app).add(new ProfileRegistryReaders('/ae/test', 'ae-test'));
    const policies = Template.fromStack(stack).findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
    expect(statements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Action: 'ssm:GetParametersByPath',
        Resource: 'arn:aws:ssm:us-east-1:111122223333:parameter/ae/test/registry/classification',
      }),
    ]));
    expect(Object.values(policies).map((p: any) => p.Properties.Roles)).toEqual([['poster']]);
  });
});
