/**
 * THE READER OF THE TURN QUEUE MUST BE WIRED LIKE ITS WRITERS (ADR-033).
 *
 * `turnQueueEnabled()` is read INSIDE every function that touches the record, and
 * `readTurnState` short-circuits to `{ busy: false, queued: [] }` when it is false - before it
 * looks at DynamoDB at all. So a turn-state API deployed without the flag does not degrade
 * loudly. It answers, with 200, that nothing is waiting, forever.
 *
 * That is what shipped: the classification stacks took `turnQueueWiring`, the Foundations
 * turn-state API hand-rolled its own environment and set only the table name. Turns claimed,
 * messages queued and the deferral notice was posted, while the composer and the transcript,
 * which render from this endpoint, showed an idle conversation over a full queue. The feature
 * was live on the write side and dark on the read side, and every symptom pointed at the queue.
 *
 * These assertions are cheap and they are the only mechanical thing standing between that
 * arrangement and a repeat, because no unit test of `turn-lock.ts` can see how a stack wired it.
 */

import { Template } from 'aws-cdk-lib/assertions';
import { conversationsTemplate } from './helpers/synth';


interface FnResource {
  Properties?: {
    Environment?: { Variables?: Record<string, unknown> };
    Role?: { 'Fn::GetAtt'?: unknown[] };
  };
}

/** The turn-state API function, found by logical id rather than by guessing at its environment. */
function turnStateApi(t: Template): FnResource {
  const fns = t.findResources('AWS::Lambda::Function');
  const key = Object.keys(fns).find((k) => k.startsWith('TurnStateApiFunction'));
  // Foundations must still declare a TurnStateApiFunction; a rename lands here first.
  expect(key).toBeTruthy();
  return fns[key!] as FnResource;
}

const envOf = (fn: FnResource) => fn.Properties?.Environment?.Variables ?? {};

describe('the turn-state API is wired from the same switch as the writers', () => {
  it('SETS the flag, off, when the deployment has not enabled the queue', () => {
    const vars = envOf(turnStateApi(conversationsTemplate()));
    // Present and '0', not absent. Absent and '0' behave the same at runtime, which is exactly why
    // the omission survived review: it has to be SET for the switch to be a switch.
    expect(vars.TURN_QUEUE_ENABLED).toBe('0');
    expect(vars.TURN_STATE_TABLE).toBeDefined();
  });

  it('turns the flag ON with the same context key the writers read, so the client can SEE the queue', () => {
    // `-c turnQueue=true` reached the writers and not this reader, and the whole feature read as
    // broken: the record said busy, and every client asking was told the conversation was idle.
    const vars = envOf(turnStateApi(conversationsTemplate({ turnQueue: true })));
    expect(vars.TURN_QUEUE_ENABLED).toBe('1');
  });

  it('stays a READER: it answers what is waiting and can never change it', () => {
    const t = conversationsTemplate({ turnQueue: true });
    const roleRef = turnStateApi(t).Properties?.Role?.['Fn::GetAtt']?.[0];
    expect(roleRef).toBeTruthy();

    // Collected rather than asserted one at a time, so a failure NAMES the write that was granted.
    // Take the `env` from turnQueueWiring, never its `grant`: that grant is read-write by design,
    // and a client that could write this record could clear somebody else's queue.
    const writes = ['dynamodb:UpdateItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'];
    const granted: string[] = [];
    for (const policy of Object.values(t.findResources('AWS::IAM::Policy'))) {
      const props = (policy as {
        Properties?: {
          Roles?: { Ref?: string }[];
          PolicyDocument?: { Statement?: { Action?: string | string[] }[] };
        };
      }).Properties;
      if (!props?.Roles?.some((r) => r.Ref === roleRef)) continue;
      for (const stmt of props.PolicyDocument?.Statement ?? []) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        granted.push(...writes.filter((w) => actions.includes(w)));
      }
    }
    expect(granted).toEqual([]);
  });
});
