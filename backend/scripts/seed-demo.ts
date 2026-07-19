#!/usr/bin/env npx ts-node
/**
 * Demo Seed Script
 *
 * Creates demo users, uploads context files to S3, and validates identity
 * preconditions (tier groups + the premium admin). Real conversations are produced
 * by the e2e validation (`npm run validate`) as actual user->assistant turns - never
 * faked here.
 * Run after CDK deploy with: npx ts-node scripts/seed-demo.ts
 *
 * Prerequisites:
 * - CDK stacks deployed (need User Pool ID, App Instance ARN, S3 bucket)
 * - AWS credentials configured
 *
 * Usage:
 *   npx ts-node scripts/seed-demo.ts
 *   AWS_PROFILE=myprofile npx ts-node scripts/seed-demo.ts
 */

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  AdminAddUserToGroupCommand,
  AdminConfirmSignUpCommand,
  AdminListGroupsForUserCommand,
  ListUserPoolClientsCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  ChimeSDKIdentityClient,
  CreateAppInstanceUserCommand,
} from '@aws-sdk/client-chime-sdk-identity';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  SecretsManagerClient,
  PutSecretValueCommand,
  CreateSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { seedAllProfileDefinitions } from '../lambda/src/lib/seed-profile-definitions.js';
import * as fs from 'fs';
import * as path from 'path';

const region = process.env.AWS_REGION || 'us-east-1';
const cognitoClient = new CognitoIdentityProviderClient({ region });
const s3Client = new S3Client({ region });
const cfnClient = new CloudFormationClient({ region });
const smClient = new SecretsManagerClient({ region });
const chimeIdentityClient = new ChimeSDKIdentityClient({ region });
const ssmClient = new SSMClient({ region });

// SSM root for this instance's params. MUST match the CDK's SSM_ROOT (agent-classification-common.ts:
// `/${AE_INSTANCE_NAME || 'agent-echelon'}`) — the handler reads the welcome orientation from
// `${SSM_ROOT}/assistant/{tier}/welcome-orientation`, so a case/name mismatch means it never loads.
const SSM_ROOT = `/${(process.env.AE_INSTANCE_NAME || 'agent-echelon').trim()}`;

const DEMO_PASSWORD = 'StratumDemo2026!';
// The e2e suite reads its users + pool/client from this secret (tests/e2e/helpers/test-credentials.ts).
// seed-demo now WRITES it, so a fresh deploy (new pool) never leaves it stale — which is what made
// every UI sign-in in the suite time out (wrong pool + wrong emails/passwords).
const TEST_SECRET_NAME = process.env.TEST_SECRET_NAME || 'agent-interface/test-credentials';

interface StackOutputs {
  userPoolId: string;
  bucketName: string;
  appInstanceArn: string;
  // Aurora mode only: the archive bucket whose `rag/` prefix the DocumentIngestion
  // Lambda watches. Company docs are seeded under `rag/company/{tier}/` here so
  // they are embedded and retrievable (ADR-017). Absent in Athena mode.
  archiveBucketName?: string;
}

/** A DescribeStacks on a non-existent stack throws a ValidationError whose
 *  message is "Stack with id X does not exist". That is an EXPECTED outcome when
 *  probing a stack that this deployment mode doesn't create — not an error. */
function isStackNotFound(error: unknown): boolean {
  // Match on the message (reliable) rather than the SDK error name, which
  // surfaces variously as ValidationError / CloudFormationServiceException.
  const e = error as { message?: string };
  return /does not exist/i.test(e?.message || '');
}

