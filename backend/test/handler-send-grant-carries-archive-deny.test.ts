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
  classificationChannelScopedAllow('standard', APP_INSTANCE, actions, {
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
 * The handler can READ the alt-bot slot roster.
 *
 * FOUND LIVE, not by reasoning. `isSanctionedBattleBot` reads this parameter to validate a
 * caller-supplied bot identity on a `/battle` turn, and it fails CLOSED. The grant was never added
 * when the battle turn entry was built, so on the first deployment the read threw AccessDenied, every
 * alt-slot identity was rejected, and BOTH SIDES OF EVERY DUEL ANSWERED AS THE SAME BOT.
 *
 * The duel still ran, which is exactly why this shipped inert: nothing failed, the UI showed two
 * replies, and only the backend-error guard caught `[battle-turn] alt-bot roster unreadable` in the
 * handler log. A permission whose absence degrades silently needs a test, not a review.
 */
describe('the handler can read the alt-bot slot roster', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../lib/stacks/assistant-profile-stack.ts'),
    'utf8',
  );
  const code = stripComments(src);

  it('grants ssm:GetParameter on the roster parameter', () => {
    // The ARN is built from INSTANCE_SSM so it follows a non-default SSM_ROOT.
    expect(code).toMatch(/INSTANCE_SSM\.altBotSlotsRoster/);
    expect(code).toMatch(/parameter\$\{INSTANCE_SSM\.altBotSlotsRoster\}/);
  });

  it('names the parameter in the handler env rather than relying on the hardcoded fallback', () => {
    // `battle-turn.ts` falls back to `/agent-echelon/alt-bot-slots/roster`, which is correct ONLY at
    // the default SSM_ROOT. A deployment with its own root would read a parameter that does not exist
    // and fail closed - the same silent one-bot duel, on a deployment nobody would think to check.
    expect(code).toMatch(/ALT_BOT_SLOTS_ROSTER_PARAM:\s*INSTANCE_SSM\.altBotSlotsRoster/);
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
    const occurrences = (code.match(/'chime:SendChannelMessage'/g) || []).length;
    const withinHelper = (code.match(/classificationChannelScopedAllow\([^)]*'chime:SendChannelMessage'/gs) || []).length;
    expect(occurrences).toBeGreaterThan(0);
    expect(withinHelper).toBe(occurrences);
  });
});
