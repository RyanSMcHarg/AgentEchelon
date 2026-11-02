import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { SSM_ROOT, RES_PREFIX } from './agent-classification-common';
import type { IssuerConfig } from '../config/issuers';

/** Where a fixture's pool is published. `provision-test-users` reads these to create the fixture's users. */
export function testIssuerSsm(id: string) {
  return {
    poolId: `${SSM_ROOT}/test-issuer/${id}/pool-id`,
    clientId: `${SSM_ROOT}/test-issuer/${id}/client-id`,
    issuer: `${SSM_ROOT}/test-issuer/${id}/issuer`,
  } as const;
}

/** The fixed name of a fixture's pool, which teardown purges by name as well as by the `Instance` tag. */
export function testIssuerPoolName(id: string): string {
  return `${RES_PREFIX}-test-issuer-${id}`;
}

/** `h1-one-channel` -> `H1OneChannel`, for output keys. */
const pascal = (id: string): string => id.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');

export interface TestIssuerStackProps extends cdk.StackProps {
  /** The registry entries whose `owner` is `test-fixture` (`lib/config/test-issuers.ts`), one pool each. */
  fixtures: readonly IssuerConfig[];
  /** The chat app origin, for the redirect callback of an `oidc` fixture besides localhost. */
  appUrl?: string;
}

/**
 * THE NON-POOL PEOPLE THE E2E SUITE SIGNS IN AS (D16, the H1 fixture). TEST-ONLY and OPT-IN, modeled on
 * `TestInboxStack`: it exists only when the trusted-issuer registry declares an entry with
 * `owner: "test-fixture"`, and synth refuses such an entry in production.
 *
 * One Cognito user pool per fixture, so no two fixtures share an `iss` (one pool declared twice would).
 * A `cognito-pool` fixture is that pool as a second pool issuer; an `oidc` fixture is the same kind of pool
 * reached only through its OpenID discovery document, with no Cognito-specific check, so the suite covers
 * a foreign OIDC issuer without a third party. The `oidc` fixture's pool gets a managed-login domain, for
 * the redirect sign-in with PKCE.
 *
 * Every pool is removed with the stack: its users are created by the suite and exist for it alone.
 * The ids the registry entries need are this stack's outputs; a fixture is admitted by the edge only
 * once its entry carries them (`fixtureNamesItsPool`).
 */
export class TestIssuerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TestIssuerStackProps) {
    super(scope, id, props);
    if (!props.fixtures.length) throw new Error('TestIssuerStack: no test-fixture issuer is declared, so there is no pool to create');

    for (const fixture of props.fixtures) {
      const key = pascal(fixture.id);
      const pool = new cognito.UserPool(this, `${key}Pool`, {
        userPoolName: testIssuerPoolName(fixture.id),
        selfSignUpEnabled: false,
        signInAliases: { username: true, email: true },
        passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: false },
        accountRecovery: cognito.AccountRecovery.NONE,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      // THE PROVIDER'S OWN GROUPS, for a fixture that translates them (SPEC-CREDENTIAL-EXCHANGE §4b): each
      // provider group its map names, and one it does not, named `admins`, which an outside administrator could
      // create in their own directory. The e2e places a person in it to prove an unmapped group reaches nothing.
      const translation = (fixture.clearance as { groups?: unknown }).groups;
      if (translation && typeof translation === 'object' && !Array.isArray(translation)) {
        const named = Object.keys((translation as { map?: Record<string, unknown> }).map ?? {});
        for (const group of [...new Set([...named, 'admins'])]) {
          new cognito.CfnUserPoolGroup(this, `${key}ProviderGroup${pascal(group)}`, { userPoolId: pool.userPoolId, groupName: group });
        }
      }

      const redirect = fixture.kind === 'oidc';
      const callbacks = ['http://localhost:5173/callback', ...(props.appUrl ? [`${props.appUrl.replace(/\/$/, '')}/callback`] : [])];
      // A public client: the suite signs in programmatically (USER_PASSWORD_AUTH, SRP), and the `oidc`
      // fixture also through the code flow with PKCE, which a public client is what the browser uses.
      const client = pool.addClient(`${key}Client`, {
        generateSecret: false,
        authFlows: { userPassword: true, userSrp: true },
        ...(redirect
          ? {
              oAuth: {
                flows: { authorizationCodeGrant: true },
                scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
                callbackUrls: callbacks,
                logoutUrls: callbacks.map((u) => u.replace(/\/callback$/, '/')),
              },
              supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
            }
          : { disableOAuth: true }),
      });

      const issuer = `https://cognito-idp.${this.region}.amazonaws.com/${pool.userPoolId}`;
      const ssmNames = testIssuerSsm(fixture.id);
      new ssm.StringParameter(this, `${key}PoolIdParameter`, { parameterName: ssmNames.poolId, stringValue: pool.userPoolId });
      new ssm.StringParameter(this, `${key}ClientIdParameter`, { parameterName: ssmNames.clientId, stringValue: client.userPoolClientId });
      new ssm.StringParameter(this, `${key}IssuerParameter`, { parameterName: ssmNames.issuer, stringValue: issuer });

      new cdk.CfnOutput(this, `TestIssuer${key}PoolId`, { value: pool.userPoolId, description: `Fixture ${fixture.id}: the pool id its registry entry names` });
      new cdk.CfnOutput(this, `TestIssuer${key}ClientId`, { value: client.userPoolClientId, description: `Fixture ${fixture.id}: the app client (the audience)` });
      new cdk.CfnOutput(this, `TestIssuer${key}Issuer`, { value: issuer, description: `Fixture ${fixture.id}: the iss its tokens carry` });
      if (redirect) {
        const domain = pool.addDomain(`${key}Domain`, { cognitoDomain: { domainPrefix: `${RES_PREFIX}-${fixture.id}-${this.account}` } });
        new cdk.CfnOutput(this, `TestIssuer${key}DiscoveryUrl`, {
          value: `${issuer}/.well-known/openid-configuration`,
          description: `Fixture ${fixture.id}: the discovery document its oidc entry names`,
        });
        new cdk.CfnOutput(this, `TestIssuer${key}DomainUrl`, { value: domain.baseUrl(), description: `Fixture ${fixture.id}: the managed login domain` });
      }
    }
  }
}
