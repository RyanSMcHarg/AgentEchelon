/**
 * Admin task routes E2E - the three operator reads, through the signed path and a vended credential.
 *
 * WHY THIS SPEC EXISTS. ADR-024 D8 moved the operator surface onto three routes, each with its own
 * vended capability, and until now NO caller and NO test exercised any admin task route - not the
 * new ones, and not the pre-existing `tasks-read`/`tasks-manage` pair either. The routes were
 * verified to EXIST on the deployed API and the exchange was verified to carry their ARN templates,
 * which is a deployment fact rather than a behavioral one: an existing route can still refuse every
 * caller, return the wrong subject, or hand back a credential wider than the question asked.
 *
 * WHAT IS ACTUALLY AT STAKE. Two things a unit test cannot reach:
 *
 *   1. THE WORDS MEAN WHAT THEY SAY. `/assignee/{id}` answers what a principal is ASSIGNED and
 *      `/owned-by/{id}` answers what a person OWNS. Those are different questions with different
 *      answers, and the whole of D8 is that one route must not quietly serve the other's set. A
 *      single seeded task whose owner and assignee are DIFFERENT people is what tells them apart -
 *      with one person in both roles every assertion here would pass with the two reads swapped.
 *
 *   2. THE VEND IS SCOPED. Both reads are principal-scoped: the session policy completes an ARN
 *      template with the one id the vend named. If that pinning ever stops, every operator task read
 *      silently becomes a read of everybody's, with no error and no visible change for any
 *      legitimate use. The containment test is the one that would catch it, and it is paired with a
 *      positive control so a denial cannot pass for containment when it is really a broken request.
 *
 * The two RETIREMENTS are asserted here for the same reason they were retired: `/admin/tasks/owner/`
 * and the capability `tasks-read-owner` named the assignee read under the owner's word. A 200 from
 * either means a stale route or a stale boundary survived a deploy, which is exactly the silent
 * survival that keeping the name would have made undetectable.
 *
 * Modeled on `moderation.spec.ts`, which establishes the vend-then-act shape and the paired
 * positive control; the difference is that these calls are SigV4-signed HTTPS rather than an AWS
 * SDK call, because what is being authorized is `execute-api:Invoke` on an API Gateway resource.
 */
