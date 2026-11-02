#!/usr/bin/env node
/**
 * PreToolUse hook - a deploy goes through the script that checks it, never through `cdk deploy`.
 *
 * A hand-typed `npx cdk deploy <Stack> --exclusively` skips every check the deploy scripts make: it
 * forwards no deploy.config.json context unless someone pastes it, exits 0 when no stack matches the
 * name, and deploys whatever the checkout holds even when that is older than what is live. On
 * 2026-10-14 one such deploy, from a branch 208 commits behind dev, would have moved every admin
 * experiments route from IAM to a Cognito authorizer; an unrelated missing export is all that stopped
 * it.
 *
 * `npm run deploy` (all stacks) and `npm run deploy:stack -- <Stack>` (one) both refuse a deploy that
 * would remove a live commit, and record what they shipped. This denies the raw form so those are
 * the only way an assistant deploys. `cdk diff`, `cdk list` and `cdk synth` pass through.
 *
 * This binds tool calls only. The binding half for everything else is the rollback check inside
 * the scripts (scripts/lib/deploy-guards.cjs `rollbackVerdict`), which a terminal run reaches too.
 *
 * Escape hatch, for the owner and not for an assistant to reach for: a command containing
 * `AE_ALLOW_RAW_CDK_DEPLOY=1` passes unexamined.
 *
 * Contract (Claude Code PreToolUse hook): stdin JSON { tool_input: { command } }; stdout a deny
 * decision or nothing; exit 0 always, and a throw allows the call.
 */

const fs = require('fs');

/** A `cdk deploy` invocation in any spelling a shell segment would run it. */
const RAW_DEPLOY_RE = /(^|[\s;&|(])(npx\s+(--yes\s+|-y\s+)?)?(aws-)?cdk(@[\w.^~-]+)?\s+(.*\s)?deploy(\s|$)/;

/**
 * The command with what the shell treats as DATA removed: heredoc bodies and quoted strings. Text that
 * mentions `cdk deploy` (a script editing a doc, a grep, a commit message) is not a deploy, and this
 * hook refused exactly that the first day it ran. The cost, accepted: a deploy hidden inside
 * `bash -c '...'` passes this hook. The scripts' own rollback check still binds the guarded paths.
 */
function commandText(command) {
  return command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g, '<<heredoc')
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
}

function isRawCdkDeploy(command) {
  return commandText(command)
    .split(/&&|\|\||[;&|\n]/)
    .map((s) => s.trim())
    .some((s) => RAW_DEPLOY_RE.test(s) && !/\bcdk\s+(diff|list|ls|synth)\b/.test(s));
}

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }
  const command = String(payload.tool_input?.command || '');
  if (!command || command.includes('AE_ALLOW_RAW_CDK_DEPLOY=1')) process.exit(0);
  if (!isRawCdkDeploy(command)) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Refused: a raw `cdk deploy`. It skips the deploy config, the stack-name check and the rollback check, and '
        + 'a deploy from a checkout older than what is live removes live commits while CloudFormation reports success.\n\n'
        + 'One stack:  cd backend && npm run deploy:stack -- <StackName>        (add --diff-only to look first)\n'
        + 'Every stack: cd backend && npm run deploy\n\n'
        + 'Both refuse a deploy whose live commit is not an ancestor of this checkout, and record what they shipped.',
    },
  }));
  process.exit(0);
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.exit(0);
  }
}

module.exports = { isRawCdkDeploy };
