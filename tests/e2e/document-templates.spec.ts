/**
 * A REPORT IS DELIVERED IN THE TEMPLATE THE PERSON CHOSE, IN THAT TEMPLATE'S SHAPE (SPEC-DOCUMENT-TEMPLATES
 * FR3a, FR6, FR8, FR10).
 *
 * Every report follows a template: the platform `report_generation` workflow declares the shipped
 * `report` template on both delivering states, and the deploy writes it for every classification that
 * serves the workflow. A classification's pack may redeclare the workflow with a choice, and the demo's
 * premium pack offers two (a quarterly account review, the default, and a one-page executive summary).
 *
 * The workflow is read from the deployment, not assumed: premium's pack parameter when it declares
 * `report_generation`, else the platform machine. Where it offers a choice, the person names the
 * non-default format, so the recorded choice is what is exercised; with one template, that one is
 * expected. The delivered file is compared to the stored version the task's delivery record names, by
 * `checkAgainstTemplate` (the function the processor runs): required sections present and in the
 * template's order, by position and heading level, with each declared table's column count. The record
 * must name the expected template and the content hash of the version active when it was delivered.
 *
 * Gated by DOCUMENT_TEMPLATES_E2E=1 (the validate.mjs `document-templates` phase). Reads SSM, S3 and the
 * task tables through the AWS CLI (AWS_PROFILE); E2E_INSTANCE_NAME names the instance.
 *
 *   E2E_BASE_URL=<cf> DOCUMENT_TEMPLATES_E2E=1 E2E_INSTANCE_NAME=<instance> AWS_PROFILE=<p>  *     npx playwright test e2e/document-templates.spec.ts --config=playwright.config.ts
 */
import { test, expect } from './helpers/fixtures';
import { signIn, createConversation, sendAndWaitForResponse, idTokenOf } from './helpers/agent-helpers';
import { getTestCredentials } from './helpers/test-credentials';
import { personIdFromIdToken } from './helpers/person';
import { openAndValidateAttachment } from './helpers/task-validation';
import { readTask, readUserTasks, resolveTaskTable, reportPromptForClassification } from './helpers/task-backend';
import { awsv } from './helpers/aws';
import { SSM_ROOT } from './helpers/stack-prefix';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { checkDeliveredAgainstItsTemplate } from './helpers/delivered-template';
import { deployedClassificationPack } from './helpers/classification-pack';
import { DEFAULT_TASK_STATE_MACHINES, templateChoiceOf, templateRefsOfMachine, type TaskStateMachine } from '../../backend/lambda/src/lib/task-state-machines';

guardConsoleErrors();

const RUN = process.env.DOCUMENT_TEMPLATES_E2E === '1';
const SKIP_REASON =
  'Set DOCUMENT_TEMPLATES_E2E=1 (the validate.mjs "document-templates" phase). '
  + 'This drives a premium report to delivery in a template on a live deployment.';

/** An SSM parameter's value, or undefined when it does not exist. */
function parameter(name: string): string | undefined {
  try {
    return awsv(['ssm', 'get-parameter', '--name', name], { quiet: true })?.Parameter?.Value;
  } catch {
    return undefined;
  }
}

/**
 * Premium's report workflow as the deployment runs it: the machine its pack parameter declares (followed
 * into the body store when the parameter holds a pointer), else the platform's.
 */
function premiumReportWorkflow(): { machine: TaskStateMachine; from: string } {
  const pack = deployedClassificationPack('premium');
  const declared = pack?.machines?.report_generation as TaskStateMachine | undefined;
  return declared
    ? { machine: declared, from: 'premium\'s pack' }
    : { machine: DEFAULT_TASK_STATE_MACHINES.report_generation, from: 'the platform workflow' };
}

