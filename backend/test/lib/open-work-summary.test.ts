/**
 * "WHAT DO YOU STILL NEED FROM ME?" IS ANSWERED FOR EVERY OPEN ITEM (the `open_work_summary` tool).
 *
 * The turn's own task carried its step's needs in the prompt and every other item arrived as a type
 * and a state, so the assistant answered for the item in front of it and said nothing about the rest.
 * The tool reports every open item here with what a waiting step still needs.
 *
 * What is pinned:
 *   - each item is named by its reference, in reference order, with who it waits on;
 *   - a waiting step lists its declared needs, less what the turn's own task already collected;
 *   - a step the assistant is getting on with asks nobody for anything;
 *   - a private item is listed as existing and described no further, even to its own requester;
 *   - the loop offers the tool only when the turn supplied the rows, and answers it with no read.
 */
import { buildOpenWorkSummary, openWorkSummaryPayload, OPEN_WORK_SUMMARY_TOOL_NAME } from '../../lambda/src/lib/open-work-summary';
import type { TaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import { TOOL_REGISTRY, anyToolChangedState } from '../../lambda/src/lib/tool-registry';

const MACHINES = {
  report_generation: {
    initial: 'collecting_requirements',
    states: {
      collecting_requirements: {
        transitions: ['drafting_outline'],
        awaits: { party: 'requester' },
        requires: ['the audience', 'the length'],
      },
      generating: { transitions: ['completed'], produces: 'document' as const, requires: ['nothing a person gives'] },
      completed: { transitions: [], terminal: 'success' },
    },
  },
} as unknown as Record<string, TaskStateMachine>;

const row = (over: Record<string, unknown>) => ({
  taskId: 't', channelArn: 'c', status: 'in_progress', createdAt: '', updatedAt: '',
  taskType: 'report_generation', taskState: 'collecting_requirements',
  assigneeType: 'user', assigneeId: 'me', ...over,
}) as never;

describe('the open work summary', () => {
  it('names every item by reference, in reference order, with who it waits on', () => {
    const items = buildOpenWorkSummary([
      row({ taskId: 'b', taskRef: 3, assigneeId: 'dana' }),
      row({ taskId: 'a', taskRef: 1 }),
      row({ taskId: 'c', taskRef: 2, taskState: 'generating', assigneeType: 'assistant', assigneeId: 'bot' }),
    ], { viewerId: 'me', machines: MACHINES });

    expect(items.map((i) => i.reference)).toEqual(['#1', '#2', '#3']);
    expect(items.map((i) => i.waitingOn)).toEqual(['you', 'an assistant', 'another person']);
    expect(items[0]).toMatchObject({ kind: 'report generation', step: 'collecting requirements' });
  });

  it('lists what a waiting step needs, and nothing for a step the assistant is working on', () => {
    const items = buildOpenWorkSummary([
      row({ taskId: 'a', taskRef: 1 }),
      row({ taskId: 'c', taskRef: 2, taskState: 'generating', assigneeType: 'assistant' }),
    ], { viewerId: 'me', machines: MACHINES });

    expect(items[0].stillNeeds).toEqual(['the audience', 'the length']);
    expect(items[1].stillNeeds).toBeUndefined();
  });

  it('subtracts what the turn\'s own task already collected, naming the requirement but never the value', () => {
    const items = buildOpenWorkSummary([row({ taskId: 'a', taskRef: 1 })], {
      viewerId: 'me',
      machines: MACHINES,
      active: {
        taskId: 'a', taskRef: 1, taskType: 'report_generation', taskState: 'collecting_requirements',
        visibility: 'conversation',
        details: { requirements: { 'the audience': 'engineering leadership' } },
      },
    });

    expect(items[0]).toMatchObject({ current: true, stillNeeds: ['the length'], alreadyGiven: ['the audience'] });
    expect(JSON.stringify(items)).not.toContain('engineering leadership');
  });

  it('includes the turn\'s own task when the conversation read did not carry it yet', () => {
    const items = buildOpenWorkSummary([], {
      machines: MACHINES,
      active: { taskId: 'new', taskRef: 4, taskType: 'report_generation', taskState: 'collecting_requirements' },
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reference: '#4', current: true });
  });

  it('lists a private item as existing and nothing more, even when the viewer may read it', () => {
    const items = buildOpenWorkSummary([
      row({ taskId: 'p1', taskRef: 1, privateItem: true }),
      row({ taskId: 'p2', taskRef: 2, private: true, taskType: undefined, taskState: undefined, assigneeId: undefined }),
    ], { viewerId: 'me', machines: MACHINES });

    for (const item of items) {
      expect(item.private).toBe(true);
      expect(item.kind).toBeUndefined();
      expect(item.step).toBeUndefined();
      expect(item.stillNeeds).toBeUndefined();
    }
    expect(items.map((i) => i.reference)).toEqual(['#1', '#2']);
  });

  it('reads the turn\'s own task with no visibility as private, whether or not the read carried it', () => {
    // Absent fails closed. Both paths: the task the conversation read already
    // listed, and the one it did not carry yet.
    const active = {
      taskId: 'a', taskRef: 1, taskType: 'report_generation', taskState: 'collecting_requirements',
    };
    for (const rows of [[row({ taskId: 'a', taskRef: 1 })], []]) {
      const [item] = buildOpenWorkSummary(rows, { viewerId: 'me', machines: MACHINES, active });
      expect(item).toMatchObject({ reference: '#1', current: true, private: true });
      expect(item.kind).toBeUndefined();
      expect(item.stillNeeds).toBeUndefined();
    }
  });

  it('says so plainly when nothing is open', () => {
    expect(openWorkSummaryPayload([]).guidance).toMatch(/Nothing is open/);
    expect(openWorkSummaryPayload([{ waitingOn: 'you' }]).items).toHaveLength(1);
  });

  it('is registered as a read-only task tool', () => {
    const entry = TOOL_REGISTRY.find((t) => t.name === OPEN_WORK_SUMMARY_TOOL_NAME);
    expect(entry).toMatchObject({ category: 'task', changesState: false });
    expect(anyToolChangedState([OPEN_WORK_SUMMARY_TOOL_NAME])).toBe(false);
  });
});

describe('the conversation read marks every private row', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const tracking = fs.readFileSync(path.resolve(__dirname, '../../lambda/src/lib/task-tracking.ts'), 'utf8');

  it('including one the viewer may read, which `private` alone does not', () => {
    expect(tracking).toContain('...(isPrivate ? { privateItem: true as const } : {}),');
  });
});

describe('the processor supplies the rows, so the loop reads nothing more', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const proc = fs.readFileSync(path.resolve(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');

  it('builds the summary from the conversation read and the turn\'s own task, off readings and duels', () => {
    const at = proc.indexOf('openWorkSummary: buildOpenWorkSummary(conversationTasksAll, {');
    expect(at).toBeGreaterThan(-1);
    expect(proc.slice(at - 300, at)).toContain('!isTriageTurn && !battleOn');
    expect(proc.slice(at, at + 400)).toContain('active: turnTasks?.current ?? null');
  });
});