async function getStackOutputs(): Promise<StackOutputs> {
  const outputs: Record<string, string> = {};

  // Read a stack's outputs into `outputs`. Returns true if the stack exists.
  // A genuine not-found is returned as false WITHOUT logging (the caller decides
  // whether that stack's absence matters); only unexpected errors are surfaced.
  const collect = async (stackName: string): Promise<boolean> => {
    try {
      const response = await cfnClient.send(new DescribeStacksCommand({ StackName: stackName }));
      for (const output of response.Stacks?.[0]?.Outputs || []) {
        if (output.OutputKey && output.OutputValue) outputs[output.OutputKey] = output.OutputValue;
      }
      return true;
    } catch (error) {
      if (isStackNotFound(error)) return false; // expected for a mode's unused stack
      console.warn(`Warning: could not read outputs from ${stackName}:`, error);
      return false;
    }
  };

  // Always-present stacks (every deployment mode creates these).
  for (const s of ['AgentEchelonCognitoAuth', 'AgentEchelonS3Storage', 'AgentEchelonChimeMessaging']) {
    await collect(s);
  }

  // Analytics is deployed in exactly ONE mode — Aurora (`…AnalyticsAurora`) or
  // Athena (`…Analytics`). Probe in order and stop at the first that exists; the
  // OTHER is legitimately absent for this deployment, so we never log about it.
  let analyticsFound = false;
  for (const s of ['AgentEchelonAnalyticsAurora', 'AgentEchelonAnalytics']) {
    if (await collect(s)) { analyticsFound = true; break; }
  }
  if (!analyticsFound) {
    console.log('  (no analytics stack deployed — analytics outputs unavailable; continuing)');
  }

  const userPoolId = outputs['UserPoolId'];
  const bucketName = outputs['AttachmentsBucketName'];
  // The Chime stack exports this as `AppInstanceArnOutput`; older
  // builds used `AppInstanceArn`. Accept either so the seed survives
  // an output logical-id rename.
  const appInstanceArn = outputs['AppInstanceArn'] || outputs['AppInstanceArnOutput'];
  const archiveBucketName = outputs['ArchiveBucketName']; // Aurora mode only

  if (!userPoolId || !bucketName || !appInstanceArn) {
    console.error('Missing required stack outputs:', { userPoolId, bucketName, appInstanceArn });
    console.error('Available outputs:', outputs);
    throw new Error('Deploy the CDK stacks first (e.g. `npm run deploy`).');
  }

  return { userPoolId, bucketName, appInstanceArn, archiveBucketName };
}

async function createDemoUser(
  userPoolId: string,
  appInstanceArn: string,
  email: string,
  tier: string,
  displayName: string
): Promise<void> {
  console.log(`  Creating user: ${email} (${tier})`);

  try {
    await cognitoClient.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'custom:tier', Value: tier },
          { Name: 'custom:approved', Value: 'true' },
          { Name: 'given_name', Value: displayName.split(' ')[0] },
          { Name: 'family_name', Value: displayName.split(' ').slice(1).join(' ') },
        ],
        MessageAction: 'SUPPRESS', // Don't send welcome email
      })
    );

    // Set permanent password (skip temp password flow)
    await cognitoClient.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: email,
        Password: DEMO_PASSWORD,
        Permanent: true,
      })
    );

    console.log(`  ✓ ${email} created with tier=${tier}`);
  } catch (error: any) {
    if (error.name === 'UsernameExistsException') {
      console.log(`  - ${email} already exists, updating tier...`);
      await cognitoClient.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: userPoolId,
          Username: email,
          UserAttributes: [
            { Name: 'custom:tier', Value: tier },
            { Name: 'custom:approved', Value: 'true' },
          ],
        })
      );
    } else {
      throw error;
    }
  }

  // Assign Cognito groups — the AUTHORITATIVE tier/admin signal (custom:tier
  // alone is not enough; router/handlers gate on group membership). Without
  // this the demo users have no effective tier and can't reach gated features.
  // The premium persona doubles as the demo operator, so it also gets `admins`
  // (it drives the admin console — experiments, /battle arming — in the demos).
  const groups = tier === 'premium' ? [tier, 'admins'] : [tier];
  for (const group of groups) {
    try {
      await cognitoClient.send(
        new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: email, GroupName: group })
      );
    } catch (err: any) {
      console.warn(`  ! could not add ${email} to group ${group}: ${err?.name || err}`);
    }
  }
  console.log(`  ✓ ${email} groups: ${groups.join(', ')}`);

  // Chime AppInstanceUser — the messaging identity. Admin-created + admin-set-password users do NOT
  // fire the Cognito post-confirmation trigger that provisions this for a normal sign-up, so without
  // it the user has a valid login but no messaging identity: the app connects, fails to open a Chime
  // session, and sits on "Reconnecting…". Create it here (mirrors create-admin-user.sh). Idempotent.
  try {
    const got = await cognitoClient.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
    const sub = got.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
    if (sub) {
      await chimeIdentityClient.send(
        new CreateAppInstanceUserCommand({ AppInstanceArn: appInstanceArn, AppInstanceUserId: sub, Name: email }),
      );
      console.log(`  ✓ ${email} Chime AppInstanceUser created (${sub})`);
    }
  } catch (err: any) {
    if (err?.name === 'ConflictException') {
      console.log(`  - ${email} Chime AppInstanceUser already exists`);
    } else {
      console.warn(`  ! could not create Chime AppInstanceUser for ${email}: ${err?.name || err}`);
    }
  }
}

