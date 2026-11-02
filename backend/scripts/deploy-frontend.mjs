#!/usr/bin/env node
/**
 * deploy-frontend.mjs — build the AgentEchelon SPA and publish it to the
 * AgentEchelonChatApp CloudFront distribution.
 *
 * Why a separate step (not a CDK BucketDeployment): the Vite bundle bakes in
 * this app's CDK outputs (VITE_USER_POOL_ID, VITE_APP_INSTANCE_ARN, the API
 * URLs) which only exist AFTER the backend stacks deploy. So the AgentEchelonChatApp
 * stack provisions an EMPTY bucket + distribution, and this script does the
 * second phase: build → sync → invalidate.
 *
 * Prereqs:
 *   1. `npm run deploy` (or a full-context `cdk deploy`) has created AgentEchelonChatApp.
 *   2. `frontend/packages/chat/.env` and `frontend/packages/admin/.env` are
 *      populated from the CDK stack outputs by `node scripts/gen-frontend-env.mjs`
 *      (each package's build reads VITE_* from its own .env). See each package's
 *      .env.example and docs/guides/user/FRONTEND-DEPLOY.md.
 *
 * Usage (from backend/, with AWS creds in the environment):
 *   node scripts/deploy-frontend.mjs            # chat SPA: build, sync + invalidate
 *   node scripts/deploy-frontend.mjs --admin    # admin console (AgentEchelonAdminApp)
 *   node scripts/deploy-frontend.mjs --widget   # the embeddable widget (<prefix>Widget)
 *   node scripts/deploy-frontend.mjs --widget-host  # the sample host page (<prefix>WidgetHost)
 *   node scripts/deploy-frontend.mjs --no-build # publish an existing build
 *
 * The --admin target builds the standalone admin app (`npm run build:admin` →
 * packages/admin/dist) and syncs it to the AgentEchelonAdminApp origin.
 * The --widget target builds the widget package (`npm run build:widget` -> packages/widget/dist) and syncs
 * it to the <prefix>Widget origin, whose outputs are `Widget*`: the frame document (index.html) and the
 * host loader (embed.js). Its build reads frontend/packages/widget/.env (gen-frontend-env.mjs).
 * The --widget-host target has no build: it syncs examples/widget-host (its README excepted) to the
 * <prefix>WidgetHost origin, with a generated host-config.js naming the widget's origin, read from the
 * <prefix>Widget stack's WidgetDistributionUrl output, so the page is never edited per deployment.
 * The default (chat) target additionally asserts the chat bundle carries no admin
 * code (DESIGN-SEPARATE-ADMIN-APP.md).
 *
 * Env overrides: AWS_REGION (default us-east-1); the stack prefix from AE_STACK_PREFIX,
 * else the PascalCase of AE_INSTANCE_NAME (default AgentEchelon), the variables the CDK app
 * names its stacks from (scripts/lib/stack-lookup.cjs). STACK_PREFIX is a script-only
 * spelling the CDK app does not read; deploy.mjs sets it for this step. FRONTEND_STACK_NAME
 * (chat target only, default <prefix>ChatApp) and ADMIN_FRONTEND_STACK_NAME (admin target
 * only, default <prefix>AdminApp). Neither override reaches the other target, and an
 * override outside this instance's prefix is refused (scripts/lib/deploy-guards.cjs).
 */
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
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

