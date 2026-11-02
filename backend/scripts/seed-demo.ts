#!/usr/bin/env npx ts-node
/**
 * Demo Seed Script
 *
 * Creates demo users, uploads context files to S3, and validates identity
 * preconditions (tier groups; no seeded user is an admin; the e2e testAdmin is). Real conversations are produced
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
 *   npx ts-node scripts/seed-demo.ts --dry-run   # reads nothing from AWS, changes nothing, prints the plan
 *
 * Each demo user is signed in through the credential exchange, and the `userArn` it answers with is
 * written into the e2e secret beside the login, as `provision-test-users.mjs` does, so the suite acts
 * as the person the exchange named. A user the exchange could not name fails the run, after the secret
 * holds the password, so a re-run converges.
 */

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  AdminAddUserToGroupCommand,
  AdminConfirmSignUpCommand,
  AdminListGroupsForUserCommand,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  SecretsManagerClient,
  PutSecretValueCommand,
  GetSecretValueCommand,
  CreateSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import { SSMClient, PutParameterCommand, GetParameterCommand } from '@aws-sdk/client-ssm';
import { seedAllProfileDefinitions } from '../lambda/src/lib/seed-profile-definitions.js';
import { writeClassificationPack } from '../lambda/src/lib/intent-pack.js';
import { putTemplate, readTemplatePointer, activateTemplate } from '../lambda/src/lib/template-store.js';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

// The one stack-name resolver every operator script uses. CommonJS, and ts-node runs this file as CommonJS.
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs') as {
  resolveStackPrefix: (env?: NodeJS.ProcessEnv) => string;
  resolveInstanceName: (env?: NodeJS.ProcessEnv) => string;
};
// Sign in, then call the credential exchange: the one path that creates a person.
const { signInAndExchange } = require('./lib/sign-in-exchange.cjs') as {
  signInAndExchange: (args: Record<string, unknown>) => Promise<string>;
};
// Which administrator the e2e secret names, and the identity preconditions: pure rules, unit-tested in
// test/provision-test-users-secret.test.ts.
type SecretUser = { email: string; password?: string; tier?: string; userArn?: string };
const { keptTestAdmin, identityPreconditionProblems } = require('./lib/test-user-secret.cjs') as {
  keptTestAdmin: (existing: Record<string, unknown>, seededEmails: string[]) => SecretUser | null;
  identityPreconditionProblems: (
    users: { email: string; tier: string; groups: string[] }[],
    admin: { email: string; groups: string[] } | null,
  ) => string[];
};
// Demo (Stratum) personas. Their own module because seed-demo runs main() at import, so nothing can
// read them from here without running the whole seeder - and they are the portable payload a profile
// export carries to another instance.
import { BASIC_PERSONA, STANDARD_PERSONA, PREMIUM_PERSONA, OPS_PERSONA } from '../demo/personas.js';
// Demo intent packs, same reason and same place as the personas above - and kept measurable, so a
// pack that outgrows its parameter fails a unit test instead of a deploy's seed step.
import { stratumIntentPack, opsIntentPack, PREMIUM_REPORT_TEMPLATES } from '../demo/intent-packs.js';
import { BASIC_ONBOARDING, STANDARD_ONBOARDING } from '../demo/onboarding.js';
import { BASIC_BOUNDARY, STANDARD_BOUNDARY, PREMIUM_BOUNDARY, OPS_BOUNDARY } from '../demo/boundaries.js';
import { OPS_WELCOME, ADVISOR_WELCOME } from '../demo/welcomes.js';

const region = process.env.AWS_REGION || 'us-east-1';
const DRY_RUN = process.argv.includes('--dry-run');
const cognitoClient = new CognitoIdentityProviderClient({ region });
const s3Client = new S3Client({ region });
const cfnClient = new CloudFormationClient({ region });
const smClient = new SecretsManagerClient({ region });
const ssmClient = new SSMClient({ region });

// SSM root for this instance's params. MUST match the CDK's SSM_ROOT (agent-classification-common.ts,
// `/<instance>`), so it comes from the same instance resolver as every operator script - the handler reads the welcome orientation from
// `${SSM_ROOT}/assistant/{tier}/welcome-orientation`, so a case/name mismatch means it never loads.
const SSM_ROOT = `/${resolveInstanceName(process.env)}`;

