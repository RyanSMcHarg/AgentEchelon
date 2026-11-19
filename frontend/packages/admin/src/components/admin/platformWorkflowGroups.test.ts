/** EVERY PLATFORM WORKFLOW HAS A PLACE ON THE PAGE, and one that has not been given a group is still shown. */
import { describe, it, expect } from 'vitest';
import { groupPlatformWorkflows, PLATFORM_WORKFLOW_GROUPS } from './platformWorkflowGroups';
import { PLATFORM_MACHINE_KEYS } from '../../../../../../backend/lambda/src/lib/task-state-machines.ts';

describe('the platform workflow groups', () => {
  it('name every platform workflow, each once', () => {
    const named = PLATFORM_WORKFLOW_GROUPS.flatMap((g) => [...g.keys] as string[]);
    expect([...named].sort()).toEqual([...PLATFORM_MACHINE_KEYS].sort());
  });

  it('keep the group order and leave out a group with nothing to show', () => {
    expect(groupPlatformWorkflows([{ key: 'form' }, { key: 'queue_drain' }]).map((g) => g.id)).toEqual(['queue', 'tasks']);
  });

  it('list a workflow no group names under other', () => {
    const groups = groupPlatformWorkflows([{ key: 'something_new' }]);
    expect(groups).toEqual([{ id: 'other', workflows: [{ key: 'something_new' }] }]);
  });
});