test.describe('document templates', () => {
  test.skip(!RUN, SKIP_REASON);
  guardBackendErrors('document-templates');

  test('[premium] a report is delivered in the template the person chose, with its sections in order', async ({ page }) => {
    test.setTimeout(600_000);
    const { machine, from } = premiumReportWorkflow();
    // THE EXPECTED TEMPLATE: the non-default format where the workflow offers a choice, so the recorded
    // choice is what decides; the one declared template otherwise.
    const choice = templateChoiceOf(machine);
    const expected = choice
      ? (choice.names.find((n) => n !== choice.defaultName) ?? choice.names[0])
      : templateRefsOfMachine(machine)[0]?.name;
    expect(expected, `${from} declares no template on report_generation, and every report follows one`).toBeTruthy();
    console.log(`--- ${from}: ${choice ? `a choice of ${choice.names.join(', ')}; asking for ${expected}` : `the ${expected} template`} ---`);

    const creds = await getTestCredentials();
    await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
    await createConversation(page, `Templated report ${Date.now()}`, 'Premium');
    const started = Date.now() - 60_000;

    await sendAndWaitForResponse(page, reportPromptForClassification('premium'), 180_000);

    // THE TASK IS FOUND NOW, while the person holds it: the per-user mirror is partitioned by the current
    // owner, and ownership moves to the assistant at the first answer and stays there once it delivers.
    const userTable = resolveTaskTable('user-tasks');
    const agentTable = resolveTaskTable('agent-tasks');
    expect(userTable && agentTable, 'the task tables must resolve - the phase needs E2E_INSTANCE_NAME').toBeTruthy();
    const personId = await personIdFromIdToken((await idTokenOf(page))!);
    let taskRef: { taskId: string; channelArn: string } | undefined;
    for (let i = 0; i < 12 && !taskRef; i++) {
      const row = readUserTasks(userTable!, personId)
        .filter((t) => String(t.taskType) === 'report_generation' && new Date(String(t.createdAt ?? 0)).getTime() >= started)
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
      if (row) taskRef = { taskId: String(row.taskId), channelArn: String(row.channelArn) };
      else await page.waitForTimeout(5000);
    }
    expect(taskRef, 'the report request must open a report_generation task').toBeTruthy();

    const attachment = page.locator('.assistant-message .attachment-display').last();
    const answers = [
      `The audience is the leadership team, in the ${expected} format. Please cover ARR growth, net revenue retention, and churn risk.`,
      'The outline looks good. Please generate the full report now.',
      'Yes, generate the report.',
    ];
    let delivered = await attachment.isVisible({ timeout: 2000 }).catch(() => false);
    for (const answer of answers) {
      if (delivered) break;
      await sendAndWaitForResponse(page, answer, 180_000);
      delivered = await attachment.isVisible({ timeout: 3000 }).catch(() => false);
    }
    expect(delivered, 'the templated report must be ATTACHED: a document that still misses its template posts inline').toBe(true);

    const content = await openAndValidateAttachment(page, attachment, { namePattern: /\.(md|markdown)$/i, minLength: 400, mustMatch: [] });

    // FR8: the task's delivery record names the template and the version it was checked against, and
    // FR6: the attached file carries that template's structure.
    const task = readTask(agentTable!, taskRef!.taskId, taskRef!.channelArn);
    const { record, check } = checkDeliveredAgainstItsTemplate(task, 'premium', content);
    expect(record.name, 'the delivery must use the template the person chose (or the one the workflow declares)').toBe(expected);
    if (choice) expect(record.chosen, 'the template was the person\'s recorded choice').toBe(true);
    const pointer = parameter(`${SSM_ROOT}/assistant/premium/templates/${record.name}`);
    expect(record.contentHash, 'the delivery names the version active when it was delivered').toBe(pointer ? JSON.parse(pointer).active : undefined);
    expect(['passed', 'passed_after_correction']).toContain(record.outcome);
    expect(check.missing, `the delivered report must carry "${record.name}"'s required sections in order, by level and table columns`).toEqual([]);
    expect(check.passed).toBe(true);
  });
});