/**
 * The demo-user password. Overridable via the `DEMO_PASSWORD` env var (set it to a known value if you
 * want stable demo logins across re-seeds); otherwise a strong RANDOM password is generated per run, so
 * NO default credential ships in the repo. Either way it is written to the e2e credentials secret and
 * printed at the end, and every seed run RE-SETS it on existing users too (see below), so the users and
 * the secret always match — the e2e suite reads the password from that secret, never a hardcoded value.
 */
function generateDemoPassword(): string {
  // Cognito-valid by construction: upper (`D`) + lower + digit (`7`) + symbol (`!`), plus ~16 chars of
  // entropy from a URL-safe random string (stripped to alphanumerics).
  return `Demo${randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, '')}7!`;
}
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || generateDemoPassword();
// The e2e suite reads its users + pool/client from this secret (tests/e2e/helpers/test-credentials.ts).
// seed-demo now WRITES it, so a fresh deploy (new pool) never leaves it stale — which is what made
// every UI sign-in in the suite time out (wrong pool + wrong emails/passwords).
const TEST_SECRET_NAME = process.env.TEST_SECRET_NAME || 'agent-interface/test-credentials';

interface StackOutputs {
  userPoolId: string;
  bucketName: string;
  appInstanceArn: string;
  /** The app client a demo user signs in with, and the exchange that makes them a person. */
  clientId: string;
  exchangeUrl: string;
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
  const prefix = resolveStackPrefix(process.env);

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

  // The required core: every deployment creates these, the archive under one name in either mode.
  for (const s of ['Identity', 'Conversations', 'Messaging', 'PersonApi'].map((n) => `${prefix}${n}`)) {
    await collect(s);
  }
  if (!(await collect(`${prefix}Archive`))) {
    console.log('  (no archive stack deployed — analytics outputs unavailable; continuing)');
  }

  const userPoolId = outputs['UserPoolId'];
  const bucketName = outputs['AttachmentsBucketName'];
  // The Chime stack exports this as `AppInstanceArnOutput`; older
  // builds used `AppInstanceArn`. Accept either so the seed survives
  // an output logical-id rename.
  const appInstanceArn = outputs['AppInstanceArn'] || outputs['AppInstanceArnOutput'];
  const archiveBucketName = outputs['ArchiveBucketName']; // Aurora mode only
  const clientId = outputs['UserPoolClientId'];
  // The person credential exchange is a route on PersonApi, at its base URL.
  const exchangeUrl = outputs['PersonApiUrl'];

  if (!userPoolId || !bucketName || !appInstanceArn || !clientId || !exchangeUrl) {
    console.error('Missing required stack outputs:', { userPoolId, bucketName, appInstanceArn, clientId, exchangeUrl });
    console.error('Available outputs:', outputs);
    throw new Error('Deploy the CDK stacks first (e.g. `npm run deploy`).');
  }

  return { userPoolId, bucketName, appInstanceArn, clientId, exchangeUrl, archiveBucketName };
}

async function createDemoUser(
  userPoolId: string,
  login: { clientId: string; exchangeUrl: string },
  email: string,
  tier: string,
  displayName: string
): Promise<string> {
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
      console.log(`  - ${email} already exists, updating tier + password...`);
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
      // Re-set the (possibly newly-generated) password so an existing user still matches the secret
      // written below — otherwise a random-default re-seed would desync the users from the e2e creds.
      await cognitoClient.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: userPoolId,
          Username: email,
          Password: DEMO_PASSWORD,
          Permanent: true,
        })
      );
    } else {
      throw error;
    }
  }

  // Assign Cognito groups — the AUTHORITATIVE tier/admin signal (custom:tier
  // alone is not enough; router/handlers gate on group membership). Without
  // this the demo users have no effective tier and can't reach gated features.
  // Each persona gets its tier group alone: none of them is an administrator. The admin console is
  // driven by a dedicated identity (`testAdmin` from provision-test-users for the e2e, `demoAdmin` from
  // the demo cast for a presenter), and validateIdentity below refuses a persona that holds `admins`.
  const groups = [tier];
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

  // THE PERSON: signed in through the credential exchange, which mints their AppInstanceUser (an opaque
  // UUID v7 id) on the first run and resolves the same one on every run after. This script never creates
  // an AppInstanceUser itself, and never prints the password.
  try {
    const userArn = await signInAndExchange({
      cognito: cognitoClient, InitiateAuthCommand, clientId: login.clientId, exchangeUrl: login.exchangeUrl,
      email, password: DEMO_PASSWORD,
    });
    console.log(`  ✓ ${email} person ${userArn}`);
    return userArn;
  } catch (err: any) {
    console.error(`  ✗ ${email} could not sign in through the credential exchange: ${err?.message || err}`);
    return '';
  }
}

