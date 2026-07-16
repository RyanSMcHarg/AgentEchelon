# Deploying the frontend (CloudFront + S3)

The AgentEchelon SPA deploys to **CloudFront + private S3 by default**. The
`AgentEchelonFrontend` stack (part of `cdk deploy --all`) creates the hosting; a
short build-and-publish step uploads the app. Local development still uses the
Vite dev server (`npm run dev`) - this guide is for a real, shareable deploy.

## Why two steps (and not a one-shot `cdk deploy`)

The Vite build **bakes configuration in at build time** - `VITE_USER_POOL_ID`,
`VITE_APP_INSTANCE_ARN`, and the API URLs all come from CDK stack outputs and
are compiled into the bundle. Those outputs don't exist until the backend
stacks have deployed. So the stack can't bundle-and-upload the app inside
itself (it would be a circular dependency). Instead:

1. **`AgentEchelonFrontend`** provisions an empty origin bucket + CloudFront
   distribution (deployed with everything else by `cdk deploy --all`).
2. **`npm run deploy-frontend`** builds the app against the now-known outputs
   and syncs `frontend/dist` to the bucket, then invalidates the CDN.

## One-time / per-environment

```bash
# 1. Deploy the backend + the (empty) frontend hosting.
cd backend
npx cdk deploy --all \
  --context senderEmail=you@example.com \
  --context appUrl=http://localhost:5173      # placeholder for now; fixed in step 4

# 2. Read the frontend hosting outputs.
aws cloudformation describe-stacks --stack-name AgentEchelonFrontend \
  --query 'Stacks[0].Outputs' --output table
#   DistributionUrl         https://<dist-id>.cloudfront.net   <- the public app URL
#   DistributionBucketName  <bucket>
#   DistributionId          <dist-id>

# 3. Populate frontend/.env from the CDK outputs (see frontend/.env.example).
#    Use `aws cloudformation describe-stacks ... --output text` per stack, or the
#    backend `sync-context` helper, to fill VITE_* values.
```

## Build + publish the app

From `backend/` with AWS credentials in your environment:

```bash
npm run deploy-frontend                 # build frontend, sync to S3, invalidate CDN
# or, to publish a build you already ran:
npm run deploy-frontend -- --no-build
```

The script reads the bucket + distribution ID from the `AgentEchelonFrontend` stack
outputs, uploads `frontend/dist` (long-cache for hashed `assets/*`, `no-cache`
for `index.html`), prunes stale objects, and issues a `/*` invalidation.

Env overrides: `AWS_REGION` (default `us-east-1`), `FRONTEND_STACK_NAME`
(default `AgentEchelonFrontend`).

## 4. Close the CORS loop

The backend APIs allow exactly the origin in the `appUrl` CDK context. After the
first deploy you finally know the CloudFront URL, so set it and redeploy the
CORS-bearing stacks:

```bash
cd backend
npx cdk deploy --all --context appUrl=https://<dist-id>.cloudfront.net
```

If you serve the app from a **custom domain** instead (recommended for
production), `appUrl` is known up front - set it on the first deploy and you
skip this round-trip. Point the domain at the distribution and attach an
ACM certificate (us-east-1) to it; the `AgentEchelonFrontend` construct can be
extended with `domainNames` + `certificate` for that.

## Running locally vs. on CloudFront

There are two ways to run the app, and the backend's CORS allowlist decides
which one works at any given time.

