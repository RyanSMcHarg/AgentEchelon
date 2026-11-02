/**
 * THE POOL HAS A MANAGED LOGIN DOMAIN, AND EVERY PROVIDER THE REGISTRY FEDERATES INTO IT IS OFFERED ON ITS
 * OWN APP CLIENT, WHICH ONLY THE PROVIDER CAN WRITE THROUGH (SPEC-CREDENTIAL-EXCHANGE §4b).
 *
 * Redirect sign-in (authorization code with PKCE) goes through the pool's managed login, so the pool needs
 * a domain, and a SAML or OIDC provider is offered there only when an app client names it. The providers
 * come from the trusted-issuer registry's `cognito-federated` entries on this deployment's own pool. A
 * provider declared in the registry and offered on no client would be a sign-in button that leads nowhere.
 *
 * Cognito writes a provider's mapped attributes (a person's name, address and `custom:groups`) only through
 * a client that lists them as writable, and a client that lists one lets any holder of its access token
 * rewrite it with UpdateUserAttributes, which needs the `aws.cognito.signin.user.admin` scope. So the
 * providers are offered on `FederatedWebClient` alone, with no password, SRP or custom flow and no such
 * scope; the password clients write only what sign-up sends, and never `custom:groups`.
 */
import { identityTemplate } from './helpers/synth';

const ALL = ['basic', 'standard', 'premium', 'admin'];
const DEPLOYMENT = { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ALL }, admin: true };
const FEDERATED = { id: 'corp-sso', kind: 'cognito-federated', pool: 'self', providerName: 'CorpSSO', clearance: { fixed: ['basic'], classifications: ['basic'] } };

type Client = { Properties: Record<string, any> };
const clientsOf = (issuers?: unknown[]) => {
  const t = identityTemplate(issuers ? { issuers } : {});
  const clients = Object.values(t.findResources('AWS::Cognito::UserPoolClient')) as Client[];
  const named = (name: string) => clients.find((c) => c.Properties.ClientName === name);
  return { t, clients, web: named('web-client')!, federated: named('federated-client') };
};

describe('managed login', () => {
  it('gives the pool a domain named for this instance and account, and outputs its URL', () => {
    const { t } = clientsOf();
    t.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
    const domain = Object.values(t.findResources('AWS::Cognito::UserPoolDomain'))[0] as { Properties: { Domain: unknown } };
    expect(JSON.stringify(domain.Properties.Domain)).toContain('123456789012');
    expect(Object.keys(t.toJSON().Outputs)).toContain('UserPoolDomainUrl');
  });

  it('offers the pool\'s own sign-in alone, and creates no federated client, when the registry federates no provider', () => {
    const { web, federated, t } = clientsOf();
    expect(web.Properties.SupportedIdentityProviders).toEqual(['COGNITO']);
    expect(federated).toBeUndefined();
    expect(Object.keys(t.toJSON().Outputs)).not.toContain('UserPoolFederatedClientId');
  });

  it('offers each provider the registry federates into the pool on the federated client alone, by its configured name', () => {
    const { web, federated, t } = clientsOf([DEPLOYMENT, FEDERATED]);
    expect(web.Properties.SupportedIdentityProviders).toEqual(['COGNITO']);
    expect(federated!.Properties.SupportedIdentityProviders).toEqual(['CorpSSO']);
    expect(Object.keys(t.toJSON().Outputs)).toContain('UserPoolFederatedClientId');
  });
});

describe('only the provider writes what it maps', () => {
  it('gives the federated client the code flow and refresh alone, and no scope UpdateUserAttributes accepts', () => {
    const { federated } = clientsOf([DEPLOYMENT, FEDERATED]);
    const p = federated!.Properties;
    expect(p.ExplicitAuthFlows).toEqual(['ALLOW_REFRESH_TOKEN_AUTH']);
    expect(p.AllowedOAuthFlows).toEqual(['code']);
    expect([...p.AllowedOAuthScopes].sort()).toEqual(['email', 'openid', 'profile']);
    expect(p.AllowedOAuthScopes).not.toContain('aws.cognito.signin.user.admin');
    expect(p.WriteAttributes).toEqual(expect.arrayContaining(['custom:groups', 'email', 'name']));
  });

  it('lets no other client write custom:groups', () => {
    const { clients } = clientsOf([DEPLOYMENT, FEDERATED]);
    for (const c of clients.filter((x) => x.Properties.ClientName !== 'federated-client')) {
      expect(c.Properties.WriteAttributes ?? []).not.toContain('custom:groups');
      expect(c.Properties.WriteAttributes).toBeDefined();
    }
  });

  it('declares custom:groups on the pool at Cognito\'s longest', () => {
    const { t } = clientsOf([DEPLOYMENT, FEDERATED]);
    const pool = Object.values(t.findResources('AWS::Cognito::UserPool'))[0] as { Properties: { Schema: Array<Record<string, any>> } };
    const groups = pool.Properties.Schema.find((a) => a.Name === 'groups');
    expect(groups).toMatchObject({ AttributeDataType: 'String', Mutable: true, StringAttributeConstraints: { MaxLength: '2048' } });
  });
});
