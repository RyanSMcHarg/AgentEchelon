/**
 * SPEC-NOTIFICATION-BRIDGE — the outbound email hand-off can actually leave the system.
 *
 * The spec's coverage was recorded as blocked: proving DELIVERY needs a mail-capture strategy this
 * suite does not have. That framing let the whole path go unchecked, and the path was broken.
 *
 * Found by reading the live deployment rather than the code: every outbound notification was failing
 * with
 *
 *   AccessDenied: ... not authorized to perform `ses:SendEmail'
 *                 on resource `arn:aws:ses:us-east-1:...:identity/example.com'
 *
 * The IAM grant named the ADDRESS identity (`identity/assistant@example.com`), but SES authorizes
 * against whichever identity it resolves the From address to — here the verified parent DOMAIN. The
 * send failed on every invocation, and `lib/notification.ts` collects send failures instead of
 * throwing, so the caller's request still returned success and nothing surfaced. A silent total
 * outage of the feature the spec calls Implemented.
 *
 * Delivery is asserted at the end of this file, from the test inbox, when the deployment has one
 * (helpers/test-inbox.ts). AUTHORIZATION needs no mailbox, and authorization is what was broken - so this
 * first asserts the two things that must hold for a send to be possible at all:
 *
 *   1. Every deployed sender is configured with a real sender address, not the placeholder. The
 *      placeholder makes `sendEmailNotifications` skip-but-report — another silent no-op.
 *   2. Each sender's execution role is allowed `ses:SendEmail` on the identity SES will ACTUALLY
 *      resolve that address to. Simulated against the address ARN and the parent-domain ARN, and
 *      required to be allowed on whichever of the two is the verified identity. Simulating only the
 *      address ARN is exactly the assumption that produced the outage.
 *
 * SES sandbox state is REPORTED, not asserted: in sandbox, delivery is limited to verified
 * recipients, which is a deployer's account decision rather than a defect in this code.
 *
 * No browser step: this path has no UI surface, so a DOM assertion would be theatre.
 *
 *   AWS_PROFILE=<p> npx playwright test e2e/notification-bridge.spec.ts --config=playwright.config.ts
 */
