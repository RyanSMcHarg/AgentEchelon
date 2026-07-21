/**
 * Generate frontend/.env from the deployed CDK stack outputs.
 *
 * The Vite build bakes these values in, and they only exist AFTER the backend
 * stacks deploy — so this reads them from the live CloudFormation outputs and
 * writes frontend/.env, replacing the error-prone hand-copy step. Works for
 * both Athena and Aurora analytics modes (whichever analytics stack is present
 * provides AnalyticsApiUrl / ClientEventsApiUrl).
 *
 * Usage:
 *   node scripts/gen-frontend-env.mjs
 *   STACK_PREFIX=AgentEchelon AWS_REGION=us-east-1 node scripts/gen-frontend-env.mjs
 *
 * Env:
 *   STACK_PREFIX  stack name prefix (default "AgentEchelon")
 *   AWS_REGION    region (default "us-east-1")
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const REGION = process.env.AWS_REGION || 'us-east-1';
const PREFIX = process.env.STACK_PREFIX || 'AgentEchelon';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Post workspace-split (SPEC-SEPARATE-ADMIN-APP.md), the chat and admin apps are
// separate packages, each with its OWN .env that its own Vite build loads. The
// admin-only endpoint URLs go ONLY into the admin package's .env and never reach
// the public chat bundle.
const CHAT_ENV_PATH = path.resolve(__dirname, '../../frontend/packages/chat/.env');
const ADMIN_ENV_PATH = path.resolve(__dirname, '../../frontend/packages/admin/.env');

// CloudFormation OutputKey -> frontend Vite variable. Keys are unique across the
// AgentEchelon stacks, so a single merged map is unambiguous.
const OUTPUT_TO_VITE = {
  // Analytics mode (athena|aurora). Checked FIRST by detectAnalyticsMode() so the app
  // uses the right endpoints without a probe (the probe can cache 'athena' if it runs
  // pre-login). Present as the AnalyticsMode output on the analytics stack.
  AnalyticsMode: 'VITE_ANALYTICS_MODE',
  UserPoolId: 'VITE_USER_POOL_ID',
  UserPoolClientId: 'VITE_CLIENT_ID',
  // P3: dedicated admin app-client (present only when the admin app is deployed
  // without `-c adminAppClient=shared`). Admin package .env only; absent ⇒ reuse.
  AdminUserPoolClientId: 'VITE_ADMIN_CLIENT_ID',
  IdentityPoolId: 'VITE_IDENTITY_POOL_ID',
  CredentialExchangeApiUrl: 'VITE_CREDENTIAL_EXCHANGE_API_URL',
  AppInstanceArnOutput: 'VITE_APP_INSTANCE_ARN',
  CreateConversationApiUrl: 'VITE_CREATE_CONVERSATION_API_URL',
  AddAgentApiUrl: 'VITE_ADD_BOT_API_URL',
  ShareConversationApiUrl: 'VITE_SHARE_CONVERSATION_API_URL',
  PresignedUrlApiUrl: 'VITE_PRESIGNED_URL_API_URL',
  AnalyticsApiUrl: 'VITE_ANALYTICS_API_URL',
  // A14: whether the backend enforces AWS_IAM on the admin read plane. When 'true' the
  // admin app SigV4-signs its requests; derived from the deployed backend so the two
  // flags can't drift (an unsigned admin app against an IAM-enforced backend 403s).
  AdminIamEnforcement: 'VITE_ADMIN_IAM_ENFORCEMENT',
  // Gates the DeploymentStatusBanner probe: only poll GET /deployment/state when sleep
  // mode is actually deployed. Absent (Athena mode) or 'false' ⇒ the banner never probes.
  SleepModeEnabled: 'VITE_SLEEP_MODE_ENABLED',
  ClientEventsApiUrl: 'VITE_CLIENT_EVENTS_API_URL',
  UserManagementApiUrl: 'VITE_USER_MANAGEMENT_API_URL',
  AdminConversationApiUrl: 'VITE_ADMIN_CONVERSATIONS_API_URL',
  UserFeedbackApiUrl: 'VITE_USER_FEEDBACK_API_URL',
  ChannelBattleApiUrl: 'VITE_CHANNEL_BATTLE_API_URL',
  BattleOutcomeApiUrl: 'VITE_BATTLE_OUTCOME_API_URL',
  ExperimentsApiUrl: 'VITE_EXPERIMENTS_API_URL',
  // SPEC-PORTABLE-VERSIONED-PROFILES: the manage-profiles lifecycle API (list/version/activate/
  // rollback/import/export). Admin-only. Co-hosted with the experiments API.
  ManageProfilesApiUrl: 'VITE_MANAGE_PROFILES_API_URL',
  // The separate admin console's URL (AgentEchelonAdminFrontend, prefix 'Admin').
  // The CHAT app reads it to show admins a link OUT to the console (a URL only, no
  // operator code). Absent until the admin frontend deploys (two-phase bootstrap);
  // a deployer can also override VITE_ADMIN_APP_URL to point at their own console.
  AdminDistributionUrl: 'VITE_ADMIN_APP_URL',
};

// Admin-ONLY Vite vars: the standalone admin console consumes these; the chat
// app does not (after the console split, SPEC-SEPARATE-ADMIN-APP.md). They are
// written to frontend/.env.admin (loaded only by `vite build --mode admin`) and
// deliberately kept OUT of frontend/.env so the public chat bundle carries no
// admin endpoint URLs. Surfaces the chat client also consumes (feedback,
// experiments, credential-exchange) are NOT here — they stay in .env.
const ADMIN_ONLY = new Set([
  'VITE_ANALYTICS_API_URL',
  'VITE_ANALYTICS_MODE',
  'VITE_USER_MANAGEMENT_API_URL',
  'VITE_ADMIN_CONVERSATIONS_API_URL',
  'VITE_MANAGE_PROFILES_API_URL',
  // P3 (optional): a dedicated admin Cognito app-client. Absent ⇒ the admin app
  // falls back to VITE_CLIENT_ID (reuse of the shared client). Admin package only.
  'VITE_ADMIN_CLIENT_ID',
  // A14: only the admin console signs requests; the chat app never does.
  'VITE_ADMIN_IAM_ENFORCEMENT',
]);

// Chat-ONLY Vite vars: the chat SPA consumes these; the admin console does not.
// Kept OUT of the admin package's .env (it never calls chat messaging / battle /
// create-conversation). Everything that is neither ADMIN_ONLY nor CHAT_ONLY is
// SHARED and written to BOTH packages' .env (auth pool/client, credential-exchange,
// app-instance ARN used by admin's chime actions, feedback, experiments).
const CHAT_ONLY = new Set([
  'VITE_CREATE_CONVERSATION_API_URL',
  'VITE_ADD_BOT_API_URL',
  'VITE_SHARE_CONVERSATION_API_URL',
  'VITE_PRESIGNED_URL_API_URL',
  // The admin-console LINK-OUT target: chat-only (the admin app does not link to
  // itself). A URL string, not an admin endpoint, so it is safe in the chat .env.
  'VITE_ADMIN_APP_URL',
  'VITE_SLEEP_MODE_ENABLED',
  'VITE_CLIENT_EVENTS_API_URL',
  'VITE_CHANNEL_BATTLE_API_URL',
  'VITE_BATTLE_OUTCOME_API_URL',
]);

// VITE vars that are optional: absent output ⇒ omit the line (the app degrades,
// e.g. client-events tracking no-ops in Aurora mode; /battle vars off when battle disabled).
const OPTIONAL = new Set([
  'VITE_ANALYTICS_MODE',
  'VITE_SLEEP_MODE_ENABLED',
  'VITE_CLIENT_EVENTS_API_URL',
  'VITE_CHANNEL_BATTLE_API_URL',
  'VITE_BATTLE_OUTCOME_API_URL',
  'VITE_EXPERIMENTS_API_URL',
  'VITE_ADMIN_CLIENT_ID',
  // Absent on stacks deployed before this output existed ⇒ omit (admin app treats
  // a missing flag as 'not enforced', matching the pre-A14 default).
  'VITE_ADMIN_IAM_ENFORCEMENT',
]);

async function collectOutputs() {
  const cfn = new CloudFormationClient({ region: REGION });
  const merged = {};
  let token;
  do {
    const resp = await cfn.send(new DescribeStacksCommand({ NextToken: token }));
    for (const stack of resp.Stacks || []) {
      if (!stack.StackName?.startsWith(PREFIX)) continue;
      for (const o of stack.Outputs || []) {
        if (o.OutputKey && o.OutputValue) merged[o.OutputKey] = o.OutputValue;
      }
    }
    token = resp.NextToken;
  } while (token);
  return merged;
}

async function main() {
  console.log(`Generating frontend/.env from ${PREFIX}* stack outputs (${REGION})...`);
  const outputs = await collectOutputs();
  if (Object.keys(outputs).length === 0) {
    throw new Error(
      `No outputs found for stacks prefixed "${PREFIX}" in ${REGION}. ` +
        'Deploy the backend first (cdk deploy --all), or set STACK_PREFIX/AWS_REGION.',
    );
  }

  // One .env per package. Each app's Vite loads only its own package's .env, so
  // the chat bundle can only carry vars written to the chat file. SHARED vars
  // (neither ADMIN_ONLY nor CHAT_ONLY) go to BOTH.
  const chatLines = [
    '# Generated by scripts/gen-frontend-env.mjs from deployed CDK outputs.',
    '# Do not edit by hand — re-run the script after a redeploy.',
    '# Chat SPA (@ae/chat) package env. No admin-only endpoint URLs.',
    `VITE_AWS_REGION=${REGION}`,
  ];
  const adminLines = [
    '# Generated by scripts/gen-frontend-env.mjs from deployed CDK outputs.',
    '# Admin console (@ae/admin) package env. Shared auth + admin-only endpoints.',
    `VITE_AWS_REGION=${REGION}`,
  ];
  const missingRequired = [];
  for (const [outputKey, viteVar] of Object.entries(OUTPUT_TO_VITE)) {
    // chat file gets everything except admin-only; admin file everything except chat-only.
    const targets = [];
    if (!ADMIN_ONLY.has(viteVar)) targets.push(chatLines);
    if (!CHAT_ONLY.has(viteVar)) targets.push(adminLines);
    const value = outputs[outputKey];
    for (const target of targets) {
      if (value) {
        target.push(`${viteVar}=${value}`);
      } else if (OPTIONAL.has(viteVar)) {
        target.push(`# ${viteVar} — not deployed (optional); feature degrades gracefully`);
      }
    }
    if (!value && !OPTIONAL.has(viteVar)) {
      missingRequired.push(`${viteVar} (output ${outputKey})`);
    }
  }

  if (missingRequired.length) {
    throw new Error(
      `Missing required outputs — is the backend fully deployed?\n  - ${missingRequired.join('\n  - ')}`,
    );
  }

  await writeFile(CHAT_ENV_PATH, chatLines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${CHAT_ENV_PATH} (${chatLines.filter((l) => l.startsWith('VITE_')).length} vars).`);
  await writeFile(ADMIN_ENV_PATH, adminLines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${ADMIN_ENV_PATH} (${adminLines.filter((l) => l.startsWith('VITE_')).length} vars).`);

  const cf = outputs.DistributionUrl;
  if (cf) {
    console.log(`\nCloudFront: ${cf}`);
    console.log(
      `Reminder: for the app to call the API from CloudFront, the backend CORS must allow that origin —\n` +
        `deploy with --context appUrl=${cf} (see docs/FRONTEND-DEPLOY.md).`,
    );
  }
}

main().catch((err) => {
  console.error('gen-frontend-env failed:', err.message || err);
  process.exit(1);
});