/**
 * Sync the e2e test-credentials secret with the users this seed just provisioned + the live pool.
 * testAdmin maps to the premium demo user (createDemoUser also puts it in the `admins` group).
 */
async function writeTestCredentialsSecret(
  userPoolId: string,
  users: { email: string; tier: string }[],
): Promise<void> {
  const clients = await cognitoClient.send(
    new ListUserPoolClientsCommand({ UserPoolId: userPoolId, MaxResults: 10 }),
  );
  const clientId = clients.UserPoolClients?.[0]?.ClientId || '';
  const emailFor = (t: string) => users.find((u) => u.tier === t)?.email || '';
  const u = (tier: string) => ({ email: emailFor(tier), password: DEMO_PASSWORD, tier });
  const payload = {
    testAdmin: u('premium'), // the premium demo user is also in the `admins` group
    basicUser: u('basic'),
    standardUser: u('standard'),
    premiumUser: u('premium'),
    cognitoUserPoolId: userPoolId,
    cognitoClientId: clientId,
  };
  const SecretString = JSON.stringify(payload);
  try {
    await smClient.send(new PutSecretValueCommand({ SecretId: TEST_SECRET_NAME, SecretString }));
  } catch (err: any) {
    if (err?.name === 'ResourceNotFoundException') {
      await smClient.send(new CreateSecretCommand({ Name: TEST_SECRET_NAME, SecretString }));
    } else {
      throw err;
    }
  }
  console.log(`  ✓ wrote ${TEST_SECRET_NAME} (pool ${userPoolId}, client ${clientId || 'NONE'})`);
}

// Per-tier welcome orientation — the config-driven copy the assistant opens a NEW conversation with
// (router-agent-handler reads it from `${SSM_ROOT}/assistant/{tier}/welcome-orientation` via the
// welcome-orientation module). Grounded in the seeded Stratum context and scoped to each tier's
// access, so a first-time user immediately knows who they are and what to try. Absent this param the
// platform shows a generic welcome — writing it here is itself a worked customization example.
const PLATFORM_NOTE =
  'I also know the AgentEchelon platform that powers this demo - ask me "how does AgentEchelon work?" or "how do I customize it?"';
