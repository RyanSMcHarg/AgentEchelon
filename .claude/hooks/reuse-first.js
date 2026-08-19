#!/usr/bin/env node
/**
 * UserPromptSubmit hook - reuse rather than build new.
 *
 * Fires when a prompt is shaped like "add another one of these": a new endpoint, a new Lambda, a new
 * way to create a conversation or add a member. It answers the question the author is about to skip -
 * "does this already exist?" - by listing the CURRENT implementations from the source tree, counted
 * live rather than remembered.
 *
 * Why counted live: a hardcoded list is a snapshot, and snapshots rot faster than the code they
 * describe. This repo already retired a point-in-time audit for exactly that reason. If a count here
 * looks wrong, the tree changed and the hook is right.
 *
 * This is the AUTHORING-TIME half of the control and it is ADVISORY - it cannot block, and it only
 * reaches an AI assistant. The half that binds every contributor is `backend/test/single-entry-point.ts`,
 * which fails CI when an unsanctioned call site appears. A hook that nudges plus a test that refuses is
 * the pair; either alone is not enough.
 *
 * Contract (Claude Code UserPromptSubmit hook):
 *   stdin  - JSON: { prompt: string, cwd: string, ... }
 *   stdout - additional context injected before the model reads the prompt
 *   exit 0 - always. Any throw is swallowed; this hook must NEVER stop work.
 */

const fs = require('fs');
const path = require('path');

/** Prompt shapes that precede a new implementation of something that already exists. */
const BUILD_KEYWORDS = [
  'new api', 'new endpoint', 'new route', 'new lambda', 'new handler', 'new function',
  'add an api', 'add a api', 'add an endpoint', 'add a endpoint', 'add a route', 'add a lambda',
  'create conversation', 'create a conversation', 'create channel', 'create a channel',
  'add member', 'add a member', 'add user', 'invite',
  'another way to', 'separate api', 'separate endpoint', 'own endpoint', 'own lambda',
  'expose an api', 'expose a new',
];

/**
 * Capabilities worth counting, by the SDK command a new copy would call. Kept in step with
 * CONTROLLED in backend/test/single-entry-point.test.ts - that file is the enforcement, this is the
 * reminder.
 */
const CAPABILITIES = [
  { label: 'create a conversation channel', command: 'CreateChannelCommand',
    canonical: 'backend/lambda/src/lib/channel-creation.ts' },
  { label: 'add a member to a conversation', command: 'CreateChannelMembershipCommand',
    canonical: 'backend/lambda/src/lib/channel-creation.ts' },
  { label: 'make someone a moderator', command: 'CreateChannelModeratorCommand',
    canonical: 'backend/lambda/src/lib/channel-creation.ts' },
];

function sourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|js)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(path.join(root, 'backend', 'lambda'));
  return out;
}

function callSites(command, files, root) {
  const re = new RegExp(`new\\s+${command}\\s*\\(`);
  const hits = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (re.test(text)) hits.push(path.relative(root, f).replace(/\\/g, '/'));
  }
  return hits.sort();
}

/** REST resources declared in the CDK stacks - the "multiple APIs that do the same thing" surface. */
function apiResourceCount(root) {
  const dir = path.join(root, 'backend', 'lib', 'stacks');
  let total = 0;
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  } catch {
    return null;
  }
  for (const f of files) {
    try {
      const m = fs.readFileSync(path.join(dir, f), 'utf8').match(/addResource\s*\(/g);
      if (m) total += m.length;
    } catch { /* skip unreadable */ }
  }
  return total;
}

function main() {
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch {
    process.exit(0);
  }
  let payload = {};
  try {
    payload = JSON.parse(input || '{}');
  } catch {
    process.exit(0);
  }

  const prompt = String(payload.prompt || '').toLowerCase();
  if (!prompt) process.exit(0);
  if (!BUILD_KEYWORDS.some((k) => prompt.includes(k))) process.exit(0);

  const root = payload.cwd || process.cwd();
  const files = sourceFiles(root);
  if (files.length === 0) process.exit(0);

  const lines = [];
  for (const cap of CAPABILITIES) {
    const hits = callSites(cap.command, files, root);
    if (hits.length <= 1) continue; // one implementation is not a proliferation problem
    lines.push(`- **${cap.label}** is implemented **${hits.length}** times (\`${cap.command}\`).`);
    lines.push(`  Canonical: \`${cap.canonical}\`. All of them:`);
    for (const h of hits) lines.push(`    - ${h}`);
  }

  const routes = apiResourceCount(root);
  if (routes !== null && routes > 0) {
    lines.push(`- The CDK stacks declare **${routes}** API resources. Check for an existing route before adding one.`);
  }

  if (lines.length === 0) process.exit(0);

  process.stdout.write(
    '## Reuse rather than build new\n\n'
    + 'This prompt looks like it may add a new implementation of something that already exists. '
    + 'Counted from the current tree:\n\n'
    + `${lines.join('\n')}\n\n`
    + 'Before writing a new one: extend the canonical implementation, or say explicitly why it cannot '
    + 'be reused. A new call site to a controlled operation FAILS CI '
    + '(`backend/test/single-entry-point.test.ts`) until it is registered there with a reason.\n\n'
    + 'This is context, not a prohibition - if a new path is genuinely right, record why.\n',
  );
  process.exit(0);
}

try {
  main();
} catch {
  // Never block the user's turn - the hook is best-effort context.
  process.exit(0);
}
