# Integrating Your Identity Provider

This guide explains how to connect your existing identity provider (IdP) to AgentEchelon so your users can authenticate with your organization's SSO, LDAP, or OAuth2 system instead of (or in addition to) Cognito User Pool username/password.

**The core requirement:** AgentEchelon uses Amazon Chime SDK Messaging, which requires temporary AWS credentials (Access Key, Secret Key, Session Token). Your IdP integration must ultimately produce these credentials. There are two approaches:

1. **Federate into Cognito Identity Pools** (recommended) - your IdP issues tokens, Cognito Identity Pools exchanges them for AWS credentials. Minimal code changes.
2. **Credential Exchange Service** - a backend Lambda validates your IdP's token and calls STS `AssumeRole` directly. More flexible, works with any auth system.

This guide is adapted from the [AWS blog post "Integrate your Identity Provider with Amazon Chime SDK Messaging"](https://aws.amazon.com/blogs/business-productivity/integrate-your-identity-provider-with-amazon-chime-sdk-messaging/) (June 2021), updated for AWS SDK v3, current Chime SDK namespaces, and the AgentEchelon architecture.

---

## Background: How Auth Works Today

AgentEchelon ships with Cognito User Pool as its identity provider. The credential flow is:

```
  User enters email + password
          │
          ▼
  Cognito User Pool (USER_PASSWORD_AUTH)
          │
          ▼
  Returns: IdToken, AccessToken, RefreshToken
          │
          ▼
  Frontend passes IdToken to Cognito Identity Pool
          │
          ▼
  Identity Pool validates token, returns temporary AWS credentials
          │
          ▼
  AWS credentials used to initialize Chime SDK MessagingClient
```

The key insight: **Cognito Identity Pools don't care where the token comes from.** They accept tokens from any configured identity provider - Cognito User Pools, SAML, OIDC, Google, Facebook, Apple, or custom. This is the integration point.

### Files involved

| File | Role | What changes per approach |
|------|------|--------------------------|
| `frontend/src/providers/AuthProvider.tsx` | User login, token management, refresh | Approach 1: minor changes. Approach 2: significant rewrite. |
| `frontend/src/services/chimeService.ts` | Exchanges IdToken for AWS credentials via Identity Pool | Approach 1: change login key only. Approach 2: replace credential provider entirely. |
| `backend/lib/stacks/cognito-auth-stack.ts` | CDK stack: User Pool, Identity Pool, IAM roles | Approach 1: add OIDC/SAML provider to Identity Pool. Approach 2: replace User Pool with custom auth stack. |
| `backend/lambda/cognito-triggers/post-confirmation.js` | Creates Chime AppInstanceUser on signup | Both: adapt to your IdP's user lifecycle events. |

---

## The access-control model is identity-provider-agnostic (read this first)

This is the foundational principle that makes IdP integration - and tier
enforcement - work cleanly, and it dictates *where* access is enforced.

**Amazon Chime SDK messaging authorizes every channel action at two native
layers, neither of which knows or cares which IdP a user came from:**

1. **The AppInstanceUser** (the `ChimeBearer`) - Chime's own model: channel
   membership, `RESTRICTED` mode, moderator status, `HIDDEN` membership. This
   decides whether *this principal* may act on *this channel*.
2. **The IAM role the caller assumes** - via the Identity Pool (or, in Approach
   2, via STS directly). This decides whether the API call is permitted at all,
   and to which model/data ARNs.

Both layers are reached the same way no matter how the user authenticated:
**every principal - a Cognito user, an external OIDC/SAML user, or an
*unauthenticated guest* - resolves to (a) an AppInstanceUser and (b) an assumed
role.** The *access level* (which tier, read-only, guest) is something **we
choose** by which AppInstanceUser we create and which role we map the principal
to. It is **not** a property of the IdP.

**Consequences - design to these, not around them:**

- **Enforce at the AppInstanceUser + assumed-role layer, never on
  Cognito-specific signals.** Cognito groups / `custom:tier` are just *one* way
  to drive the role-and-membership mapping. An external IdP drives the same
  mapping from its own claims; a guest gets a default guest role + restricted
  membership. If you enforced on `cognito:groups` directly, you'd lock out every
  non-Cognito user. (This is also why tier→role selection in **Step 8** keys on
  a *claim* that any IdP can emit, and why the channel-join boundary is expressed
  as "who may be a channel member" + "what the assumed role may call" - both
  IdP-neutral - rather than a Cognito construct.)
- **Unauthenticated / guest access is a first-class, *controlled* level.** Chime
  supports unauthenticated Identity Pool identities (a guest role) and guest
  AppInstanceUsers. AgentEchelon ships with `allowUnauthenticatedIdentities:
  false`, but the model is designed so a deployer can grant guests a deliberate,
  bounded access level - e.g. a `guest` role limited to a public/basic
  classification, added to channels only as `HIDDEN` or to `basic`-classified
  channels - using the **same** two enforcement layers. You are always granting
  guests *a level of access you control*, never an accident of the IdP.
- **The strongest tier boundaries are the IdP-agnostic ones.** The per-tier
  *model* IAM (what models a role may invoke) and the *channel membership* gate
  (who may be added to a higher-tier channel - enforced today in
  `create-conversation`/`share-conversation`) hold for every IdP and for guests,
  because they live on the role and the AppInstanceUser. Anything that depends on
  a Cognito-only signal is, by definition, not portable - keep it as a
  convenience layer above the portable enforcement, not as the enforcement.

See also `docs/specs/identity-access/SPEC-CONVERSATION-SECURITY.md` (the channel-join boundary +
membership model) and **Step 8** below (claim-driven tier→role mapping).

---

## Approach 1: Federate Your IdP into Cognito Identity Pools

This is the recommended approach if your IdP supports OIDC or SAML. You keep Cognito Identity Pools (for AWS credential exchange) but replace Cognito User Pools with your own IdP.

```
  User authenticates with your IdP (Okta, Auth0, Azure AD, etc.)
          │
          ▼
  IdP returns OIDC token or SAML assertion
          │
          ▼
  Frontend passes token to Cognito Identity Pool
          │
          ▼
  Identity Pool validates with your IdP, returns AWS credentials
          │
          ▼
  Chime SDK initialized (unchanged)
```

### Step 1: Register your IdP with Cognito Identity Pool

#### For OIDC providers (Auth0, Okta, Google Workspace, etc.)

In `backend/lib/stacks/cognito-auth-stack.ts`, add your OIDC provider to the Identity Pool:

```typescript
import * as iam from 'aws-cdk-lib/aws-iam';

// Create an IAM OIDC provider for your IdP
const oidcProvider = new iam.OpenIdConnectProvider(this, 'OIDCProvider', {
  url: 'https://your-idp.example.com',  // Your IdP's issuer URL
  clientIds: ['your-client-id'],          // OAuth2 client ID
});

// Update the Identity Pool to accept tokens from your IdP
this.identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
  identityPoolName: 'AgentEchelonIdentityPool',
  allowUnauthenticatedIdentities: false,

  // Remove or keep the Cognito User Pool provider (if still using it for some users)
  cognitoIdentityProviders: [
    {
      clientId: this.userPoolClient.userPoolClientId,
      providerName: this.userPool.userPoolProviderName,
    },
  ],

  // Add your OIDC provider
  openIdConnectProviderArns: [oidcProvider.openIdConnectProviderArn],
});
```

#### For SAML providers (Azure AD, Okta SAML, ADFS, etc.)

The `cognito-auth-stack.ts` already has a commented-out SAML placeholder (lines 175-191). Uncomment and configure it:

```typescript
const samlProvider = new cognito.UserPoolIdentityProviderSaml(this, 'SAMLProvider', {
  userPool: this.userPool,
  name: 'CorporateSSO',
  metadata: cognito.UserPoolIdentityProviderSamlMetadata.url(
    'https://your-idp.example.com/saml/metadata'
  ),
  attributeMapping: {
    email: cognito.ProviderAttribute.other('email'),
    givenName: cognito.ProviderAttribute.other('firstName'),
    familyName: cognito.ProviderAttribute.other('lastName'),
    custom: {
      'custom:tier': cognito.ProviderAttribute.other('userTier'),
    },
  },
});
```

### Step 2: Update the authenticated role trust policy

The Identity Pool's authenticated role must trust your IdP. Update the trust policy in `cognito-auth-stack.ts`:

```typescript
this.authenticatedRole = new iam.Role(this, 'AuthenticatedRole', {
  assumedBy: new iam.FederatedPrincipal(
    'cognito-identity.amazonaws.com',
    {
      StringEquals: {
        'cognito-identity.amazonaws.com:aud': this.identityPool.ref,
      },
      'ForAnyValue:StringLike': {
        'cognito-identity.amazonaws.com:amr': 'authenticated',
      },
    },
    'sts:AssumeRoleWithWebIdentity',
  ),
});
```

This trust policy already works for any IdP federated through Cognito Identity Pools - no changes needed if the Identity Pool is configured correctly.

### Step 3: Update the frontend credential exchange

In `frontend/src/services/chimeService.ts`, update the `logins` key to match your IdP:

```typescript
async initialize(idToken: string, userId: string): Promise<void> {
  const credentials = fromCognitoIdentityPool({
    client: new CognitoIdentityClient({ region: REGION }),
    identityPoolId: IDENTITY_POOL_ID!,
    logins: {
      // For Cognito User Pool (current):
      // [`cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`]: idToken,

      // For OIDC provider (Auth0, Okta, etc.):
      'your-idp.example.com': idToken,

      // For SAML provider:
      // [`arn:aws:iam::${ACCOUNT_ID}:saml-provider/CorporateSSO`]: samlAssertion,
    },
  });

  this.messagingClient = new ChimeSDKMessagingClient({
    region: REGION,
    credentials,
  });

  this.userArn = `${APP_INSTANCE_ARN}/user/${userId}`;
}
```

The login key format depends on your IdP type:

| IdP Type | Login Key Format |
|----------|-----------------|
| Cognito User Pool | `cognito-idp.{region}.amazonaws.com/{userPoolId}` |
| OIDC provider | Your IdP's issuer URL (e.g., `accounts.google.com`, `your-tenant.auth0.com`) |
| SAML provider | `arn:aws:iam::{accountId}:saml-provider/{providerName}` |
| Login with Amazon | `www.amazon.com` |
| Facebook | `graph.facebook.com` |
| Google | `accounts.google.com` |
| Apple | `appleid.apple.com` |

### Step 4: Update AuthProvider for your IdP's login flow

Replace the Cognito-specific auth logic in `frontend/src/providers/AuthProvider.tsx` with your IdP's SDK. The key contract AuthProvider must fulfill:

```typescript
interface AuthContract {
  // Must produce an OIDC-compatible IdToken (or SAML assertion)
  idToken: string | null;

  // Must provide a stable user ID (used as Chime AppInstanceUserId)
  user: { id: string; email: string; tier: string } | null;

  // Auth state
  isAuthenticated: boolean;
  isLoading: boolean;

  // Auth actions
  login(email: string, password: string): Promise<void>;
  logout(): void;
  refreshToken(): Promise<void>;
}
```

Example for Auth0:

```typescript
import { Auth0Client } from '@auth0/auth0-spa-js';

const auth0 = new Auth0Client({
  domain: 'your-tenant.auth0.com',
  clientId: 'your-client-id',
  authorizationParams: {
    redirect_uri: window.location.origin,
  },
});

// Login
async function login() {
  await auth0.loginWithRedirect();
}

// After redirect, get tokens
const idToken = (await auth0.getIdTokenClaims()).__raw;
const user = await auth0.getUser();

// Pass idToken to chimeService.initialize(idToken, user.sub)
```

### Step 5: Handle Chime AppInstanceUser creation

The post-confirmation Lambda creates a Chime `AppInstanceUser` when a user first registers. With an external IdP, you need an equivalent trigger:

**Option A: Just-in-time creation on first login**

Add this to your frontend's login flow (after successful auth, before Chime initialization):

```typescript
import { ChimeSDKIdentityClient, CreateAppInstanceUserCommand } from '@aws-sdk/client-chime-sdk-identity';

const chimeIdentityClient = new ChimeSDKIdentityClient({});

async function ensureChimeUser(userId: string, displayName: string) {
  try {
    await chimeIdentityClient.send(new CreateAppInstanceUserCommand({
      AppInstanceArn: APP_INSTANCE_ARN,
      AppInstanceUserId: userId,
      Name: displayName,
    }));
  } catch (error: any) {
    // 409 Conflict means user already exists — that's fine
    if (error.name !== 'ConflictException') throw error;
  }
}
```

**Option B: Webhook from your IdP**

Most IdPs support webhooks on user creation events. Point your IdP's "user created" webhook at an API Gateway + Lambda that calls `CreateAppInstanceUser`. This is the same pattern as the Cognito post-confirmation trigger, just with a different event source.

### Step 6: Map user tier

AgentEchelon uses a `custom:tier` attribute on Cognito users to control model access. With an external IdP, you have options:

| Strategy | How |
|----------|-----|
| **IdP custom attribute** | Add a `tier` claim to your IdP's user profile. Map it via SAML/OIDC attribute mapping in Cognito Identity Pool. |
| **IdP groups → tier** | Map IdP groups (e.g., "ai-basic", "ai-premium") to tiers in your AuthProvider. |
| **Default tier** | Set all external users to a default tier. Admins upgrade via a backend API. |
| **Lookup table** | Store tier mappings in DynamoDB. AuthProvider queries on login. |

### Step 7: Sync the tier attribute into a Cognito group (extension point)

**Background - why this step exists.** AgentEchelon's authorization checks trust **Cognito group membership**, not the `custom:tier` attribute. The group is the authoritative signal; the attribute is just a hint that gets mirrored into the matching group at sign-up time. Three places read groups: `router-agent-handler.ts`, `share-conversation/index.js`, and `create-conversation/index.js`. Two places write them: `post-confirmation.js` (runs at self-signup) and `user-management.ts` (runs when an admin approves or changes a user's tier). See [SPEC-CONVERSATION-SECURITY.md](../../specs/identity-access/SPEC-CONVERSATION-SECURITY.md) for the full rationale.

