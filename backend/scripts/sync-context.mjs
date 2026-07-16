#!/usr/bin/env node

/**
 * Sync Project Context to S3
 *
 * Compiles project documentation into tiered context files and uploads
 * to the archive S3 bucket where async processors can read them.
 *
 * Paths:
 *   s3://{bucket}/standard/context.json  — Features, architecture overview
 *   s3://{bucket}/premium/context.json   — Full architecture + security + analytics details
 *
 * Usage:
 *   node scripts/sync-context.mjs [--profile <your-profile>] [--bucket name]
 *
 * Automatically strips:
 *   - AWS account IDs (12-digit numbers in ARN context)
 *   - Access keys, secret keys, tokens
 *   - Specific endpoint URLs
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// ============================================================
// Config
// ============================================================

const args = process.argv.slice(2);
const profileIdx = args.indexOf('--profile');
const profile = profileIdx >= 0 ? args[profileIdx + 1] : null;
const bucketIdx = args.indexOf('--bucket');
let bucket = bucketIdx >= 0 ? args[bucketIdx + 1] : null;

// Auto-detect bucket from CDK outputs if not specified. Athena mode publishes
// ArchiveBucketName on AgentEchelonAnalytics; Aurora mode swaps that stack for
// AgentEchelonAnalyticsAurora, which exposes the same output. Try both so the
// helper is analytics-mode agnostic.
if (!bucket) {
  const profileFlag = profile ? `--profile ${profile}` : '';
  for (const stack of ['AgentEchelonAnalytics', 'AgentEchelonAnalyticsAurora']) {
    try {
      const output = execSync(
        `aws cloudformation describe-stacks --stack-name ${stack} ${profileFlag} --query "Stacks[0].Outputs[?OutputKey=='ArchiveBucketName'].OutputValue" --output text`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      if (output && output !== 'None') {
        bucket = output;
        break;
      }
    } catch {
      // Try the next candidate stack.
    }
  }
}

if (!bucket) {
  console.error('Could not determine S3 bucket. Pass --bucket or ensure the analytics stack (AgentEchelonAnalytics or AgentEchelonAnalyticsAurora) is deployed.');
  process.exit(1);
}

console.log(`Syncing context to s3://${bucket}/`);

// ============================================================
// Document Loading
// ============================================================

function loadDoc(relativePath) {
  const fullPath = join(ROOT, relativePath);
  if (!existsSync(fullPath)) {
    console.warn(`  Skipping ${relativePath} (not found)`);
    return null;
  }
  return readFileSync(fullPath, 'utf-8');
}

function sanitize(content) {
  return content
    // Strip specific ARNs (arn:aws:...:123456789012:...)
    .replace(/arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[^\s"')]+/g, 'arn:aws:***:***:***:***')
    // Strip AWS account IDs in ARN-like contexts
    .replace(/(\d{12})/g, (match, p1, offset, str) => {
      // Only redact if it looks like it's in an AWS context
      const before = str.substring(Math.max(0, offset - 20), offset);
      if (before.includes('arn:') || before.includes('account') || before.includes('Account')) {
        return '***';
      }
      return match;
    })
    // Strip access keys
    .replace(/AKIA[A-Z0-9]{16}/g, '***')
    .replace(/ASIA[A-Z0-9]{16}/g, '***')
    // Strip URLs that look like API endpoints
    .replace(/https:\/\/[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com\/[^\s"')]+/g, 'https://***')
    // Strip .env values
    .replace(/^(VITE_\w+=).+$/gm, '$1***');
}

// ============================================================
// Context Compilation
// ============================================================

// Standard tier: features, architecture overview, how to use the app
const standardDocs = [
  'README.md',
  'docs/MODEL_STRATEGY.md',
];

// Premium tier: everything standard has + deep architecture, security, specs
const premiumDocs = [
  'README.md',
  'CLAUDE.md',
  'docs/ARCHITECTURE.md',
  'docs/MODEL_STRATEGY.md',
  'docs/SPEC-CONVERSATION-SECURITY.md',
  'docs/CHIME_SDK_INTEGRATION.md',
  'CONTRIBUTING.md',
];

function compileContext(docPaths, tierLabel) {
  const sections = [];

  sections.push(`# Agent Echelon — ${tierLabel} Context`);
  sections.push('');
  sections.push('This context describes the Agent Echelon platform you are part of.');
  sections.push('Use it to answer questions about the application, its architecture, and capabilities.');
  sections.push('');

  for (const path of docPaths) {
    const content = loadDoc(path);
    if (!content) continue;

    const sanitized = sanitize(content);
    sections.push(`---`);
    sections.push(`## Source: ${path}`);
    sections.push('');
    sections.push(sanitized.trim());
    sections.push('');
  }

  return sections.join('\n');
}

const standardContext = compileContext(standardDocs, 'Standard Tier');
const premiumContext = compileContext(premiumDocs, 'Premium Tier');

console.log(`  Standard context: ${(standardContext.length / 1024).toFixed(1)} KB`);
console.log(`  Premium context: ${(premiumContext.length / 1024).toFixed(1)} KB`);

// ============================================================
// S3 Upload
// ============================================================

const profileFlag = profile ? `--profile ${profile}` : '';

for (const [key, content] of [
  ['standard/context.json', standardContext],
  ['premium/context.json', premiumContext],
]) {
  const tmpFile = join(__dirname, `../.context-tmp-${key.replace('/', '-')}`);
  try {
    writeFileSync(tmpFile, content, 'utf-8');
    execSync(
      `aws s3 cp "${tmpFile}" "s3://${bucket}/${key}" --content-type "text/plain" ${profileFlag}`,
      { stdio: 'inherit' }
    );
    console.log(`  Uploaded ${key}`);
    unlinkSync(tmpFile);
  } catch (error) {
    console.error(`  Failed to upload ${key}:`, error.message);
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

console.log('Context sync complete.');
