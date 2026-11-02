/**
 * A DRIFT-SPAWNED CONVERSATION GETS ITS CHANNEL FLOW.
 *
 * ── WHAT WENT WRONG, MEASURED ───────────────────────────────────────────────────────────────────
 *
 * `chime:AssociateChannelFlow` authorizes against THREE resources: the channel, the `ChimeBearer`,
 * and the channel flow being attached. `driftChannelCreateStatements` granted the first two. Every
 * associate the handler attempted was therefore denied on the one resource nobody had listed - over
 * seven days on the development deployment, SIX creations and SIX
 * `Failed to associate channel flow: AccessDeniedException`. Six of six is what makes it a policy bug
 * rather than a tag-propagation race; a race would have let some through.
 *
 * ── WHY IT STAYED HIDDEN ────────────────────────────────────────────────────────────────────────
 *
 * The associate is best-effort and its failure was a caught `console.warn`, while `CreateChannel`
 * reported success. So a drift-spawned conversation came up with NO channel flow - no addressing, no
 * marker stripping, no private-address enforcement, no duplicate-placeholder claim - and looked
 * entirely normal. The only thing that ever noticed was the e2e backend-error guard, which greps
 * handler logs for `AccessDenied`, and it reported it as a failure of a test about something else.
 *
 * ── WHY THIS TEST AND NOT A SYNTH ASSERTION ─────────────────────────────────────────────────────
 *
 * The statements are attached only when drift is enabled (`assistant-profile-stack.ts`, `if (drift)`),
 * so a synthesized stack without that context contains none of them - and a guard scanning for
 * statements that are not there passes by finding nothing wrong. Calling the builder directly makes
 * the resource list the subject, which is what was wrong.
 */
import { driftChannelCreateStatements } from '../lib/stacks/agent-classification-common';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const SERVICE_ADMIN = `${APP}/user/agent-echelon-admin`;

/** The resources one action can actually reach, across every statement that allows it. */
function resourcesFor(action: string): string[] {
  const statements = driftChannelCreateStatements('premium' as never, APP, 'us-east-1', '111122223333', SERVICE_ADMIN);
  return statements
    .map((s) => s.toStatementJson() as { Action?: string | string[]; Resource?: string | string[] })
    .filter((j) => (Array.isArray(j.Action) ? j.Action : [j.Action]).includes(action))
    .flatMap((j) => (Array.isArray(j.Resource) ? j.Resource : [j.Resource]))
    .filter((r): r is string => typeof r === 'string');
}

describe('the grant for associating a channel flow', () => {
  const resources = resourcesFor('chime:AssociateChannelFlow');

  it('is granted at all, so the assertions below are not passing on an empty list', () => {
    // NON-VACUITY, and not a formality: the first version of this guard scanned a synthesized stack
    // that contained no such statement, found nothing, and would have reported the policy as fine.
    expect(resources.length).toBeGreaterThan(0);
  });

  it('reaches the CHANNEL FLOW resource, which is the one that was missing', () => {
    expect(resources.some((r) => r.includes('/channel-flow/'))).toBe(true);
  });

  it('still reaches the channel and the bearer, because all three are required', () => {
    // Dropping either of these would deny the call just as completely as the missing third did.
    expect(resources.some((r) => r.includes('/channel/'))).toBe(true);
    expect(resources).toContain(SERVICE_ADMIN);
    expect(resources.some((r) => r.includes('/bot/'))).toBe(false);
  });

  it('does not widen to the whole app instance to get there', () => {
    // The blunt fix is `${appInstanceArn}/*`, which is what the two grants that already worked use.
    // This role reaches three named resource types and nothing else, so a future action added to the
    // same statement cannot quietly inherit reach over users, sub-channels or the instance itself.
    expect(resources).not.toContain(`${APP}/*`);
    expect(resources).not.toContain(APP);
  });
});

describe('and the channel boundary it sits behind', () => {
  it('still gates the CHANNEL on the classification tag', () => {
    // The channel flow carries no `classification` tag - there is one per deployment, shared by every
    // conversation - so its statement has no condition. That must not be read as relaxing the channel
    // leg, which is SPEC-CONVERSATION-SECURITY Layer 1 and is what actually bounds this role.
    const statements = driftChannelCreateStatements('premium' as never, APP, 'us-east-1', '111122223333', SERVICE_ADMIN);
    // Found by its Sid: the drift tag stamp also names `channel/*`, so matching on the resource would
    // read the stamp rather than the channel leg.
    const channelLeg = statements
      .map((s) => s.toStatementJson() as { Sid?: string; Condition?: unknown })
      .find((j) => j.Sid === 'DriftConfigureOwnClassificationChannel');
    expect(channelLeg?.Condition).toEqual(
      expect.objectContaining({ StringEquals: expect.objectContaining({ 'aws:ResourceTag/classification': expect.anything() }) }),
    );
  });
});

describe('membership on a drift creator is conditioned on the classification (step 31)', () => {
  const ADMIN = `${APP}/user/agent-echelon-admin`;
  const CHANGES = ['chime:CreateChannelMembership', 'chime:CreateChannelModerator', 'chime:DeleteChannelMembership', 'chime:DeleteChannelModerator'];
  type Json = { Sid?: string; Action?: string | string[]; Resource?: string | string[]; Condition?: Record<string, Record<string, unknown>> };
  const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : ([] as T[]).concat(v));
  const all = (admin?: string): Json[] => driftChannelCreateStatements('premium' as never, APP, 'us-east-1', '111122223333', admin as string)
    .map((s) => s.toStatementJson() as Json);
  const membershipOf = (admin?: string): Json[] => all(admin).filter((j) => list(j.Action).some((a) => CHANGES.includes(a)));

  it('bearing the service admin: a premium channel and the admin by its exact ARN, for all four changes', () => {
    const statements = membershipOf(ADMIN);
    const channel = statements.find((j) => list(j.Resource).includes(`${APP}/channel/*`));
    const bearer = statements.find((j) => list(j.Resource).includes(ADMIN));
    expect(channel?.Condition).toEqual({ StringEquals: { 'aws:ResourceTag/classification': ['premium'] } });
    expect(bearer?.Condition).toBeUndefined();
    for (const j of [channel, bearer]) expect([...list(j?.Action)].sort()).toEqual([...CHANGES].sort());
    // Nothing else: no bot, no `user/*`, no app instance.
    expect(statements.flatMap((j) => list(j.Resource)).sort()).toEqual([`${APP}/channel/*`, ADMIN].sort());
    expect(all(ADMIN).some((j) => j.Sid === 'DriftMembershipNotTagGatable')).toBe(false);
  });

  it('bearing the service admin, the role cannot create, tag or attach a flow as an assistant (step 33)', () => {
    const reachesBot = (j: Json) => list(j.Resource).some((r) => r.includes('/bot/') || r === `${APP}/*`);
    for (const action of ['chime:CreateChannel', 'chime:TagResource', 'chime:AssociateChannelFlow']) {
      const granting = all(ADMIN).filter((j) => list(j.Action).includes(action));
      expect([action, granting.length > 0, granting.some(reachesBot)]).toEqual([action, true, false]);
    }
  });

  it('a creator that would bear an assistant is refused at synth (step 37)', () => {
    // Every creator, the proactive briefing and federated add-member included, creates as the service
    // admin, so there is no assistant-bearing form left to build.
    for (const admin of [undefined, '', `${APP}/user/*`, `${APP}/bot/premium-assistant`]) {
      expect(() => all(admin)).toThrow(/service admin must be named exactly/);
    }
  });
});
