#!/usr/bin/env node
/**
 * deploy-frontend.mjs — build the AgentEchelon SPA and publish it to the
 * AgentEchelonFrontend CloudFront distribution.
 *
 * Why a separate step (not a CDK BucketDeployment): the Vite bundle bakes in
 * this app's CDK outputs (VITE_USER_POOL_ID, VITE_APP_INSTANCE_ARN, the API
 * URLs) which only exist AFTER the backend stacks deploy. So the AgentEchelonFrontend
 * stack provisions an EMPTY bucket + distribution, and this script does the
 * second phase: build → sync → invalidate.
 *
 * Prereqs:
 *   1. `cdk deploy --all` has created AgentEchelonFrontend.
 *   2. `frontend/.env` is populated from the CDK stack outputs (the build reads
 *      VITE_* from it). See frontend/.env.example + CLAUDE.md.
 *
 * Usage (from backend/, with AWS creds in the environment):
 *   node scripts/deploy-frontend.mjs            # chat SPA: build, sync + invalidate
 *   node scripts/deploy-frontend.mjs --admin    # admin console (AgentEchelonAdminFrontend)
 *   node scripts/deploy-frontend.mjs --no-build # publish an existing build
 *
 * The --admin target builds the standalone admin app (`npm run build:admin` →
 * packages/admin/dist) and syncs it to the AgentEchelonAdminFrontend origin.
 * The default (chat) target additionally asserts the chat bundle carries no admin
 * code (SPEC-SEPARATE-ADMIN-APP.md).
 *
 * Env overrides: AWS_REGION (default us-east-1), STACK_PREFIX (default
 * AgentEchelon), FRONTEND_STACK_NAME (default <prefix>[Admin]Frontend).
 */
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from '@aws-sdk/client-cloudfront';

const REGION = process.env.AWS_REGION || 'us-east-1';
const STACK_PREFIX = process.env.STACK_PREFIX || 'AgentEchelon';
const isAdmin = process.argv.includes('--admin');
// Distinct CloudFormation output keys per target (the admin stack prefixes its
// outputs 'Admin*'; see FrontendStack.outputPrefix).
const OUT_PREFIX = isAdmin ? 'Admin' : '';
const STACK_NAME = process.env.FRONTEND_STACK_NAME
  || `${STACK_PREFIX}${isAdmin ? 'AdminFrontend' : 'Frontend'}`;
// Frontend is an npm-workspaces monorepo: @ae/chat and @ae/admin are separate
// packages, each a Vite app that builds its own index.html into its own dist/.
const BUILD_SCRIPT = isAdmin ? 'npm run build:admin' : 'npm run build:chat';
const ROOT_DOC = 'index.html';
const skipBuild = process.argv.includes('--no-build');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
// The workspace root (where the build:chat / build:admin / assert scripts live).
const frontendDir = path.join(repoRoot, 'frontend');
const distDir = path.join(frontendDir, 'packages', isAdmin ? 'admin' : 'chat', 'dist');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

function contentTypeFor(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// Hashed build assets (Vite emits content-hashed names into assets/) are safe
// to cache forever; the HTML entrypoint must always be revalidated so a new
// deploy is picked up immediately.
function cacheControlFor(key) {
  if (key === 'index.html' || key.endsWith('.html')) return 'no-cache';
  if (key.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full, base)));
    } else {
      // S3 keys are always forward-slash, even on Windows.
      out.push({ full, key: path.relative(base, full).split(path.sep).join('/') });
    }
  }
  return out;
}

async function getOutputs() {
  const cfn = new CloudFormationClient({ region: REGION });
  let res;
  try {
    res = await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
  } catch (err) {
    fail(
      `Could not describe stack "${STACK_NAME}": ${err?.message}\n` +
        `   Deploy it first:  npx cdk deploy ${STACK_NAME}  (or --all)`,
    );
  }
  const outputs = res.Stacks?.[0]?.Outputs ?? [];
  const get = (k) => outputs.find((o) => o.OutputKey === k)?.OutputValue;
  const bucket = get(`${OUT_PREFIX}DistributionBucketName`);
  const distributionId = get(`${OUT_PREFIX}DistributionId`);
  const url = get(`${OUT_PREFIX}DistributionUrl`);
  if (!bucket || !distributionId) {
    fail(`Stack "${STACK_NAME}" is missing ${OUT_PREFIX}DistributionBucketName/${OUT_PREFIX}DistributionId outputs.`);
  }
  return { bucket, distributionId, url };
}

