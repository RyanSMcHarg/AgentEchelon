/**
 * A WORKFLOW IS CHECKED AGAINST WHAT ITS EVENT RUNS (ADR-061 decisions 1 to 3, W1).
 *
 * What it proves: a prompt step reached after an agent or a task step is refused, because the run goes on past such a
 * step through its hand-back, which says no prompt turn, while a prompt step after the opening is not; and a step that
 * addresses, mentions or names the subject on any event but `assistant-joined`, where the subject is resolved, is said
 * as a warning naming the step, never refused, so a version stored with one still validates and Validate says why it
 * reaches nobody.
 */
import { getModelCatalog } from '../../lib/config/model-strategy';
import {
  eventWorkflowSubjectWarnings, versionEventWorkflowsErrors, type EventStepDef, type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import { createDraft, editDraft, validateDraft } from '../../lambda/src/lib/profile-lifecycle';
import { __clearActiveProfileCache } from '../../lambda/src/lib/active-profile';
import { fakeSsmStore } from '../helpers/fake-ssm-store';

const ROOT = '/agent-echelon';
const NAME = 'ops-premium';
const CATALOG = getModelCatalog('us-east-1', '123456789012');

beforeEach(() => __clearActiveProfileCache());

const AGENT: EventStepDef = {
  agent: { prompt: 'ops-first-look', tools: [], to: 'room', deadlineMs: 20_000, fallback: { send: { to: 'room', template: 'workflow-opening' } } },
};
const PROMPT: EventStepDef = { prompt: { template: 'welcome-greeting' }, onSuccess: 'done', onFailure: 'done' };

describe('a prompt turn is said only where the join runs the welcome', () => {
  it('refuses a prompt step reached after an agent step, naming both', () => {
    const wf: EventWorkflow = {
      on: 'assistant-joined', initial: 'opening',
      states: {
        opening: { opening: {}, onSuccess: 'think', onFailure: 'think' },
        think: { ...AGENT, onSuccess: 'ask', onFailure: 'done' },
        ask: PROMPT,
        done: { disposition: 'success' },
      },
    };
    expect(versionEventWorkflowsErrors({ welcome: wf })).toContain(
      'eventWorkflows.welcome.states.ask is a prompt step reached after think, an agent step; a run goes on past such a step without the join that says a prompt turn, so a prompt step comes before every agent, task and wait step',
    );
  });

  it('refuses a prompt step reached after a task step, however many steps lie between', () => {
    const wf: EventWorkflow = {
      on: 'assistant-joined', initial: 'opening',
      states: {
        opening: { opening: {}, onSuccess: 'ack', onFailure: 'done' },
        ack: { task: { machine: 'acknowledgement', for: 'subject', by: 'subject', deadline: { afterMinutes: 60 } }, onSuccess: 'say', onFailure: 'done' },
        say: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'ask', onFailure: 'done' },
        ask: PROMPT,
        done: { disposition: 'success' },
      },
    };
    expect(versionEventWorkflowsErrors({ welcome: wf }).join('\n')).toMatch(/states\.ask is a prompt step reached after ack, a task step/);
  });

  it('accepts a prompt step after the opening, the welcome the join says', () => {
    const wf: EventWorkflow = {
      on: 'assistant-joined', initial: 'opening',
      states: { opening: { opening: {}, onSuccess: 'ask', onFailure: 'ask' }, ask: PROMPT, done: { disposition: 'success' } },
    };
    expect(versionEventWorkflowsErrors({ welcome: wf })).toEqual([]);
  });
});

describe('the subject is known where the assistant joins, and only there', () => {
  const joined: EventWorkflow = {
    on: 'person-joined', initial: 'hi',
    states: {
      hi: { send: { to: 'joined', template: 'workflow-subject-welcome', mention: { name: 'subject' } }, onSuccess: 'tell' },
      tell: { send: { to: 'subject', template: 'workflow-opening' }, onSuccess: 'done' },
      done: { disposition: 'success' },
    },
  };

  it('names each step that addresses or mentions the subject off assistant-joined, and refuses none', () => {
    expect(eventWorkflowSubjectWarnings('greet', joined)).toEqual([
      'eventWorkflows.greet.states.hi.send.mention.name mentions subject, the person the conversation was opened for, who is known on assistant-joined only; on person-joined it renders nothing',
      'eventWorkflows.greet.states.tell.send.to addresses subject, the person the conversation was opened for, who is known on assistant-joined only; on person-joined it reaches nobody',
    ]);
    expect(versionEventWorkflowsErrors({ greet: joined })).toEqual([]);
  });

  it('says nothing of a welcome, which knows the subject', () => {
    expect(eventWorkflowSubjectWarnings('welcome', { ...joined, on: 'assistant-joined', states: { ...joined.states, hi: { send: { to: 'room', template: 'workflow-opening', mention: { name: 'subject' } }, onSuccess: 'tell' } } })).toEqual([]);
  });

  it('Validate says it beside the result, so a stored version with one still validates', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, NAME, 'admin');
    await editDraft(client, ROOT, NAME, { eventWorkflows: { greet: joined } } as never, 'admin');
    const res = await validateDraft(client, ROOT, NAME, CATALOG);
    expect(res.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/eventWorkflows\.greet\.states\.tell\.send\.to addresses subject/)]));
    expect(res.errors.filter((e) => /(addresses|mentions) subject/.test(e))).toEqual([]);
  });
});