/**
 * THE DOMAIN THE DEMO USERS' ADDRESSES ARE ON. These users are also the e2e's basic, standard and
 * premium users (the secret below is re-pointed at them), so when provisioning recorded a test inbox,
 * they have to be on its domain or no notification to them can be read back: the delivery checks then
 * fail on users the seed itself moved off the inbox. TEST_EMAIL_DOMAIN wins, as it does at provisioning.
 */
async function demoEmailDomain(): Promise<string> {
  const declared = (process.env.TEST_EMAIL_DOMAIN || '').trim().toLowerCase();
  if (declared) return declared;
  try {
    const current = await smClient.send(new GetSecretValueCommand({ SecretId: TEST_SECRET_NAME }));
    const inbox = (JSON.parse(current.SecretString || '{}') as { testInbox?: { domain?: string } }).testInbox;
    if (inbox?.domain) return inbox.domain.trim().toLowerCase();
  } catch {
    // No secret yet: no inbox was recorded, so nothing has to be read back.
  }
  return 'stratum.example.com';
}

/**
 * Sync the e2e test-credentials secret with the users this seed just provisioned + the live pool.
 * Returns the administrator the secret names after the write, or null when it names none.
 */
async function writeTestCredentialsSecret(
  userPoolId: string,
  clientId: string,
  users: { email: string; tier: string; userArn: string }[],
): Promise<SecretUser | null> {
  // The chat app client the users just signed in with (Identity `UserPoolClientId`), not the first
  // client the pool lists: a pool publishes the admin client too, and tokens for the wrong audience fail
  // at the API.
  const u = (tier: string) => {
    const user = users.find((x) => x.tier === tier);
    return { email: user?.email || '', password: DEMO_PASSWORD, tier, ...(user?.userArn ? { userArn: user.userArn } : {}) };
  };

  // MERGE onto whatever is already there, rather than replacing it.
  //
  // This built the payload from scratch and PUT it, so every key the seeder does not own was
  // destroyed on each run. That is not hypothetical: a suite needing a second premium user (battle's
  // per-user picks) and one needing a never-onboarded user (the intake) both provision their own
  // entries, and both were silently wiped by the next `seed` phase. The tests then SKIPPED with "no
  // provisioned <user>", which reads as a deployment that was never set up rather than as state the
  // run itself had just deleted - and it only happened inside a full sweep, because running those
  // suites alone never triggers a seed.
  //
  // The seeder owns the three demo users and the pool/client ids. Anything else in the secret belongs
  // to whoever put it there, `testAdmin` included: provision-test-users provisions it as a dedicated
  // account in `admins`. An entry naming one of the seed's own users is dropped, because none of them
  // is an administrator, and validateIdentity then says how to provision the real one.
  let existing: Record<string, unknown> = {};
  try {
    const current = await smClient.send(new GetSecretValueCommand({ SecretId: TEST_SECRET_NAME }));
    existing = JSON.parse(current.SecretString || '{}') as Record<string, unknown>;
  } catch {
    // No secret yet, or unreadable — the create path below writes a fresh one.
  }

  const testAdmin = keptTestAdmin(existing, users.map((x) => x.email));
  const payload: Record<string, unknown> = {
    ...existing,
    basicUser: u('basic'),
    standardUser: u('standard'),
    premiumUser: u('premium'),
    cognitoUserPoolId: userPoolId,
    cognitoClientId: clientId,
  };
  if (testAdmin) payload.testAdmin = testAdmin;
  else delete payload.testAdmin;
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
  console.log(testAdmin
    ? `  ✓ testAdmin kept: ${testAdmin.email}`
    : `  ! testAdmin: none (the secret named no dedicated administrator); run \`npm run provision-test-users -- --only testAdmin\``);
  return testAdmin;
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
    // WHAT IS REACHABLE, NOT WHO IS ASKING. A classification is a set of grants (ADR-046); "leadership
    // access" named an audience and read as though premium were an org level.
    accessBlurb: 'You have full internal access: financials, team metrics, customer accounts, the board summary, and competitive intel.',
    examples: [
      // This example used to grade the answer in advance, in the one place a person reads before they
      // have seen any output: the suggested prompts. The assistant writes a structured, grounded
      // report; whether it clears a given audience's bar is the reader's call. Describe the ask.
      'Compile a report on our Q2 ARR performance for the leadership team',
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

// Standard-tier onboarding intake — the opt-in first-conversation questionnaire the router runs
// when a NEW conversation opens (router-agent-handler reads it from
// `${SSM_ROOT}/assistant/standard/onboarding-intake` via ONBOARDING_INTAKE_PARAM; the schema shape is
// lib/onboarding-intake.ts IntakeConfig). Onboarding is OFF by default (absent param ⇒ disabled), so
// only the standard classification is seeded here — leaving basic/premium absent keeps their plain
// welcome flow. This is the schema the `onboarding-intake.spec.ts` e2e is written against; seeding it
// makes that test reproducible on a fresh deploy instead of depending on a hand-written SSM param.
const ONBOARDING_INTAKE_STANDARD = {
  greeting: 'Welcome! Let me collect a couple of details before we begin.',
  fields: [
    { key: 'company', prompt: 'What company are you with?' },
    { key: 'role', prompt: 'And what is your role there?' },
  ],
  completion: "Great, you're all set. How can I help?",
};

async function writeOnboardingIntake(): Promise<void> {
  const name = `${SSM_ROOT}/assistant/standard/onboarding-intake`;
  await ssmClient.send(new PutParameterCommand({
    Name: name,
    Value: JSON.stringify(ONBOARDING_INTAKE_STANDARD),
    Type: 'String',
    Overwrite: true,
  }));
  console.log(`  ✓ standard onboarding intake → ${name}`);
}


/**
 * The SSM Standard-tier value limit every seeded parameter is written under.
 *
 * Not an incidental AWS number: the per-deployment packs are DESIGNED to live inside it
 * (`intent-pack.ts` keeps keyword lists short for exactly this reason), and profile definitions are
 * written under the same cap (`profile-lifecycle.ts`). Named here so the seeder can fail with the
 * field and the measurement rather than an opaque AWS error.
 */
const SSM_STANDARD_TIER_MAX = 4096;

/** Write an SSM param only if it does not already exist (protects an operator's `-c` value / prior seed). */
async function putParamIfAbsent(name: string, value: string, label: string): Promise<void> {
  // SIZE IS CHECKED BEFORE THE WRITE, because the AWS failure is unusable on its own: a bare
  // `ValidationException: Standard tier parameters support a maximum parameter value of 4096
  // characters` names neither the parameter nor the field, and it lands MID-SEED. Earlier parameters
  // are already written, so the retry reports them as "already set - leaving it" and dies on the same
  // one, which reads as idempotent progress while the deployment is left incomplete. This is the same
  // guard `profile-lifecycle.ts` provides for definition writes; this write previously had none.
  if (value.length > SSM_STANDARD_TIER_MAX) {
    throw new Error(
      `${label} is ${value.length} characters; the SSM Standard tier caps a value at ${SSM_STANDARD_TIER_MAX} `
      + `(${value.length - SSM_STANDARD_TIER_MAX} over). Parameter: ${name}. `
      + `Shorten the content rather than raising the tier - the definition write in profile-lifecycle.ts `
      + `is Tier: 'Standard' regardless, so an oversize body fails again at profile activation.`,
    );
  }
  try {
    await ssmClient.send(new GetParameterCommand({ Name: name }));
    console.log(`  - ${label} already set (${name}) - leaving it`);
  } catch (err: any) {
    if (err?.name === 'ParameterNotFound') {
      await ssmClient.send(new PutParameterCommand({ Name: name, Value: value, Type: 'String', Overwrite: false }));
      console.log(`  ✓ ${label} → ${name} (${value.length}/${SSM_STANDARD_TIER_MAX})`);
    } else {
      throw err;
    }
  }
}

/**
 * Seed the standard-tier assistant PERSONA (SSM) so the demo is self-grounding without the operator
 * authoring one. WRITE-IF-ABSENT: if the parameter already exists we leave it untouched, so an operator's
 * explicit `-c assistantSystemPrompt` (which the CDK then owns as a RETAIN resource) is never clobbered.
 * In the default (no-flag) demo the CDK creates NO persona resource, so seeding here is the source of
 * truth. If an operator later wants a CDK-managed persona over a seeded one, that is the documented
 * `-c assistantParamWriter` migration path. (The intent pack is seeded separately, per tier, below.)
 */
async function writeStandardAssistantConfig(): Promise<void> {
  await putParamIfAbsent(`${SSM_ROOT}/assistant/standard/assistant-system-prompt`, STANDARD_PERSONA, 'standard persona');
}

/**
 * Seed the per-tier Stratum intent pack (S3 body plus SSM pointer), write-if-absent. Each classification stack that carries
 * `intentPackParam: true` (basic, standard, premium) reads its own
 * `${SSM_ROOT}/assistant/{tier}/assistant-intent-pack`; absent ⇒ the platform DEFAULT pack. Seeding the
 * Stratum pack here makes the demo's admin console show domain intents (financial_metric, account_status,
 * directory_lookup, …) instead of an all-`general` breakdown. Write-if-absent, so an operator's
 * `-c assistantIntentPack` is never clobbered. NOTE: premium only reads this once its classification
 * stack is deployed with `intentPackParam: true` (its topology in lib/config/profiles.ts) — a redeploy, not just
 * a re-seed, is required for premium to pick up its pack.
 */
/**
 * The templates premium's report workflow offers a choice of (`PREMIUM_REPORT_TEMPLATES`, declared on the
 * workflow in its pack), stored for premium and activated where no version is active yet, so a re-seed
 * never moves a version an operator activated. The platform's own `report` template is the deploy's to
 * write, for every classification whose workflows declare it.
 */
async function writeExampleTemplates(bucketName: string): Promise<void> {
  const deps = { s3: s3Client, ssm: ssmClient, bucket: bucketName, ssmRoot: SSM_ROOT };
  for (const name of PREMIUM_REPORT_TEMPLATES) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'demo', 'templates', `${name}.md`), 'utf8');
    const put = await putTemplate('premium', source, deps);
    const pointer = await readTemplatePointer('premium', put.name, deps);
    if (!pointer) await activateTemplate('premium', put.name, put.contentHash, deps);
    console.log(`  ✓ premium template ${put.name} ${put.contentHash.slice(0, 12)}`
      + (pointer ? ` stored; ${pointer.active.slice(0, 12)} stays active` : ' stored and active'));
  }
}

