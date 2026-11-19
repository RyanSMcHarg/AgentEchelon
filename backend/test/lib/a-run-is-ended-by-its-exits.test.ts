/**
 * A RUN'S EXITS (ADR-067 WT27, WT28): a person's /stop ends their own run, and an operator cancels a run.
 *
 * What it proves: /stop takes the continuation of each run waiting on the work it stops, as `stopped`, BEFORE the cancel,
 * so the cancel's settlement continues nothing, and records the run's end once; and an operator's run cancel reads the
 * run from the task they name, never a key they pass, and cancels each live task of that run through the operator's own
 * task cancel, audited, in a conversation of the service's classification only.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (rel: string) => readFileSync(resolve(__dirname, '../../lambda/src', rel), 'utf8');

describe('/stop ends the person\'s own run (WT28)', () => {
  const router = read('router-agent-handler.ts');

  it('takes the run\'s continuation before the cancel, so the cancel\'s settlement continues nothing', () => {
    const ends = router.indexOf('if (held.length) await endStoppedRuns(channelArn,');
    const cancels = router.indexOf('? await cancelStoppedTasks(channelArn,');
    expect(ends).toBeGreaterThan(0);
    expect(ends).toBeLessThan(cancels);
  });

  it('claims the step\'s continuation as stopped and records the run\'s end once', () => {
    const fn = router.slice(router.indexOf('async function endStoppedRuns('), router.indexOf('async function endStoppedRuns(') + 1800);
    expect(fn).toMatch(/claimEventStep\(\{ runKey: run\.runKey, channelArn, step: continuationClaim\(run\.step\), outcome: 'stopped' \}\)/);
    expect(fn).toMatch(/claimEventStep\(\{ runKey: run\.runKey, channelArn, step: 'end', outcome: 'failure' \}\)[\s\S]*recordRunEnded\(/);
  });
});

describe('an operator cancels a run (WT27)', () => {
  const service = read('task-service.ts');
  const route = read('admin-tasks.ts');

  it('reads the run from the task named, refuses another classification\'s conversation, and cancels each live task through the operator cancel', () => {
    const fn = service.slice(service.indexOf('export async function adminCancelRun('), service.indexOf('export async function adminCancelRun(') + 1400);
    expect(fn).toMatch(/await refusesChannel\(channelArn\)/);
    expect(fn).toMatch(/const runKey = \(await getTask\(named, channelArn\)[\s\S]{0,60}\)\?\.workflowRun\?\.runKey;/);
    expect(fn).toMatch(/task\.workflowRun\?\.runKey !== runKey \|\| !\(ACTIVE_TASK_STATUSES/);
    expect(fn).toMatch(/await adminCancelTask\(\{ taskId: task\.taskId, channelArn, by:/);
    expect(service).toMatch(/case 'adminCancelRun':\s*return adminCancelRun\(input as never\);/);
  });

  it('the route takes a task and run: true, never a run key, and audits the cancel', () => {
    expect(route).toMatch(/if \(run === true\) \{[\s\S]*ask<\{ cancelled\?: number \}>\(arn, 'adminCancelRun', \{ taskId, channelArn: runChannelArn, by: actor \}\)/);
    expect(route).toMatch(/\[admin-tasks\]\[audit\] operator cancelled a run/);
    expect(route).not.toMatch(/runKey/);
  });
});