function build() {
  if (skipBuild) {
    console.log('• Skipping build (--no-build); publishing existing dist/');
    return;
  }
  console.log(`• Building frontend (${BUILD_SCRIPT})…`);
  // Single command string (not an args array) with shell:true so npm resolves
  // to npm.cmd on Windows AND we avoid the DEP0190 unescaped-args warning. The
  // command is a fixed literal — no interpolation, no injection surface.
  const res = spawnSync(BUILD_SCRIPT, {
    cwd: frontendDir,
    stdio: 'inherit',
    shell: true,
  });
  if (res.status !== 0) fail('Frontend build failed — fix the errors above and retry.');

  // Security invariant: the public chat bundle must carry no admin code
  // (SPEC-SEPARATE-ADMIN-APP.md). Assert it before publishing the chat origin.
  if (!isAdmin) {
    console.log('• Asserting chat bundle is admin-free…');
    const assert = spawnSync('npm run assert-no-admin-in-chat', {
      cwd: frontendDir,
      stdio: 'inherit',
      shell: true,
    });
    if (assert.status !== 0) {
      fail('Chat bundle contains admin code — refusing to publish. See the offending import chain above.');
    }
  }
}

async function sync(bucket) {
  let files;
  try {
    const st = await stat(path.join(distDir, ROOT_DOC));
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    fail(
      `No build found at ${distDir} (${ROOT_DOC} missing).\n` +
        `   Run without --no-build, or build first: npm --prefix ../frontend run ${isAdmin ? 'build:admin' : 'build:chat'}`,
    );
  }
  files = await walk(distDir);
  const s3 = new S3Client({ region: REGION });

  console.log(`• Uploading ${files.length} files → s3://${bucket}`);
  for (const { full, key } of files) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(full),
        ContentType: contentTypeFor(full),
        CacheControl: cacheControlFor(key),
      }),
    );
  }

  // Prune objects that are no longer part of the build (old hashed assets).
  const keep = new Set(files.map((f) => f.key));
  const stale = [];
  let token;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    for (const obj of listed.Contents ?? []) {
      if (obj.Key && !keep.has(obj.Key)) stale.push({ Key: obj.Key });
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);

  for (let i = 0; i < stale.length; i += 1000) {
    const batch = stale.slice(i, i + 1000);
    await s3.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch } }),
    );
  }
  if (stale.length) console.log(`• Pruned ${stale.length} stale object(s)`);
}

async function invalidate(distributionId) {
  console.log(`• Invalidating CloudFront ${distributionId} (/*)`);
  const cf = new CloudFrontClient({ region: REGION });
  await cf.send(
    new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        // CallerReference must be unique per call.
        CallerReference: `deploy-frontend-${Date.now()}`,
        Paths: { Quantity: 1, Items: ['/*'] },
      },
    }),
  );
}

async function main() {
  console.log(`\nAgentEchelon frontend deploy → ${STACK_NAME} (${REGION})\n`);
  const { bucket, distributionId, url } = await getOutputs();
  build();
  await sync(bucket);
  await invalidate(distributionId);
  console.log(`\n✅ Deployed. ${isAdmin ? 'Admin console' : 'App'}: ${url || `https://<distribution>`}\n`);
  const corsCtx = isAdmin ? 'adminAppUrl' : 'appUrl';
  console.log(
    '   If the API rejects requests with CORS errors, redeploy the backend with\n' +
      `   --context ${corsCtx}=${url || 'https://<DistributionUrl>'}  so its CORS allowlist\n` +
      `   includes the ${isAdmin ? 'admin console' : 'app'} origin.\n`,
  );
}

main().catch((err) => fail(err?.stack || err?.message || String(err)));
