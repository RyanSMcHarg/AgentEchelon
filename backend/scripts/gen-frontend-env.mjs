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
// The chat/production build loads .env; `vite build --mode admin` loads .env
// PLUS .env.admin. So the admin-only endpoint URLs live ONLY in .env.admin and
// never reach the public chat bundle (SPEC-SEPARATE-ADMIN-APP.md).
const ENV_PATH = path.resolve(__dirname, '../../frontend/.env');
const ADMIN_ENV_PATH = path.resolve(__dirname, '../../frontend/.env.admin');

// CloudFormation OutputKey -> frontend Vite variable. Keys are unique across the
// AgentEchelon stacks, so a single merged map is unambiguous.
const OUTPUT_TO_VITE = {
  // Analytics mode (athena|aurora). Checked FIRST by detectAnalyticsMode() so the app
  // uses the right endpoints without a probe (the probe can cache 'athena' if it runs
  // pre-login). Present as the AnalyticsMode output on the analytics stack.
  AnalyticsMode: 'VITE_ANALYTICS_MODE',
  UserPoolId: 'VITE_USER_POOL_ID',
  UserPoolClientId: 'VITE_CLIENT_ID',
  IdentityPoolId: 'VITE_IDENTITY_POOL_ID',
  CredentialExchangeApiUrl: 'VITE_CREDENTIAL_EXCHANGE_API_URL',
  AppInstanceArnOutput: 'VITE_APP_INSTANCE_ARN',
  CreateConversationApiUrl: 'VITE_CREATE_CONVERSATION_API_URL',
  AddAgentApiUrl: 'VITE_ADD_BOT_API_URL',
  ShareConversationApiUrl: 'VITE_SHARE_CONVERSATION_API_URL',
  PresignedUrlApiUrl: 'VITE_PRESIGNED_URL_API_URL',
  AnalyticsApiUrl: 'VITE_ANALYTICS_API_URL',
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

  // Chat/shared env (frontend/.env) — everything EXCEPT admin-only vars.
  const lines = [
    '# Generated by scripts/gen-frontend-env.mjs from deployed CDK outputs.',
    '# Do not edit by hand — re-run the script after a redeploy.',
    '# Chat SPA + shared vars. Admin-only endpoint URLs live in .env.admin.',
    `VITE_AWS_REGION=${REGION}`,
  ];
  // Admin-only env (frontend/.env.admin) — loaded on top of .env only by the
  // admin build (`vite build --mode admin`).
  const adminLines = [
    '# Generated by scripts/gen-frontend-env.mjs from deployed CDK outputs.',
    '# Admin-console-only vars, loaded on top of .env by `vite build --mode admin`.',
    '# Kept OUT of .env so the public chat bundle carries no admin endpoint URLs.',
  ];
  const missingRequired = [];
  for (const [outputKey, viteVar] of Object.entries(OUTPUT_TO_VITE)) {
    const target = ADMIN_ONLY.has(viteVar) ? adminLines : lines;
    const value = outputs[outputKey];
    if (value) {
      target.push(`${viteVar}=${value}`);
    } else if (OPTIONAL.has(viteVar)) {
      target.push(`# ${viteVar} — not deployed (optional); feature degrades gracefully`);
    } else {
      missingRequired.push(`${viteVar} (output ${outputKey})`);
    }
  }

  if (missingRequired.length) {
    throw new Error(
      `Missing required outputs — is the backend fully deployed?\n  - ${missingRequired.join('\n  - ')}`,
    );
  }

  await writeFile(ENV_PATH, lines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${ENV_PATH} (${lines.filter((l) => l.startsWith('VITE_')).length} chat/shared vars).`);
  await writeFile(ADMIN_ENV_PATH, adminLines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${ADMIN_ENV_PATH} (${adminLines.filter((l) => l.startsWith('VITE_')).length} admin-only vars).`);

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
