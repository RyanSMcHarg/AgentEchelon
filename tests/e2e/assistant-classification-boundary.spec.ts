/**
 * THE ASSISTANT CHANNEL BOUNDARY, PROVEN BY DENIAL RATHER THAN BY READING A POLICY.
 *
 * ADR-042: an assistant acts in exactly one classification. Every other check of that rule reads the
 * synthesized template and asserts the condition it finds, which proves what CDK emitted and not what
 * AWS decides. Tenet P4 asks for isolation provable with a deny-test, and this is that test for the
 * channel boundary.
 *
 * ── WHO IS ASKED ────────────────────────────────────────────────────────────────────────────────
 *
 * Every assistant of a classification acts through that classification's one acting role, on a
 * session the vend tags with the assistant, its role and its bot. So the principal is the acting role,
 * simulated with those tags. Two grants decide a conversation call, and both are asked about here:
 * `ActOnlyInThisClassificationsChannels` (the channel must carry this classification's tag) and
 * `ActOnlyAsTheSessionsOwnBot` (the bearer is `…/bot/${aws:PrincipalTag/bot}`, so a session acts as
 * the bot it was minted for and no other). The boundary's `BoundaryNoChannelOutsideThisClassification`
 * and `BoundaryNoBotOutsideThisClassification` deny the same thing again from the boundary.
 *
 * The bot pin is the per-assistant edge. A classification tag alone cannot separate two assistants of
 * the same classification, because both bots carry it; only the ARN variable does.
 *
 * ── WHAT MAKES THIS A REAL DENY-TEST ────────────────────────────────────────────────────────────
 *
 * `iam simulate-principal-policy` evaluates the DEPLOYED role, boundary included, against a resource
 * and a context, and returns AWS's own decision. The resource tag is supplied as a context entry,
 * because the simulator cannot fetch Amazon Chime SDK resource tags.
 *
 * IT RUNS AGAINST A DEPLOYMENT AND FAILS UNTIL ONE CARRIES THE CHANGE. That is deliberate. A
 * boundary that passes before it is deployed is testing the tree rather than the account.
 *
 * ── WHY THE POSITIVE CASE IS HALF OF IT ─────────────────────────────────────────────────────────
 *
 * A policy that denies everything passes every deny-test ever written. Each classification's session
 * is asserted to be ALLOWED on its own classification's channel, as its own bot, in the same loop, so a
 * boundary narrowed into uselessness fails here rather than looking like success.
 */

import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import {
  TAG, CLASSIFICATIONS, NO_AWS_REASON, awsReachable, actingRole, botFor, assistantBots, appInstanceArn,
  decide, decisionSources, ctx, sessionContext, processorRoleArn,
} from './helpers/assistant-acting-role';

const SEND = 'chime:SendChannelMessage';