async function writeStratumIntentPacks(bucketName: string): Promise<void> {
  for (const tier of ['basic', 'standard', 'premium'] as const) {
    // The body to `classification-packs/{tier}/...` in the attachments bucket, then the pointer to the
    // parameter (`writeClassificationPack`), so the pack's size is not the parameter's value limit.
    const wrote = await writeClassificationPack(
      ssmClient, SSM_ROOT, tier, JSON.stringify(stratumIntentPack(tier)), { s3: s3Client, bucket: bucketName }, { ifAbsent: true },
    );
    console.log(wrote ? `  ✓ ${tier} intent pack → s3://${bucketName}/classification-packs/${tier}/` : `  - ${tier} intent pack already set - leaving it`);
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

  // Per-classification company-context DIGEST (ADR-017): a small manifest of the documents
  // each classification may read (title + one-line description), so an assistant knows WHAT
  // company context exists and can fetch the right document. Cumulative (premium
  // includes standard + basic); stored at context/{classification}/_digest.json, scoped by
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
        // `file` lets the assistant name the exact document(s) to load (GUIDE-ASSISTANT-CONTEXT selective load).
        .map((d) => ({ file: d.file, title: d.title, description: d.description, classification: d.tier }));
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
 * ADR-017: embed the per-classification company docs for relevance retrieval. Each
 * `demo/context/{classification}/*.json` is uploaded under `rag/company/{classification}/` in the
 * archive bucket; the DocumentIngestion Lambda chunks + embeds it with
 * `source_type='company'` and the classification stamped from the path, so the router
 * retrieves the relevant company facts per turn (deterministic pre-fetch),
 * classification-scoped by the fail-closed SQL filter. Aurora mode only.
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
 * `<personId>-admin` app-instance-admin (provisioned on first vend). This asserts each
 * demo user holds its tier group and NOT `admins`, and that the administrator the e2e
 * secret names (`testAdmin`, a dedicated account) holds `admins`; the full chat-vs-admin
 * plane vend is exercised e2e by credential-exchange.spec.ts. Throws (fails the seed)
 * on any mismatch.
 */
async function validateIdentity(
  userPoolId: string,
  users: { email: string; tier: string }[],
  admin: SecretUser | null,
): Promise<void> {
  const groupsOf = async (email: string): Promise<string[]> => {
    try {
      const res = await cognitoClient.send(new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: email }));
      return (res.Groups || []).map((g) => g.GroupName || '');
    } catch (err: any) {
      if (err?.name === 'UserNotFoundException') return [];
      throw err;
    }
  };
  const seeded: { email: string; tier: string; groups: string[] }[] = [];
  for (const user of users) {
    const groups = await groupsOf(user.email);
    console.log(`  ${user.email}: [${groups.join(', ')}]`);
    seeded.push({ email: user.email, tier: user.tier, groups });
  }
  let adminGroups: { email: string; groups: string[] } | null = null;
  if (admin?.email) {
    adminGroups = { email: admin.email, groups: await groupsOf(admin.email) };
    console.log(`  ${admin.email} (testAdmin): [${adminGroups.groups.join(', ')}]`);
  }
  const problems = identityPreconditionProblems(seeded, adminGroups);
  for (const p of problems) console.error(`  ✗ ${p}`);
  if (problems.length > 0) {
    throw new Error(`Identity validation failed: ${problems.length} issue(s). Check the group assignments and re-run.`);
  }
  console.log('  ✓ identity preconditions OK (tier groups present; no seeded identity holds admins; testAdmin does)');
}