**The gap for federated users.** Cognito's `PostConfirmation_ConfirmSignUp` trigger **does not fire** for users created via federated IdPs (SAML / OIDC). It fires only for the native username-and-password sign-up flow. A SAML user therefore lands in the pool with `custom:tier` possibly populated (via your attribute mapping) but no group membership. Every reader in the system falls through to `basic` in that case - no crashes, no security bypass, just the conservative floor until an admin elevates them via the user-management UI.

**If you want IdP-provided tiers to propagate automatically**, add a `PostAuthentication` Lambda trigger. It fires on every successful sign-in regardless of whether the user came through native sign-up, SAML, OIDC, or any future identity source. It runs after attribute mapping, so `event.request.userAttributes['custom:tier']` is already populated from the IdP claim.

This is an **additive change** - you don't modify the existing `PostConfirmationFn`, you add a new Lambda alongside it. The existing native-sign-up flow keeps working unchanged.

**Lambda handler sketch** (`backend/lambda/cognito-triggers/post-authentication.js`):

```javascript
const {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const cognitoClient = new CognitoIdentityProviderClient({});
const TIER_GROUPS = ['basic', 'standard', 'premium'];

exports.handler = async (event) => {
  const userPoolId = event.userPoolId;
  const username = event.userName;
  const attrs = event.request.userAttributes || {};

  // Resolve desired tier. Adapt this to your IdP's claim shape:
  //  - OIDC: event.request.userAttributes['custom:tier']
  //  - SAML with group claim: parse attrs['cognito:groups'] or a custom claim
  //  - Lookup table: call DynamoDB with attrs.email
  const desired = TIER_GROUPS.includes(attrs['custom:tier'])
    ? attrs['custom:tier']
    : 'basic';

  // Idempotent sync: look at current groups, remove stale tier groups,
  // add the desired one if missing. Safe to run on every sign-in.
  const { Groups = [] } = await cognitoClient.send(
    new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: username })
  );
  const current = Groups.map((g) => g.GroupName);

  for (const other of TIER_GROUPS) {
    if (other !== desired && current.includes(other)) {
      await cognitoClient.send(new AdminRemoveUserFromGroupCommand({
        UserPoolId: userPoolId, Username: username, GroupName: other,
      }));
    }
  }

  if (!current.includes(desired)) {
    await cognitoClient.send(new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId, Username: username, GroupName: desired,
    }));
  }

  return event;
};
```

