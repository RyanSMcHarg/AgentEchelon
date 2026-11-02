/**
 * AN ASSISTANT'S INFRASTRUCTURE LINKS NAME THE LIVE RESOURCES THAT SERVE IT.
 *
 * The resolver read the processor and router under the assistant's own name, but the stack publishes them per
 * classification, so `advisor` and `ops-premium` showed only "Find AsyncProcessor" searches of the Lambda
 * console. This opens both as an admin and checks every link on their Infrastructure section against what the
 * deployment says it is: each href names one resource (no list, no search), and the processor, router, acting
 * role and Lex bot are the ones the classification's parameters and the assistant's identity name.
 *
 * Read-only: it opens two pages and reads parameters.
 */
import { test, expect } from './helpers/fixtures';
import { type Page } from '@playwright/test';
import { signInAsAdmin } from './helpers/agent-helpers';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { assistantServing } from './helpers/assistant-identity';
import { awsOrNull } from './helpers/aws';
import { SSM_ROOT } from './helpers/stack-prefix';

const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
test.use({ baseURL: ADMIN_BASE_URL });

guardBackendErrors('infrastructure-links');
guardConsoleErrors();

/** A list or search page: the fallback a resolved resource must never get. */
const LIST_OR_SEARCH = /#\/functions(\?|$)|#\/roles$|#\/guardrails$|\?fo=and|#\/policies$|\/systems-manager\/parameters\/?\?/;

const fnName = (arn: string | null | undefined) => (arn ?? '').split(':function:')[1]?.split(':')[0] ?? '';
const param = (name: string): string | null => {
  const r = awsOrNull(`ssm get-parameter --name ${name} --query Parameter.Value`);
  return typeof r === 'string' ? r : null;
};

async function openInfrastructure(page: Page, assistant: string): Promise<string[]> {
  await page.goto('/?admin=profiles');
  await expect(page.locator('.admin-tab-loading')).toHaveCount(0, { timeout: 30000 });
  const row = page.locator(`tr[data-assistant="${assistant}"]`);
  await expect(row, `${assistant} is listed`).toBeVisible({ timeout: 20000 });
  await row.locator('button.btn-link').first().click();
  // The infrastructure is in the page's Tools and context section.
  await page.getByTestId('assistant-nav-tools').click();
  const section = page.getByTestId('assistant-infrastructure');
  await expect(section).toBeVisible({ timeout: 20000 });
  return section.locator('a.doc-link').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
}

const cases = [
  { label: 'the premium primary', assistant: () => assistantServing('premium'), role: 'primary' },
  { label: 'the premium ops role', assistant: () => 'ops-premium', role: 'ops' },
];

for (const c of cases) {
  test(`every infrastructure link of ${c.label} names its live resource`, async ({ page }) => {
    test.setTimeout(120_000);
    const assistant = c.assistant();
    // Every assistant's record is at one path family, whoever asked for it (ADR-048, amended 2026-10-23).
    const record = param(`${SSM_ROOT}/assistant-assignments/premium/${c.role}/assistants/${assistant}`);
    test.skip(!record, `premium has no ${c.role} assistant on this deployment`);
    const botArn = (JSON.parse(record!) as { botArn?: string }).botArn ?? '';

    await signInAsAdmin(page);
    const hrefs = await openInfrastructure(page, assistant);
    expect(hrefs.length, 'the section links its resources').toBeGreaterThanOrEqual(8);
    for (const h of hrefs) expect(h, `a list or search link: ${h}`).not.toMatch(LIST_OR_SEARCH);

    // The classification's shared resources, as the stack published them.
    const processor = fnName(param(`${SSM_ROOT}/assistant/premium/processor-arn`));
    const router = fnName(param(`${SSM_ROOT}/assistant/premium/router-arn`));
    expect(processor).not.toBe('');
    expect(hrefs.some((h) => h.endsWith(`#/functions/${encodeURIComponent(processor)}`)), `the processor ${processor}`).toBe(true);
    expect(hrefs.some((h) => h.endsWith(`#/functions/${encodeURIComponent(router)}`)), `the router ${router}`).toBe(true);

    // The acting role the vend assumes, and its boundary.
    const vend = param(`${SSM_ROOT}/assistant/premium/vend-arn`);
    const acting = awsOrNull(`lambda get-function-configuration --function-name ${vend} --query Environment.Variables.ACTING_ROLE_ARN`) as string | null;
    expect(acting, 'the vend names its acting role').toBeTruthy();
    expect(hrefs).toContain(`https://console.aws.amazon.com/iam/home#/roles/details/${encodeURIComponent(acting!.split('/').pop()!)}`);
    expect(hrefs.some((h) => h.includes('#/policies/details/') && h.includes('AssistantActingBoundary-premium'))).toBe(true);

    // The assistant's own Lex bot, read from its identity.
    const alias = awsOrNull(`chime-sdk-identity describe-app-instance-bot --app-instance-bot-arn ${botArn} --query AppInstanceBot.Configuration.Lex.LexBotAliasArn`) as string | null;
    const lexBot = /bot-alias\/([^/]+)\//.exec(alias ?? '')?.[1];
    expect(lexBot, 'the identity names its Lex bot').toBeTruthy();
    expect(hrefs.some((h) => h.endsWith(`#bot/${lexBot}`))).toBe(true);

    // Its own definition parameter.
    expect(hrefs.some((h) => h.includes(`/systems-manager/parameters/${SSM_ROOT.replace(/^\//, '')}/assistant/${assistant}/definition/`))).toBe(true);
  });
}