async function main(): Promise<void> {
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('  Stratum Technologies Demo Seed Script');
  console.log('═══════════════════════════════════════════');
  console.log('');

  // Step 1: Get stack outputs
  console.log('Step 1: Reading CDK stack outputs...');
  const { userPoolId, bucketName, appInstanceArn, clientId, exchangeUrl, archiveBucketName } = await getStackOutputs();
  console.log(`  ✓ User Pool: ${userPoolId}`);
  console.log(`  ✓ S3 Bucket: ${bucketName}`);
  console.log(`  ✓ App Instance: ${appInstanceArn}`);
  if (archiveBucketName) console.log(`  ✓ Archive Bucket (RAG): ${archiveBucketName}`);
  console.log('');

  // Step 2: Create demo users
  console.log('Step 2: Creating demo users...');
  const domain = await demoEmailDomain();
  console.log(`  addresses on ${domain}`);
  const users = [
    { email: `basic@${domain}`, tier: 'basic', name: 'Demo Basic' },
    { email: `standard@${domain}`, tier: 'standard', name: 'Demo Standard' },
    { email: `premium@${domain}`, tier: 'premium', name: 'Demo Premium' },
  ];

  const people: { email: string; tier: string; userArn: string }[] = [];
  for (const user of users) {
    people.push({ ...user, userArn: await createDemoUser(userPoolId, { clientId, exchangeUrl }, user.email, user.tier, user.name) });
  }
  console.log('');

  // Step 2b: keep the e2e test-credentials secret in sync with these users + this pool, so the
  // Playwright suite (which reads the secret) can actually sign in after a fresh deploy. Written before
  // the person check below, so the secret always holds the password the users now have.
  console.log('Step 2b: Syncing e2e test-credentials secret...');
  const testAdmin = await writeTestCredentialsSecret(userPoolId, clientId, people);
  const unnamed = people.filter((p) => !p.userArn).map((p) => p.email);
  if (unnamed.length) {
    throw new Error(`the credential exchange named no person for ${unnamed.join(', ')}; the e2e acts as the person the exchange names, so fix the exchange and re-run`);
  }
  console.log('');

  // Step 2c: per-tier welcome orientation (what a first-time user sees + can try).
  console.log('Step 2c: Writing per-tier welcome orientation to SSM...');
  await writeWelcomeOrientation();
  console.log('');

  // Step 2c-i: standard-tier onboarding intake schema (opt-in first-conversation questionnaire).
  console.log('Step 2c-i: Writing standard onboarding intake schema to SSM...');
  await writeOnboardingIntake();
  console.log('');

  // Step 2c-ii: standard-tier persona, so the demo is self-grounding without an operator
  // -c assistantSystemPrompt (standard is the only per-deployment-persona tier; absent it the assistant
  // is terse/off-brand — the standard-tier validation gap). Write-if-absent, never clobbers an operator's.
  console.log('Step 2c-ii: Writing standard assistant persona to SSM...');
  await writeStandardAssistantConfig();
  console.log('');

  // Step 2c-iii: per-tier Stratum DOMAIN intent packs, so the admin console shows domain intents
  // (financial_metric, account_status, directory_lookup, product_info, …) instead of an all-`general`
  // breakdown. Inline intents deliver in one turn (PLACEHOLDER_UPDATE) per ADR-018; the DEFAULT task
  // intents are kept so multi-step flows are unchanged. Write-if-absent. (Premium needs its stack
  // deployed with intentPackParam: true to read its pack — a redeploy, not just a re-seed.)
  // NOT WRITTEN ANY MORE, and the omission is the point. The pack now rides each profile's VERSION
  // (step 2d below), which is the source of truth for the taxonomy. Writing the per-classification
  // parameter as well would be two answers to one question (tenet D7) that drift the moment either is
  // edited, and the parameter is the one an operator cannot version, roll back or export.
  //
  // It also does not FIT: a materialized premium pack is 5208 characters against that parameter's 4096,
  // because a profile now declares its whole taxonomy rather than inheriting the platform set. On the
  // version that is not a constraint - the pack is offloaded to S3 as a body (`intentPackRef`).
  //
  // The parameter remains a supported seam, read when a version carries no pack of its own, and it is the
  // only place a classification's MACHINES live: a version does not read `machines`. The one demo
  // classification that redeclares a workflow is premium (its report's choice of templates), so step
  // 2c-iv writes premium's pack there. `writeStratumIntentPacks` is kept and still exercised by the
  // budget test.
  console.log('');

  // Step 2c-iv: the document templates premium's report workflow offers (SPEC-DOCUMENT-TEMPLATES FR3a),
  // stored for premium and made active when no version is. Premium's pack redeclares `report_generation`
  // with `templates` on its delivering states, so the person chooses between a quarterly account review
  // and a one-page executive summary; every other classification's reports follow the platform's
  // `report` template, which the deploy writes (HOW-TO-ADD-OR-MANAGE-A-PROFILE, "Document templates").
  console.log('Step 2c-iv: Storing the premium report templates...');
  await writeExampleTemplates(bucketName);
  // The workflow that offers them, on the parameter a classification's machines are read from. The same
  // pack the version carries, so the two cannot disagree about the taxonomy. Write-if-absent, so an
  // operator's `-c assistantIntentPack` is never clobbered.
  const wrotePremiumPack = await writeClassificationPack(
    ssmClient, SSM_ROOT, 'premium', JSON.stringify(stratumIntentPack('premium')), { s3: s3Client, bucket: bucketName }, { ifAbsent: true },
  );
  console.log(wrotePremiumPack
    ? `  ✓ premium intent pack (its report workflow's template choice) → s3://${bucketName}/classification-packs/premium/`
    : '  - premium intent pack already set - leaving it');
  console.log('');

  // Step 2d: seed each profile's ACTIVE version (SPEC-PORTABLE-PROFILES P0). Writes the
  // compiled default as version 1 of /assistant/{name}/definition and labels it `active`, so the
  // async-processor resolves its base model from the versioned definition (byte-identical to the
  // deploy default here) and the P1 lifecycle has a v1 to build on. Idempotent + fail-closed.
  // The standard persona is folded INTO the definition, not left to `assistant-system-prompt` alone.
  // Persona truth lives in the profile: that is what a manifest export carries and what the async
  // processor prefers, so a profile imported into another instance arrives as the Stratum assistant
  // rather than the generic default. The parameter is still written (below) as the deployment seam
  // for a deploy that runs no versioned profile - it is the fallback now, not the source of truth.
  console.log('Step 2d: Seeding active profile definitions to SSM...');
  // The attachments bucket doubles as the profile BODY store, so each persona is written to
  // `profiles/{name}/{configId}/persona` and the parameter carries a pointer. Resolved from the stack
  // outputs rather than an env var: this runs as an operator script, not in a Lambda, so there is no
  // PROFILE_BODY_BUCKET/CONTEXT_BUCKET in its environment to fall back to.
  // The intent pack is folded in the same way, and it matters more here than the persona does: the
  // `assistant-intent-pack` parameter above is write-if-absent and its CDK writer only exists under
  // `-c assistantIntentPack`, so on a deployment that passes neither, editing `stratumIntentPack()` in
  // code can never reach SSM. On the version it can, and it converges within the profile cache TTL.
  for (const r of await seedAllProfileDefinitions(ssmClient, SSM_ROOT, {
    concierge: BASIC_PERSONA,
    analyst: STANDARD_PERSONA,
    advisor: PREMIUM_PERSONA,
    // THE `ops` ROLE'S ASSISTANT, keyed by profile name like every other entry here - which is the only
    // way it CAN be keyed: it is a second assistant inside `premium`, so there is no classification to
    // hang it on. Without these two entries it had an identity, a Lex bot and an assignment record, and answered in
    // premium's built-in tier voice with premium's taxonomy (see demo/personas.ts OPS_PERSONA).
    'ops-premium': OPS_PERSONA,
  }, { bucket: bucketName }, {
    concierge: stratumIntentPack('basic'),
    analyst: stratumIntentPack('standard'),
    advisor: stratumIntentPack('premium'),
    'ops-premium': opsIntentPack(),
  }, {
    // The assistant's opening differs by what the assistant can reach - see demo/onboarding.ts. Seeded
    // onto the version for the same reason the pack is: the per-deployment parameter is one config for
    // every assistant, so it could only ever make them introduce themselves identically.
    concierge: BASIC_ONBOARDING,
    analyst: STANDARD_ONBOARDING,
    // Advisor carries no intake: its welcome opens with no onboarding question.
    // PREMIUM_ONBOARDING stays authored in demo/onboarding.ts for when premium onboarding returns.
  }, {
    // What each assistant does NOT reach. Authored rather than derived: a pack says what an assistant
    // recognizes and nothing about what it does not, so absence has no phrase to assemble from.
    concierge: BASIC_BOUNDARY,
    analyst: STANDARD_BOUNDARY,
    advisor: PREMIUM_BOUNDARY,
    // The ops role's assistant, which was missing from this map and from the onboarding one above while
    // it had a persona and a pack - so it could say what it recognizes and not what it cannot reach.
    'ops-premium': OPS_BOUNDARY,
  }, {
    // WELCOME WORKFLOWS (W1), and only for the assistants that need their own.
    //
    // The three primaries' ordinary openings are their classification's parameter, seeded above; a copy here
    // would be two sources for one sentence. 'ops-premium' is the case this map exists for: the premium
    // parameter is the ADVISOR's copy, so before this the ops assistant opened by introducing itself as
    // the Stratum leadership assistant and offering to compile ARR reports, one second after the primary
    // had said the same words. show-ops-rollout.mjs reports the cause in its own output.
    // The premium PRIMARY gets welcomes for the ops rooms ONLY - none for an ordinary room, so its
    // normal opening stays the classification parameter that was written for it.
    advisor: ADVISOR_WELCOME,
    'ops-premium': OPS_WELCOME,
  })) {
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
    // The PLATFORM corpus (the repo's own docs, for "how does AgentEchelon work?") is deliberately
    // NOT uploaded here: it is generated from the docs tree, which a deployed instance does not have,
    // so it is its own deploy-time step. Say so at the point the operator is already looking at RAG,
    // because the failure mode is silent - without it the assistant still answers platform questions,
    // from titles and one-paragraph summaries, which reads as vague rather than as a missing step.
    console.log('  NOTE: platform self-knowledge (deep Q&A about AgentEchelon itself) is a SEPARATE');
    console.log('        deploy-time step and is not seeded here. Run it now, and after any doc change:');
    console.log('          npm run sync-knowledge:rag');
    console.log('        Without it, the assistant answers platform questions from the curated');
    console.log('        summaries only (the load_platform_info tool), not the full documentation.');
  }
  console.log('');

  // Step 4: Validate identity preconditions (belt-and-suspenders; the full
  // chat-vs-admin plane vend is exercised e2e by credential-exchange.spec.ts).
  console.log('Step 4: Validating identity...');
  await validateIdentity(userPoolId, users, testAdmin);
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

/** What a run would do, from the environment alone. No AWS call is made. */
function printDryRun(): void {
  const prefix = resolveStackPrefix(process.env);
  console.log('seed-demo --dry-run (no AWS call is made, nothing is changed)');
  console.log(`  instance        ${resolveInstanceName(process.env)} (SSM root ${SSM_ROOT})`);
  console.log(`  reads outputs   ${prefix}Identity, ${prefix}Conversations, ${prefix}Messaging and ${prefix}Archive`);
  console.log('  users           basic@, standard@, premium@ the demo domain (each in its tier group only, none in admins), each signed in through the credential exchange');
  console.log(`  writes secret   ${TEST_SECRET_NAME}: basicUser, standardUser, premiumUser with each userArn, merged; testAdmin kept from provision-test-users`);
  console.log(`  writes SSM      welcome orientation, onboarding intake, the standard persona (if absent), each profile's active definition`);
  console.log('  uploads         classification context files, and the company RAG corpus in Aurora mode');
}

if (DRY_RUN) {
  printDryRun();
} else {
  main().catch((error) => {
    console.error('Seed script failed:', error);
    process.exit(1);
  });
}
