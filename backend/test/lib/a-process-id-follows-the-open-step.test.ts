/**
 * A PROCESS ID FOLLOWS THE OPEN STEP (SPEC-PROCESSES P2, P3; DESIGN-PROCESSES section 3).
 *
 * What it proves: the process a run starts or inherits is one field of the run's identity, so every record that continues
 * the run (a held wait, a task's workflow run, an agent step's dispatch and hand-back, the `open` step's continuation) carries
 * it; the conversation an `open` step opens inherits it, and only where a workflow opened it; a hand-back's process is kept
 * only where every part has its shape; and the run's owner team is this run's assistant's, never the opener's.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runProcessOf } from '../../lambda/src/lib/event-workflow';

const src = (p: string) => readFileSync(resolve(__dirname, '../../lambda/src', p), 'utf8');
const router = src('router-agent-handler.ts');

describe('a run carries its process on every record that continues it', () => {
  it('as one field of the run\'s identity', () => {
    const identity = router.slice(router.indexOf('function runIdentity('), router.indexOf('function runProcessFor('));
    expect(identity).toMatch(/ctx\.process \? \{ process: ctx\.process \}/);
  });

  it('started or inherited before any step, with this run\'s owner team', () => {
    const run = router.slice(router.indexOf('async function runWorkflowFor('), router.indexOf('async function participantRolesForRun('));
    expect(run.indexOf('runProcessFor(ctx, who, name, runKey)')).toBeGreaterThan(run.indexOf('eventRunKey('));
    expect(run.indexOf('runProcessFor(')).toBeLessThan(run.indexOf('runEventWorkflow('));
    const fn = router.slice(router.indexOf('function runProcessFor('), router.indexOf('function runnerOf('));
    expect(fn).toMatch(/ctx\.process \?\? startedProcess\(who\.version\?\.processes, name, runKey\)/);
    expect(fn).toMatch(/ownerTeam: _inherited/);
  });

  it('through a task\'s settlement and an agent step\'s hand-back', () => {
    expect(router).toMatch(/run\.process \? \{ process: run\.process \}/);
    expect(router).toMatch(/const runProc = runProcessOf\(req\.process\);/);
    expect(src('assistant-async-processor.ts')).toMatch(/req\.process \? \{ process: req\.process \}/);
    expect(src('lib/task-tracking.ts')).toMatch(/process\?: \{ id: string; name: string; edition\?: string; ownerTeam\?: string \}/);
  });
});

describe('the conversation an open step opens inherits it (P3)', () => {
  it('the creator hands the opening run\'s process to conversation-opened', () => {
    expect(src('typed-conversation-from-event.ts')).toMatch(/detail\.continueRun\?\.process \? \{ process: detail\.continueRun\.process \}/);
  });
  it('read only where a workflow opened the conversation', () => {
    expect(router).toMatch(/const inherited = openedBy === 'workflow' \? runProcessOf\(req\.process\) : undefined;/);
  });
});

describe('a process handed on is kept only where every part has its shape', () => {
  const ok = { id: 'a1b2c3d4e5f6', name: 'incident-response', edition: '0123456789ab' };
  it('kept', () => {
    expect(runProcessOf(ok)).toEqual(ok);
    expect(runProcessOf({ ...ok, ownerTeam: 'ops' })).toEqual({ ...ok, ownerTeam: 'ops' });
  });
  it.each([
    ['an id that is not a hash', { ...ok, id: 'x' }],
    ['an edition that is not a hash', { ...ok, edition: 'ZZZ' }],
    ['a name that is not a process name', { ...ok, name: 'Incident Response' }],
    ['nothing', undefined],
  ])('none for %s', (_label, raw) => {
    expect(runProcessOf(raw)).toBeUndefined();
  });
  it('a team that is not a team name is dropped', () => {
    expect(runProcessOf({ ...ok, ownerTeam: 'Not A Team!' })).toEqual(ok);
  });
});