const STRATUM_BLURB = 'an enterprise SaaS company (workflow automation, ~280 people, based in Austin)';
const WELCOME_ORIENTATION: Record<'basic' | 'standard' | 'premium', unknown> = {
  basic: {
    companyName: 'Stratum Technologies',
    companyBlurb: STRATUM_BLURB,
    accessBlurb: "You're exploring with public access: products, pricing, and support information.",
    examples: [
      "What's included in the StratumFlow Professional plan?",
      'Compile a one-page overview of the StratumFlow product',
      'Which integrations does Stratum support?',
    ],
    platformNote: PLATFORM_NOTE,
  },
  standard: {
    companyName: 'Stratum Technologies',
    companyBlurb: STRATUM_BLURB,
    accessBlurb: 'You have standard (internal) access: the employee directory, internal processes, and the product roadmap.',
    examples: [
      'Who leads the Platform Core engineering team?',
      'Extract the engineering roster by location as a table',
      'Compile a report on the Q3 product roadmap',
    ],
    platformNote: PLATFORM_NOTE,
  },
  premium: {
    companyName: 'Stratum Technologies',
    companyBlurb: STRATUM_BLURB,
    accessBlurb: 'You have leadership access: financials, team metrics, customer accounts, the board summary, and competitive intel.',
    examples: [
      'Compile a board-ready report on our Q2 ARR performance',
      'Extract the enterprise accounts flagged as churn risk as a table',
      "What's our current net revenue retention?",
    ],
    platformNote: PLATFORM_NOTE,
  },
};

async function writeWelcomeOrientation(): Promise<void> {
  for (const tier of ['basic', 'standard', 'premium'] as const) {
    const name = `${SSM_ROOT}/assistant/${tier}/welcome-orientation`;
    await ssmClient.send(new PutParameterCommand({
      Name: name,
      Value: JSON.stringify(WELCOME_ORIENTATION[tier]),
      Type: 'String',
      Overwrite: true,
    }));
    console.log(`  ✓ ${tier} welcome orientation → ${name}`);
  }
}

async function uploadContextFiles(bucketName: string): Promise<void> {
  const contextDir = path.join(__dirname, '..', 'demo', 'context');

  async function uploadDir(dir: string, prefix: string): Promise<number> {
    let count = 0;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        count += await uploadDir(fullPath, `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith('.json')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const key = `${prefix}${entry.name}`;

        await s3Client.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            Body: content,
            ContentType: 'application/json',
          })
        );
        count++;
      }
    }

    return count;
  }

  const count = await uploadDir(contextDir, 'context/');
  console.log(`  ✓ ${count} context files uploaded to s3://${bucketName}/context/`);

  // Per-tier company-context DIGEST (ADR-017): a small manifest of the documents
  // each tier may read (title + one-line description), so an assistant knows WHAT
  // company context exists and can fetch the right document. Cumulative (premium
  // includes standard + basic); stored at context/{tier}/_digest.json, scoped by
  // the SAME IAM prefix boundary as the documents it describes. The `_` prefix
  // keeps it out of company-context document loads.
  const manifestPath = path.join(__dirname, '..', 'demo', 'context-digest-manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      documents: Array<{ file: string; tier: 'basic' | 'standard' | 'premium'; title: string; description: string }>;
    };
    const scope: Record<'basic' | 'standard' | 'premium', Array<'basic' | 'standard' | 'premium'>> = {
      basic: ['basic'],
      standard: ['basic', 'standard'],
      premium: ['basic', 'standard', 'premium'],
    };
    for (const tier of ['basic', 'standard', 'premium'] as const) {
      const entries = manifest.documents
        .filter((d) => scope[tier].includes(d.tier))
        .map((d) => ({ title: d.title, description: d.description, tier: d.tier }));
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: `context/${tier}/_digest.json`,
          Body: JSON.stringify(entries, null, 2),
          ContentType: 'application/json',
        })
      );
    }
    console.log('  ✓ per-tier context digests → context/{basic,standard,premium}/_digest.json');
  } else {
    console.log('  (no demo/context-digest-manifest.json — skipping context digests)');
  }

  // Platform self-knowledge (about AgentEchelon itself) uploads to a SEPARATE
  // prefix so it is never bundled into a company-context load — it is retrieved
  // only via the load_platform_info tool when a user asks about the platform.
  const platformDir = path.join(__dirname, '..', 'demo', 'platform-knowledge');
  if (fs.existsSync(platformDir)) {
    const platformCount = await uploadDir(platformDir, 'platform-knowledge/');
    console.log(`  ✓ ${platformCount} platform-knowledge files uploaded to s3://${bucketName}/platform-knowledge/`);
  } else {
    console.log('  (no demo/platform-knowledge dir — run `npm run sync-knowledge` to generate it)');
  }
}