**CDK wiring** (`backend/lib/stacks/cognito-auth-stack.ts`):

```typescript
// Alongside the existing postConfirmationFn + preAuthenticationFn definitions
const postAuthenticationFn = new lambda.Function(this, 'PostAuthenticationFn', {
  functionName: 'agent-echelon-post-authentication',
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'post-authentication.handler',
  code: lambda.Code.fromAsset('lambda/cognito-triggers'),
  timeout: cdk.Duration.seconds(10),
  role: lambdaRole, // Same role — it already has AdminAddUserToGroup etc.
  description: 'Mirrors custom:tier into a Cognito group on every sign-in (IdP-safe)',
});

// Wire the trigger alongside the existing ones — L1 to avoid circular deps
cfnUserPool.lambdaConfig = {
  postConfirmation: postConfirmationFn.functionArn,
  preAuthentication: preAuthenticationFn.functionArn,
  postAuthentication: postAuthenticationFn.functionArn, // ← new
};

new lambda.CfnPermission(this, 'PostAuthenticationPermission', {
  action: 'lambda:InvokeFunction',
  functionName: postAuthenticationFn.functionArn,
  principal: 'cognito-idp.amazonaws.com',
  sourceArn: this.userPool.userPoolArn,
});
```

**No changes needed elsewhere.** The three readers already call `AdminListGroupsForUser` and pick the highest tier the user belongs to - they don't care whether the group was populated by `post-confirmation.js`, `post-authentication.js`, or an admin action via `user-management.ts`.