test.describe('an assistant acts in exactly one classification, as exactly one bot (ADR-042)', () => {
  // Installed even though this spec drives no browser and calls no platform API. The suite rule is
  // that every spec carries it, and the reason applies here too: the guard reads CloudWatch, and a
  // boundary test that passed while the deployment was throwing is exactly the shape it refuses.
  guardBackendErrors('assistant-classification-boundary');
  test.skip(!awsReachable(), NO_AWS_REASON);

  test('each acting role is allowed on its own classification\'s channel and DENIED on every other', async () => {
    test.setTimeout(180_000);

    const appInstance = appInstanceArn();
    expect(appInstance, 'no assigned bot to read the app instance from').toBeTruthy();
    const channel = `${appInstance}/channel/probe-boundary`;
    const violations: string[] = [];

    for (const c of CLASSIFICATIONS) {
      const role = actingRole(c);
      expect(role, `no deployed ${c} acting role`).toBeTruthy();
      const own = botFor(c, 'primary');
      expect(own, `no assistant is assigned to (${c}, primary)`).toBeTruthy();
      const session = sessionContext(c, 'primary', own!.botId);

      for (const tag of CLASSIFICATIONS) {
        const decision = decide(role!.arn, SEND, channel, [...session, ctx(TAG.resourceClassification, tag)]);
        const isOwn = tag === c;
        if (isOwn && decision !== 'allowed') {
          violations.push(
            `${c} assistant CANNOT send in its OWN classification (${decision}). The boundary is `
            + 'not narrow, it is broken: this assistant can no longer answer the conversations it exists for.',
          );
        }
        if (!isOwn && decision === 'allowed') {
          violations.push(
            `${c} assistant CAN send into a ${tag} channel - the assistant boundary is OPEN. `
            + 'An assistant added to another classification\'s conversation, by an out-of-band '
            + 'membership call or a routing mistake, would answer there with its own model and context.',
          );
        }
      }

      // The untagged channel, which is the case Layer 1 is fail-closed for. No resource tag at all, so
      // the Allow cannot match and the boundary's negated Deny does.
      const untagged = decide(role!.arn, SEND, channel, session);
      if (untagged === 'allowed') {
        violations.push(`${c} assistant CAN send into an UNTAGGED channel - Layer 1 is not fail-closed`);
      }

      console.log(`[assistant-boundary] ${c}: allowed on ${c} only, denied on `
        + `${CLASSIFICATIONS.filter((t) => t !== c).join('+')} and untagged`);
    }

    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });

  test('an archived conversation is read-only to an assistant, refused by the boundary', async () => {
    // A POSITIVE CONTROL FIRST. Without the classification and bot context every send is denied anyway,
    // so "archived is denied" would pass on a broken policy. The same context with `archived=false` must
    // be allowed, and `archived=true` must be an explicit Deny that the BOUNDARY produced: the boundary
    // then covers every grant the role holds, not only the one the Deny was written next to.
    test.setTimeout(180_000);
    const appInstance = appInstanceArn();
    expect(appInstance, 'no assigned bot to read the app instance from').toBeTruthy();
    const channel = `${appInstance}/channel/probe-archived`;
    const violations: string[] = [];
    for (const c of CLASSIFICATIONS) {
      const role = actingRole(c);
      const own = botFor(c, 'primary');
      expect(role && own, `no deployed ${c} acting role or primary assistant`).toBeTruthy();
      const base = [...sessionContext(c, 'primary', own!.botId), ctx(TAG.resourceClassification, c)];
      for (const action of [SEND, 'chime:UpdateChannelMessage']) {
        const open = decide(role!.arn, action, channel, [...base, ctx('aws:ResourceTag/archived', 'false')]);
        if (open !== 'allowed') violations.push(`${c}: ${action} on an open conversation is ${open}, so the archived check proves nothing`);
        const archived = decisionSources(role!.arn, action, channel, [...base, ctx('aws:ResourceTag/archived', 'true')]);
        if (archived.decision !== 'explicitDeny') violations.push(`${c}: ${action} on an ARCHIVED conversation is ${archived.decision}`);
        if (!archived.sources.some((p) => p.includes('AssistantActingBoundary'))) {
          violations.push(`${c}: the archived Deny did not come from the boundary (matched: ${archived.sources.join(', ') || 'none'})`);
        }
        // And only from the boundary: the role carries no copy of its own, so one place answers it.
        const elsewhere = archived.sources.filter((p) => !p.includes('AssistantActingBoundary'));
        if (elsewhere.length) violations.push(`${c}: the archived Deny also comes from ${elsewhere.join(', ')}`);
      }
    }
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });

  test('a session acts as its own bot and is DENIED acting as any other, in or out of its classification', async () => {
    test.setTimeout(180_000);

    const appInstance = appInstanceArn();
    expect(appInstance, 'no assigned bot to read the app instance from').toBeTruthy();
    const violations: string[] = [];

    for (const c of CLASSIFICATIONS) {
      const role = actingRole(c);
      expect(role, `no deployed ${c} acting role`).toBeTruthy();
      const own = botFor(c, 'primary');
      expect(own, `no assistant is assigned to (${c}, primary)`).toBeTruthy();
      const session = sessionContext(c, 'primary', own!.botId);

      // POSITIVE: the bot this session was minted for, carrying its own classification's tag.
      const asOwn = decide(role!.arn, SEND, own!.botArn, [...session, ctx(TAG.resourceClassification, own!.classificationTag)]);
      if (asOwn !== 'allowed') {
        violations.push(`${c}: a session cannot act as its OWN bot (${asOwn}); no assistant of ${c} can speak`);
      }

      // THE PER-ASSISTANT PIN: a DIFFERENT bot of the SAME classification, same tag. Only the
      // `${aws:PrincipalTag/bot}` variable separates these. A real sibling when one is assigned, and a
      // made-up id otherwise, because the question is whether ANY other id is refused.
      const sibling = assistantBots(c).find((b) => b.botId !== own!.botId);
      const otherId = sibling?.botId || '00000000-0000-0000-0000-000000000000';
      const otherArn = `${appInstance}/bot/${otherId}`;
      const asOther = decide(role!.arn, SEND, otherArn, [...session, ctx(TAG.resourceClassification, c)]);
      if (asOther === 'allowed') {
        violations.push(
          `${c}: a session minted for bot ${own!.botId} is ALLOWED to act as bot ${otherId} of the same `
          + 'classification. The bearer is not pinned to the session, so any assistant could post as any other.',
        );
      }

      // ACROSS CLASSIFICATIONS: another classification's bot, carrying its own tag.
      for (const other of CLASSIFICATIONS.filter((t) => t !== c)) {
        const foreign = botFor(other, 'primary');
        if (!foreign) continue;
        const d = decide(role!.arn, SEND, foreign.botArn, [...session, ctx(TAG.resourceClassification, foreign.classificationTag)]);
        if (d === 'allowed') {
          violations.push(`${c}: a session is ALLOWED to act as the ${other} primary's bot; an assistant reached another classification`);
        }
      }
      console.log(`[assistant-boundary] ${c}: acts as its own bot only (sibling ${sibling ? 'real' : 'synthetic'})`);
    }

    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });

  test('the processor\'s own role sends nothing and cannot assume the acting role', async () => {
    test.setTimeout(180_000);

    // THE PROCESSOR IS BOOTSTRAP ONLY. It writes logs and asks the vend for a session; every call a
    // turn makes goes out on that session. If its own role could send, a turn could skip the vend and
    // speak with no bot pin; if it could assume the acting role, it could mint a session with tags of
    // its own choosing. This is the identity side: the acting role's trust policy also refuses it,
    // and `only-the-vend-mints-an-assistant-session.spec.ts` asserts that half.
    const appInstance = appInstanceArn();
    expect(appInstance, 'no assigned bot to read the app instance from').toBeTruthy();
    const violations: string[] = [];

    for (const c of CLASSIFICATIONS) {
      const processor = processorRoleArn(c);
      const role = actingRole(c);
      expect(processor, `no deployed ${c} processor role`).toBeTruthy();
      expect(role, `no deployed ${c} acting role`).toBeTruthy();
      const own = botFor(c, 'primary');

      const onChannel = decide(processor!, SEND, `${appInstance}/channel/probe-boundary`, [ctx(TAG.resourceClassification, c)]);
      if (onChannel === 'allowed') violations.push(`${c}: the processor role is ALLOWED ${SEND} on a ${c} channel`);
      if (own) {
        const asBot = decide(processor!, SEND, own.botArn, [ctx(TAG.resourceClassification, own.classificationTag)]);
        if (asBot === 'allowed') violations.push(`${c}: the processor role is ALLOWED ${SEND} as the ${c} primary's bot`);
      }
      const assume = decide(processor!, 'sts:AssumeRole', role!.arn);
      if (assume === 'allowed') violations.push(`${c}: the processor role holds sts:AssumeRole on the acting role; it could mint its own session`);
    }

    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });
});
