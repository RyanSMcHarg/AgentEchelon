# Deploying the frontend (CloudFront + S3)

The AgentEchelon SPA deploys to **CloudFront + private S3 by default**. The `<prefix>ChatApp` stack (`AgentEchelonChatApp` for the default instance name) creates the hosting; a separate build-and-publish step uploads the app. Local development uses the Vite dev server (`cd frontend && npm run dev:chat`, or `npm run dev:admin`); this guide covers a real, shareable deploy.

## Two-step model

The Vite build **bakes configuration in at build time**: `VITE_USER_POOL_ID`, `VITE_APP_INSTANCE_ARN` and the API URLs all come from CDK stack outputs and are compiled into the bundle. Those outputs exist only after the backend stacks deploy, so the frontend stack cannot bundle and upload the app inside itself (it would be a circular dependency). Instead:

1. **`<prefix>ChatApp`** provisions an empty origin bucket and a CloudFront distribution, deployed with the backend stacks.
2. **`node scripts/deploy-frontend.mjs`** (`npm run deploy-frontend`) builds the app against the live outputs, syncs `frontend/packages/chat/dist` to the bucket, and invalidates the CDN.

The frontend never ships through `cdk deploy`: a `cdk deploy` of the frontend stack exits 0 and publishes no app. The app ships only through `deploy-frontend.mjs`.

## One-command deploy

The supported path does both steps, plus the CORS loop below, in one command:

```bash
cd backend
cp deploy.config.example.json deploy.config.json   # first deploy only; set senderEmail and any other keys
npm run deploy
```

`npm run deploy` (`backend/scripts/deploy.mjs`) runs, in order:

1. `npm run build` (compiles the Lambda TypeScript so esbuild does not bundle stale `.js`).
2. Resolves the live CloudFront origin and deploys every backend stack with it as `appUrl`, forwarding every key in the gitignored `backend/deploy.config.json` as `--context`. The chat app hosting exists when `chat` is in `capabilities`.
3. `node scripts/sync-context.mjs`, which compiles the project docs into tiered context files (`standard/context.json`, `premium/context.json`) and uploads them to S3.
4. `node scripts/gen-frontend-env.mjs`, which writes one env file per package from the live outputs: `frontend/packages/chat/.env` and `frontend/packages/admin/.env`, and `frontend/packages/widget/.env` when `widget` is a declared capability. There is no root `frontend/.env`.
5. `node scripts/deploy-frontend.mjs` for the chat app when `chat` is a declared capability, `node scripts/deploy-frontend.mjs --admin` when `admin` is, `node scripts/deploy-frontend.mjs --widget` when `widget` is, and `node scripts/deploy-frontend.mjs --widget-host` (the sample host page, on `<prefix>WidgetHost`) when an issuer in `issuers` lists `"widget-host"` in its `allowedOrigins`. The widget frame calls `PersonApi` from the `Widget` distribution's own origin, so `deploy.mjs` resolves `widgetUrl` from the `Widget` stack's `WidgetDistributionUrl` output (`widgetUrlLookup`) unless you pass it. It does not write the value into `deploy.config.json`, and `npm run deploy:stack` reads it only from there, refusing to run while `widget` is declared and `widgetUrl` is absent: copy the output into `widgetUrl` in `deploy.config.json` before a single-stack deploy.

On the first ever deploy the distribution does not exist before step 2, so the script runs one extra backend pass with the new CloudFront origin as `appUrl`. The widget's origin (`widgetUrl`, from the `Widget` stack's `WidgetDistributionUrl`) is resolved and applied the same way when `widget` is declared.

CLI context flags come after the config file and win: `npm run deploy -- --context appUrl=https://app.example.com`.

## Read the hosting outputs

```bash
aws cloudformation describe-stacks --stack-name AgentEchelonChatApp \
  --query 'Stacks[0].Outputs' --output table
#   DistributionUrl         https://<dist-id>.cloudfront.net   <- the public app URL
#   DistributionBucketName  <bucket>
#   DistributionId          <dist-id>
```

## Publish the app only

From `backend/` with AWS credentials in your environment, after the backend is deployed:

```bash
node scripts/gen-frontend-env.mjs       # regenerate frontend/packages/{chat,admin}/.env from live outputs
npm run deploy-frontend                 # build the chat app, sync to S3, invalidate the CDN
npm run deploy-frontend -- --no-build   # publish a build you already ran
```

The script reads the bucket and distribution ID from the frontend stack's outputs, uploads `frontend/packages/chat/dist` (`frontend/packages/admin/dist` with `--admin`) with long-cache headers for hashed `assets/*` and `no-cache` for `index.html`, prunes stale objects, and issues a `/*` invalidation.