/**
 * ADR-017: embed the tier company docs for relevance retrieval. Each
 * `demo/context/{tier}/*.json` is uploaded under `rag/company/{tier}/` in the
 * archive bucket; the DocumentIngestion Lambda chunks + embeds it with
 * `source_type='company'` and the tier stamped from the path, so the router
 * retrieves the relevant company facts per turn (deterministic pre-fetch),
 * tier-scoped by the fail-closed SQL filter. Aurora mode only.
 */
async function uploadCompanyRag(archiveBucketName: string): Promise<void> {
  const contextDir = path.join(__dirname, '..', 'demo', 'context');
  let count = 0;
  for (const tierEntry of fs.readdirSync(contextDir, { withFileTypes: true })) {
    if (!tierEntry.isDirectory()) continue;
    const tierDir = path.join(contextDir, tierEntry.name);
    for (const file of fs.readdirSync(tierDir)) {
      if (!file.endsWith('.json')) continue;
      const body = fs.readFileSync(path.join(tierDir, file), 'utf-8');
      await s3Client.send(
        new PutObjectCommand({
          Bucket: archiveBucketName,
          Key: `rag/company/${tierEntry.name}/${file}`,
          Body: body,
          ContentType: 'application/json',
        })
      );
      count++;
    }
  }
  console.log(`  ✓ ${count} company docs uploaded to s3://${archiveBucketName}/rag/company/ (embedding is async)`);
}

/**
 * Belt-and-suspenders identity check. Cognito GROUP membership is the authoritative
 * tier/admin signal (router + handlers gate on it, not on custom:tier). The `admins`
 * group is also the precondition for the two-plane admin identity: on an
 * identity:'admin' request the credential exchange vends the caller's own
 * `${sub}-admin` app-instance-admin (provisioned on first vend). This asserts each
 * demo user has the right groups; the full chat-vs-admin plane vend is exercised e2e
 * by credential-exchange.spec.ts. Throws (fails the seed) on any mismatch.
 */
async function validateIdentity(
  userPoolId: string,
  users: { email: string; tier: string }[],
): Promise<void> {
  let failures = 0;
  for (const user of users) {
    const res = await cognitoClient.send(
      new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: user.email }),
    );
    const groups = (res.Groups || []).map((g) => g.GroupName || '');
    const hasTier = groups.includes(user.tier);
    const expectAdmin = user.tier === 'premium';
    const hasAdmin = groups.includes('admins');
    const ok = hasTier && (!expectAdmin || hasAdmin);
    console.log(`  ${ok ? '✓' : '✗'} ${user.email}: [${groups.join(', ')}]${expectAdmin ? ` (admin: ${hasAdmin})` : ''}`);
    if (!hasTier) { console.error(`    MISSING tier group '${user.tier}'`); failures++; }
    if (expectAdmin && !hasAdmin) { console.error(`    MISSING 'admins' group (premium is the demo admin)`); failures++; }
  }
  if (failures > 0) {
    throw new Error(`Identity validation failed: ${failures} issue(s). Check the group assignments and re-run.`);
  }
  console.log('  ✓ identity preconditions OK (tier groups present; premium holds admins)');
}

