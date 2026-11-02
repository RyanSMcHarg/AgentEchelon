/**
 * ONLY THE VEND MINTS AN ASSISTANT SESSION, AND ONLY A SESSION THE ROUTER DECIDED.
 *
 * Every assistant of a classification acts through one acting role. Whoever can assume that role
 * chooses the session's tags, and the tags decide which bot it acts as and which assistant role it
 * holds. So the trust policy is the edge everything else rests on: the boundary, the bot pin and the
 * per-role context grants all compare tags, and a principal that could mint its own session could
 * write any tags the trust policy lets through.
 *
 * The design (`assistantActingRole` in `agent-classification-common.ts`) names the vend as the only
 * principal, pins the `classification` request tag to the role's own classification and the `role`
 * tag to the roles it declares, and requires `assistant` and `bot` tags on the assume itself. The
 * vend reads the routing record only the router writes, so the vend can only mint what the router
 * decided.
 *
 * ── TWO SIDES, BOTH ASSERTED ────────────────────────────────────────────────────────────────────
 *
 * An assume needs the trust policy to admit the caller AND the caller's own policy to allow it. The
 * trust side is read from the deployed role. The identity side is simulated: the processor, the router
 * handler, the channel flow processor and the battle orchestrator must hold no `sts:AssumeRole` on the
 * acting role. The vend is the positive control, so a simulation that denied everything would not read
 * as a pass.
 *
 * The routing services must also hold no `chime:SendChannelMessage` of their own: they decide who
 * answers, and an answer goes out as the assistant on its own session. A send on either would be a
 * second way to speak with no bot pin.
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import {
  TAG, CLASSIFICATIONS, NO_AWS_REASON, awsReachable, actingRole, assumeStatement, conditionValues,
  vendRoleArn, processorRoleArn, handlerRoleArn, channelFlowProcessorRoleArn, battleOrchestratorRoleArn,
  botFor, appInstanceArn, decide, ctx,
} from './helpers/assistant-acting-role';

guardBackendErrors('only-the-vend-mints');

const asList = (v: unknown): string[] => (v === undefined || v === null ? [] : ([] as string[]).concat(v as string[]));

/** Every principal a trust statement names, flattened, with its kind. */
function principalsOf(statement: any): string[] {
  const p = statement?.Principal;
  if (!p) return [];
  if (typeof p === 'string') return [`*:${p}`];
  return Object.entries(p).flatMap(([kind, v]) => asList(v).map((x) => `${kind}:${x}`));
}

