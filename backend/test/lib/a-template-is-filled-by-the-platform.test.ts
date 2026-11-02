/**
 * A PLATFORM-FILLED TEMPLATE IS RENDERED FROM WHAT THE TASK RECORDED, WITH NO MODEL CALL
 * (SPEC-DOCUMENT-TEMPLATES FR9).
 *
 * A field binds to a SOURCED requirement (what the person said, or a retrieved passage) or to a value on
 * the task's details. A field nothing recorded refuses the whole delivery with a named error rather than
 * shipping a document with a gap in it, and the advance that would have delivered it moves nothing.
 */
const mockAdvance = jest.fn();
jest.mock('../../lambda/src/lib/task-store', () => ({
  ...jest.requireActual('../../lambda/src/lib/task-store'),
  advanceTaskStateTo: (...args: unknown[]) => mockAdvance(...args),
}));

import { parseTemplate, fillTemplate } from '../../lambda/src/lib/document-template';
import { handleAdvanceTaskStateTool, handleDeliverDocumentTool, declarationForReplayedAdvance } from '../../lambda/src/lib/task-tools';
import { validateTaskStateMachine, type TaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import type { Task } from '../../lambda/src/lib/task-tracking';

const SOURCE = `---
${JSON.stringify({
  name: 'access-request-record',
  description: 'The record of an access request, filled from what was agreed.',
  fill: 'platform',
  fields: { system: 'requirement:the system', who: 'requirement:who needs it', ticket: 'detail:ticketId' },
})}
---
# Access request

## Request

| System | Requested for | Ticket |
|---|---|---|
| {{system}} | {{who}} | {{ticket}} |
`;
const TEMPLATE = parseTemplate(SOURCE);
const HASH = 'e'.repeat(64);

const sourced = (value: string) => ({ value, source: 'message', evidence: value });

describe('a platform-filled template renders from the record', () => {
  it('fills every field from sourced requirements and details', () => {
    const out = fillTemplate(TEMPLATE, {
      collectedRequirements: { 'the system': sourced('Billing'), 'who needs it': sourced('Dana Ortiz') },
      ticketId: 'ACC-42',
    });
    expect(out).toEqual({ ok: true, document: expect.stringContaining('| Billing | Dana Ortiz | ACC-42 |') });
  });

  it('refuses a field with nothing recorded, naming it, rather than shipping a gap', () => {
    const out = fillTemplate(TEMPLATE, { collectedRequirements: { 'the system': sourced('Billing') }, ticketId: 'ACC-42' });
    expect(out).toMatchObject({ ok: false, error: 'template_unbound_field', field: 'who', binding: 'requirement:who needs it' });
  });

  it('reads only a SOURCED requirement: a plain value the model filled in does not bind', () => {
    const out = fillTemplate(TEMPLATE, {
      requirements: { 'the system': 'Billing', 'who needs it': 'Dana Ortiz' },
      ticketId: 'ACC-42',
    });
    expect(out.ok).toBe(false);
  });
});

describe('a field binds to the result a declared step action recorded (`tool:<state>.<path>`, FR9 with SPEC-TASK-STATE-TRANSITIONS FR29)', () => {
  const QUOTE = parseTemplate(`---
${JSON.stringify({
    name: 'quote', description: 'A quote.', fill: 'platform',
    fields: { first: 'tool:searching.options.0.summary', price: 'tool:searching.options.0.priceUsd', portal: 'tool:searching.portalUrl' },
  })}
---
# Quote

{{first}} at {{price}} USD, book at {{portal}}
`);

  it('reads the successful run by state and path, walking array indices', () => {
    const out = fillTemplate(QUOTE, {
      actions: {
        searching: {
          tool: 'search_corporate_travel', ok: true, key: 'searching#1', at: 'now',
          result: { options: [{ summary: 'SEA to JFK', priceUsd: 412 }], portalUrl: 'https://travel.example' },
        },
      },
    });
    expect(out).toEqual({ ok: true, document: expect.stringContaining('SEA to JFK at 412 USD, book at https://travel.example') });
  });

  it('refuses a field whose action failed, or never ran, naming the state', () => {
    const failed = fillTemplate(QUOTE, { actions: { searching: { tool: 'search_corporate_travel', ok: false, errorClass: 'timeout' } } });
    expect(failed).toMatchObject({ ok: false, error: 'template_unbound_field', field: 'first' });
    expect(failed.ok ? '' : failed.message).toContain('"searching"');
    expect(fillTemplate(QUOTE, {}).ok).toBe(false);
  });

  it('refuses a path that is not in the result rather than filling a gap', () => {
    const out = fillTemplate(QUOTE, {
      actions: { searching: { tool: 'search_corporate_travel', ok: true, result: { options: [], portalUrl: 'x' } } },
    });
    expect(out).toMatchObject({ ok: false, field: 'first' });
  });
});

describe('the delivering step is filled by the platform, not written by the model', () => {
  const machine: TaskStateMachine = {
    initial: 'collecting',
    states: {
      collecting: {
        transitions: ['recording'],
        awaits: { party: 'requester' },
        requires: ['the system', 'who needs it'],
      },
      recording: { transitions: ['done'], produces: 'document' as const, template: 'access-request-record' },
      done: { transitions: [], terminal: 'success' },
    },
  };
  const machines = { access_request: machine };
  const templates = { 'access-request-record': { name: 'access-request-record', contentHash: HASH, template: TEMPLATE } };
  const task = (details: Record<string, unknown>): Task => ({
    taskId: 't1', channelArn: 'arn:c', taskType: 'access_request', taskState: 'collecting', status: 'in_progress', details,
  } as Task);
  const collected = [
    { need: 'the system', value: 'Billing', source: 'message', evidence: 'billing' },
    { need: 'who needs it', value: 'Dana Ortiz', source: 'message', evidence: 'for Dana' },
  ];

  beforeEach(() => mockAdvance.mockReset().mockResolvedValue({ ok: true, from: 'collecting', to: 'recording' }));

  it('validates as a machine', () => {
    expect(() => validateTaskStateMachine('access_request', machine)).not.toThrow();
  });

  it('delivers the filled document with no document from the model', async () => {
    const out = await handleAdvanceTaskStateTool({
      task: task({ ticketId: 'ACC-42' }), machines, templates,
      input: { to_state: 'recording', reason: 'confirmed', collected },
    });
    expect(out.result.ok).toBe(true);
    expect(out.document).toContain('| Billing | Dana Ortiz | ACC-42 |');
    expect(out.template).toMatchObject({ filled: true, state: 'recording' });
    expect(out.payload.document_filled_by_platform).toBe(true);
  });

  it('fills the document on the move into a step that writes its own document, since no model writes it (ADR-064 decision B)', async () => {
    const out = await handleAdvanceTaskStateTool({
      task: task({ ticketId: 'ACC-42' }), machines, templates, documentWrittenOnStep: () => true,
      input: { to_state: 'recording', reason: 'confirmed', collected },
    });
    expect(out.document).toContain('| Billing | Dana Ortiz | ACC-42 |');
    expect(out.template).toMatchObject({ filled: true, state: 'recording' });
    expect(out.payload).not.toHaveProperty('writes_document');
  });

  it('ignores a document the model wrote: the record is the document', async () => {
    const out = await handleAdvanceTaskStateTool({
      task: task({ ticketId: 'ACC-42' }), machines, templates,
      input: { to_state: 'recording', reason: 'confirmed', collected, document: '# Something else entirely' },
    });
    expect(out.document).not.toContain('Something else');
  });

  it('refuses the delivery, moving nothing, when a bound field has nothing recorded', async () => {
    const out = await handleAdvanceTaskStateTool({
      task: task({}), machines, templates,
      input: { to_state: 'recording', reason: 'confirmed', collected },
    });
    expect(out.result).toMatchObject({ ok: false, error: 'template_unbound_field' });
    expect(out.payload).toMatchObject({ refusal: 'template_unbound_field', field: 'ticket' });
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it('re-renders a rewrite inside the step from the record', () => {
    const inStep = { ...task({ ticketId: 'ACC-9', collectedRequirements: { 'the system': sourced('HR'), 'who needs it': sourced('Lee') } }), taskState: 'recording' } as Task;
    const out = handleDeliverDocumentTool({ task: inStep, machines, templates, input: { document: 'model text' } });
    expect(out.document).toContain('| HR | Lee | ACC-9 |');
    expect(out.template?.filled).toBe(true);
  });
});

describe('a retried model call that replays an advance already written still carries its template', () => {
  const machine: TaskStateMachine = {
    initial: 'collecting',
    states: {
      collecting: { transitions: ['recording'], awaits: { party: 'requester' }, requires: ['the system', 'who needs it'] },
      recording: { transitions: ['done'], produces: 'document' as const, template: 'access-request-record' },
      done: { transitions: [], terminal: 'success' },
    },
  };
  const filledTemplates = { 'access-request-record': { name: 'access-request-record', contentHash: HASH, template: TEMPLATE } };
  const written = parseTemplate(`---\n${JSON.stringify({ name: 'access-request-record', description: 'Written by the model.' })}\n---\n# Access request\n\n## Request\n`);
  const writtenTemplates = { 'access-request-record': { name: 'access-request-record', contentHash: HASH, template: written } };
  const details = { ticketId: 'ACC-7', collectedRequirements: { 'the system': sourced('CRM'), 'who needs it': sourced('Ana') } };

  it('re-renders a platform-filled document from the record, with the template, for the delivery check', () => {
    const out = declarationForReplayedAdvance({
      machine, from: 'collecting', to: 'recording', details, templates: filledTemplates, document: 'model text',
    });
    expect(out.document).toContain('| CRM | Ana | ACC-7 |');
    expect(out.template).toMatchObject({ filled: true, state: 'recording' });
  });

  it('carries the template beside the replayed document when the model writes it', () => {
    const out = declarationForReplayedAdvance({
      machine, from: 'collecting', to: 'recording', details, templates: writtenTemplates, document: '# Access request\n\n## Request\n\nCRM for Ana.',
    });
    expect(out.document).toContain('CRM for Ana.');
    expect(out.template).toMatchObject({ state: 'recording', chosen: false });
    expect(out.template?.filled).toBeUndefined();
  });

  it('declares no model-written document on a replayed move into a step that writes its own, and still the platform fill', () => {
    expect(declarationForReplayedAdvance({
      machine, from: 'collecting', to: 'recording', details, templates: writtenTemplates, document: '# Access request\n\n## Request\n\nCRM.', writtenOnStep: true,
    })).toEqual({});
    const filled = declarationForReplayedAdvance({
      machine, from: 'collecting', to: 'recording', details, templates: filledTemplates, document: 'model text', writtenOnStep: true,
    });
    expect(filled.document).toContain('| CRM | Ana | ACC-7 |');
  });

  it('declares only the document on an edge that hands over nothing, and nothing without one', () => {
    expect(declarationForReplayedAdvance({ machine, from: 'recording', to: 'done', details, templates: writtenTemplates }))
      .toEqual({});
    const quiet: TaskStateMachine = { ...machine, states: { ...machine.states, recording: { transitions: ['done'] } } };
    expect(declarationForReplayedAdvance({ machine: quiet, from: 'collecting', to: 'recording', details, templates: writtenTemplates, document: 'x' }))
      .toEqual({ document: 'x' });
  });
});
