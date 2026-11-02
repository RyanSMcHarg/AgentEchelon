/**
 * THE TASK STORE'S BLAST RADIUS, asserted in the synthesized template.
 *
 * Tasks are the one conversation-scoped store SPEC-CONVERSATION-SECURITY's layer model does not
 * cover, and the layers it does cover are held by ASSERTION rather than by description: `cdk-synth`
 * Layer 1 fails the build when a channel-tag Allow widens, Layer 4 when a context prefix does.
 * Nothing played that role here, so the only thing keeping one classification's assistant out of
 * another's tasks is a `channelArn = :ch` in a query, and a widened grant would deploy green.
 *
 * ── WHAT THESE DO NOT CLAIM ──────────────────────────────────────────────────────────────────────
 *
 * They do not claim the boundary is IAM-enforced. It is not. The grant carries no condition, and no
 * arrangement of DynamoDB IAM can express "private to the requester" or "visible to this
 * conversation's current members" - `aws:ResourceTag` is table-level and `dynamodb:LeadingKeys`
 * reaches a partition key and nothing else. Pretending otherwise is the failure these guard against
 * in the other direction.
 *
 * ── WHAT THEY DO PIN ─────────────────────────────────────────────────────────────────────────────
 *
 * WHICH principals hold the tables, and with WHICH verbs. That is the property a task service in
 * front of them depends on: a front door is only a boundary if nothing else still holds the tables,
 * so a fourth holder appearing has to be a failing test rather than something discovered later.
 * When the service lands, the holder expectation narrows to the service role and these tests are
 * where that narrowing is recorded.
 *
 * See DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING section 3.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { conversationsTemplate } from './helpers/synth';
import { assistantsOf } from './helpers/assistants';

const env = { account: '123456789012', region: 'us-east-1' };
const APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:123456789012:app-instance/test';

/** Every IAM statement in a template, inline role policies and standalone policies alike. */
function allStatements(template: Template): any[] {
  const out: any[] = [];
  for (const r of [
    ...Object.values(template.findResources('AWS::IAM::Policy')),
    ...Object.values(template.findResources('AWS::IAM::Role')),
  ]) {
    const props = (r as any).Properties ?? {};
    const inline = ((props.Policies ?? []) as any[]).flatMap((p) => p.PolicyDocument?.Statement ?? []);
    const direct = (props.PolicyDocument?.Statement ?? []) as any[];
    out.push(...direct, ...inline);
  }
  return out;
}

/**
 * Flatten a resource entry to one searchable string.
 *
 * ALL FOUR FORMS, because the same table renders differently depending on which stack is being
 * synthesized: `Fn::GetAtt` where the table is DEFINED (Foundations), a CfnParameter `Ref` where it
 * arrives as an SSM dynamic ref (a classification stack), `Fn::Join` for a composed index ARN, and a
 * plain string for a literal. Dropping any one of them makes the assertions below pass on a template
 * they never actually inspected.
 */
function flat(r: any): string {
  if (typeof r === 'string') return r;
  if (!r) return '';
  if (r['Fn::Join']) return (r['Fn::Join'][1] as any[]).map(flat).join('');
  if (r['Fn::GetAtt']) return (r['Fn::GetAtt'] as any[]).map(String).join('.');
  if (r.Ref) return String(r.Ref);
  return '';
}

const asArr = (x: any): any[] => (Array.isArray(x) ? x : x === undefined ? [] : [x]);
const actionsOf = (s: any): string[] => asArr(s.Action).map(String);

/**
 * The tasks-table ARN arrives as an SSM dynamic ref, so the resource renders as a CfnParameter `Ref`
 * whose logical id sanitizes the parameter name. Normalizing before matching is what makes this hold
 * whether CDK emits a literal or a Ref, and it is the same normalization the Layer 4 checks use for
 * the channel-context store.
 */
const norm = (s: string): string => s.replace(/[^a-z0-9]/gi, '').toLowerCase();

function touchesTasks(s: any): boolean {
  return asArr(s.Resource)
    .map(flat)
    .map(norm)
    .some((r) => r.includes('agenttasks') || r.includes('usertasks'));
}

const taskStatements = (t: Template): any[] =>
  allStatements(t).filter((s) => s.Effect === 'Allow' && touchesTasks(s));

const taskActions = (t: Template): string[] =>
  Array.from(new Set(taskStatements(t).flatMap(actionsOf))).sort();

