/**
 * The handler's new send grant must carry the archived-channel Deny (ADR-025).
 *
 * WHY THIS EXISTS. `classificationChannelScopedAllow` layers
 * `archivedChannelReadOnlyDeny` automatically when the action list contains a message write, so
 * granting the handler `chime:SendChannelMessage` through that helper gets archived-channel
 * read-only enforcement for free. **Protection that arrives as a side effect is exactly what
 * disappears quietly**: someone adds a raw `PolicyStatement` for the send because it is one line
 * shorter, the Deny silently does not come with it, and an archived conversation becomes writable by
 * the assistant with nothing failing.
 *
 * So this pins both halves: that the helper really does layer the Deny for a write, and that the
 * handler role really does go through the helper.
 */

import { stripComments } from './helpers/strip-comments';
import * as fs from 'fs';
import * as path from 'path';
import {
  classificationChannelScopedAllow,
  ARCHIVE_DENIED_ACTIONS,
} from '../lib/stacks/agent-classification-common';

const APP_INSTANCE = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';

/** The rendered statements, as IAM sees them. */
const render = (actions: string[]) =>
  // A bot bearer, so this renders the ASSISTANT boundary (ADR-042). The archived-channel Deny these
  // cases are about is layered the same way for either actor, so the choice does not affect them.
  classificationChannelScopedAllow('standard', APP_INSTANCE, actions, {
    actor: 'assistant',
    bearerResources: [`${APP_INSTANCE}/bot/*`],
  }).map((s) => s.toStatementJson() as { Effect: string; Action: string | string[] });

const denies = (actions: string[]) => render(actions).filter((s) => s.Effect === 'Deny');

describe('the archived-channel Deny follows a message write', () => {
  it('is absent for a read-only grant', () => {
    // The negative case matters: if the Deny were layered unconditionally this test suite would pass
    // while proving nothing about the write.
    expect(denies(['chime:DescribeChannel', 'chime:ListChannelMessages'])).toHaveLength(0);
  });

  it('is layered when the grant includes SendChannelMessage', () => {
    expect(denies(['chime:DescribeChannel', 'chime:SendChannelMessage'])).toHaveLength(1);
  });

  it('covers the handler role\'s EXACT action list', () => {
    // The list as the stack passes it. If someone drops the send from the helper and grants it
    // separately, this still passes - which is what the source scan below is for.
    const handlerActions = [
      'chime:DescribeChannel',
      'chime:ListChannelMemberships',
      'chime:ListChannelMessages',
      'chime:SendChannelMessage',
    ];
    expect(denies(handlerActions)).toHaveLength(1);
    expect(ARCHIVE_DENIED_ACTIONS.has('chime:SendChannelMessage')).toBe(true);
  });
});

/**
 * The handler can READ the assignment records it sanctions a duel's alt from.
 *
 * FOUND LIVE, not by reasoning, when the alt was named by a roster: `isSanctionedBattleBot` validates a
 * caller-supplied bot identity on a `/battle` turn and fails CLOSED, the grant was missing, and BOTH
 * SIDES OF EVERY DUEL ANSWERED AS THE SAME BOT. The alt is now named by its own assignment record
 * (§3.7), read through the same classification-scoped subtree grant the handler resolves a Lex bot
 * with, so the two cannot drift apart. A permission whose absence degrades silently needs a test.
 */
describe('the handler can read the alt\'s assignment record', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../lib/stacks/assistant-profile-stack.ts'),
    'utf8',
  );
  const code = stripComments(src);

  it('grants the path read on this classification\'s assignment subtree to the handler', () => {
    const handlerRole = code.slice(code.indexOf("new iam.Role(this, 'AgentHandlerRole'"));
    expect(handlerRole).toMatch(/actions: \['ssm:GetParameter', 'ssm:GetParametersByPath'\],\s*resources: \[\s*`arn:aws:ssm:\$\{this\.region\}:\$\{this\.account\}:parameter\$\{SSM_ROOT\}\/assistant-assignments\/\$\{classification\}`,/);
  });

  it('reads no roster', () => {
    expect(code).not.toMatch(/alt-bot-slots|altBotSlotsRoster|ALT_BOT_SLOTS_ROSTER_PARAM/);
  });
});

describe('the handler role grants its send THROUGH the helper', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../lib/stacks/assistant-profile-stack.ts'),
    'utf8',
  );
  // Ignore comments: the rationale names the action, and prose must not read as a grant.
  //
  // THE `/*` MUST BE PRECEDED BY WHITESPACE OR A LINE START. The obvious
  // `replace(/\/\*[\s\S]*?\*\//g, '')` is WRONG in this file and silently defeated the scan below:
  // an IAM resource glob like `${appInstanceArn}/user/*` ends in `/*`, which that pattern reads as a
  // comment opener, so everything from the first ARN glob to the next `*/` vanished - including a
  // deliberately planted raw grant. Caught by mutation; the mutant survived until this line was fixed.
  const code = stripComments(src);

  it('names SendChannelMessage only inside classificationChannelScopedAllow calls', () => {
    // Every occurrence of the action in code must sit within a helper call. A bare
    // `new iam.PolicyStatement({ actions: ['chime:SendChannelMessage'] ... })` would grant the write
    // with no Deny attached, which is the regression this file exists to catch.
    //
    // ZERO IS A PASS, and the reason is the stronger property: the handler role holds no send at all.
    // Everything the router says goes out on the routed assistant's session, whose acting role carries
    // the archived-channel Deny (asserted below).
    const occurrences = (code.match(/'chime:SendChannelMessage'/g) || []).length;
    const withinHelper = (code.match(/classificationChannelScopedAllow\([^)]*'chime:SendChannelMessage'/gs) || []).length;
    expect(withinHelper).toBe(occurrences);
  });

  it('puts the archived-channel Deny in the boundary of the acting role the assistant posts through', () => {
    const common = stripComments(fs.readFileSync(path.join(__dirname, '../lib/stacks/agent-classification-common.ts'), 'utf8'));
    const acting = common.slice(common.indexOf('export function assistantActingRole('));
    const tagPin = acting.indexOf('const tagPin');
    // In the boundary, a limit over every grant the role holds; and only there, so one place answers it.
    expect(acting.slice(0, tagPin)).toContain('archivedChannelReadOnlyDeny(opts.appInstanceArn)');
    expect(acting.slice(tagPin, acting.indexOf('return { role, boundary }'))).not.toContain('archivedChannelReadOnlyDeny');
  });
});