Env overrides: `AWS_REGION` (default `us-east-1`); the stack prefix, from `AE_STACK_PREFIX`, else the PascalCase of `AE_INSTANCE_NAME` (default `AgentEchelon`), the variables the CDK app names its stacks from; `FRONTEND_STACK_NAME`, the chat target only (default `<prefix>ChatApp`); and `ADMIN_FRONTEND_STACK_NAME`, the `--admin` target only (default `<prefix>AdminApp`). `STACK_PREFIX` is a script-only spelling of the prefix that the CDK app does not read, so on its own it points the scripts at stacks that do not exist; `deploy.mjs` sets it for its child steps. Every operator script resolves the prefix with one function (`resolveStackPrefix` in `backend/scripts/lib/stack-lookup.cjs`), and variables that name different instances stop the script. An override for one target never reaches the other, and a target that names the other console's stack, a stack outside this instance's prefix, or a stack that does not exist fails with both stack names in the message (`backend/scripts/lib/deploy-guards.cjs`).

## CORS loop

`PersonApi` allows the chat origin in the `appUrl` CDK context. `npm run deploy` resolves it from the live distribution, so the loop closes without a manual step.

For a non-default instance name, set `AE_INSTANCE_NAME` (or `AE_STACK_PREFIX`), the same variable the CDK app names its stacks from. `deploy.mjs` derives both frontend targets from it and passes the prefix and both targets to `sync-context.mjs`, `gen-frontend-env.mjs` and `deploy-frontend.mjs`, so every step resolves the same stacks; run on their own, those scripts read `AE_INSTANCE_NAME` the same way.

To serve the app from a **custom domain** (recommended for production), set `appUrl` in `deploy.config.json` before the first deploy. Point the domain at the distribution and attach an ACM certificate (us-east-1) to it; the `FrontendDistribution` construct (`backend/lib/constructs/frontend-distribution.ts`) can be extended with `domainNames` and `certificate` for that.

A single-stack deploy goes through `npm run deploy:stack -- <Stack>` (`--diff-only` to look first), which applies `deploy.config.json`, refuses a missing `appUrl`, and checks the name against `cdk list` with the same context. A bare `cdk deploy <Stack>` without context reverts every context-gated flag to its default and resets `appUrl` to `http://localhost:5173`, which CORS-blocks the hosted app. [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) §18b has the detail.

## Standalone admin console (optional)

The operator console is a **separate app on its own origin**, not a route in the chat SPA (see [`DESIGN-SEPARATE-ADMIN-APP.md`](../../specs/interface/DESIGN-SEPARATE-ADMIN-APP.md)). The frontend is an npm-workspaces monorepo: `@ae/chat` and `@ae/admin` are separate packages sharing `@ae/shared`, each building its own `index.html` into its own `dist/`. The chat bundle carries no admin code or admin endpoint URLs. An admin UI is opt-in: a deployment may run headless or host its own console, and when present it is always the separate app. Both apps run against the **same** Amazon Chime SDK app instance, trusted-issuer registry, people and credential exchange; only the build and origin are separate. The console admits a person whose issuer declares `admin: true`, and for the deployment's own pool the admin authority is its `admins` group (`adminGroups` on the `deployment` entry names another).

It is the admin interface, the last of the four deployable components (the core, the chat interface, the admin backend, the admin interface):

1. Add `"admin"` to `capabilities` in `backend/deploy.config.json` and run `npm run deploy`. This creates the `<prefix>AdminApp` hosting with prefixed outputs (`AdminDistributionUrl`, `AdminDistributionBucketName`, `AdminDistributionId`), creates `<prefix>AdminServices` and `<prefix>AdminApi`, adds a dedicated admin Cognito app client to the deployment's pool in `<prefix>Identity` (set `"adminAppClient": "shared"` to reuse the chat app client instead), writes `frontend/packages/admin/.env`, and publishes the admin app (`deploy-frontend.mjs --admin`).
2. The same run closes the admin CORS loop. `deploy.mjs` resolves `adminAppUrl` from the `AdminDistributionUrl` output the way it resolves `appUrl`: up front when the admin distribution already exists, otherwise in one extra backend pass after it is created. Set `"adminAppUrl"` in `deploy.config.json` only when the console is served from a custom domain.

