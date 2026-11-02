#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const { checkIssuers, issuersFromConfig } = createRequire(import.meta.url)('./lib/issuer-checks.cjs');

const repoRoot = path.resolve(process.cwd(), '..');
const frontendEnvPath = path.join(repoRoot, 'frontend', 'packages', 'chat', '.env');
const frontendExamplePath = path.join(repoRoot, 'frontend', 'packages', 'chat', '.env.example');

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.trim().startsWith('#'))
    .reduce((acc, line) => {
      const separator = line.indexOf('=');
      if (separator === -1) {
        return acc;
      }
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      acc[key] = value;
      return acc;
    }, {});
}

function printCheck(label, passed, details) {
  const marker = passed ? '[ok]' : '[warn]';
  console.log(`${marker} ${label}`);
  if (details) {
    console.log(`      ${details}`);
  }
}

console.log('Agent Echelon Deployment Doctor');
console.log('');

const frontendEnv = readEnvFile(frontendEnvPath);
const frontendExample = readEnvFile(frontendExamplePath);

printCheck(
  'AWS credentials present',
  Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.CDK_DEFAULT_ACCOUNT),
  'Set AWS_PROFILE or AWS_ACCESS_KEY_ID/CDK_DEFAULT_ACCOUNT before deploying.'
);

printCheck(
  'AWS region present',
  Boolean(process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION),
  'Expected CDK_DEFAULT_REGION or AWS_REGION.'
);

printCheck(
  'Frontend env file exists',
  fs.existsSync(frontendEnvPath),
  'After deploy, run "node scripts/gen-frontend-env.mjs" to write frontend/packages/chat/.env and frontend/packages/admin/.env.'
);

const requiredFrontendKeys = Object.keys(frontendExample);
const missingFrontendKeys = requiredFrontendKeys.filter((key) => !frontendEnv[key]);
printCheck(
  'Frontend env keys populated',
  missingFrontendKeys.length === 0,
  missingFrontendKeys.length === 0
    ? 'All expected frontend values are present.'
    : `Missing: ${missingFrontendKeys.join(', ')}`
);

const appUrl = process.env.APP_URL || 'http://localhost:5173';
printCheck(
  'Local callback URL matches frontend dev server',
  appUrl.includes('5173'),
  `Current APP_URL fallback is ${appUrl}; local Cognito callback defaults should stay aligned with port 5173.`
);

printCheck(
  'SES sender configured',
  Boolean(process.env.SES_SENDER_EMAIL),
  'Set SES_SENDER_EMAIL before deploy if you want conversation-sharing emails.'
);

printCheck(
  'Analytics mode selected',
  true,
  `analyticsMode=${process.env.CDK_CONTEXT_ANALYTICS_MODE || 'athena (default)'}. Use "aurora" only when you need advanced evaluation features.`
);

// ── THE TRUSTED-ISSUER REGISTRY: each pool exists, each discovery URL answers ───────────────────────
const deployConfigPath = path.join(process.cwd(), 'deploy.config.json');
let deployConfig = {};
try {
  deployConfig = fs.existsSync(deployConfigPath) ? JSON.parse(fs.readFileSync(deployConfigPath, 'utf8')) : {};
} catch (err) {
  printCheck('deploy.config.json is readable', false, `could not be parsed: ${err.message}`);
}
const issuers = issuersFromConfig(deployConfig);
if (issuers.length === 0) {
  printCheck('Trusted issuers', true, "No issuers declared: this deployment trusts its own pool alone.");
} else {
  const region = process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-1';
  const results = await checkIssuers(issuers, {
    describePool: async (poolId) => {
      const { CognitoIdentityProviderClient, DescribeUserPoolCommand } = await import('@aws-sdk/client-cognito-identity-provider');
      const client = new CognitoIdentityProviderClient({ region: poolId.split('_')[0] || region });
      await client.send(new DescribeUserPoolCommand({ UserPoolId: poolId }));
    },
    fetchDiscovery: async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });
  for (const r of results) printCheck(`Issuer ${r.issuer}: ${r.check}`, r.ok, r.detail);
}

// ── AN IMPORTED VPC WITHOUT ENDPOINTS: its routes to what the in-VPC handlers read ──────────────────
// The same check `npm run deploy` refuses on (check-imported-vpc.mjs); skipped unless the config selects it.
{
  const { contextFlagsFromConfig, contextValue } = createRequire(import.meta.url)('./lib/deploy-guards.cjs');
  const { importedVpcFindings } = await import('./check-imported-vpc.mjs');
  const forwarded = contextFlagsFromConfig(deployConfig);
  try {
    const result = await importedVpcFindings((k) => contextValue(forwarded, k));
    if (!result) {
      printCheck('Analytics VPC endpoints', true, 'The deployment creates its own VPC endpoints (or runs in Athena mode): nothing imported to check.');
    } else {
      for (const f of result.findings) printCheck(`Imported VPC ${result.vpcId}: ${f.check}`, f.level === 'ok', f.level === 'ok' ? '' : f.detail);
    }
  } catch (err) {
    printCheck('Imported VPC routes', false, `could not be read: ${err?.stderr?.toString?.() || err.message}`);
  }
}

console.log('');
console.log('Recommended next steps:');
console.log('  1. Run "npm install" in backend, frontend, and tests.');
console.log('  2. Deploy with "npm run deploy" from backend.');
console.log('  3. Run the frontend locally (npm run deploy already wrote frontend/packages/{chat,admin}/.env).');
console.log('  4. Verify Bedrock model access for Haiku, Sonnet, Opus, and Titan in your AWS account.');
