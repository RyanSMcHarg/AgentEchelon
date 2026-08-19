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
 * Delivery still cannot be asserted without a mailbox. AUTHORIZATION can, and authorization is what
 * was broken — so this asserts the two things that must hold for a send to be possible at all:
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
import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { guardBackendErrors } from './helpers/turn-guards';

guardBackendErrors('notification-bridge');

const AWS_PROFILE = process.env.AWS_PROFILE || '';
const REGION = process.env.AWS_REGION || 'us-east-1';
const PLACEHOLDER_SENDER = 'noreply@example.com'; // lib/notification.ts PLACEHOLDER_SENDER
const haveCreds = () => Boolean(AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);

function aws(args: string): any {
  const out = execSync(`aws ${args} --region ${REGION} --output json`, {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ...(AWS_PROFILE ? { AWS_PROFILE } : {}),
      MSYS_NO_PATHCONV: '1',
      // The CLI is Python and defaults to the Windows console codepage; a non-Latin-1 character
      // anywhere in a Lambda's config (one description carries a '→') then aborts the whole call
      // with a charmap encode error rather than returning JSON.
      PYTHONIOENCODING: 'utf-8',
    },
  }).trim();
  return out ? JSON.parse(out) : null;
}

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
    // deliberately on the placeholder. Only AgentEchelon's are this spec's business.
    const senders: Sender[] = all
      .filter((f) => f.e && String(f.n).includes('AgentEchelon'))
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
      // switched OFF in this deployment. The channel-flow notify bridge is the real case: its whole
      // NotifyBridgePolicy (Cognito lookup + SES) is gated on a `federatedUserPoolId` this
      // deployment does not set, so it ships with SENDER_EMAIL but no way to address or send. That
      // is the documented design, not a defect, and failing on it would be a false alarm.
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
      `no AgentEchelon Lambda is actually granted SES sending — the outbound hand-off cannot work anywhere.\n  inert: ${inert.join('\n  ')}`,
    ).toBeGreaterThan(0);

    expect(failures, `outbound email cannot leave the system:\n  - ${failures.join('\n  - ')}`).toEqual([]);
  });
});