**Caveats:**

- **Runs on every sign-in.** The extra Lambda invocation is a few milliseconds plus three Cognito API calls per sign-in. For high-volume deployments, add a cache or short-circuit when `current` already contains `desired`.
- **`PostAuthentication` does not fire on silent token refresh** - only on full sign-in events. Tier changes therefore take effect on the user's next full login, not mid-session.
- **Admin UI remains the override.** `user-management.ts` still wins on any tier change performed through the admin dashboard - on the user's next sign-in, `post-authentication.js` sees the admin's chosen tier in `custom:tier` (because the admin UI updates both the attribute and the group together) and no-ops.
- **Group precedence is managed in `cognito-auth-stack.ts`.** Groups are declared with precedence 0 - 3 (`admins` / `premium` / `standard` / `basic`). If you need multi-group membership (e.g., an admin who is also premium), the readers already pick the highest tier via `TIER_RANK` - no change needed.

### Step 8: Tier → IAM role mapping (channel-join enforcement) - important for federated IdPs

The Cognito **group also selects the user's IAM role**, not just the application-layer tier. `cognito-auth-stack.ts` defines one authenticated IAM role per tier, attaches each to its group via `roleArn`, and the Identity Pool uses **Token-based role mapping** (`roleMappings … type: 'Token'`, keyed on the `cognito:preferred_role` claim Cognito derives from the group `roleArn`s). Each tier's role carries a pure-IAM **Deny** keyed on the GLOBAL `aws:ResourceTag/classification` (not `chime:ResourceTag`, which the Chime SDK does not surface as a condition key and would silently never match) so a tier-X user's credentials physically cannot send/join/read a channel tagged for a higher tier (`SPEC-CONVERSATION-SECURITY.md` Layer 1).