function classificationTemplate(): Template {
  return Template.fromStack(
    assistantsOf('basic')(new cdk.App(), 'AgentEchelonAssistants-basic', {
      env,
      appInstanceArn: APP_INSTANCE_ARN,
      attachmentsBucketName: 'agent-echelon-attachments-test',
      attachmentsBucketArn: 'arn:aws:s3:::agent-echelon-attachments-test',
    } as never),
  );
}

describe('an assistant classification and the task tables', () => {
  it('reaches them at all', () => {
    // The guard against the guard. If the resource matcher stops matching, every assertion below
    // passes vacuously and reports a boundary nobody is holding.
    expect(taskStatements(classificationTemplate()).length).toBeGreaterThan(0);
  });

  it('holds NO verb beyond the ones a task lifecycle needs', () => {
    // Deny-by-absence, the same shape as the Layer 4 context-prefix checks. A task is read, created,
    // advanced and mirrored, so these are the verbs. Anything outside the set is a widening that has
    // to be argued rather than merged.
    const permitted = new Set([
      'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem',
      'dynamodb:Query', 'dynamodb:BatchGetItem', 'dynamodb:BatchWriteItem',
      'dynamodb:ConditionCheckItem', 'dynamodb:DescribeTable',
    ]);
    expect(taskActions(classificationTemplate()).filter((a) => !permitted.has(a))).toEqual([]);
  });

  it('never reaches them with a Scan', () => {
    // Stated separately from the set above because it is the one verb whose presence would make the
    // conversation scope UNENFORCEABLE rather than merely unasserted: `channelArn = :ch` is a key
    // condition, and a scan does not have one.
    expect(taskActions(classificationTemplate())).not.toContain('dynamodb:Scan');
  });

  it('grants them ONLY to the roles named here', () => {
    // The list is the point. A service in front of these tables is a boundary only if nothing else
    // still holds them, so an unexpected principal has to be a failing test rather than a discovery.
    //
    // ONE HOLDER, and it took a migration to get here. The list carried three while the router and
    // processor still read the tables directly; each left it as its call sites moved behind the
    // service, and this assertion is what said the migration was unfinished until they had.
    //
    // A SECOND NAME APPEARING HERE IS A BYPASS. The service is the second enforcement layer only
    // while nothing else holds the tables - and the fallback in `task-store` would silently prefer a
    // direct read on any deployment whose service ARN was unset.
    const t = classificationTemplate();
    const holders = new Set<string>();

    for (const r of Object.values(t.findResources('AWS::IAM::Policy'))) {
      const stmts = ((r as any).Properties?.PolicyDocument?.Statement ?? []) as any[];
      if (stmts.some((s) => s.Effect === 'Allow' && touchesTasks(s))) {
        for (const role of asArr((r as any).Properties?.Roles)) holders.add(flat(role));
      }
    }
    for (const [id, r] of Object.entries(t.findResources('AWS::IAM::Role'))) {
      const stmts = (((r as any).Properties?.Policies ?? []) as any[])
        .flatMap((p) => p.PolicyDocument?.Statement ?? []);
      if (stmts.some((s: any) => s.Effect === 'Allow' && touchesTasks(s))) holders.add(id);
    }

    const PERMITTED = ['taskservicerole'];
    const named = Array.from(holders).map(norm);
    expect(named.length).toBeGreaterThan(0);
    // Asserted as the LIST of unexpected holders rather than a boolean, so a failure names the
    // principal that appeared instead of only saying that one did.
    expect(named.filter((h) => !PERMITTED.some((p) => h.includes(p)))).toEqual([]);
  });

  it('the task service holds the tables, and holds them WITHOUT a scan', () => {
    // The destination of the migration above, asserted from the first commit that creates it rather
    // than once the call sites arrive: a service granted more than its callers were would be a
    // widening dressed as a boundary.
    const t = classificationTemplate();
    const roleId = Object.entries(t.findResources('AWS::IAM::Role'))
      .find(([id]) => norm(id).includes('taskservicerole'));
    expect(roleId).toBeDefined();

    const stmts = (((roleId![1] as any).Properties?.Policies ?? []) as any[])
      .flatMap((p) => p.PolicyDocument?.Statement ?? [])
      .filter((s: any) => s.Effect === 'Allow' && touchesTasks(s));
    expect(stmts.length).toBeGreaterThan(0);

    const verbs = stmts.flatMap(actionsOf);
    expect(verbs).not.toContain('dynamodb:Scan');
    // It must also be able to READ THE TAG every refusal is decided on. Without it the tag read
    // fails, the service refuses every conversation, and a total outage looks like a strict boundary.
    const all = (((roleId![1] as any).Properties?.Policies ?? []) as any[])
      .flatMap((p) => p.PolicyDocument?.Statement ?? [])
      .flatMap(actionsOf);
    expect(all).toContain('chime:ListTagsForResource');
  });
});

