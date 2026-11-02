/**
 * A ROUTE IS KEYED BY THE INTENT IT SERVES (ADR-064 slice 1), against a freshly deployed dev.
 *
 * The shipped routes are written in intent keys (`general`, `data_extraction`), so a general question is answered on
 * the model the `general` route names and a data-extraction request on the model the `data_extraction` route names,
 * read from the premium primary's active version rather than assumed. The `general` card's Effectiveness link filters
 * `?intent=general`, which is the value the archive records, so the intent row it opens holds this run's turns.
 *
 * GATED: it sends real turns on premium, so it runs only with `E2E_MODEL_ROUTES=1`.
 *
 * **Coverage:** `e2e/a-route-is-keyed-by-its-intent.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { aws } from './helpers/aws';
import { channelArnFor } from './helpers/battle-state-backend';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { openConversation, waitFor, sleep } from './helpers/workflow-task';
import { ANALYTICS_API, activeBody, adminSessionOrSkip, modelKeyOf } from './helpers/model-routes';

const MARK = `ROUTEKEY-${Date.now().toString(36)}`;

test.describe.serial('a route is keyed by the intent it serves', () => {
  guardBackendErrors('a-route-is-keyed-by-its-intent');
  let admin: any;
  let idToken = '';

  test.beforeAll(async () => {
    test.skip(process.env.E2E_MODEL_ROUTES !== '1', 'sends real premium turns; set E2E_MODEL_ROUTES=1 to run it');
    const s = await adminSessionOrSkip();
    test.skip(!!s.skip, s.skip);
    admin = s.admin;
    idToken = s.idToken!;
  });

  test('a general question and a data-extraction request answer on the models their own routes name', async () => {
    test.setTimeout(10 * 60_000);
    const body = await activeBody(admin);
    const routes = (body.models?.byIntent ?? {}) as Record<string, { primary: string }>;
    for (const retired of ['general_qa', 'workflow_actions', 'document_extraction']) expect(routes[retired], `the active version names the retired key ${retired}`).toBeUndefined();
    expect(routes.general?.primary, 'the shipped routes key the general route by the intent').toBeTruthy();
    expect(routes.data_extraction?.primary, 'the shipped routes key the data_extraction route by the intent').toBeTruthy();

    // EACH REQUEST IN ITS OWN CONVERSATION. The two are unrelated topics, and a second unrelated topic in one conversation
    // is answered with the drift suggestion to start a new one, not with a turn on its route.
    const ask = async (title: string, text: string, intent: string) => {
      const conv = await openConversation(`${title} ${MARK}`);
      const finalFor = (m: { sender: string; metadata: Record<string, any> }) =>
        m.sender !== conv.personArn && m.metadata?.respPhase === 'final' && m.metadata?.intent === intent;
      await sleep(15_000);
      aws(`chime-sdk-messaging send-channel-message --channel-arn ${channelArnFor(conv.channelId)} --chime-bearer ${conv.personArn} --type STANDARD --persistence PERSISTENT --content "${encodeURIComponent(text)}"`);
      return waitFor(conv.channelId, conv.personArn, finalFor, 4 * 60_000);
    };

    const general = await ask('Routes general', `${MARK}: what is the difference between a process and a thread?`, 'general');
    expect(general.hit, `no final general reply; intents seen ${JSON.stringify(general.seen.map((m) => m.metadata?.intent).filter(Boolean))}`).toBeDefined();
    expect(modelKeyOf(general.hit!.metadata.bedrockModel)).toBe(routes.general.primary);

    const extraction = await ask('Routes extraction', `${MARK}: extract the name, date and amount from this line as a table: "Invoice 4471 from Acme Ltd, 3 March 2026, total 1,240.00 EUR".`, 'data_extraction');
    expect(extraction.hit, `no final data_extraction reply; intents seen ${JSON.stringify(extraction.seen.map((m) => m.metadata?.intent).filter(Boolean))}`).toBeDefined();
    expect(modelKeyOf(extraction.hit!.metadata.bedrockModel)).toBe(routes.data_extraction.primary);
  });

  test("the general card's Effectiveness link opens the general intent's rows", async () => {
    test.setTimeout(8 * 60_000);
    let row: any;
    for (const deadline = Date.now() + 6 * 60_000; Date.now() < deadline && !row; await sleep(15_000)) {
      const eff = await signedAnalyticsPost(ANALYTICS_API, idToken, { queryType: 'intent_effectiveness', intent: 'general' });
      row = ((eff?.data ?? []) as any[]).find((r) => r?.intent === 'general');
    }
    expect(row, 'the intent row the card link (?intent=general) filters to holds turns').toBeDefined();
    expect(Number(row.total_exchanges ?? row.exchanges ?? row.count ?? 1)).toBeGreaterThan(0);
  });
});
