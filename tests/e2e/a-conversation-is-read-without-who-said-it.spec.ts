/**
 * A CONVERSATION IS READ WITHOUT WHO SAID IT, ON THE DEPLOYED API (SPEC-ADMIN-CONSOLE FR54).
 *
 * Reads real de-identified copies through the signed admin route the console uses, and checks what a
 * unit test cannot: that the copies the deployed batch wrote name nobody. Every person is a pseudonym,
 * no test user's email address survives in what was said, a removed message carries no text, and a read
 * without a stated reason is refused before anything is returned.
 *
 * THE COPY IS DERIVED ONCE A DAY (02:00 UTC by default), so a deployment younger than its first run has
 * none. When none of the conversations read has a copy, the spec runs the deployed batch once on a
 * sample of the most recently changed conversations, the manual run the batch documents for proving a
 * change, and reads again. The read itself still goes through the signed admin route.
 */
import { test, expect } from './helpers/fixtures';
import { signIn, idTokenOf } from './helpers/agent-helpers';
import { getAdminUser, getBasicUser, getPremiumUser, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { signedAdminGet } from './helpers/signed-analytics';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';
import { aws } from './helpers/aws';
import { physicalIdsIn, stackName } from './helpers/stack-prefix';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

guardConsoleErrors();

const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || '';
/** Each conversation costs detector calls, so the sample is a few, never the whole archive. */
const SAMPLE = 5;

/**
 * Run the deployed de-identification batch once on a sample and wait for it to end. It is found in the
 * archive stack by its logical id, and its own report says how it ended.
 */
function runBatchOnASample(): { outcome: string; conversations: number; failure: string | null } {
  const [fn] = physicalIdsIn([stackName('Archive')], { type: 'AWS::Lambda::Function', logicalId: /^CleanCopyBatchFunction/ });
  if (!fn) throw new Error(`no CleanCopyBatchFunction in ${stackName('Archive')}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-copy-'));
  const inFile = path.join(dir, 'in.json');
  const outFile = path.join(dir, 'out.json');
  fs.writeFileSync(inFile, JSON.stringify({ maxConversations: SAMPLE }));
  aws(`lambda invoke --function-name ${fn} --cli-binary-format raw-in-base64-out --cli-read-timeout 0 --payload fileb://${inFile} ${outFile}`, { timeoutMs: 600_000 });
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}
const API = ADMIN_API_URL ? adminUrl('admin-conversations', '/admin/conversations') : '';
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;

test.describe('the de-identified copy on the deployed API', () => {
  test.skip(!hasTestCredentials(), 'Needs provisioned test users.');
  guardBackendErrors('a-conversation-is-read-without-who-said-it');

  test('names nobody, and is refused without a reason', async ({ browser }) => {
    test.setTimeout(600_000);
    test.skip(!ADMIN_BASE_URL || !API, 'Needs E2E_ADMIN_BASE_URL and VITE_ADMIN_API_URL.');
    const admin = await getAdminUser();
    test.skip(!admin.password, missingUserReason('testAdmin'));
    const people = [admin, await getBasicUser(), await getPremiumUser()].map((u) => u.email).filter(Boolean);

    const ctx = await browser.newContext({ baseURL: ADMIN_BASE_URL });
    const page = await ctx.newPage();
    let idToken = '';
    try {
      await signIn(page, admin.email, admin.password);
      idToken = await idTokenOf(page);
    } finally {
      await ctx.close();
    }
    expect(idToken, 'admin idToken').toBeTruthy();

    const list = await signedAdminGet(API, idToken, { limit: '40', offset: '0' });
    expect(list.status).toBe(200);
    const ids: string[] = (list.body?.conversations ?? []).map((c: any) => String(c.channelArn ?? c.channel_arn).split('/').pop());
    expect(ids.length, 'conversations to read').toBeGreaterThan(0);

    const refused = await signedAdminGet(adminUrl('admin-conversations', `/admin/conversations/${ids[0]}/clean`), idToken, {});
    expect(refused.status, 'a read with no reason').toBe(400);
    expect(refused.body?.code).toBe('REASON_REQUIRED');

    const read = async (id: string) => {
      const { status, body } = await signedAdminGet(adminUrl('admin-conversations', `/admin/conversations/${id}/clean`), idToken, { reason: 'e2e: de-identification check' });
      expect(status, `clean read of ${id}`).toBe(200);
      return body;
    };
    // One read at a time, as the console reads: each is an audited read with its own reason.
    const readAll = async () => { const out: any[] = []; for (const id of ids) out.push(await read(id)); return out; };
    let copies = await readAll();
    if (!copies.some((c) => c.derivedAt)) {
      const report = runBatchOnASample();
      console.log(`--- no copy yet; the batch ran on a sample: ${JSON.stringify(report)} ---`);
      expect(report.outcome, `the batch run on a sample: ${report.failure ?? ''}`).not.toBe('failed');
      copies = await readAll();
    }

    let derived = 0;
    let messages = 0;
    for (const [i, id] of ids.entries()) {
      const body = copies[i];
      if (!body.derivedAt) continue;
      derived++;
      for (const r of body.rows as any[]) {
        if (r.actorKind === 'person') expect(r.actor, `actor in ${id}`).toMatch(/^Person \d+$/);
        if (r.kind === 'membership' && r.subject && !/^Person \d+$/.test(r.subject)) {
          // A membership subject that is not a person is an assistant, named by its assistant id.
          expect(r.subject, `membership subject in ${id}`).not.toMatch(EMAIL);
        }
        if (r.kind !== 'message') continue;
        messages++;
        if (r.state !== 'present') expect(r.text, `a removed message in ${id} carries no text`).toBeNull();
        for (const t of [r.text, r.originalText]) {
          if (!t) continue;
          for (const email of people) expect(t.toLowerCase(), `a test user's address in ${id}`).not.toContain(email.toLowerCase());
          expect(t, `an email address in ${id}`).not.toMatch(EMAIL);
          // A user's ARN carries their sign-in id, so it is never left in the copy, whole or in part.
          expect(t, `a user id in ${id}`).not.toMatch(/app-instance\/[A-Za-z0-9-]+\/user\//);
        }
      }
    }
    console.log(`--- ${derived} of ${ids.length} conversations derived, ${messages} messages checked ---`);
    expect(derived, 'the batch has derived at least one of the most recent conversations').toBeGreaterThan(0);
  });
});