async function main(): Promise<void> {
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('  Stratum Technologies Demo Seed Script');
  console.log('═══════════════════════════════════════════');
  console.log('');

  // Step 1: Get stack outputs
  console.log('Step 1: Reading CDK stack outputs...');
  const { userPoolId, bucketName, appInstanceArn, archiveBucketName } = await getStackOutputs();
  console.log(`  ✓ User Pool: ${userPoolId}`);
  console.log(`  ✓ S3 Bucket: ${bucketName}`);
  console.log(`  ✓ App Instance: ${appInstanceArn}`);
  if (archiveBucketName) console.log(`  ✓ Archive Bucket (RAG): ${archiveBucketName}`);
  console.log('');

  // Step 2: Create demo users
  console.log('Step 2: Creating demo users...');
  const users = [
    { email: 'basic@stratum.example.com', tier: 'basic', name: 'Demo Basic' },
    { email: 'standard@stratum.example.com', tier: 'standard', name: 'Demo Standard' },
    { email: 'premium@stratum.example.com', tier: 'premium', name: 'Demo Premium' },
  ];

  for (const user of users) {
    await createDemoUser(userPoolId, appInstanceArn, user.email, user.tier, user.name);
  }
  console.log('');

  // Step 2b: keep the e2e test-credentials secret in sync with these users + this pool, so the
  // Playwright suite (which reads the secret) can actually sign in after a fresh deploy.
  console.log('Step 2b: Syncing e2e test-credentials secret...');
  await writeTestCredentialsSecret(userPoolId, users);
  console.log('');

  // Step 2c: per-tier welcome orientation (what a first-time user sees + can try).
  console.log('Step 2c: Writing per-tier welcome orientation to SSM...');
  await writeWelcomeOrientation();
  console.log('');

  // Step 2d: seed each profile's ACTIVE version (SPEC-PORTABLE-VERSIONED-PROFILES P0). Writes the
  // compiled default as version 1 of /assistant/{name}/definition and labels it `active`, so the
  // async-processor resolves its base model from the versioned definition (byte-identical to the
  // deploy default here) and the P1 lifecycle has a v1 to build on. Idempotent + fail-closed.
  console.log('Step 2d: Seeding active profile definitions to SSM...');
  for (const r of await seedAllProfileDefinitions(ssmClient, SSM_ROOT)) {
    console.log(`  ✓ ${r.profileName} definition v${r.version} labeled active`);
  }
  console.log('');

  // Step 3: Upload context files
  console.log('Step 3: Uploading context files to S3...');
  await uploadContextFiles(bucketName);
  // ADR-017: also embed company docs for retrieval. Upload them under
  // rag/company/{tier}/ in the archive bucket; the DocumentIngestion Lambda
  // chunks + embeds them (tier stamped from the path) so the router retrieves
  // the relevant company facts per turn. Aurora mode only (no archive bucket
  // otherwise); the load_company_context tool remains the fallback.
  if (archiveBucketName) {
    await uploadCompanyRag(archiveBucketName);
  }
  console.log('');

  // Step 4: Validate identity preconditions (belt-and-suspenders; the full
  // chat-vs-admin plane vend is exercised e2e by credential-exchange.spec.ts).
  console.log('Step 4: Validating identity...');
  await validateIdentity(userPoolId, users);
  console.log('');

  // Done
  console.log('═══════════════════════════════════════════');
  console.log('  Demo environment ready!');
  console.log('═══════════════════════════════════════════');
  console.log('');
  console.log('  Demo users (all password: ' + DEMO_PASSWORD + '):');
  console.log('');
  for (const user of users) {
    console.log(`    ${user.tier.padEnd(10)} ${user.email}`);
  }
  console.log('');
  console.log('  Context files uploaded to:');
  console.log(`    s3://${bucketName}/context/basic/`);
  console.log(`    s3://${bucketName}/context/standard/`);
  console.log(`    s3://${bucketName}/context/premium/`);
  console.log('');
}

main().catch((error) => {
  console.error('Seed script failed:', error);
  process.exit(1);
});