const require = createRequire(import.meta.url);
const {
  resolveFrontendTargets,
  checkFrontendStackOutputs,
  checkWidgetStackOutputs,
  widgetStackName,
  checkWidgetHostStackOutputs,
  widgetHostStackName,
  classifyDescribeStacksError,
} = require('./lib/deploy-guards.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const isAdmin = process.argv.includes('--admin');
const isWidget = process.argv.includes('--widget');
const isWidgetHost = process.argv.includes('--widget-host');
if ([isAdmin, isWidget, isWidgetHost].filter(Boolean).length > 1) {
  console.error('\n❌ --admin, --widget and --widget-host each name a target; publish one at a time.\n');
  process.exit(1);
}
/** Which bundle this run publishes: the package it builds and the console it is, for messages. */
const TARGET = isWidgetHost ? 'widget-host' : isWidget ? 'widget' : isAdmin ? 'admin' : 'chat';
// Distinct CloudFormation output keys per target (the admin stack prefixes its
// outputs 'Admin*'; see FrontendStack.outputPrefix).
const OUT_PREFIX = isWidget ? 'Widget' : isAdmin ? 'Admin' : '';
// Each target is derived from the instance prefix on its own, so an override for one never
// redirects the other. deploy.mjs passes its environment here, so an override that reached both
// would send the --admin publish at the chat stack.
let TARGETS;
try {
  TARGETS = resolveFrontendTargets(process.env);
} catch (err) {
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
}
const STACK_NAME = isWidgetHost
  ? widgetHostStackName(TARGETS.prefix)
  : isWidget ? widgetStackName(TARGETS.prefix) : isAdmin ? TARGETS.admin : TARGETS.chat;
// Frontend is an npm-workspaces monorepo: @ae/chat and @ae/admin are separate
// packages, each a Vite app that builds its own index.html into its own dist/.
const BUILD_SCRIPT = `npm run build:${TARGET}`;
const ROOT_DOC = 'index.html';
// The sample host page is static files in the repository, with nothing to build.
const skipBuild = process.argv.includes('--no-build') || isWidgetHost;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
// The workspace root (where the build:chat / build:admin / assert scripts live).
const frontendDir = path.join(repoRoot, 'frontend');
const distDir = isWidgetHost
  ? path.join(repoRoot, 'examples', 'widget-host')
  : path.join(frontendDir, 'packages', TARGET, 'dist');
/** The sample host page's generated configuration: the one value that differs between deployments. */
const HOST_CONFIG = 'host-config.js';
/** Files in the source directory that are not published: the README, and the local placeholder the generated configuration replaces. */
const UNPUBLISHED = new Set(isWidgetHost ? ['README.md', HOST_CONFIG] : []);
if (isWidget && !existsSync(path.join(frontendDir, 'packages', 'widget'))) {
  console.error('\n❌ The widget package (frontend/packages/widget) is NOT BUILT, so there is nothing to publish.\n');
  process.exit(1);
}

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

/**
 * The widget's origin, for the sample host page: the `WidgetDistributionUrl` output of this instance's own
 * Widget stack. Without it the page would load nothing, so its absence stops the publish.
 */
async function widgetOriginForHost(cfn) {
  const name = widgetStackName(TARGETS.prefix);
  let res;
  try {
    res = await cfn.send(new DescribeStacksCommand({ StackName: name }));
  } catch (err) {
    fail(`The sample host page embeds the widget, and its stack "${name}" could not be read: ${err?.message}\n`
      + '   Deploy with "widget" in capabilities first.');
  }
  const url = res.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'WidgetDistributionUrl')?.OutputValue;
  if (!url || !/^https:\/\/[^/\s]+\/?$/.test(url)) fail(`Stack "${name}" has no WidgetDistributionUrl output naming an https origin.`);
  return url.replace(/\/$/, '');
}