**What this means when you swap the IdP:**

- **Token-based role mapping reads `cognito:preferred_role`, which only exists for Cognito-group-backed roles.** A federated user with no group → no `preferred_role` → the Identity Pool falls back to the default `authenticated` role (the most-restrictive **basic** role). That is fail-safe, but a premium federated user stays basic at the IAM layer until their group is populated - so **Step 7 (group sync) is now a Layer-1 requirement, not just an app-layer nicety.** Use the `PostAuthentication` trigger above so every federated sign-in lands in the right group, hence the right role.
- **If you bypass Cognito groups entirely** (e.g., a pure claim-based mapping, or Approach 2's credential-exchange Lambda), map your IdP's tier claim directly to the per-tier IAM role: with the Identity Pool use **rules-based role mapping** on the claim; with the exchange Lambda, `AssumeRole` the matching `…AuthenticatedRole` based on the validated token's tier. The four role ARNs are stack outputs of `AgentEchelonCognitoAuth`.
- **The strongest layer is IdP-agnostic.** Channels are tagged `classification=<tier>` at creation and the **assistant-side** Deny lives on backend Lambda (async-processor) roles - entirely independent of how users authenticate. So even a misconfigured user-side IdP mapping cannot make a tier-X *assistant* act on a higher-tier channel.
- **Never key tier off a user-writable claim.** AgentEchelon keys role selection on group membership (admin-controlled), not the `custom:tier` attribute (which a user can self-set). If your IdP exposes a tier/role claim, ensure it is IdP-managed (admin/directory-controlled), not self-service-editable.

---

## Approach 2: Credential Exchange Service

Use this approach when your IdP doesn't support OIDC or SAML (e.g., LDAP, custom auth, legacy systems), or when you want full control over the credential exchange.

```
  User authenticates with your system
          │
          ▼
  Your app receives identity token or session
          │
          ▼
  Frontend calls your Credential Exchange Lambda
  POST /exchange-credentials { token: "..." }
          │
          ▼
  Lambda: 1. Validates token with your auth system
          2. Extracts user UUID and attributes
          3. Calls STS AssumeRole with user-scoped session
          4. Returns temporary AWS credentials
          │
          ▼
  Frontend uses credentials to initialize Chime SDK
```

### Step 1: Create the Credential Exchange Lambda

```typescript
// backend/lambda/credential-exchange/index.ts

import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import {
  ChimeSDKIdentityClient,
  CreateAppInstanceUserCommand,
} from '@aws-sdk/client-chime-sdk-identity';

const sts = new STSClient({});
const chime = new ChimeSDKIdentityClient({});

const USER_ROLE_ARN = process.env.USER_ROLE_ARN!;
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN!;

interface UserInfo {
  uuid: string;
  displayName: string;
  email: string;
  tier: string;
}

/**
 * STEP 1: Validate your IdP's token and extract user info.
 * Replace this with your actual validation logic.
 */
async function validateToken(token: string): Promise<UserInfo> {
  // Example: call your auth server's /userinfo endpoint
  const response = await fetch('https://your-auth-server.com/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error('Token validation failed');
  }

  const userInfo = await response.json();
  return {
    uuid: userInfo.sub,
    displayName: userInfo.name,
    email: userInfo.email,
    tier: userInfo.tier || 'basic',
  };
}

/**
 * STEP 2: Assume an IAM role scoped to this user.
 * The role must have Chime SDK messaging permissions.
 */
async function assumeRole(user: UserInfo) {
  const command = new AssumeRoleCommand({
    RoleArn: USER_ROLE_ARN,
    RoleSessionName: `chime_${user.uuid}`,
    DurationSeconds: 3600,
    Tags: [
      { Key: 'UserUUID', Value: user.uuid },
      { Key: 'UserTier', Value: user.tier },
    ],
  });

  const response = await sts.send(command);
  return response.Credentials;
}

/**
 * STEP 3: Ensure Chime AppInstanceUser exists (idempotent).
 */
async function ensureChimeUser(user: UserInfo): Promise<string> {
  const userArn = `${APP_INSTANCE_ARN}/user/${user.uuid}`;

  try {
    await chime.send(new CreateAppInstanceUserCommand({
      AppInstanceArn: APP_INSTANCE_ARN,
      AppInstanceUserId: user.uuid,
      Name: user.displayName,
    }));
  } catch (error: any) {
    if (error.name !== 'ConflictException') throw error;
    // User already exists — fine
  }

  return userArn;
}

/**
 * Lambda handler
 */
export async function handler(event: any) {
  const body = JSON.parse(event.body || '{}');
  const { token } = body;

  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Token required' }) };
  }

  try {
    // 1. Validate token with your auth system
    const user = await validateToken(token);

    // 2. Assume role for this user
    const credentials = await assumeRole(user);

    // 3. Ensure Chime user exists
    const userArn = await ensureChimeUser(user);

    // 4. Return credentials to frontend
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': process.env.APP_URL || '*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        credentials: {
          AccessKeyId: credentials!.AccessKeyId,
          SecretAccessKey: credentials!.SecretAccessKey,
          SessionToken: credentials!.SessionToken,
          Expiration: credentials!.Expiration,
        },
        userArn,
        tier: user.tier,
      }),
    };
  } catch (error) {
    console.error('Credential exchange failed:', error);
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Authentication failed' }),
    };
  }
}
```

### Step 2: Add the CDK stack for the credential exchange

```typescript
// In your CDK stack:

const credentialExchangeRole = new iam.Role(this, 'CredentialExchangeRole', {
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  inlinePolicies: {
    AssumeUserRole: new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole', 'sts:TagSession'],
          resources: [authenticatedRole.roleArn],
        }),
      ],
    }),
    ChimeCreateUser: new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          actions: ['chime:CreateAppInstanceUser'],
          resources: [`${appInstanceArn}/*`],
        }),
      ],
    }),
  },
  managedPolicies: [
    iam.ManagedPolicy.fromAwsManagedPolicyName(
      'service-role/AWSLambdaBasicExecutionRole'
    ),
  ],
});
```

### Step 3: Update the frontend to use direct credentials

Replace `fromCognitoIdentityPool` in `chimeService.ts` with a direct credential fetch:

```typescript
async initialize(token: string, userId: string): Promise<void> {
  // Call your credential exchange service
  const response = await fetch(CREDENTIAL_EXCHANGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  if (!response.ok) throw new Error('Credential exchange failed');

  const { credentials, userArn, tier } = await response.json();

  // Use the credentials directly (no Cognito Identity Pool)
  this.messagingClient = new ChimeSDKMessagingClient({
    region: REGION,
    credentials: {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    },
  });

  this.userArn = userArn;
}
```

### Step 4: Handle credential refresh

STS credentials expire (default: 1 hour). Set up a refresh interval similar to the existing token refresh:

```typescript
// In AuthProvider or a dedicated CredentialProvider
const CREDENTIAL_REFRESH_MS = 50 * 60 * 1000; // 50 minutes

useEffect(() => {
  const interval = setInterval(async () => {
    try {
      await chimeService.initialize(currentToken, userId);
    } catch {
      // Credential refresh failed — redirect to login
      logout();
    }
  }, CREDENTIAL_REFRESH_MS);

  return () => clearInterval(interval);
}, [currentToken]);
```

---

## Which Approach Should I Use?

| Situation | Recommended approach |
|-----------|---------------------|
| Your IdP supports OIDC (Auth0, Okta, Azure AD, Google) | **Approach 1** - federate into Cognito Identity Pool |
| Your IdP supports SAML (ADFS, Azure AD, Okta SAML) | **Approach 1** - federate via SAML provider |
| You have LDAP, custom auth, or a non-standard IdP | **Approach 2** - credential exchange service |
| You want to support multiple IdPs simultaneously | **Approach 1** - Identity Pool accepts multiple providers |
| You need custom authorization logic (IP allowlists, MFA checks) | **Approach 2** - full control in your Lambda |
| You want minimal code changes | **Approach 1** - only `chimeService.ts` login key and CDK config change |

---

## Common Pitfalls

**AppInstanceUserId must be stable and unique.** The Chime `AppInstanceUserId` you create must be the same every time a given user logs in. Use your IdP's stable user identifier (e.g., `sub` claim in OIDC, `NameID` in SAML, UUID in your system). Do not use email addresses - they can change.

**Token must reach the credential provider.** In Approach 1, the Identity Pool login key must exactly match the provider name registered in the Identity Pool. A mismatch silently returns unauthenticated credentials (or fails with `NotAuthorizedException`).

**Tier mapping must happen before Chime initialization.** The user's tier determines which IAM policies apply. If your IdP doesn't have a `tier` claim, you need to resolve the tier (from a lookup table, IdP group, or default) before the frontend calls `chimeService.initialize()`.

**Credential refresh timing matters.** STS credentials and IdP tokens expire independently. Refresh credentials at 50 minutes (before the 60-minute default expiry) to avoid interrupted sessions. The existing `AuthProvider.tsx` refresh interval pattern works for both approaches.

**Chime user creation is idempotent.** `CreateAppInstanceUser` returns a `ConflictException` if the user already exists. Always catch this - it means the user was already created (by a previous login or the post-confirmation trigger) and is safe to proceed.

---

## Related Documentation

- [ARCHITECTURE.md](../../overview/ARCHITECTURE.md) - Full system architecture including auth flow
- [Amazon Cognito Identity Pools Developer Guide](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-identity.html)
- [Amazon Cognito Identity Pools - External Identity Providers](https://docs.aws.amazon.com/cognito/latest/developerguide/external-identity-providers.html)
- [AWS STS AssumeRole](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html)
- [Chime SDK CreateAppInstanceUser](https://docs.aws.amazon.com/chime-sdk/latest/APIReference/API_identity-chime_CreateAppInstanceUser.html)
- [Original AWS Blog Post (2021)](https://aws.amazon.com/blogs/business-productivity/integrate-your-identity-provider-with-amazon-chime-sdk-messaging/) - covers the same concepts but uses older SDK namespaces
