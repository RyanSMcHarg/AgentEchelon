/**
 * SPEC-BILINGUAL-CONVERSATIONS — the shipped half: the assistant replies in the user's language.
 *
 * Only reply-language ships; the inference pivot and dual delivery are design. The spec's coverage
 * was recorded as blocked because "a test would need a non-English turn driven end to end" — but the
 * interesting case is the opposite one, and it is drivable: the user writes in ENGLISH and must still
 * be answered in their configured language. That is what "meet the assistant in your own language"
 * actually means, and asserting it rules out the trivial explanation that the model merely echoed the
 * language it was addressed in.
 *
 * The chain under test is real and entirely deployed:
 *   ChannelContextTable.userLanguage  (the SERVER-ONLY store)
 *     -> assembleHostGrounding (lib/host-grounding.ts)
 *     -> event.userLanguage
 *     -> "Respond in Simplified Chinese (简体中文) unless the user writes to you in a different
 *        language" injected into the system prompt (lib/async-processor-core.ts).
 *
 * In a host integration `userLanguage` is written by federated-create-conversation, which is gated on
 * a `federatedUserPoolId` this deployment does not set. So the test writes the store row itself. The
 * path from the store onwards is untouched production code.
 *
 * IT ALSO DRIVES THE NEGATIVE CONTROL, and that is the more valuable half. `userLanguage` used to be
 * read from channel Metadata, which is MEMBER-WRITABLE: a conversation's creator is made a moderator
 * of their own channel and holds `chime:UpdateChannel`, and Chime writes Name and Metadata in one
 * call, so IAM cannot separate a rename from a metadata rewrite. A member could therefore choose which
 * model answered their own turns. So this test stamps a CONFLICTING `userLanguage` into Metadata using
 * exactly that capability and requires the reply to follow the STORE anyway. Without the negative
 * control the positive case passes just as well against the old, member-writable behaviour.
 *
 * The assertion is deterministic, not a prose judgement: a Simplified Chinese reply contains Han
 * characters and an English one contains none. Counting them is objective in a way that "the reply
 * mentions X" never is.
 *
 *   AWS_PROFILE=<p> E2E_BASE_URL=<cf> npx playwright test e2e/bilingual-conversations.spec.ts
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { signIn, createConversation, sendAndWaitForResponse } from './helpers/agent-helpers';
import { getStandardUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

guardConsoleErrors();

const REGION = process.env.AWS_REGION || 'us-east-1';
const EXCHANGE_URL = (process.env.VITE_CREDENTIAL_EXCHANGE_API_URL || process.env.EXCHANGE_API_URL || '').replace(/\/$/, '');

/** An ENGLISH question. The reply language must come from configuration, not from mirroring. */
const ENGLISH_PROMPT = 'In two or three sentences, what is the main benefit of using a code review checklist?';

/** CJK Unified Ideographs. Present throughout a Simplified Chinese reply, absent from an English one. */
const HAN = /[一-鿿]/g;
const hanCount = (s: string) => (s.match(HAN) ?? []).length;

let _tmp: string | undefined;
function jsonFileArg(obj: unknown): string {
  if (!_tmp) _tmp = mkdtempSync(join(tmpdir(), 'ae-chan-'));
  const f = join(_tmp, `arg-${process.hrtime.bigint()}.json`);
  writeFileSync(f, JSON.stringify(obj), 'utf8');
  return `file://${f.replace(/\\/g, '/')}`;
}