describe('the user-tasks API and the task tables', () => {
  it('reaches them at all', () => {
    // The same guard-against-the-guard as above, and needed independently: this stack DEFINES the
    // tables, so their ARNs render as `Fn::GetAtt` rather than the SSM `Ref` a classification sees.
    // A flattener that handles one form and not the other passes every assertion below vacuously.
    expect(taskStatements(conversationsTemplate()).length).toBeGreaterThan(0);
  });

  it('holds READ verbs only, never a write', () => {
    // The endpoint answers "what do I owe". Its caller-scoping is application code
    // (`getActiveTasksForUser(callerSub)`), so there is no second layer to catch a defect - which
    // makes a write verb here the difference between a wrong answer and a mutated queue.
    const t = conversationsTemplate();
    const apiStatements = Object.values(t.findResources('AWS::IAM::Policy'))
      .filter((r) => asArr((r as any).Properties?.Roles).map(flat).map(norm)
        .some((x) => x.includes('usertasksapi')))
      .flatMap((r) => ((r as any).Properties?.PolicyDocument?.Statement ?? []) as any[])
      .filter((s) => s.Effect === 'Allow' && touchesTasks(s));

    expect(apiStatements.length).toBeGreaterThan(0);
    const verbs = apiStatements.flatMap(actionsOf);
    expect(verbs.filter((v) => /PutItem|UpdateItem|DeleteItem|BatchWrite/.test(v))).toEqual([]);
  });
});

describe('post-processing and the task tables', () => {
  it('reads a task and cannot advance one', () => {
    // Its own comment states the rule: "this component resolves a turn, it never advances one".
    // Asserted rather than left to the comment, because it is about to grow a triage rule that
    // CREATES tasks, and the grant it grows must be the one that change argues for rather than one
    // that was already sitting there.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'lib', 'stacks', 'post-processing-stack.ts'), 'utf8');
    const taskRead = /TaskRead:[\s\S]{0,500}?agentTasksArn/.exec(src);
    expect(taskRead).not.toBeNull();
    expect(taskRead![0]).toContain("'dynamodb:GetItem'");
    expect(taskRead![0]).not.toMatch(/PutItem|UpdateItem|DeleteItem/);
  });
});

/**
 * THE INVOKE GRANT IS THE CLASSIFICATION BOUNDARY.
 *
 * Not a formality. A direct Lambda invoke attests nothing about its caller, so the service cannot
 * check who is asking; what it can rely on is that only this stack's roles were ever permitted to ask
 * it at all. If the grant widened to every classification's service, the boundary would be gone and
 * nothing in the handler would notice, because there is nothing in the handler to notice with.
 */
describe('the task service invoke grant', () => {
  it('is granted, or a turn cannot reach the service at all', () => {
    const t = classificationTemplate();
    const invokes = allStatements(t)
      .filter((s) => s.Effect === 'Allow' && actionsOf(s).includes('lambda:InvokeFunction'))
      .flatMap((s) => asArr(s.Resource).map(flat).map(norm));
    expect(invokes.some((r) => r.includes('taskservice'))).toBe(true);
  });

  it('names a SPECIFIC function, never a wildcard over the account', () => {
    // A `function:*` here would let one classification's turn reach another's service, which is the
    // entire boundary. Asserted on the statements that mention the service so a wildcard elsewhere
    // in the template (a legitimately prefix-scoped grant) does not mask it.
    const t = classificationTemplate();
    const serviceInvokes = allStatements(t)
      .filter((s) => s.Effect === 'Allow' && actionsOf(s).includes('lambda:InvokeFunction'))
      .flatMap((s) => asArr(s.Resource).map(flat))
      .filter((r) => norm(r).includes('taskservice'));
    expect(serviceInvokes.length).toBeGreaterThan(0);
    // `<functionArn>:*` is CDK's version-qualified form and is still ONE function; what must never
    // appear is a name wildcard, which would reach every classification's service in the account.
    for (const r of serviceInvokes) expect(r).not.toMatch(/function:[^.]*\*/);
  });

  it('stamps the service with the classification it serves', () => {
    // The one fact no caller can influence, and the one every refusal is decided against. A service
    // deployed without it refuses everything, which is safe and useless; deployed with the WRONG one
    // it serves a classification it should not, which is the leak.
    const t = classificationTemplate();
    const fns = Object.entries(t.findResources('AWS::Lambda::Function'))
      .filter(([id]) => id.startsWith('TaskService'));
    expect(fns).toHaveLength(1);
    const vars = ((fns[0][1] as any).Properties?.Environment ?? {}).Variables ?? {};
    expect(vars.SERVICE_CLASSIFICATION).toBe('basic');
  });

  it('tells both halves of a turn where the service is', () => {
    // The router and the processor each read tasks. A function that holds the grant but not the ARN
    // deploys green and silently keeps using its direct table access.
    const t = classificationTemplate();
    const withArn = Object.entries(t.findResources('AWS::Lambda::Function'))
      .filter(([, r]) => ((r as any).Properties?.Environment ?? {}).Variables?.TASK_SERVICE_ARN)
      .map(([id]) => norm(id));
    expect(withArn.some((id) => id.includes('asyncprocessor'))).toBe(true);
    expect(withArn.some((id) => id.includes('agenthandler'))).toBe(true);
  });
});

