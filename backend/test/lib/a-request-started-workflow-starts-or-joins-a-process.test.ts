/**
 * A REQUEST-STARTED WORKFLOW STARTS OR JOINS A PROCESS (SPEC-PROCESSES P1, P2, P8, P13; DESIGN-PROCESSES "A request starts or
 * joins a process").
 *
 * What it proves:
 *  - a version's `processes` may link its request-started workflows (`intentWorkflows`, keyed by the intent) as well as its
 *    event workflows; a name in neither is still refused, a workflow two processes link is still refused, and a metric may name
 *    a request-started workflow and its steps;
 *  - a run of a linked request-started workflow starts the process under the same id scheme as an event run, keyed by the
 *    process and the request's own run key, and a workflow no process links starts none;
 *  - the router starts or joins a process for an intent's run before any step, joining the asking run's process read from the
 *    task's platform-written `askedBy`, else the process that opened the conversation, read from the record the router wrote
 *    there as the opening run started (never from what anyone said), carries it on the request's own task, and reads it back from the run's own task row
 *    when the run goes on, so the run's end records it; a task's turns carry it on their out-of-band record, never on Metadata;
 *  - a process manifest requires the intent of a linked request-started workflow and the machine its own step opens, and a
 *    target whose owner does not answer the intent is refused with its own code; a process of event workflows requires nothing new.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PROCESS_REFUSALS, linkableWorkflows, processOfWorkflow, versionProcessesErrors, type VersionProcess } from '../../lambda/src/lib/event-workflow';
import { canonicalIntentWorkflow, intentRunKey, intentWorkflowErrors } from '../../lambda/src/lib/intent-workflow';
import { ACCOUNT_BRIEF_INTENT, ACCOUNT_BRIEF_WORKFLOW } from '../../../demo/stratum-company/intent-packs';
import { startedProcess, processEditionOf } from '../../lambda/src/lib/process-start';
import { PROCESS_MANIFEST_REFUSALS, processRequirementErrors, processRequirementsOf, readProcessManifest, type ProcessTarget } from '../../lambda/src/lib/process-manifest';
import { buildAnalyticsMetadata, processRunOf } from '../../lambda/src/lib/analytics-metadata';
import { contentHash12 } from '../../lambda/src/lib/canonical-json';
import { advisorBriefProcess, advisorBriefProcessManifest, advisorBriefWorkflowIsCurrent, advisorIntentWorkflows, ACCOUNT_BRIEF_PROCESS } from '../../../demo/portable-assistants/advisor-processes';
import { opsIncidentProcessManifest } from '../../../demo/portable-assistants/ops-assistant-manifest';

const eventWorkflows = {
  'ops-room': { on: 'conversation-opened', types: ['ops'], initial: 'done', states: { done: { disposition: 'success' } } },
};
const intentWorkflows = {
  account_brief: {
    on: { intent: 'account_brief' }, initial: 'work',
    states: { work: { label: 'Brief written', task: { machine: 'account_brief', for: 'requester' }, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } },
  },
};
const errs = (processes: unknown) => versionProcessesErrors(processes, eventWorkflows, intentWorkflows);
const codes = (processes: unknown) => errs(processes).map((e) => e.split(': ')[1]);
const briefs: VersionProcess = { label: 'Account briefs', workflows: ['account_brief'] };

describe('a process links a version\'s request-started workflows (P1)', () => {
  it('a request-started workflow alone, or beside an event workflow', () => {
    expect(errs({ briefs })).toEqual([]);
    expect(errs({ briefs: { ...briefs, workflows: ['account_brief', 'ops-room'] } })).toEqual([]);
  });

  it('DENY: a name the version declares neither as an event workflow nor as an intent\'s workflow', () => {
    expect(codes({ briefs: { ...briefs, workflows: ['report_generation'] } })).toEqual(['PROCESS_WORKFLOW_UNDECLARED']);
    // WITHOUT THE INTENT'S WORKFLOW the name is not linkable, as before.
    expect(versionProcessesErrors({ briefs }, eventWorkflows).map((e) => e.split(': ')[1])).toEqual(['PROCESS_WORKFLOW_UNDECLARED']);
  });

  it('DENY: one request-started workflow linked by two processes', () => {
    expect(codes({ a: briefs, b: { label: 'B', workflows: ['account_brief'] } })).toEqual(['PROCESS_WORKFLOW_LINKED_TWICE']);
  });

  it('a metric names a request-started workflow and one of its steps', () => {
    const metric = (m: unknown) => ({ briefs: { ...briefs, metrics: [m] } });
    expect(errs(metric({ id: 'written', label: 'Written', workflow: 'account_brief', step: 'work', within: 'PT1H' }))).toEqual([]);
    expect(codes(metric({ id: 'written', label: 'Written', workflow: 'account_brief', step: 'nope' }))).toEqual(['METRIC_STEP']);
  });

  it('an event workflow of the same name as an intent is the one a name links', () => {
    const both = linkableWorkflows({ account_brief: eventWorkflows['ops-room'] }, intentWorkflows);
    expect(both.account_brief).toBe(eventWorkflows['ops-room']);
  });

  it('every process refusal still has its copy, the request-started one included', () => {
    const locale = JSON.parse(readFileSync(resolve(__dirname, '../../../frontend/packages/shared/src/locales/en.json'), 'utf8'));
    for (const code of [...PROCESS_REFUSALS, ...PROCESS_MANIFEST_REFUSALS]) expect(`${code}: ${typeof locale.admin.processes.errors[code]}`).toBe(`${code}: string`);
  });
});

describe('a run of a linked request-started workflow starts the process (P2)', () => {
  const runKey = intentRunKey('corr-1', 'advisor');
  it('under the event run\'s id scheme, keyed by the process and the request\'s run key', () => {
    const started = startedProcess({ briefs }, 'account_brief', runKey);
    expect(started).toEqual({ id: contentHash12({ process: 'briefs', run: runKey }), name: 'briefs', edition: processEditionOf(briefs) });
    expect(processOfWorkflow({ briefs }, 'account_brief')?.name).toBe('briefs');
  });
  it('a request-started workflow no process links starts none', () => {
    expect(startedProcess({ briefs }, 'report_generation', runKey)).toBeUndefined();
  });
});

describe('the router starts or joins the process for an intent\'s run, and the id rides the run (P2, P8)', () => {
  const src = (p: string) => readFileSync(resolve(__dirname, '../../lambda/src', p), 'utf8');
  const router = src('router-agent-handler.ts');
  const between = (from: string, to: string) => router.slice(router.indexOf(from), router.indexOf(to, router.indexOf(from)));

  it('only where the version links the intent\'s workflow, joining the asking run\'s process, else the conversation\'s, else starting its own', () => {
    const fn = between('async function intentRunProcessFor(', '/** A run\'s process as its run-end fact records it');
    expect(fn).toMatch(/who\.version\?\.eventWorkflows\?\.\[intent\] \|\| !processOfWorkflow\(who\.version\?\.processes, intent\)/);
    expect(fn).toMatch(/const asking = runProcessOf\(askedBy\?\.process\) \?\? await conversationProcessOf\(ctx\.channelArn\);/);
    expect(fn).toMatch(/runProcessFor\(asking \? \{ \.\.\.ctx, process: asking \} : ctx, who, intent, runKey\)/);
    // THE CONVERSATION'S PROCESS is read from the platform's own record in that conversation, checked for shape.
    expect(fn).toMatch(/readRunWait\(\{ waitId: CONVERSATION_PROCESS_WAIT_ID, channelArn \}\)/);
    expect(fn).toMatch(/return runProcessOf\(held\?\.process\);/);
  });

  it('a conversation a process opened records that process once, before its opening run starts, only where a workflow opened it', () => {
    const opened = between('export async function handleConversationOpened(', 'async function noticeSelection(');
    expect(opened).toMatch(/const inherited = openedBy === 'workflow' \? runProcessOf\(req\.process\) : undefined;/);
    expect(opened).toContain('if (inherited) await recordConversationProcess(channelArn, inherited);');
    expect(opened.indexOf('recordConversationProcess(')).toBeLessThan(opened.indexOf('runWorkflowFor('));
    // WRITTEN ONCE, through the task service's write-once record, and without the team: each run names its own.
    const rec = between('async function recordConversationProcess(', '/** A run\'s process as its run-end fact records it');
    expect(rec).toMatch(/const \{ ownerTeam: _team, \.\.\.named \} = proc;/);
    expect(rec).toMatch(/holdRunWait\(\{ waitId: CONVERSATION_PROCESS_WAIT_ID, channelArn, continuation: \{ process: named \} \}\)/);
  });

  it('started before any step of the request\'s run, and carried on the request\'s own task', () => {
    const start = between('async function startIntentRun(', 'async function runOriginVersion(');
    expect(start.indexOf('intentRunProcessFor(base, who, args.intent, runKey, args.askedBy)')).toBeGreaterThan(start.indexOf('intentRunKey('));
    expect(start.indexOf('intentRunProcessFor(')).toBeLessThan(start.indexOf('runEventWorkflow('));
    expect(start).toMatch(/\.\.\.\(gated\.process \? \{ process: gated\.process \} : \{\}\)/);
  });

  it('read back from the run\'s own task row when the run goes on, never from the hand-back, so its end records it', () => {
    const cont = between('export async function handleIntentContinuation(', 'async function endStoppedRuns(');
    expect(cont).toMatch(/const ownProcess = runProcessOf\(own\.workflowRun\?\.process\);/);
    expect(cont).toMatch(/\.\.\.\(ownProcess \? \{ process: ownProcess \} : \{\}\)/);
    expect(cont).not.toMatch(/runProcessOf\(req\.process\)/);
    // THE END FACT names the context's process (`eventRunDeps`), which every intent run's context now carries.
    expect(router).toMatch(/recordRunEnded\(\{[\s\S]{0,400}\.\.\.processFactFields\(ctx\.process\)/);
  });

  it('a task\'s turns carry the run\'s process on their out-of-band record only', () => {
    const core = src('lib/async-processor-core.ts');
    expect(core).toMatch(/task\.workflowRun\?\.process && messageAnalyticsEnabled\(\) \? \{ processRun: processRunOf\(/);
    const meta = buildAnalyticsMetadata({ processRun: processRunOf({ id: 'a1b2c3d4e5f6', name: 'briefs', edition: '0123456789ab', ownerTeam: 'advisory' }) } as never);
    expect((meta as { processRun?: unknown }).processRun).toEqual({ processId: 'a1b2c3d4e5f6', process: 'briefs', processEdition: '0123456789ab', ownerTeam: 'advisory' });
    // NEVER ON THE MESSAGE'S METADATA: the frontend set does not name it.
    expect(src('lib/analytics-metadata.ts')).not.toMatch(/FRONTEND_METADATA_KEYS[^;]*'processRun'/);
  });
});

describe('a process manifest requires what a linked request-started workflow needs (P13)', () => {
  const requires = processRequirementsOf(briefs, eventWorkflows as never, intentWorkflows as never);
  const target = (over: Partial<ProcessTarget> = {}): ProcessTarget => ({
    workflows: ['ops-room', 'account_brief'], intents: ['account_brief'], conversationTypes: {}, assistantRoles: {}, templates: [], machines: ['account_brief'], ...over,
  });

  it('the intent itself and the machine its own step opens', () => {
    expect(requires.intents).toEqual(['account_brief']);
    expect(requires.machines).toEqual(['account_brief']);
    expect(requires.workflows).toEqual(['account_brief']);
  });

  it('met where the owner answers the intent and declares its workflow', () => {
    expect(processRequirementErrors(requires, target())).toEqual([]);
  });

  it('DENY: an owner that does not answer the intent, with its own code', () => {
    expect(processRequirementErrors(requires, target({ intents: [] }))).toEqual([{ code: 'PROCESS_REQ_OWN_INTENT', intent: 'account_brief', workflow: 'account_brief' }]);
  });

  it('DENY: an owner that does not declare the intent\'s workflow', () => {
    expect(processRequirementErrors(requires, target({ workflows: ['ops-room'] })).map((r) => r.code)).toEqual(['PROCESS_REQ_WORKFLOW']);
  });

  it('a process of event workflows requires no intent, so its manifest reads as it always has', () => {
    expect(opsIncidentProcessManifest().requires).not.toHaveProperty('intents');
  });
});

describe('the demo\'s request-started process (Advisor\'s account briefs)', () => {
  it('links Advisor\'s account brief workflow, and its manifest reads back and requires the intent', () => {
    expect(versionProcessesErrors(advisorBriefProcess(), {}, advisorIntentWorkflows())).toEqual([]);
    const manifest = advisorBriefProcessManifest();
    expect(manifest.processName).toBe(ACCOUNT_BRIEF_PROCESS);
    expect(manifest.requires.intents).toEqual(['account_brief']);
    expect(manifest.requires.machines).toEqual(['account_brief']);
    expect('manifest' in readProcessManifest(JSON.parse(JSON.stringify(manifest)))).toBe(true);
  });

  it('runs the canonical workflow with its one step labeled, so the process shows that step as its stage', () => {
    const shipped = advisorIntentWorkflows().account_brief;
    const canonical = canonicalIntentWorkflow('account_brief');
    const { label, description, ...work } = shipped.states.work as unknown as Record<string, unknown>;
    expect(label).toBe('Brief');
    expect(typeof description).toBe('string');
    expect({ ...shipped, states: { ...shipped.states, work } }).toEqual(canonical);
    const opts = { multiStepIntents: ['account_brief'], intents: ['account_brief'], machines: { account_brief: ACCOUNT_BRIEF_WORKFLOW } };
    expect(intentWorkflowErrors('account_brief', shipped, opts)).toEqual([]);
    // A STAGE IS A STEP WITH A LABEL (the console's `declaredStages`): the brief's one step, and nothing else.
    const labeled = Object.entries(shipped.states).filter(([, def]) => (def as { label?: string }).label).map(([step, def]) => `${ACCOUNT_BRIEF_INTENT}.${step}:${(def as { label: string }).label}`);
    expect(labeled).toEqual(['account_brief.work:Brief']);
  });

  it('the import holds the active version to that labeled workflow, and a version without the label is not current', () => {
    expect(advisorBriefWorkflowIsCurrent({ intentWorkflows: JSON.parse(JSON.stringify(advisorIntentWorkflows())) })).toBe(true);
    expect(advisorBriefWorkflowIsCurrent({ intentWorkflows: { account_brief: canonicalIntentWorkflow('account_brief') } })).toBe(false);
    expect(advisorBriefWorkflowIsCurrent({})).toBe(false);
    const importer = readFileSync(resolve(__dirname, '../../scripts/lib/demo-process-import.mjs'), 'utf8');
    expect(importer).toMatch(/call\('\/draft', \{ profileName: owner, configId, patch: \{ intentWorkflows: \{ \.\.\.\(exported\?\.body\?\.intentWorkflows \?\? \{\}\), \.\.\.advisorIntentWorkflows\(\) \} \} \}\)/);
    expect(importer).toMatch(/!advisorBriefWorkflowIsCurrent\(after\?\.body\)/);
    // SAVING THE LABEL GIVES THE DRAFT A NEW configId: that one is validated and activated, never the configId the import landed.
    expect(importer).toMatch(/const draftConfigId = labeled\.draftConfigId;/);
    expect(importer).toMatch(/valid\.configId !== draftConfigId/);
    expect(importer).toMatch(/call\('\/activate', \{ profileName: owner, configId: draftConfigId \}\)/);
  });
});
