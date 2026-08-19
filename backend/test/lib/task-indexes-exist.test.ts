/**
 * Every index the task code QUERIES is an index the stack DEFINES.
 *
 * A query against an index that does not exist fails at runtime with a validation error and nowhere
 * else: unit tests mock the DynamoDB client, so they assert the IndexName string they were given and
 * pass whatever it says. That is the shape of defect this repo has shipped before - code that is
 * green in every suite and inert once deployed - so the two sides are tied together statically here.
 *
 * Both directions matter. A typo in the code names an index that will never exist; a rename in the
 * stack silently orphans every reader. Either way this goes red.
 */
import { stripComments } from '../helpers/strip-comments';
import * as fs from 'fs';
import * as path from 'path';

const STACK = fs.readFileSync(
  path.join(__dirname, '../../lib/stacks/foundations-stack.ts'),
  'utf8',
);
const TASK_CODE = fs.readFileSync(
  path.join(__dirname, '../../lambda/src/lib/task-tracking.ts'),
  'utf8',
);

/** Index names the stack declares on the task tables. */
function declaredIndexes(): string[] {
  return [...STACK.matchAll(/indexName:\s*'([^']+)'/g)].map((m) => m[1]);
}

/** Index names the task code queries, ignoring comments so prose cannot satisfy the check. */
function queriedIndexes(): string[] {
  const code = stripComments(TASK_CODE);
  return [...code.matchAll(/IndexName:\s*'([^']+)'/g)].map((m) => m[1]);
}

describe('task index names line up with the stack', () => {
  it('queries only indexes the stack declares', () => {
    const declared = new Set(declaredIndexes());
    const missing = [...new Set(queriedIndexes())].filter((i) => !declared.has(i));
    expect(missing).toEqual([]);
  });

  it('still declares the indexes the reads depend on', () => {
    const declared = declaredIndexes();
    // Named explicitly rather than derived, so REMOVING a read does not quietly permit removing the
    // index it used - these three each carry a decision.
    expect(declared).toContain('userSub-taskType-index'); // the type-scoped active lookup
    expect(declared).toContain('contextId-index'); // cascade-cancel across a plan
    expect(declared).toContain('channelArn-updatedAt-index'); // ADR-024 D4, what is open in this conversation
  });

  it('the owner lookup uses NO index at all', () => {
    // ADR-024 D2: it is a strongly consistent read of the mirror's BASE TABLE. A GSI can never be
    // read consistently, so an IndexName appearing on this query would silently drop the guard that
    // stops a rapid follow-up turn starting a second expensive task.
    // Both list helpers are projections of ONE query; the query - and so the index discipline -
    // lives in getOwnerChannelTasks, which they delegate to.
    const fn = TASK_CODE.slice(TASK_CODE.indexOf('export async function getOwnerChannelTasks'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('ConsistentRead');
    expect(body).not.toContain('IndexName');
  });
});