async function getOutputs() {
  const cfn = new CloudFormationClient({ region: REGION });
  let res;
  try {
    res = await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
  } catch (err) {
    const targets = `   Chat target:  ${TARGETS.chat}\n   Admin target: ${TARGETS.admin}\n`;
    if (classifyDescribeStacksError(err) === 'absent') {
      fail(
        `The ${TARGET} frontend stack "${STACK_NAME}" does not exist in ${REGION}.\n` +
          targets +
          `   Deploy it first (npm run deploy, with ${TARGET} in capabilities), or check the\n` +
          '   instance name (AE_INSTANCE_NAME / AE_STACK_PREFIX) and FRONTEND_STACK_NAME / ADMIN_FRONTEND_STACK_NAME.',
      );
    }
    fail(`Could not describe stack "${STACK_NAME}": ${err?.message}\n${targets}`);
  }
  const outputs = res.Stacks?.[0]?.Outputs ?? [];
  // The outputs say which console a stack hosts whatever it is called, so a target pointed at the
  // other console's stack stops here instead of replacing that console's bundle. A stack whose create
  // failed has no outputs, and the status says so rather than reading as the wrong kind of stack.
  const mismatch = isWidgetHost
    ? checkWidgetHostStackOutputs({ stackName: STACK_NAME, outputKeys: outputs.map((o) => o.OutputKey), stackStatus: res.Stacks?.[0]?.StackStatus })
    : isWidget
    ? checkWidgetStackOutputs({ stackName: STACK_NAME, outputKeys: outputs.map((o) => o.OutputKey), stackStatus: res.Stacks?.[0]?.StackStatus })
    : checkFrontendStackOutputs({
    stackName: STACK_NAME,
    isAdmin,
    outputKeys: outputs.map((o) => o.OutputKey),
    targets: TARGETS,
    stackStatus: res.Stacks?.[0]?.StackStatus,
  });
  if (mismatch) fail(mismatch);
  const get = (k) => outputs.find((o) => o.OutputKey === k)?.OutputValue;
  if (isWidgetHost) {
    return {
      bucket: get('WidgetHostBucketName'),
      distributionId: get('WidgetHostDistributionId'),
      url: get('WidgetHostUrl'),
      widgetOrigin: await widgetOriginForHost(cfn),
    };
  }
  const bucket = get(`${OUT_PREFIX}DistributionBucketName`);
  const distributionId = get(`${OUT_PREFIX}DistributionId`);
  const url = get(`${OUT_PREFIX}DistributionUrl`);
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
  // (DESIGN-SEPARATE-ADMIN-APP.md). Assert it before publishing the chat origin.
  if (TARGET === 'chat') {
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

async function sync(bucket, generated = []) {
  let files;
  try {
    const st = await stat(path.join(distDir, ROOT_DOC));
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    fail(
      `No build found at ${distDir} (${ROOT_DOC} missing).\n` +
        `   Run without --no-build, or build first: npm --prefix ../frontend run build:${TARGET}`,
    );
  }
  files = (await walk(distDir)).filter((f) => !UNPUBLISHED.has(f.key));
  const s3 = new S3Client({ region: REGION });

  console.log(`• Uploading ${files.length + generated.length} files → s3://${bucket}`);
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

  // Files written for this deployment rather than read from the source directory, never cached.
  for (const { key, body } of generated) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentTypeFor(key), CacheControl: 'no-cache' }));
  }

  // Prune objects that are no longer part of the build (old hashed assets).
  const keep = new Set([...files.map((f) => f.key), ...generated.map((g) => g.key)]);
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
  const { bucket, distributionId, url, widgetOrigin } = await getOutputs();
  build();
  const generated = isWidgetHost
    ? [{ key: HOST_CONFIG, body: `window.AE_WIDGET_HOST = ${JSON.stringify({ widgetOrigin })};\n` }]
    : [];
  await sync(bucket, generated);
  await invalidate(distributionId);
  if (isWidgetHost) {
    console.log(`\n✅ Deployed. Sample host page: ${url || 'https://<distribution>'}, embedding the widget from ${widgetOrigin}\n`);
    return;
  }
  console.log(`\n✅ Deployed. ${isWidget ? 'Widget' : isAdmin ? 'Admin console' : 'App'}: ${url || `https://<distribution>`}\n`);
  // The widget is a frame on this distribution's origin, so its API calls come from here: PersonApi admits
  // it through `widgetUrl`, beside the hosts the registry declares (which may frame it, by frame-ancestors).
  const corsCtx = isWidget ? 'widgetUrl' : isAdmin ? 'adminAppUrl' : 'appUrl';
  console.log(
    '   If the API rejects requests with CORS errors, redeploy the backend with\n' +
      `   --context ${corsCtx}=${url || 'https://<DistributionUrl>'}  so its CORS allowlist\n` +
      `   includes the ${isWidget ? 'widget' : isAdmin ? 'admin console' : 'app'} origin.\n`,
  );
}

main().catch((err) => fail(err?.stack || err?.message || String(err)));