import { test, expect } from './helpers/fixtures';
import { randomUUID } from 'crypto';
import { signIn, createConversation } from './helpers/agent-helpers';
import { getAdminUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { aws, jsonArg, resolveTaskTable, unmarshalItem } from './helpers/task-backend';
import { exchange, signedCall } from './helpers/admin-api';
import { idTokenFor, personArnOf, personIdOf } from './helpers/person';
import { PERSON_API_URL, ADMIN_API_URL, adminUrl } from './helpers/api-urls';

guardConsoleErrors();

const E2E_RUNNABLE = hasTestCredentials();

/**
 * Seed one task whose OWNER and ASSIGNEE are different people.
 *
 * This mirrors what `createTask` + the mirror write produce under D8 rather than reusing
 * `seedPlaceItemTask`, which still writes the pre-rename `ownerId`/`ownerType` shape: a row with no
 * `ownerPersonId` is invisible to `ownerPersonId-index`, so the owner read would return empty and the test
 * would report a working route as broken. The distinct roles are the point - see the header.
 */
function seedOwnedTask(args: {
  agentTable: string;
  userTable: string;
  channelArn: string;
  ownerPersonId: string;
  assigneeId: string;
}): { taskId: string } {
  const taskId = randomUUID();
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
  const common = {
    taskId: { S: taskId },
    channelArn: { S: args.channelArn },
    taskType: { S: 'place_item' },
    taskState: { S: 'collecting_requirements' },
    status: { S: 'in_progress' },
    details: { M: {} },
    createdAt: { S: now },
    updatedAt: { S: now },
    ttl: { N: String(ttl) },
  };

  aws(`dynamodb put-item --table-name "${args.agentTable}" --item ${jsonArg({
    ...common,
    userArn: { S: `${args.channelArn.split('/channel/')[0]}/user/${args.ownerPersonId}` },
    requestExcerpt: { S: 'admin task route probe' },
    deliveryOption: { S: 'TASK_MULTI_STEP' },
    ownerPersonId: { S: args.ownerPersonId },
    assigneeId: { S: args.assigneeId },
    assigneeType: { S: 'user' },
  })}`);

  // The mirror is partitioned by the ASSIGNEE (`principalId`) and carries the OWNER as an attribute,
  // which is what makes the two reads answer different questions off one row.
  aws(`dynamodb put-item --table-name "${args.userTable}" --item ${jsonArg({
    ...common,
    principalId: { S: args.assigneeId },
    assigneeType: { S: 'user' },
    ownerPersonId: { S: args.ownerPersonId },
  })}`);

  return { taskId };
}

function deleteSeeded(agentTable: string, userTable: string, taskId: string, channelArn: string, assigneeId: string): void {
  try {
    aws(`dynamodb delete-item --table-name "${agentTable}" --key ${jsonArg({ taskId: { S: taskId }, channelArn: { S: channelArn } })}`);
  } catch { /* best effort */ }
  try {
    aws(`dynamodb delete-item --table-name "${userTable}" --key ${jsonArg({ principalId: { S: assigneeId }, taskId: { S: taskId } })}`);
  } catch { /* best effort */ }
}

function readAgentTask(agentTable: string, taskId: string, channelArn: string): Record<string, any> | undefined {
  const out = aws(`dynamodb get-item --table-name "${agentTable}" --key ${jsonArg({ taskId: { S: taskId }, channelArn: { S: channelArn } })}`);
  return out?.Item ? unmarshalItem(out.Item) : undefined;
}

test.describe.serial('Admin task routes - the operator reads, signed and scoped', () => {
  guardBackendErrors('admin-task-routes');

  let agentTable = '';
  let userTable = '';
  let channelArn = '';
  let taskId = '';
  let ownerPersonId = '';
  let assigneePersonId = '';
  let strangerPersonId = '';
  let adminToken = '';

  test.beforeAll(async () => {
    test.skip(!E2E_RUNNABLE, 'test credentials are not available');
    test.skip(!PERSON_API_URL || !ADMIN_API_URL, 'VITE_PERSON_API_URL or VITE_ADMIN_API_URL is not set - the vend cannot be exercised');
    agentTable = resolveTaskTable('agent-tasks') || '';
    userTable = resolveTaskTable('user-tasks') || '';
    test.skip(!agentTable || !userTable, 'task tables could not be resolved from the shared SSM contract');
  });

  test('a task whose owner and assignee differ is readable by BOTH words, and each answers its own question', async ({ page }) => {
    const admin = await getAdminUser();
    test.skip(!admin.password, missingUserReason('testAdmin'));
    const creds = await getTestCredentials();

    // A REAL conversation. The task service refuses a channel it may not serve by reading the
    // channel's classification TAG, so a fabricated ARN would be refused for the wrong reason.
    await signIn(page, admin.email, admin.password);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
    const createResp = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await createConversation(page, `Admin task routes ${Date.now()}`, 'Basic');
    channelArn = (await (await createResp).json())?.conversation?.conversationArn || '';
    expect(channelArn, 'channelArn').toBeTruthy();

    // THREE DISTINCT PEOPLE. Owner and assignee must differ or the two reads are indistinguishable;
    // the stranger is what the containment test below vends for.
    ownerPersonId = personIdOf(await personArnOf(creds.standardUser));
    assigneePersonId = personIdOf(await personArnOf(creds.premiumUser));
    strangerPersonId = personIdOf(await personArnOf(creds.basicUser));
    expect(ownerPersonId, 'owner and assignee must be different people').not.toBe(assigneePersonId);

    ({ taskId } = seedOwnedTask({ agentTable, userTable, channelArn, ownerPersonId, assigneeId: assigneePersonId }));
    console.log(`\n--- seeded ${taskId}\n    owner=${ownerPersonId}\n    assignee=${assigneePersonId}\n    channel=${channelArn}`);

    adminToken = idTokenFor(admin.email, admin.password, creds.cognitoClientId);

    // THE ASSIGNEE READ, vended for the assignee.
    const vendAssignee = await exchange(adminToken, {
      identity: 'admin', principalId: assigneePersonId, capabilities: ['tasks-read-assignee'],
    });
    expect(vendAssignee.status, `assignee vend: ${JSON.stringify(vendAssignee.body).slice(0, 300)}`).toBe(200);
    const assigneeRead = await signedCall(
      adminUrl('admin-conversations', `/admin/tasks/assignee/${encodeURIComponent(assigneePersonId)}`),
      vendAssignee.body.credentials,
    );
    expect(assigneeRead.status, `assignee read: ${JSON.stringify(assigneeRead.body).slice(0, 300)}`).toBe(200);
    // EVERY SERVICE ANSWERED, asserted before the rows. The route fans out to one task service per
    // classification and returns whatever came back, so a service that failed to answer yields
    // `data: []` - indistinguishable from "this principal has no work" unless the count is checked.
    expect(assigneeRead.body?.servicesAnswered, 'a task service did not answer the assignee read')
      .toBe(assigneeRead.body?.servicesAsked);
    const assigned = (assigneeRead.body?.data ?? []) as any[];
    expect(
      assigned.some((t) => t.taskId === taskId),
      'the assignee read did not return the task the assignee is assigned',
    ).toBe(true);

    // THE OWNER READ, vended for the owner. A different id, a different capability, the same task.
    const vendOwner = await exchange(adminToken, {
      identity: 'admin', principalId: ownerPersonId, capabilities: ['tasks-read-owned-by'],
    });
    expect(vendOwner.status, `owner vend: ${JSON.stringify(vendOwner.body).slice(0, 300)}`).toBe(200);
    const ownerRead = await signedCall(
      adminUrl('admin-conversations', `/admin/tasks/owned-by/${encodeURIComponent(ownerPersonId)}`),
      vendOwner.body.credentials,
    );
    expect(ownerRead.status, `owner read: ${JSON.stringify(ownerRead.body).slice(0, 300)}`).toBe(200);
    expect(ownerRead.body?.servicesAnswered, 'a task service did not answer the owner read')
      .toBe(ownerRead.body?.servicesAsked);
    const owned = (ownerRead.body?.data ?? []) as any[];
    expect(
      owned.some((t) => t.taskId === taskId),
      'the owner read did not return the task that person OWNS - the ownerPersonId-index or the mirror '
      + 'write is not carrying the owner',
    ).toBe(true);
  });

  test('a read vended for one principal cannot read another', async () => {
    test.skip(!taskId, 'the seeded task was not created');
    // ONE credential, scoped to the stranger. The positive control above already established that
    // the assignee route answers 200 for a correctly scoped vend, so a refusal here is containment
    // rather than a route that refuses everybody.
    const vend = await exchange(adminToken, {
      identity: 'admin', principalId: strangerPersonId, capabilities: ['tasks-read-assignee'],
    });
    expect(vend.status, `stranger vend: ${JSON.stringify(vend.body).slice(0, 300)}`).toBe(200);

    const crossPrincipal = await signedCall(
      adminUrl('admin-conversations', `/admin/tasks/assignee/${encodeURIComponent(assigneePersonId)}`),
      vend.body.credentials,
    );
    console.log(`--- read of an UNSCOPED principal: ${crossPrincipal.status}`);
    expect(
      crossPrincipal.status,
      'a task-read credential vended for one principal read ANOTHER principal\'s queue. The session '
      + 'policy completes its ARN template with the id the vend named; if that pinning stops, every '
      + 'operator task read silently becomes a read of everybody\'s, with no error and no visible '
      + 'change for any legitimate use.',
    ).toBe(403);
  });

  test('handing a task over moves the OWNER and leaves the assignee untouched', async () => {
    test.skip(!taskId, 'the seeded task was not created');
    const channelId = channelArn.split('/').pop() || '';

    const vend = await exchange(adminToken, {
      identity: 'admin', channelArn, capabilities: ['tasks-reassign-owner'],
    });
    expect(vend.status, `reassign vend: ${JSON.stringify(vend.body).slice(0, 300)}`).toBe(200);

    const before = readAgentTask(agentTable, taskId, channelArn);
    expect(before?.assigneeId, 'assignee before the handover').toBe(assigneePersonId);

    const res = await signedCall(
      adminUrl('admin-conversations', `/admin/tasks/channel/${encodeURIComponent(channelId)}/owner`),
      vend.body.credentials,
      'POST',
      { taskId, ownerPersonId: strangerPersonId },
    );
    expect(res.status, `handover: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);

    const after = readAgentTask(agentTable, taskId, channelArn);
    expect(after?.ownerPersonId, 'the handover did not move the owner').toBe(strangerPersonId);
    expect(
      after?.assigneeId,
      'the handover moved the ASSIGNEE as well as the owner. They change at different rates by '
      + 'design: the owner on a handover, the assignee at every awaits boundary. Moving both makes '
      + 'a handover silently reassign the next step to somebody who was never asked for it.',
    ).toBe(assigneePersonId);
  });

  test('the retired capability is refused, and the retired route is not there', async () => {
    test.skip(!adminToken, 'no admin token');

    // `tasks-read-owner` named the ASSIGNEE read under the owner's word and is GONE rather than
    // repurposed. A 200 here means a stale boundary survived the deploy.
    const retiredCap = await exchange(adminToken, {
      identity: 'admin', principalId: assigneePersonId, capabilities: ['tasks-read-owner'],
    });
    console.log(`--- vend for the retired capability: ${retiredCap.status}`);
    expect(
      retiredCap.status,
      'the exchange still vends `tasks-read-owner`. An alias preserves exactly the confusion the '
      + 'rename exists to remove: one capability naming two different facts either side of a deploy.',
    ).not.toBe(200);

    // And the retired ROUTE. Vended for a capability that legitimately exists, so a refusal here is
    // about the path rather than about the credential.
    const vend = await exchange(adminToken, {
      identity: 'admin', principalId: assigneePersonId, capabilities: ['tasks-read-assignee'],
    });
    expect(vend.status).toBe(200);
    // DELIBERATELY NOT `adminUrl`: this is the one URL a spec composes that must NOT be a declared route,
    // and the route-table test holds every `adminUrl` call to the declared routes.
    const retiredRoute = await signedCall(
      `${ADMIN_API_URL}/admin/tasks/owner/${encodeURIComponent(assigneePersonId)}`,
      vend.body.credentials,
    );
    console.log(`--- GET the retired /admin/tasks/owner/: ${retiredRoute.status}`);
    expect(
      retiredRoute.status,
      '/admin/tasks/owner/ still answers. It is retired rather than repurposed so that a caller '
      + 'still on it fails loudly and immediately; a 200 means an operator script or a saved query '
      + 'is quietly reading a different fact than the one it was written against.',
    ).not.toBe(200);
  });

  test.afterAll(() => {
    if (taskId && agentTable && userTable) deleteSeeded(agentTable, userTable, taskId, channelArn, assigneePersonId);
  });
});