**The key constraint:** the backend APIs allow **exactly one** origin - the
value of the `appUrl` CDK context (the CORS-bearing stacks set
`allowOrigins: [appUrl]`). So the backend permits **either** `localhost`
**or** the CloudFront origin, not both at once. Switching modes = redeploying
the CORS-bearing stacks with the other `appUrl`. (`frontend/.env` - the API
URLs the bundle calls - is identical in both modes; only the *serving origin*
and the backend's allowed origin differ.)

The CORS-bearing stacks are: `AgentEchelonCognitoAuth`, `AgentEchelonFoundations`,
`AgentEchelonS3Storage`, `AgentEchelonNotifications`, `AgentEchelonExperiments`,
`AgentEchelonAnalytics` (or `AgentEchelonAnalyticsAurora`), `AgentEchelonBattle`. You can pass
the stack names to `cdk deploy` to switch quickly, or just use `--all` (the
non-CORS stacks no-op).

### Local development (Vite dev server)

```bash
# backend allows localhost (this is the default appUrl, so usually no redeploy needed)
cd backend && npx cdk deploy --all --context appUrl=http://localhost:5173   # only if currently on CloudFront

cd frontend && npm run dev        # serves at http://localhost:5173
# open http://localhost:5173
```

### On CloudFront (the deployed SPA)

```bash
cd backend && npm run deploy-frontend        # build + sync + invalidate the CDN
# point the backend CORS at the CloudFront origin:
npx cdk deploy --all --context appUrl=https://<dist-id>.cloudfront.net
# open https://<dist-id>.cloudfront.net
```

> Switching to CloudFront makes `localhost` CORS-fail (and vice versa) - that's
> expected with the single-origin allowlist. If you need **both** simultaneously
> (e.g. local dev against the same backend a CloudFront demo uses), the
> CORS-bearing stacks would need to accept a list of origins instead of one
> `appUrl` - a small additive change, not wired today.

### Running the E2E suite against either

The Playwright suite defaults to `http://localhost:5173`; set `E2E_BASE_URL` to
target the deployed origin. The backend's `appUrl` must match whichever you
point at (so CORS allows it).

```bash
# against the local dev server (must be running)
cd tests && npm test

# against CloudFront (backend appUrl must be the CloudFront origin)
cd tests && E2E_BASE_URL=https://<dist-id>.cloudfront.net npm test
```

(The default-on WAF passes normal browser/E2E traffic - managed rules don't trip
on SPA GETs and the per-IP rate limit is far above a test run's volume.)

## WAF protection

A CLOUDFRONT-scoped WAF Web ACL is attached to the distribution **by default**
with `defaultAction: allow` (public-safe) plus AWS Managed Rules and a rate limit:

- `AWSManagedRulesCommonRuleSet` - OWASP-style common protections
- `AWSManagedRulesKnownBadInputsRuleSet` - known exploit signatures
- `AWSManagedRulesAmazonIpReputationList` - known-malicious source IPs
- a per-IP **rate-based rule** (default 3000 requests / 5-min window)

Tune or disable it:

```bash
# disable the managed-rules Web ACL (e.g. throwaway deploy; avoids ~$5/mo + per-rule cost)
npx cdk deploy AgentEchelonFrontend --context frontendWaf=false

# raise the rate limit (counts viewer requests per source IP; raise for shared/NAT'd office IPs)
npx cdk deploy AgentEchelonFrontend --context wafRateLimit=6000
```

### Optional: lock to known IPs (private deployments)

To additionally restrict the distribution to specific IP ranges while it is still
private, pass an allowlist. This adds a rule that **blocks any source IP not in
the set** (evaluated before the managed rules; listed IPs still pass through
them):

```bash
npx cdk deploy AgentEchelonFrontend \
  --context wafAllowedIps='["203.0.113.4/32","198.51.100.0/24"]'
# comma-separated also works: --context wafAllowedIps=203.0.113.4/32,198.51.100.0/24
```

The managed-rules WAF and the IP allowlist are independent: you can run either,
both, or (with `frontendWaf=false` and no allowlist) neither. Cognito auth still
gates everything past the static shell regardless.

## What the hosting gives you

- **Private S3 origin** reached only through CloudFront (Origin Access Control,
  SigV4-signed origin requests - no public bucket).
- **SPA routing**: `403`/`404` from S3 are served the app shell (`/index.html`,
  `200`) so client-side routes, refreshes, and email deep links resolve.
- **Security response headers**: HSTS (1 yr, preload), `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and
  `X-Frame-Options: DENY` (anti-clickjacking). A Content-Security-Policy is left
  to the deployer - a strict CSP must enumerate your Cognito / Chime /
  API-Gateway origins.
- **HTTPS only** (HTTP redirects to HTTPS), HTTP/2 + HTTP/3, TLS 1.2_2021 floor.

## Teardown

`cdk destroy AgentEchelonFrontend` removes the distribution and auto-empties the
origin bucket (the build is fully rebuildable, so the bucket is `DESTROY` +
`autoDeleteObjects`, unlike the RETAIN attachments bucket).