import { test, expect, expectAlarm } from './helpers/fixtures';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { signIn, createConversation } from './helpers/agent-helpers';
import { getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { personArnOf, personIdOf, testUserByPersonArn } from './helpers/person';
import { getTestInbox, inboxSkipReason, waitForEmail, emailsTo } from './helpers/test-inbox';
import { STACK_PREFIX, INSTANCE, instanceStacks, physicalIdsIn, ANY_FUNCTION } from './helpers/stack-prefix';
import { aws, awsv } from './helpers/aws';

guardBackendErrors('notification-bridge');
// The admin-alert test signs in and drives the chat, so browser console errors fail it like any other.
guardConsoleErrors();

const AWS_PROFILE = process.env.AWS_PROFILE || '';
const REGION = process.env.AWS_REGION || 'us-east-1';
const PLACEHOLDER_SENDER = 'noreply@example.com'; // lib/notification.ts PLACEHOLDER_SENDER
const haveCreds = () => Boolean(AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);

interface Sender {
  fn: string;
  role: string;
  senderEmail: string;
}

test.describe('The outbound email hand-off is authorized to send (SPEC-NOTIFICATION-BRIDGE)', () => {
  test('every deployed email sender can actually reach SES', async () => {
    test.skip(!haveCreds(), 'needs AWS credentials — set AWS_PROFILE');
    test.setTimeout(300_000);

    const account = aws('sts get-caller-identity')?.Account;
    expect(account, 'caller identity should resolve').toBeTruthy();

    // DISCOVER the senders rather than hard-coding them: a new Lambda that sends email inherits
    // this check automatically, which a fixed list would not.
    //
    // The --query projects the three fields needed and nothing else, for two reasons. It keeps the
    // expression free of spaces, single quotes and backticks — execSync goes through cmd.exe on
    // Windows, where those are not quoting characters and a normal JMESPath filter arrives mangled.
    // And it never serializes `Description`, one of which contains a '→': the CLI is Python, encodes
    // stdout in the Windows console codepage, and aborts the ENTIRE call on a charmap error rather
    // than returning JSON. (PYTHONIOENCODING does not help — CLI v2 is a frozen binary.)
    const q = 'Functions[].{n:FunctionName,r:Role,e:Environment.Variables.SENDER_EMAIL}';
    const all: any[] = aws(`lambda list-functions --query ${q}`) ?? [];
    expect(all.length, 'Lambdas should be discoverable').toBeGreaterThan(0);

    // This is a MULTI-PROJECT account — other stacks deploy their own senders, some of them
    // deliberately on the placeholder. Only this deployment's are this spec's business, and a function
    // is this deployment's when one of its stacks holds it (helpers/stack-prefix.ts), not when its
    // generated name happens to carry a prefix.
    const ours = new Set(physicalIdsIn(instanceStacks(), ANY_FUNCTION));
    const senders: Sender[] = all
      .filter((f) => f.e && ours.has(String(f.n)))
      .map((f) => ({ fn: f.n, role: String(f.r).split('/').pop()!, senderEmail: f.e }));

    console.log(`\n--- deployed email senders (${senders.length}) ---`);
    for (const s of senders) console.log(`  ${s.fn}\n    sender=${s.senderEmail} role=${s.role}`);

    // The spec claims the outbound hand-off is Implemented. Zero deployed senders would make every
    // assertion below vacuously true, so the claim itself is the first thing checked.
    expect(
      senders.length,
      'SPEC-NOTIFICATION-BRIDGE claims a shipped outbound email hand-off, so at least one deployed Lambda must be configured to send',
    ).toBeGreaterThan(0);

    // Report the account posture. Sandbox limits delivery to verified recipients — a real constraint
    // on this deployment, but the deployer's decision, not a defect in the bridge.
    const sandboxed = aws('sesv2 get-account')?.ProductionAccessEnabled === false;
    console.log(
      `\n--- SES account ---\n  production access: ${!sandboxed}` +
        (sandboxed ? '\n  SANDBOX: delivery is limited to VERIFIED recipients.' : ''),
    );

    const verification = (identities: string[]) =>
      aws(`ses get-identity-verification-attributes --identities ${identities.map((i) => `"${i}"`).join(' ')}`)
        ?.VerificationAttributes ?? {};

    const failures: string[] = [];
    const active: string[] = [];
    const inert: string[] = [];

    for (const s of senders) {
      // 1) A placeholder sender is a silent no-op: lib/notification.ts skips the send and reports it.
      if (s.senderEmail === PLACEHOLDER_SENDER) {
        failures.push(`${s.fn}: SENDER_EMAIL is the placeholder ${PLACEHOLDER_SENDER} — sends are skipped, never delivered`);
        continue;
      }

      const domain = s.senderEmail.split('@').pop()!;
      const attrs = verification([s.senderEmail, domain]);
      const addressVerified = attrs[s.senderEmail]?.VerificationStatus === 'Success';
      const domainVerified = attrs[domain]?.VerificationStatus === 'Success';

      console.log(
        `\n--- ${s.senderEmail} ---\n  address identity: ${attrs[s.senderEmail]?.VerificationStatus ?? 'absent'}` +
          `\n  domain identity (${domain}): ${attrs[domain]?.VerificationStatus ?? 'absent'}`,
      );

      // 2) SES must be able to resolve the From address to SOME verified identity.
      if (!addressVerified && !domainVerified) {
        failures.push(
          `${s.fn}: neither ${s.senderEmail} nor ${domain} is a verified SES identity — no send can succeed`,
        );
        continue;
      }

      // 3) The role must be allowed on the identity SES will resolve to. Both are simulated so the
      //    log shows the full picture; only the VERIFIED one(s) must be allowed, because that is the
      //    resource that appears in the authorization decision at send time.
      const roleArn = `arn:aws:iam::${account}:role/${s.role}`;
      const denialsOnVerified: string[] = [];
      let anyAllowed = false;

      for (const [identity, isVerified] of [
        [s.senderEmail, addressVerified],
        [domain, domainVerified],
      ] as Array<[string, boolean]>) {
        const resource = `arn:aws:ses:${REGION}:${account}:identity/${identity}`;
        const decision = aws(
          `iam simulate-principal-policy --policy-source-arn "${roleArn}" ` +
            `--action-names ses:SendEmail --resource-arns "${resource}"`,
        )?.EvaluationResults?.[0]?.EvalDecision;

        console.log(`  ses:SendEmail on identity/${identity} => ${decision}${isVerified ? '  (VERIFIED)' : ''}`);

        if (decision === 'allowed') anyAllowed = true;
        if (isVerified && decision !== 'allowed') {
          denialsOnVerified.push(
            `${s.fn}: role ${s.role} is ${decision} for ses:SendEmail on ${resource}, ` +
              `which is a VERIFIED identity SES can resolve ${s.senderEmail} to — sends fail with AccessDenied`,
          );
        }
      }

      // A role holding NO SES grant at all is not a misconfigured sender — it is a sender that is
      // switched OFF in this deployment. A sender whose SES grant is gated on a context value the
      // deployment does not set is the real case: it ships with SENDER_EMAIL but no way to address
      // or send. That is the documented design, not a defect, and failing on it would be a false
      // alarm.
      //
      // The post-processing consumer, which carries the notify fan-out, gates BOTH its SENDER_EMAIL
      // and its grants on `federatedUserPoolId`, so on a deployment without one it is not a sender
      // here at all rather than an inert one.
      //
      // The bug this spec exists for looks DIFFERENT: granted on one identity, denied on the one SES
      // actually resolves to. That is `anyAllowed && denialsOnVerified.length`, and it still fails.
      if (!anyAllowed) {
        inert.push(`${s.fn} (sender configured, but the role holds no ses:SendEmail grant)`);
        continue;
      }
      active.push(s.fn);
      failures.push(...denialsOnVerified);
    }

    console.log(`\n--- active senders: ${active.length}, inert: ${inert.length} ---`);
    for (const i of inert) console.log(`  INERT: ${i}`);

    // Guards the exemption above: if every sender were switched off, the loop would find nothing to
    // check and report green. At least one must really be wired to send.
    expect(
      active.length,
      `no ${STACK_PREFIX} Lambda is actually granted SES sending — the outbound hand-off cannot work anywhere.\n  inert: ${inert.join('\n  ')}`,
    ).toBeGreaterThan(0);

    expect(failures, `outbound email cannot leave the system:\n  - ${failures.join('\n  - ')}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// An admin alert, end to end: posted AS THE ADMIN AGENT, and emailed to the channel's MEMBERS.
// ---------------------------------------------------------------------------------------------------

const RUN_ADMIN_ALERT = process.env.ADMIN_ALERT_E2E === '1';

/** An SSM parameter's value, or '' when it is absent. Absent is a configuration answer, not an error. */
function ssmValue(name: string): string {
  try {
    return String(awsv(['ssm', 'get-parameter', '--name', name])?.Parameter?.Value || '');
  } catch {
    return '';
  }
}

/**
 * The AppInstanceUser an email signs in as, through the same records the bridge uses: the deployment pool's
 * user for that address, and the Identities row the credential exchange wrote for its subject. '' when either
 * is absent. The test secret names only some people (the seed points its standard users at the demo
 * users), so an address it does not name is resolved here rather than counted as a non-member.
 */
function personArnForAddress(email: string, poolId: string, identitiesTable: string): string {
  try {
    const users = (awsv(['cognito-idp', 'list-users', '--user-pool-id', poolId, '--filter', `email = "${email}"`])?.Users ?? []) as any[];
    const sub = String((users[0]?.Attributes ?? []).find((a: any) => a?.Name === 'sub')?.Value || '');
    if (!sub) return '';
    const row = awsv(['dynamodb', 'get-item', '--table-name', identitiesTable, '--consistent-read',
      '--key', JSON.stringify({ issuerSubject: { S: `deployment|${sub}` } })])?.Item;
    return String(row?.personArn?.S || '');
  } catch {
    return '';
  }
}

/** Every member ARN of a channel, paginated, read as the given bearer. */
function memberArns(channelArn: string, bearer: string): string[] {
  const arns: string[] = [];
  let token: string | undefined;
  for (let i = 0; i < 20; i += 1) {
    const r = awsv(['chime-sdk-messaging', 'list-channel-memberships', '--channel-arn', channelArn,
      '--chime-bearer', bearer, '--max-results', '50', ...(token ? ['--next-token', token] : [])]);
    arns.push(...((r?.ChannelMemberships ?? []) as any[]).map((m) => String(m?.Member?.Arn || '')).filter(Boolean));
    token = r?.NextToken;
    if (!token) break;
  }
  return arns;
}

function decode(content: string): string {
  try { return decodeURIComponent(content); } catch { return content; }
}

/**
 * THE ALERT PATH, WHICH NOTHING HAD EVER DRIVEN.
 *
 * DESIGN-ADMIN-AGENT-NOTIFICATIONS moved the admin alert's sender from the service app-instance-admin
 * to an admin-agent bot, because the service admin is not a member of the RESTRICTED + PRIVATE alert
 * channel and a post bearing it is refused. The rework is unit-tested; what no test had done is post
 * an alert and look at what landed. Two claims ride on that one alert:
 *
 *   293 - THE SENDER. The alert in the admin channel is sent by the admin-agent bot whose ARN the
 *         deployment publishes at `/<instance>/assistant/admin-agent/bot-arn`, and the service admin
 *         is neither the sender nor a member of the channel.
 *
 *   3   - THE RECIPIENTS. The email fan-out resolves WHO from live channel membership, never from the
 *         roster in channel Metadata, which a channel moderator can rewrite. On this channel the two
 *         are identical by construction (the provisioner stamps the roster from the same admin set),
 *         so reading one where the other is meant would pass unnoticed. The test therefore makes them
 *         DIFFER for the duration of the alert: it writes a decoy - a real person who is not a member -
 *         into `Metadata.participants`, as the channel's moderator could, and requires that the decoy
 *         is not sent to while a member is. It also checks that an ordinary conversation's Metadata
 *         carries no roster at all, which is where the roster was moved out of.
 *
 * HOW THE ALERT IS PRODUCED. A real uncleared membership: a basic user is added to a premium
 * conversation through Amazon Chime SDK directly, as the app-instance-admin - the bypass of the
 * product's own share gate that the membership audit exists to catch. The audit then runs from the
 * membership event stream exactly as it would for a real incident. Nothing is invoked by hand and no
 * claim is fabricated. The membership is removed afterwards (the audit may already have revoked it)
 * and the channel Metadata is restored.
 *
 * WHAT DELIVERY MEANS HERE. Who the fan-out tried to reach is read from the notification bridge's own
 * `notify fan-out` log record (the Notifications stack's `NotificationBridgeFunction`), which lists the
 * addresses it emailed and failed. What ARRIVED is read from the test inbox when the deployment has one
 * and the member's address is on its domain: the member received the `[Security]` mail and the decoy
 * received none. In an SES sandbox an unverified recipient is refused by SES rather than by this code;
 * that is reported, as the test above reports sandbox posture, and the recipient is still required to
 * have been RESOLVED.
 *
 * Gated by ADMIN_ALERT_E2E=1 because it produces a real security finding (and a real admin email) on
 * the deployment. Needs `admin` in capabilities (the admin notification channel); without it the deployment has no
 * alert channel and the test skips, saying so.
 */
test.describe('An admin alert is posted as the admin agent and emailed to the channel\'s members (DESIGN-ADMIN-AGENT-NOTIFICATIONS)', () => {
  test.skip(!RUN_ADMIN_ALERT, 'set ADMIN_ALERT_E2E=1 (runs via validate.mjs --only=notifications); it induces a real uncleared membership finding');

  test('an uncleared membership alert lands in the admin channel from the admin agent, and is sent to members, not to the Metadata roster', async ({ page }) => {
    test.skip(!haveCreds(), 'needs AWS credentials - set AWS_PROFILE');
    test.skip(!hasTestCredentials(), 'needs the provisioned test users');
    test.setTimeout(600_000);
    // The finding this test induces is an operator notice by design.
    expectAlarm('membership_audit_finding');

    const alertChannelArn = ssmValue(`/${INSTANCE}/admin-notification/channel-arn`);
    test.skip(
      !alertChannelArn,
      `/${INSTANCE}/admin-notification/channel-arn is not published: this deployment did not enable the admin `
        + 'notification channel (admin is not a declared capability), so alerts are log-only by design',
    );
    const agentBotArn = ssmValue(`/${INSTANCE}/assistant/admin-agent/bot-arn`);
    const serviceAdminArn = ssmValue(`/${INSTANCE}/app-instance-admin-arn`);
    expect(agentBotArn, 'the admin channel is enabled, so the admin-agent bot ARN must be published').toContain('/bot/');
    expect(serviceAdminArn, 'the service app-instance-admin ARN must be published').toContain('/user/');

    const creds = await getTestCredentials();
    test.skip(!creds.premiumUser.password, missingUserReason('premiumUser'));
    test.skip(!creds.basicUser.password, missingUserReason('basicUser'));

    // ── THE CHANNEL'S IDENTITIES, before anything is driven ────────────────────────────────────
    const members = memberArns(alertChannelArn, serviceAdminArn);
    console.log(`\n--- admin channel ${alertChannelArn}\n    members: ${members.join(', ')}`);
    expect(
      members,
      'the service app-instance-admin is a MEMBER of the admin channel. It is only the member-add bearer; '
        + 'as a member it is a sender the design removed',
    ).not.toContain(serviceAdminArn);
    const moderators: string[] = ((awsv(['chime-sdk-messaging', 'list-channel-moderators', '--channel-arn',
      alertChannelArn, '--chime-bearer', agentBotArn])?.ChannelModerators ?? []) as any[])
      .map((m) => String(m?.Moderator?.Arn || ''));
    expect(moderators, 'the admin-agent bot does not moderate the channel it is meant to have created').toContain(agentBotArn);

    // A member's email, for the test users the secret carries: the inbox can observe only those.
    const memberEmails: string[] = [];
    for (const arn of members.filter((a) => a.includes('/user/'))) {
      const user = await testUserByPersonArn(arn);
      if (user) memberEmails.push(user.email);
    }
    expect(memberEmails.length, 'the admin channel has no human member with an email, so nobody could be notified').toBeGreaterThan(0);

    const basicArn = await personArnOf(creds.basicUser);
    expect(basicArn, 'the basic user must resolve to an AppInstanceUser').toContain('/user/');
    const basicPersonId = personIdOf(basicArn);
    const decoyEmail = creds.basicUser.email;
    expect(decoyEmail, 'the decoy must have an email, or a send to it could not be observed').toBeTruthy();
    expect(
      memberEmails,
      'PRECONDITION: the decoy must NOT be a member of the admin channel, or a send to it proves nothing',
    ).not.toContain(decoyEmail);

    // ── AN ORDINARY CONVERSATION, created the product's way ────────────────────────────────────
    await signIn(page, creds.premiumUser.email, creds.premiumUser.password);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
    const createResp = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await createConversation(page, `Admin alert e2e ${Date.now()}`, 'Premium');
    const channelArn: string = (await (await createResp).json())?.conversation?.conversationArn || '';
    expect(channelArn, 'channelArn from create-conversation').toBeTruthy();

    // The storage half: no recipient roster in member-writable Metadata.
    const convMeta = JSON.parse(awsv(['chime-sdk-messaging', 'describe-channel', '--channel-arn', channelArn,
      '--chime-bearer', serviceAdminArn])?.Channel?.Metadata || '{}');
    expect(
      { participants: convMeta.participants, memberIdentities: convMeta.memberIdentities },
      'a conversation carries a member roster in channel Metadata, which any moderator of it can rewrite',
    ).toEqual({ participants: undefined, memberIdentities: undefined });

    // ── THE DECOY: make the Metadata roster and the membership DIFFER ──────────────────────────
    const described = awsv(['chime-sdk-messaging', 'describe-channel', '--channel-arn', alertChannelArn,
      '--chime-bearer', agentBotArn])?.Channel ?? {};
    const originalMetadata: string = described.Metadata || '';
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(originalMetadata || '{}'); } catch { parsed = {}; }
    const roster = Array.isArray(parsed.participants) ? (parsed.participants as unknown[]) : [];
    // The decoy in the SAME shape the roster already holds, so a reader of that roster would take it.
    const decoyEntry = roster.length && typeof roster[0] === 'object' ? { sub: basicPersonId } : basicPersonId;
    const updateMetadata = (metadata: string) => awsv(['chime-sdk-messaging', 'update-channel',
      '--channel-arn', alertChannelArn, '--name', String(described.Name || 'Admin Notifications'),
      '--mode', String(described.Mode || 'RESTRICTED'), '--metadata', metadata, '--chime-bearer', agentBotArn]);

    const since = Date.now() - 5_000;
    try {
      updateMetadata(JSON.stringify({ ...parsed, participants: [...roster, decoyEntry] }));

      // ── THE INCIDENT ───────────────────────────────────────────────────────────────────────────
      awsv(['chime-sdk-messaging', 'create-channel-membership', '--channel-arn', channelArn,
        '--member-arn', basicArn, '--type', 'DEFAULT', '--chime-bearer', serviceAdminArn]);

      // ── The alert, SETTLED, and who sent it ───────────────────────────────────────────
      let alert: any = null;
      for (let i = 0; i < 48 && !alert; i += 1) {
        const r = awsv(['chime-sdk-messaging', 'list-channel-messages', '--channel-arn', alertChannelArn,
          '--chime-bearer', serviceAdminArn, '--max-results', '50', '--sort-order', 'DESCENDING']);
        alert = ((r?.ChannelMessages ?? []) as any[]).find((m) => {
          const text = decode(String(m?.Content || ''));
          return text.includes(channelArn) && text.includes(basicArn);
        }) ?? null;
        if (!alert) await page.waitForTimeout(5_000);
      }
      console.log(`--- alert: ${alert ? `${alert.MessageId} from ${alert.Sender?.Arn}` : 'none'}`);
      expect(
        alert,
        'no alert naming this uncleared membership reached the admin channel within 4 minutes. Either the '
          + 'audit did not flag it, or its post was refused - which is what a post by an identity that is not a '
          + 'member of a RESTRICTED + PRIVATE channel looks like',
      ).toBeTruthy();
      expect(
        alert.Sender?.Arn,
        'the admin alert was not sent by the admin-agent bot. The service app-instance-admin is not a member '
          + 'of this channel and must not be its sender',
      ).toBe(agentBotArn);

      // ── Who the fan-out sent to ─────────────────────────────────────────────────────────
      //
      // THE FAN-OUT RUNS IN THE NOTIFICATION BRIDGE (`notification-bridge.ts`, ADR-041 decision 7), not
      // in the function that posted the alert: the audit posts the notice with a `notify` directive, and
      // the Notifications stack's own consumer on the message stream emails the room off the reply path.
      // It logs one `notify fan-out` record per message (`lib/notify-on-delivery.ts`), with the addresses
      // it emailed, skipped and failed.
      const bridgeFn = String(awsv(['cloudformation', 'describe-stack-resources', '--stack-name',
        `${STACK_PREFIX}Notifications`, '--query',
        "StackResources[?ResourceType=='AWS::Lambda::Function' && starts_with(LogicalResourceId,'NotificationBridgeFunction')].PhysicalResourceId | [0]"]) || '');
      expect(
        bridgeFn,
        'the Notifications stack holds no NotificationBridgeFunction. It is built only when a trusted issuer '
          + 'holds contacts (notifyBridge), and without it no alert is emailed to anyone',
      ).toBeTruthy();
      let lines: string[] = [];
      for (let i = 0; i < 24; i += 1) {
        const r = awsv(['logs', 'filter-log-events', '--log-group-name', `/aws/lambda/${bridgeFn}`,
          '--start-time', String(since), '--filter-pattern', '"notify fan-out"', '--query', 'events[].message']);
        lines = ((r ?? []) as unknown[]).map((l) => String(l));
        if (lines.length) break;
        await page.waitForTimeout(5_000);
      }
      console.log(`--- fan-out log (${lines.length}):\n  ${lines.map((l) => l.slice(0, 240)).join('\n  ')}`);

      // Each record lists `emailed: [...]` and `failed: [...]`; an address may appear in either.
      const listed = (l: string, key: 'emailed' | 'failed'): string[] =>
        [...(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(l)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
      const attempted = new Map<string, 'sent' | 'error'>();
      for (const l of lines) {
        for (const a of listed(l, 'emailed')) attempted.set(a, 'sent');
        for (const a of listed(l, 'failed')) if (!attempted.has(a)) attempted.set(a, 'error');
      }
      const addresses = [...attempted.keys()];
      expect(
        addresses.filter((a) => memberEmails.includes(a)),
        'the alert was emailed to NO member of the admin channel',
      ).not.toEqual([]);
      expect(
        addresses,
        'the alert was sent to the DECOY - a person named only in the channel\'s Metadata roster. Recipients '
          + 'are being read from member-writable Metadata, so a moderator can have alerts mailed to anyone',
      ).not.toContain(decoyEmail);
      // An address the secret does not name is resolved to the person it signs in as, so a member the
      // secret leaves out (an admin the seed no longer lists) still counts as a member.
      const poolId = String(creds.cognitoUserPoolId || '');
      const identitiesTable = ssmValue(`/${INSTANCE}/shared/tables/identities-name`);
      const notMembers = addresses.filter((a) => !memberEmails.includes(a)
        && !members.includes(personArnForAddress(a, poolId, identitiesTable)));
      expect(notMembers, 'the alert was emailed to somebody who is not a member of the admin channel').toEqual([]);

      // A refusal BY SES is the account's posture, not this code's, but only in a sandbox.
      const refused = addresses.filter((a) => memberEmails.includes(a) && attempted.get(a) === 'error');
      if (refused.length) {
        const sandboxed = aws('sesv2 get-account')?.ProductionAccessEnabled === false;
        expect(
          sandboxed,
          `SES refused the send to member(s) ${refused.join(', ')} on an account with production access`,
        ).toBe(true);
        console.log(`  SANDBOX: SES refused ${refused.join(', ')} (unverified recipient). Resolved correctly; not delivered.`);
      }

      // ── What ARRIVED, read from the test inbox ─────────────────────────────────────────────
      //
      // The log says what the bridge attempted; the inbox says what a member received. Only a member the
      // bridge reports as SENT and whose address the inbox can observe is awaited, so a sandbox refusal
      // reported above is not read as a lost mail. The decoy is checked after a member's mail arrived:
      // the fan-out sends one message's recipients in a single pass, so by then the decoy had its turn.
      const inbox = await getTestInbox();
      const observable = memberEmails.filter((a) => attempted.get(a) === 'sent' && !inboxSkipReason(inbox, a));
      if (!inbox || !observable.length) {
        const why = inboxSkipReason(inbox, ...memberEmails) || 'no member the bridge reports as sent has an address on the inbox domain';
        console.log(`  DELIVERY NOT READ: ${why}`);
        test.info().annotations.push({ type: 'delivery-not-read', description: why });
        // A release gate treats an unproven delivery as it treats a skip (reporters/skip-visibility.ts).
        expect(process.env.E2E_REQUIRE_ALL === '1' ? why : '', 'E2E_REQUIRE_ALL=1 and the alert\'s delivery could not be read').toBe('');
      } else {
        const member = observable[0];
        // The first [Security] mail proves arrival; THIS finding's is the one naming its conversation, and
        // another finding in the same window may land first.
        await waitForEmail(inbox, { to: member, since, subjectIncludes: '[Security]' });
        let mine = emailsTo(inbox, { to: member, since, subjectIncludes: '[Security]' }).find((m) => m.text.includes(channelArn));
        for (let i = 0; i < 12 && !mine; i += 1) {
          await page.waitForTimeout(5_000);
          mine = emailsTo(inbox, { to: member, since, subjectIncludes: '[Security]' }).find((m) => m.text.includes(channelArn));
        }
        expect(mine, `${member} received no [Security] mail naming ${channelArn}`).toBeTruthy();
        console.log(`--- delivered to ${member}: "${mine!.subject}"`);
        if (!inboxSkipReason(inbox, decoyEmail)) {
          expect(
            emailsTo(inbox, { to: decoyEmail, since, subjectIncludes: '[Security]' }),
            'the DECOY received the [Security] mail: recipients are being read from member-writable Metadata',
          ).toEqual([]);
        }
      }
    } finally {
      try {
        updateMetadata(originalMetadata || '{}');
      } catch (err) {
        console.error(`!!! could not restore the admin channel Metadata; restore it by hand to: ${originalMetadata}\n${err}`);
      }
      try {
        awsv(['chime-sdk-messaging', 'delete-channel-membership', '--channel-arn', channelArn,
          '--member-arn', basicArn, '--chime-bearer', serviceAdminArn]);
      } catch { /* the audit may already have revoked it */ }
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// A mention addresses an email: to the member it names, and to nobody else. READ FROM THE INBOX.
// ---------------------------------------------------------------------------------------------------

/**
 * SPEC-NOTIFICATION-BRIDGE FR4/FR5: outside the admin channel an email is addressed by a delimited mention
 * (`@<Name|id>`), bounded to the room's members, and a person's message without one emails nobody even
 * when it carries the email flag. The tests above can show only that a send was attempted; this reads the
 * delivered mail from the test inbox, so it asserts who RECEIVED it, what it says and where its link goes.
 *
 * Messages are posted with the AWS CLI as the room's assistant and as a person, because that is exactly
 * what the bridge reads (the stored message and its Metadata off the stream); the composer has no email
 * flag. ABSENCE IS ORDERED, not timed: each "nobody else" message is sent BEFORE a message whose email is
 * awaited in the same room, the stream delivers a channel's messages in order, and the fan-out sends one
 * message's recipients in a single pass. So once the later email has arrived, the earlier one had its turn.
 */
test.describe('A mention emails the member it names, and nobody else (SPEC-NOTIFICATION-BRIDGE FR4, FR5)', () => {
  test("an assistant's mention and a person's mention each reach only the named member; a person without one reaches no one", async ({ page }) => {
    test.skip(!haveCreds(), 'needs AWS credentials - set AWS_PROFILE');
    test.skip(!hasTestCredentials(), 'needs the provisioned test users');
    test.setTimeout(600_000);

    const creds = await getTestCredentials();
    const sender = creds.premiumUser;
    const named = creds.secondPremiumUser;
    test.skip(!sender?.password, missingUserReason('premiumUser'));
    test.skip(!named?.password, missingUserReason('secondPremiumUser'));
    const inbox = await getTestInbox();
    const unavailable = inboxSkipReason(inbox, sender.email, named!.email);
    test.skip(Boolean(unavailable), unavailable);

    const nameOf = (email: string) => String(((awsv(['cognito-idp', 'admin-get-user',
      '--user-pool-id', creds.cognitoUserPoolId, '--username', email])?.UserAttributes ?? []) as any[]).find((a) => a?.Name === 'name')?.Value || '');
    const senderArn = await personArnOf(sender);
    const namedArn = await personArnOf(named!);
    const namedName = nameOf(named!.email) || 'Test Premium Two';
    expect(senderArn.includes('/user/') && namedArn.includes('/user/'), 'both test users must resolve to an AppInstanceUser').toBe(true);
    const serviceAdminArn = ssmValue(`/${INSTANCE}/app-instance-admin-arn`);
    expect(serviceAdminArn, 'the service app-instance-admin ARN must be published').toContain('/user/');

    // ── THE ROOM: a premium conversation opened the product's way, with the named person as a member ──
    await signIn(page, sender.email, sender.password);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
    const createResp = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await createConversation(page, `Mention email e2e ${Date.now()}`, 'Premium');
    const channelArn: string = (await (await createResp).json())?.conversation?.conversationArn || '';
    expect(channelArn, 'channelArn from create-conversation').toBeTruthy();
    const channelId = channelArn.split('/channel/').pop() || '';
    awsv(['chime-sdk-messaging', 'create-channel-membership', '--channel-arn', channelArn,
      '--member-arn', namedArn, '--type', 'DEFAULT', '--chime-bearer', serviceAdminArn]);
    let botArn = '';
    for (let i = 0; i < 12 && !botArn; i += 1) {
      botArn = memberArns(channelArn, serviceAdminArn).find((a) => a.includes('/bot/')) || '';
      if (!botArn) await page.waitForTimeout(5_000);
    }
    expect(botArn, 'the conversation has no assistant member to post as').toBeTruthy();

    const run = `${Date.now()}`;
    const since = Date.now() - 5_000;
    const mention = `@<${namedName}|${personIdOf(namedArn)}>`;
    const post = (bearer: string, content: string, subject: string) => awsv(['chime-sdk-messaging', 'send-channel-message',
      '--channel-arn', channelArn, '--content', content, '--type', 'STANDARD', '--persistence', 'PERSISTENT',
      '--metadata', JSON.stringify({ notify: { email: true }, notifySubject: subject, notifyConversationId: channelId }),
      '--chime-bearer', bearer]);

    // ── 1. AN ASSISTANT'S MENTION ──────────────────────────────────────────────────────────────────
    const assistantSubject = `Mention e2e assistant ${run}`;
    post(botArn, `${mention} Report generation is running slow.`, assistantSubject);
    const got = await waitForEmail(inbox!, { to: named!.email, since, subjectIncludes: assistantSubject });
    console.log(`--- delivered ${got.key}: "${got.subject}"\n${got.text.slice(0, 400)}`);
    expect(got.text, 'the email body shows the mention as the name a person reads')
      .toContain(`@${namedName} Report generation is running slow.`);
    expect(got.text, 'the email body carries the raw mention token').not.toContain('@<');
    expect(got.text, 'the email does not link into the conversation it names').toContain(`?conversation=${channelId}`);
    expect(
      emailsTo(inbox!, { to: sender.email, since, subjectIncludes: assistantSubject }),
      "the assistant's mention named one member, and another member was emailed too",
    ).toEqual([]);

    // ── 2. A PERSON WITHOUT A MENTION, THEN A PERSON WITH ONE ─────────────────────────────────────
    // The unaddressed message goes FIRST, so the addressed one's arrival proves the first had its turn.
    const unaddressedSubject = `Mention e2e unaddressed ${run}`;
    const personSubject = `Mention e2e person ${run}`;
    post(senderArn, 'Everyone, the report is slow again.', unaddressedSubject);
    post(senderArn, `${mention} can you look at the report latency?`, personSubject);
    const fromPerson = await waitForEmail(inbox!, { to: named!.email, since, subjectIncludes: personSubject });
    expect(fromPerson.text).toContain(`@${namedName} can you look at the report latency?`);
    expect(
      emailsTo(inbox!, { to: sender.email, since, subjectIncludes: personSubject }),
      'a person who mentioned someone was emailed their own message',
    ).toEqual([]);
    for (const who of [named!.email, sender.email]) {
      expect(
        emailsTo(inbox!, { to: who, since, subjectIncludes: unaddressedSubject }),
        `a person's message that mentions no one emailed ${who}: their own Metadata reached the room`,
      ).toEqual([]);
    }
  });
});