/**
 * A TURN REACHES TASKS THROUGH THE SEAM, NEVER THE TABLE.
 *
 * The service is only the second enforcement layer if callers stop going around it. Governance is
 * infrastructure: every sensitive operation is supposed to carry two layers so one missed check is
 * not a breach, and task access had one - a `channelArn` the caller supplied, in a query.
 *
 * WHAT MAKES THIS WORTH A TEST is that a regression is invisible. Importing `getTask` from
 * `task-tracking` instead of `task-store` compiles, passes every behavioral test, and quietly
 * removes the boundary for that one path. Nothing else would notice.
 */
describe('the turn path reaches tasks through the seam', () => {
  const READ = (p: string) => fs.readFileSync(path.join(__dirname, '..', 'lambda', 'src', p), 'utf8');
  /**
   * The functions the service fronts.
   *
   * THE LIST BEING SHORT IS WHAT LET THE MIGRATION BE DECLARED FINISHED EARLY. It held only the four
   * below, so a router importing `getAssigneeChannelTasks` or `getActiveTask` from `task-tracking`
   * passed this test while reading the table directly - and the grants had already been removed from
   * its role on the strength of the same claim. Nothing failed until a deployed router asked a real
   * table and was denied on every turn that looked up who owned the work.
   *
   * So the rule this encodes is now the real one: EVERY task table read or write reachable from the
   * turn path is fronted, and this list is the record of which. Adding a table-touching function to
   * `task-tracking` and calling it from the turn path means adding it here and to the seam.
   */
  const FRONTED = [
    'getTask', 'createTask', 'updateTaskStatus', 'advanceTaskStateTo',
    'getAssigneeChannelTasks', 'getActiveTaskForOwner', 'getActiveTask',
    'selectStoppableTasks', 'cancelStoppedTasks', 'applyUserResponseToTask', 'recordNoTransitionTurn',
    'claimStateAction',
  ];

  const TURN_PATH = [
    'router-agent-handler.ts',
    'lib/async-processor-core.ts',
    'lib/task-tools.ts',
    'lib/task-answer-repair.ts',
    'lib/turn-triage-proposal.ts',
  ];

  it.each(TURN_PATH)('%s imports none of the fronted functions from task-tracking', (file) => {
    const src = READ(file);
    // Only the VALUE imports matter: a `import type` cannot reach the table.
    const valueImports = src
      .split('\n')
      .filter((l) => /^import \{/.test(l) && /task-tracking\.js/.test(l) && !/^import type/.test(l));
    for (const line of valueImports) {
      const named = line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'));
      for (const fn of FRONTED) {
        expect(new RegExp(`(^|[,\s])${fn}\s*(,|$)`).test(named)).toBe(false);
      }
    }
  });

  it('the seam itself is the ONE module allowed to import them directly', () => {
    // The guard against the guard: if `task-store` stopped importing them, every assertion above
    // would still pass while the seam quietly did nothing.
    const seam = READ('lib/task-store.ts');
    expect(seam).toMatch(/from '\.\/task-tracking\.js'/);
    for (const fn of FRONTED) expect(seam).toContain(fn);
  });

  it('and it gates every one of them on the service being wired', () => {
    // A function that forgot the gate would reach the table on a deployment that HAS the service,
    // which is the bypass this whole seam exists to remove.
    const seam = READ('lib/task-store.ts');
    expect((seam.match(/hasTaskService\(\)/g) || []).length).toBeGreaterThanOrEqual(FRONTED.length);
  });
});