`gen-frontend-env.mjs` writes the admin-only values (the admin API `VITE_ADMIN_API_URL` and its `VITE_ADMIN_API_CAPABILITIES`, the analytics mode, and `VITE_ADMIN_CLIENT_ID` when the client is dedicated) only into `frontend/packages/admin/.env`, the chat-only `VITE_ADMIN_APP_URL` and `VITE_SLEEP_MODE_ENABLED` only into `frontend/packages/chat/.env`, and the person API `VITE_PERSON_API_URL` and its `VITE_PERSON_API_CAPABILITIES` into both, because the console resolves its person there too. Signed in, both apps read the deployment's classifications from `GET /classifications` on the person API (each classification's display name, audience, badge token and grants, from the runtime registry), so a classification added later renders with no build. The chat app also renders before sign-in (the registration screen offers the member classifications), so `gen-frontend-env.mjs` writes `VITE_CLASSIFICATIONS` into `frontend/packages/chat/.env` alone, from the same registry rows (`<SSM root>/registry/classification`), URI-encoded behind `uri:`; the console carries none. The widget's env carries, beside the person API, the guest issuer's `VITE_GUEST_CAPTCHA_SITE_KEY` and `VITE_GUEST_NOTICE_VERSION`, the upgrade paths the visitor's conversation type declares (`VITE_GUEST_UPGRADE_PATHS`, the `GuestUpgradePaths` output) and the chat app a visitor signs in at, and whose sign-in carries the visit over (`VITE_GUEST_SIGN_IN_URL`, the `GuestSignInUrl` output, which is `appUrl`).

### Two-origin CORS

Each API trusts exactly the origins that legitimately call it, configured on the API itself:

- **`AdminApi`** (every admin route: the admin credential exchange, analytics, user management, admin conversations, the feedback summary, profiles and experiments): trusts `adminAppUrl` only.
- **`PersonApi`** (every route a person calls, the person credential exchange and user feedback among them): trusts `appUrl`, `adminAppUrl` (the console resolves its person there), every origin an issuer in the registry declares in `allowedOrigins` except the sample host page (`"widget-host"`, which frames the widget and calls nothing), and, with the `widget` capability, the widget frame's own origin `widgetUrl` (`personApiOrigins` in `backend/lib/stacks/person-api-stack.ts`).

An unset `adminAppUrl` falls back to `appUrl`, so a hand-run `cdk deploy` without it leaves the admin origin untrusted. The admin console gates its own entry on the `admins` group; IAM on every admin route, and `requireAdmin` behind it, are the authorization boundary regardless of origin.

## Sign-in providers