test.describe('only the vend mints an assistant session', () => {
  test.skip(!awsReachable(), NO_AWS_REASON);

  test('each acting role trusts its own classification\'s vend and nothing else, with the session pins on the assume', async () => {
    test.setTimeout(180_000);
    const violations: string[] = [];

    for (const c of CLASSIFICATIONS) {
      const role = actingRole(c);
      expect(role, `no deployed ${c} acting role under the assistant IAM path`).toBeTruthy();
      const vend = vendRoleArn(c);
      expect(vend, `no deployed ${c} vend (the vend-arn parameter or its function is missing)`).toBeTruthy();

      // EVERY STATEMENT, NOT ONLY THE ASSUME. `sts:TagSession` and `sts:SetSourceIdentity` also have to
      // name the vend alone: a second principal on either is a principal the role partly trusts.
      const statements: any[] = role!.trust?.Statement ?? [];
      expect(statements.length, `${c}: the acting role's trust policy has no statements`).toBeGreaterThan(0);
      for (const st of statements) {
        if (st.Effect !== 'Allow') continue;
        const named = principalsOf(st);
        const others = named.filter((p) => p !== `AWS:${vend}`);
        if (!named.length || others.length) {
          violations.push(
            `${c}: trust statement for ${asList(st.Action).join(', ')} names ${JSON.stringify(named)}; `
            + `the only principal may be this classification's vend (${vend})`,
          );
        }
      }

      // THE PINS ON THE ASSUME ITSELF. Conditioning only `sts:TagSession` would let the vend assume
      // without tags and skip every pin, so the conditions have to sit on `sts:AssumeRole`.
      const assume = assumeStatement(role!.trust);
      if (!assume) {
        violations.push(`${c}: no trust statement grants sts:AssumeRole`);
        continue;
      }
      const pinned = conditionValues(assume, 'StringEquals', 'aws:RequestTag/classification');
      if (pinned.length !== 1 || pinned[0] !== c) {
        violations.push(`${c}: the assume pins aws:RequestTag/classification to ${JSON.stringify(pinned)}; it must be exactly ['${c}']`);
      }
      const roles = conditionValues(assume, 'StringEquals', 'aws:RequestTag/role');
      if (!roles.includes('primary') || roles.some((r) => r === '*' || r.includes('*'))) {
        violations.push(`${c}: the assume pins aws:RequestTag/role to ${JSON.stringify(roles)}; it must name the declared roles, primary included, with no wildcard`);
      }
      for (const key of ['aws:RequestTag/assistant', 'aws:RequestTag/bot']) {
        const required = [...conditionValues(assume, 'StringLike', key), ...conditionValues(assume, 'StringEquals', key)];
        if (!required.length) violations.push(`${c}: the assume does not require ${key}; a session could be minted without it`);
      }

      // The same pins on `sts:TagSession`, which is the call that actually writes the tags.
      const tagSession = (role!.trust?.Statement ?? []).find((s: any) => asList(s.Action).includes('sts:TagSession'));
      if (tagSession && !asList(tagSession.Action).includes('sts:AssumeRole')) {
        const tsPinned = conditionValues(tagSession, 'StringEquals', 'aws:RequestTag/classification');
        if (tsPinned.length !== 1 || tsPinned[0] !== c) {
          violations.push(`${c}: sts:TagSession does not pin aws:RequestTag/classification to '${c}' (${JSON.stringify(tsPinned)})`);
        }
      }
      console.log(`[vend-trust] ${c}: trusts ${vend!.split('/').pop()} only; pins classification=${c}, role in [${roles.join(', ')}]`);
    }

    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });

  test('no turn-running or routing role may assume an acting role; the vend may', async () => {
    test.setTimeout(240_000);
    const violations: string[] = [];

    const flow = channelFlowProcessorRoleArn();
    const orchestrator = battleOrchestratorRoleArn();
    expect(flow, 'no deployed channel flow processor role').toBeTruthy();

    for (const c of CLASSIFICATIONS) {
      const role = actingRole(c);
      expect(role, `no deployed ${c} acting role`).toBeTruthy();
      const vend = vendRoleArn(c);
      const processor = processorRoleArn(c);
      const handler = handlerRoleArn(c);
      expect(vend && processor && handler, `could not read the ${c} vend, processor and handler roles`).toBeTruthy();

      // THE POSITIVE CONTROL: the vend's own policy allows the assume. Without it, a simulation that
      // denied everything would make every denial below read as a pass.
      const asVend = decide(vend!, 'sts:AssumeRole', role!.arn);
      if (asVend !== 'allowed') violations.push(`${c}: the vend is ${asVend} for sts:AssumeRole on its acting role; no assistant can act`);

      const others: Array<[string, string | null]> = [
        ['processor', processor],
        ['router handler', handler],
        ['channel flow processor', flow],
        ['battle orchestrator', orchestrator],
      ];
      for (const [who, arn] of others) {
        if (!arn) continue;
        for (const action of ['sts:AssumeRole', 'sts:TagSession']) {
          const d = decide(arn, action, role!.arn);
          if (d === 'allowed') {
            violations.push(`${c}: the ${who} role is ALLOWED ${action} on the acting role; it could mint a session with tags of its own choosing`);
          }
        }
      }
    }
    if (!orchestrator) console.log('[vend-trust] battle is not deployed; the orchestrator was not checked');
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });

  test('the channel flow processor and the battle orchestrator send no message of their own', async () => {
    test.setTimeout(180_000);
    const violations: string[] = [];

    const appInstance = appInstanceArn();
    expect(appInstance, 'no assigned bot to read the app instance from').toBeTruthy();
    const flow = channelFlowProcessorRoleArn();
    const orchestrator = battleOrchestratorRoleArn();
    expect(flow, 'no deployed channel flow processor role').toBeTruthy();

    const channel = `${appInstance}/channel/probe-routing`;
    const principals: Array<[string, string | null]> = [
      ['channel flow processor', flow],
      ['battle orchestrator', orchestrator],
    ];
    for (const [who, arn] of principals) {
      if (!arn) continue;
      for (const c of CLASSIFICATIONS) {
        // A CHANNEL of each classification, and an UNTAGGED one, because the grant this replaced was
        // unconditioned (`${appInstance}/*`) and would have answered allowed to all of them.
        const onChannel = decide(arn, 'chime:SendChannelMessage', channel, [ctx(TAG.resourceClassification, c)]);
        if (onChannel === 'allowed') violations.push(`the ${who} role is ALLOWED chime:SendChannelMessage on a ${c} channel`);
        // AND AS A BOT: a send names the bot as its bearer, so this is the identity it would speak as.
        const bot = botFor(c, 'primary');
        if (bot) {
          const asBot = decide(arn, 'chime:SendChannelMessage', bot.botArn, [ctx(TAG.resourceClassification, bot.classificationTag)]);
          if (asBot === 'allowed') violations.push(`the ${who} role is ALLOWED chime:SendChannelMessage as the ${c} primary's bot`);
        }
      }
      const untagged = decide(arn, 'chime:SendChannelMessage', channel);
      if (untagged === 'allowed') violations.push(`the ${who} role is ALLOWED chime:SendChannelMessage on an UNTAGGED channel`);
    }
    if (!orchestrator) console.log('[vend-trust] battle is not deployed; the orchestrator was not checked');
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });
});