async function exchange(idToken: string, payload: unknown): Promise<{ status: number; body: any }> {
  // Bearer scheme, and on `/exchange-credentials` rather than the API root — see moderation.spec.ts,
  // where getting either wrong produced a 403 that read like a refusal and proved nothing.
  const resp = await fetch(`${EXCHANGE_URL}/exchange-credentials`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  try { return { status: resp.status, body: JSON.parse(text) }; }
  catch { return { status: resp.status, body: { raw: text } }; }
}

/**
 * The server-only Channel Context store, resolved by name so the test is not pinned to one deployment.
 * Returns null when it is absent, which the test treats as a skip rather than a failure.
 */
function resolveChannelContextTable(): string | null {
  try {
    const raw = execSync(
      `aws dynamodb list-tables --region ${REGION} ` +
        `--query "TableNames[?contains(@, 'ChannelContextTable')]" --output json`,
      { encoding: 'utf8', timeout: 20000, env: process.env },
    );
    return (JSON.parse(raw) as string[])[0] || null;
  } catch {
    return null;
  }
}

/** Write the routing signal where production reads it: the server-only store, with the OPERATOR's creds. */
function setStoredUserLanguage(table: string, channelArn: string, userLanguage: string) {
  const item = jsonFileArg({
    channelArn: { S: channelArn },
    userLanguage: { S: userLanguage },
  });
  execSync(
    `aws dynamodb put-item --region ${REGION} --table-name ${table} --item ${item}`,
    { encoding: 'utf8', timeout: 20000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
}

/** UpdateChannel as the USER, with vended session credentials — never the operator's own profile. */
function setChannelMetadata(creds: any, channelArn: string, bearerArn: string, name: string, metadata: unknown) {
  const input = jsonFileArg({
    ChannelArn: channelArn,
    Name: name, // UpdateChannel replaces the channel record — Name must be resent or it is lost.
    Metadata: JSON.stringify(metadata),
    ChimeBearer: bearerArn,
  });
  execSync(`aws chime-sdk-messaging update-channel --cli-input-json ${input} --region ${REGION} --output json`, {
    encoding: 'utf8',
    timeout: 30000,
    env: (() => {
      // AWS_PROFILE must be DELETED, not blanked: an empty profile name makes the CLI fail before it
      // reaches Chime, which would look like a refusal and is really a call that never happened.
      const e: NodeJS.ProcessEnv = { ...process.env, MSYS_NO_PATHCONV: '1' };
      delete e.AWS_PROFILE;
      e.AWS_ACCESS_KEY_ID = creds.accessKeyId ?? creds.AccessKeyId;
      e.AWS_SECRET_ACCESS_KEY = creds.secretAccessKey ?? creds.SecretAccessKey;
      e.AWS_SESSION_TOKEN = creds.sessionToken ?? creds.SessionToken;
      return e;
    })(),
  });
}

test.describe('The assistant replies in the user\'s configured language (SPEC-BILINGUAL-CONVERSATIONS)', () => {
  guardBackendErrors('bilingual-conversations');

  test('an English question in a zh conversation is answered in Chinese', async ({ page }) => {
    test.setTimeout(300_000);

    const user = await getStandardUser();
    test.skip(!user.password, missingUserReason('standardUser'));
    test.skip(!EXCHANGE_URL, 'needs VITE_CREDENTIAL_EXCHANGE_API_URL for the UpdateChannel capability');
    const contextTable = resolveChannelContextTable();
    test.skip(!contextTable, 'ChannelContextTable not found (deploy AgentEchelonFoundations).');

    await signIn(page, user.email, user.password);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });

    const title = `Bilingual e2e ${Date.now()}`;
    const createResp = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await createConversation(page, title, 'Standard');
    const channelArn: string = (await (await createResp).json())?.conversation?.conversationArn || '';
    expect(channelArn, 'channelArn from create-conversation').toBeTruthy();
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    const idToken = await page.evaluate(() => localStorage.getItem('idToken'));
    expect(idToken, 'idToken after sign-in').toBeTruthy();

    // `rename` vends chime:UpdateChannel WITHOUT delete — the capability the rename UI already holds.
    const vended = await exchange(idToken!, { capabilities: ['rename'], channelArn });
    expect(
      vended.status,
      `could not vend the rename capability: ${JSON.stringify(vended.body).slice(0, 300)}`,
    ).toBe(200);
    const bearerArn: string = vended.body.userArn;
    expect(bearerArn, 'vended userArn (the ChimeBearer)').toBeTruthy();

    // The real configuration: the server-only store, which no member can write.
    setStoredUserLanguage(contextTable!, channelArn, 'zh');
    console.log(`\n--- userLanguage=zh written to ${contextTable} for ---\n${channelArn}`);

    // The negative control: the member writes a CONFLICTING value into channel Metadata, using the
    // real `rename` capability. If this wins, a member can steer their own conversation's model and
    // language, and the assertion below fails with an English reply.
    setChannelMetadata(vended.body.credentials, channelArn, bearerArn, title, { userLanguage: 'en' });
    console.log('--- conflicting userLanguage=en written to member-writable channel Metadata ---');

    const resp = await sendAndWaitForResponse(page, ENGLISH_PROMPT, 180_000);
    const text = resp.text ?? '';
    expect(text.length, 'the turn must return a response').toBeGreaterThan(0);

    const han = hanCount(text);
    console.log(`--- reply: ${han} Han characters of ${text.length} ---\n${text.slice(0, 160)}`);

    // A threshold rather than "at least one": a single stray ideograph inside an otherwise English
    // answer is not a Chinese reply, and would let the test pass on a deployment where the
    // instruction never reached the prompt.
    expect(
      han,
      `the STORE configures userLanguage=zh and member-writable Metadata says 'en', but the reply to ` +
        `an English question came back with ${han} Han characters. Either the reply-language ` +
        `instruction did not reach the model, or member-writable Metadata overrode the store — the ` +
        `second would mean a member can choose which model answers their own turns.\n` +
        `reply: ${text.slice(0, 400)}`,
    ).toBeGreaterThan(10);
  });
});
