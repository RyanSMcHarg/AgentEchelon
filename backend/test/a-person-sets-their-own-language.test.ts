/**
 * A PERSON SETS THEIR OWN LANGUAGE, AND NOTHING ELSE (ADR-062 decision 4, ADR-060 decision 1): the two layers of
 * `GET` and `POST /me/language`, at synth.
 *
 *  - the routes are person routes behind the edge authorizer, in the core;
 *  - the function's role reads only the `preferences` attribute of a user-profile row and writes only `preferences` and
 *    `updatedAt`, so it reaches no onboarding answer and cannot mark anyone onboarded;
 *  - it is DENIED every item whose key carries a `#` (a person's notice preferences, contact copies), so the shared
 *    table's other kinds of record are out of its reach even through an attribute it may name;
 *  - it holds no other DynamoDB action and no grant on any other table.
 *
 * The handler's own layer (the person is the caller the edge resolved, a value outside the declared set is refused) is
 * proven in `test/lib/a-message-reaches-a-person-in-their-language.test.ts`.
 */
import { conversationsStacks, conversationsTemplate } from './helpers/synth';

const t = conversationsTemplate({ 'aws:cdk:bundling-stacks': [] });
const stack = conversationsStacks({ 'aws:cdk:bundling-stacks': [] }).conversations;

function statementsOf(fnLogicalPrefix: string): any[] {
  return Object.values(t.findResources('AWS::IAM::Policy'))
    .filter((p: any) => JSON.stringify(p.Properties.Roles).includes(fnLogicalPrefix))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
}

describe('a person sets their own language: the routes and the role, at synth', () => {
  const statements = statementsOf('LanguagePreferenceFunction');
  const dynamo = statements.filter((s) => JSON.stringify(s.Action).includes('dynamodb:'));
  const allow = dynamo.filter((s) => s.Effect === 'Allow');
  const deny = dynamo.filter((s) => s.Effect === 'Deny');

  it('is a core person route behind the edge authorizer, on GET and POST', () => {
    const routes = stack.routes.filter((r) => r.path === '/me/language');
    expect(routes.map((r) => r.method).sort()).toEqual(['GET', 'POST']);
    for (const r of routes) {
      expect(r.api).toBe('person');
      expect(r.capability).toBe('core');
      expect(r.auth).toBeUndefined();
    }
  });

  it('reads only a row\'s preferences, with only the attributes it names', () => {
    const read = allow.find((s) => s.Action === 'dynamodb:GetItem');
    expect(read.Condition['ForAllValues:StringEquals']['dynamodb:Attributes']).toEqual(['personId', 'preferences']);
    expect(read.Condition.StringEqualsIfExists['dynamodb:Select']).toBe('SPECIFIC_ATTRIBUTES');
  });

  it('writes only preferences and updatedAt: never facts, never onboardedAt', () => {
    const write = allow.find((s) => s.Action === 'dynamodb:UpdateItem');
    const attributes = write.Condition['ForAllValues:StringEquals']['dynamodb:Attributes'];
    expect(attributes).toEqual(['personId', 'preferences', 'updatedAt']);
    expect(attributes).not.toContain('facts');
    expect(attributes).not.toContain('onboardedAt');
  });

  it('is denied every item of another kind on the shared table (a key carrying #)', () => {
    expect(deny).toHaveLength(1);
    expect([...deny[0].Action].sort()).toEqual(['dynamodb:GetItem', 'dynamodb:UpdateItem']);
    expect(deny[0].Condition['ForAnyValue:StringLike']['dynamodb:LeadingKeys']).toEqual(['*#*']);
  });

  it('holds no other DynamoDB action, and every DynamoDB statement names the one user-profile table', () => {
    expect(allow.map((s) => s.Action).sort()).toEqual(['dynamodb:GetItem', 'dynamodb:UpdateItem']);
    const tables = new Set(dynamo.map((s) => JSON.stringify(s.Resource)));
    expect(tables.size).toBe(1);
    expect([...tables][0]).toContain('UserProfileTable');
  });
});

describe('every function is told the languages the deployment declares', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cdk = require('aws-cdk-lib') as typeof import('aws-cdk-lib');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const lambda = require('aws-cdk-lib/aws-lambda') as typeof import('aws-cdk-lib/aws-lambda');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Template: T } = require('aws-cdk-lib/assertions') as typeof import('aws-cdk-lib/assertions');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DeploymentLanguagesEnv } = require('../lib/constructs/deployment-languages-env') as typeof import('../lib/constructs/deployment-languages-env');
  const envOf = (languages: readonly string[]) => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    new lambda.Function(stack, 'F', { runtime: lambda.Runtime.NODEJS_20_X, handler: 'i.h', code: lambda.Code.fromInline('exports.h=()=>1') });
    cdk.Aspects.of(app).add(new DeploymentLanguagesEnv(languages));
    const fn = Object.values(T.fromStack(stack).findResources('AWS::Lambda::Function'))[0] as any;
    return fn.Properties.Environment?.Variables ?? {};
  };

  it('a declared list reaches each function as JSON, its own language first', () => {
    expect(envOf(['es', 'en'])).toEqual({ AE_DEPLOYMENT_LANGUAGES: '["es","en"]' });
  });

  it('the default is told nothing, so a deployment that never declared languages synthesizes as before', () => {
    expect(envOf(['en', 'zh'])).toEqual({});
  });
});