The sign-in screen offers a button for each redirect issuer in `issuers` in `backend/deploy.config.json` (`cognito-federated` on the deployment's pool, `oidc`, `oidc-entra`), beside the password form. `gen-frontend-env.mjs` projects the registry into `VITE_ISSUERS`, public fields only, and writes it into both packages' `.env`; the admin console offers only the entries with `admin: true`. It prints each entry it leaves out with the reason. The list is baked in at build time like every other `VITE_` value, so a change to `issuers` reaches the screen after `gen-frontend-env.mjs` runs again and the app is republished; `npm run deploy` does both.

An issuer returns the tab to `<origin>/callback`. On CloudFront that path is served by the SPA error mapping (403 and 404 answer `/index.html` with 200, `backend/lib/constructs/frontend-distribution.ts`), and the Vite dev server serves it the same way. The pool's web client registers `<origin>/callback` for both interface origins plus `http://localhost:5173/callback`, and the dedicated admin client `http://localhost:5174/callback` plus the admin origin. A foreign issuer registers the same URI on its own client.

The deployment's pool has a managed login domain, which the redirect sign-in and an in-pool provider's button go through (`ManagedLoginDomain`, output `UserPoolDomainUrl`, in `backend/lib/stacks/identity-stack.ts`). **NOT VERIFIED:** a live redirect sign-in on a deployed origin. [`IDENTITY-PROVIDER-GUIDE.md`](IDENTITY-PROVIDER-GUIDE.md#step-2-sign-in-in-the-frontend) has the flow, its checks and what each issuer must provide.

## Local vs. CloudFront

The backend's CORS allowlist decides which way of running the app works at a given time.

**Single chat origin.** `PersonApi` allows exactly one chat origin, the `appUrl` context (beside `adminAppUrl` and the origins issuers declare), and `AdminApi` allows `adminAppUrl`. So for the chat app the backend permits **either** `localhost` **or** the CloudFront origin, not both at once, and switching means redeploying with the other `appUrl`. The generated `frontend/packages/chat/.env` (the API URLs the bundle calls) is identical in both modes; only the serving origin and the backend's allowed origin differ.

The CORS configuration is on `<prefix>PersonApi` and `<prefix>AdminApi`; a handler that checks the request origin itself takes the same `appUrl` and `adminAppUrl` in its own stack.

### Local development (Vite dev server)

```bash
# Point the backend CORS at localhost (only needed if it currently allows CloudFront):
cd backend && npm run deploy -- --context appUrl=http://localhost:5173

cd frontend && npm run dev:chat     # serves at http://localhost:5173
```

The admin console's dev server, `npm run dev:admin`, sets no port of its own: Vite serves it at `http://localhost:5173`, or at the next free port (`http://localhost:5174`) when the chat dev server already holds 5173. Run it beside the chat app so it lands on 5174, the port the admin sign-in client registers (`http://localhost:5174/callback`), and deploy with `--context adminAppUrl=http://localhost:5174` so `AdminApi` allows it.

### On CloudFront (the deployed SPA)

```bash
cd backend && npm run deploy        # resolves appUrl from the live distribution and publishes the app
# open https://<dist-id>.cloudfront.net
```

Switching to CloudFront makes `localhost` fail CORS, and the reverse, which is expected with the single chat origin. Accepting both at once (local development against the backend a CloudFront demo uses) would need `PersonApi` and the handlers that check the origin to take a list of chat origins instead of one `appUrl`: **NOT BUILT**.

### E2E against either

The Playwright suite defaults to `http://localhost:5173`; set `E2E_BASE_URL` to target the deployed origin. The backend's `appUrl` must match whichever you point at, so CORS allows it.

```bash
# against the local dev server (must be running)
cd tests && npm test

# against CloudFront (backend appUrl must be the CloudFront origin)
cd tests && E2E_BASE_URL=https://<dist-id>.cloudfront.net npm test
```

The default-on WAF passes normal browser and E2E traffic: managed rules do not trip on SPA GETs and the per-IP rate limit is far above a test run's volume.

## WAF protection

A CLOUDFRONT-scoped WAF Web ACL is attached to the distribution **by default** with `defaultAction: allow` plus AWS Managed Rules and a rate limit:

- `AWSManagedRulesCommonRuleSet` - OWASP-style common protections
- `AWSManagedRulesKnownBadInputsRuleSet` - known exploit signatures
- `AWSManagedRulesAmazonIpReputationList` - known-malicious source IPs
- a per-IP **rate-based rule** (default 3000 requests per 5-minute window)

Tune or disable it with keys in `backend/deploy.config.json`, then `npm run deploy`:

```jsonc
"frontendWaf": false,     // disable the managed-rules Web ACL (throwaway deploy; avoids ~$5/mo plus per-rule cost)
"wafRateLimit": 6000,     // raise the per-source-IP limit (shared or NAT'd office IPs)
```

### IP allowlist (private deployments)

To restrict the distribution to specific IP ranges while it is private, set an allowlist. This adds a rule that **blocks any source IP not in the set**, evaluated before the managed rules; listed IPs still pass through them:

```jsonc
"wafAllowedIps": "[\"203.0.113.4/32\",\"198.51.100.0/24\"]"
// comma-separated also works: "203.0.113.4/32,198.51.100.0/24"
```

The managed-rules WAF and the IP allowlist are independent: run either, both, or (with `frontendWaf` false and no allowlist) neither. The static shell is all the distribution serves; the WAF does not protect data. Data access past the shell is enforced server-side: messaging and AWS calls use credentials the credential exchange vends, bearer-pinned to the signed-in person and scoped to the declared classification their groups resolve to, so IAM evaluates every call whatever origin it came from, and each API checks its own authorizer.

## What the hosting gives you

- **Private S3 origin** reached only through CloudFront (Origin Access Control, SigV4-signed origin requests; no public bucket).
- **SPA routing**: `403`/`404` from S3 are served the app shell (`/index.html`, `200`) so client-side routes, refreshes and email deep links resolve.
- **Security response headers**: HSTS (1 year, preload), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and `X-Frame-Options: DENY` (anti-clickjacking). A Content-Security-Policy is left to the deployer: a strict CSP must enumerate your Cognito, Amazon Chime SDK and API Gateway origins.
- **HTTPS only** (HTTP redirects to HTTPS), HTTP/2 and HTTP/3, TLS 1.2_2021 floor.

## Teardown

`cdk destroy AgentEchelonChatApp` (with the full context, so the name resolves) removes the distribution and auto-empties the origin bucket. The build is fully rebuildable, so the bucket is `DESTROY` with `autoDeleteObjects`, unlike the RETAIN attachments bucket.
