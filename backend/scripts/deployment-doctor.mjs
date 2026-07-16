#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(process.cwd(), '..');
const frontendEnvPath = path.join(repoRoot, 'frontend', '.env');
const frontendExamplePath = path.join(repoRoot, 'frontend', '.env.example');

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
  'Create frontend/.env from frontend/.env.example after deployment outputs are available.'
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

console.log('');
console.log('Recommended next steps:');
console.log('  1. Run "npm install" in backend, frontend, and tests.');
console.log('  2. Deploy with "cdk deploy --all" from backend.');
console.log('  3. Copy outputs into frontend/.env and run the frontend locally.');
console.log('  4. Verify Bedrock model access for Haiku, Sonnet, Opus, and Titan in your AWS account.');
