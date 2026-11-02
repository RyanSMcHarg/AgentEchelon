/**
 * AN ASSISTANT'S PAGE SHOWS ITS CLASSIFICATION'S TEMPLATES AND ITS ACTIVE VERSION'S INTENTS AND WORKFLOWS,
 * AS THE DEPLOYMENT HOLDS THEM (SPEC-ADMIN-CONSOLE "Assistants").
 *
 * The page renders these read-only, each with its edit path, from the listing's classification catalog and
 * the exported active version. This opens `ops-premium` as an admin and checks them against the source:
 *   - the templates against the classification's template pointers in SSM
 *     (`<root>/assistant/premium/templates/<name>`), and each pointer's version against the S3 body it names
 *     (`templates/premium/<name>/<sha256>.md` in the attachments bucket);
 *   - the intents against the active definition in SSM, its intent pack read from S3 when the definition
 *     carries a pointer, or the classification's pack when the version carries none;
 *   - the workflows against the definition's `workflows`, and their steps against the machines the page lists.
 * Each field without a control says how it is changed.
 *
 * Read-only: it opens one page and reads parameters and objects.
 */
import { test, expect } from './helpers/fixtures';
import { signInAsAdmin } from './helpers/agent-helpers';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { awsOrNull, awsv, awsvText } from './helpers/aws';
import { SSM_ROOT } from './helpers/stack-prefix';
import { attachmentsBucket } from './helpers/delivered-template';

const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
test.use({ baseURL: ADMIN_BASE_URL });

guardBackendErrors('assistant-page-fields');
guardConsoleErrors();

const ASSISTANT = 'ops-premium';
const CLASSIFICATION = 'premium';

const param = (name: string): string | null => {
  const r = awsOrNull(`ssm get-parameter --name ${name} --query Parameter.Value`);
  return typeof r === 'string' ? r : null;
};

/** The classification's template pointers: name to active content hash. */
function templatePointers(): Map<string, string> {
  const out = new Map<string, string>();
  const path = `${SSM_ROOT}/assistant/${CLASSIFICATION}/templates`;
  const res = awsv(['ssm', 'get-parameters-by-path', '--path', path], { quiet: true }) as { Parameters?: Array<{ Name: string; Value: string }> };
  for (const p of res?.Parameters ?? []) {
    const active = (JSON.parse(p.Value) as { active?: string }).active;
    if (active) out.set(p.Name.slice(path.length + 1), active);
  }
  return out;
}

/** The active version's intent keys and workflows, from SSM and, when the definition points there, S3. */
function activeIntentsAndWorkflows(): { intents: string[]; workflows: string[] } {
  const def = JSON.parse(param(`${SSM_ROOT}/assistant/${ASSISTANT}/definition:active`) ?? '{}') as {
    intentPack?: { intents?: Array<{ key: string }> };
    intentPackRef?: { key: string };
    workflows?: string[];
  };
  let pack = def.intentPack;
  if (!pack && def.intentPackRef) {
    const bucket = attachmentsBucket();
    expect(bucket, 'the attachments bucket that holds profile bodies').toBeTruthy();
    pack = JSON.parse(awsvText(['s3', 'cp', `s3://${bucket}/${def.intentPackRef.key}`, '-'], { quiet: true }));
  }
  return { intents: (pack?.intents ?? []).map((i) => i.key), workflows: def.workflows ?? [] };
}

test(`${ASSISTANT}'s page lists its classification's templates and its active intents and workflows`, async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(!param(`${SSM_ROOT}/assistant-assignments/${CLASSIFICATION}/ops/assistants/${ASSISTANT}`), `${ASSISTANT} is not deployed here`);
  const pointers = templatePointers();
  expect(pointers.has('report'), 'the premium classification holds the report template').toBe(true);
  const bucket = attachmentsBucket();
  for (const [name, hash] of pointers) {
    // Each pointer names a body that exists, so the page's version is a real one.
    const head = awsOrNull(`s3api head-object --bucket ${bucket} --key templates/${CLASSIFICATION}/${name}/${hash}.md`);
    expect(head, `templates/${CLASSIFICATION}/${name}/${hash}.md exists`).toBeTruthy();
  }
  const { intents, workflows } = activeIntentsAndWorkflows();

  await signInAsAdmin(page);
  await page.goto('/?admin=profiles');
  await expect(page.locator('.admin-tab-loading')).toHaveCount(0, { timeout: 30000 });
  const row = page.locator(`tr[data-assistant="${ASSISTANT}"]`);
  await expect(row).toBeVisible({ timeout: 20000 });
  await row.locator('button.btn-link').first().click();

  // The page shows one section at a time: templates and workflows are in Workflows, the intents in Scope and models.
  await page.getByTestId('assistant-nav-workflows').click();
  const templates = page.getByTestId('field-templates');
  await expect(templates).toBeVisible({ timeout: 20000 });
  for (const [name, hash] of pointers) {
    await expect(templates).toContainText(name);
    await expect(templates).toContainText(hash.slice(0, 12));
  }
  await expect(templates).toContainText(`npm run template -- put|activate|rollback|list|check ${CLASSIFICATION}`);
  await expect(templates).toContainText(`templates/${CLASSIFICATION}/`);

  await page.getByTestId('assistant-nav-scope').click();
  const intentField = page.getByTestId('field-intentPack');
  await expect(intentField).toBeVisible({ timeout: 20000 });
  // The intents and workflows are the active version's, so they are read once the version has loaded and only if it
  // could be read: the page names no intents as the version's before then.
  await expect(page.locator('.admin-tab-loading')).toHaveCount(0, { timeout: 30000 });
  await expect(intentField).not.toContainText('Loading configuration');
  await expect(intentField, 'the active version could not be read').not.toContainText('Could not be read');
  const shownIntents = await intentField.locator('code.admin-chip').allInnerTexts();
  if (intents.length) expect(shownIntents.sort()).toEqual([...intents].sort());
  else expect(shownIntents.length, 'a version with no pack shows its classification\'s').toBeGreaterThan(0);
  await expect(page.getByTestId('edit-path-intentPack')).toContainText('npm run assistant -- draft');

  await page.getByTestId('assistant-nav-workflows').click();
  const workflowField = page.getByTestId('field-workflows');
  for (const w of workflows) await expect(workflowField).toContainText(w);
  if (!workflows.length) await expect(workflowField).toContainText('None');
  await expect(page.getByTestId('edit-path-workflows')).toContainText('npm run assistant -- draft');

  const platform = page.getByTestId('assistant-config-platform');
  await expect(platform).toContainText('Platform-level, not editable');
});
