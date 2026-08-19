/**
 * The channel flow's timeout must EXCEED the router's.
 *
 * `@all` hands the turn to `router-agent-handler` and waits for it (`RequestResponse`), because the
 * placeholder comes back from the turn (MESSAGE-FLOW §3.1). That makes the two budgets a pair: a
 * caller that dies before its callee produces the worst failure shape in this system, and it is
 * completely silent.
 *
 * WHAT GOES WRONG IF THIS INVERTS. The flow times out mid-invoke. The ROUTER does not - it keeps
 * running, classifies, and dispatches the async processor. But the flow never returns, so it never
 * posts the placeholder the router produced. The processor then polls for a message that will never
 * exist, logs `No placeholder for correlationId`, and the user's question goes unanswered. Nothing
 * errors on the user's side; the message simply sits there. That exact shape is on the record - see
 * the duplicate-fulfillment trace in `router-agent-handler.ts`, where a lost placeholder cost a turn.
 *
 * `callbackAllow` runs BEFORE the handoff, so the larger budget never delays the user's own message
 * reaching the channel - it only bounds how long the flow may wait for an answer.
 *
 * SOURCE-LEVEL, and deliberately so: reading both stacks' declared timeouts is what makes the pairing
 * checkable at all. A synth-level assertion would need both stacks stood up with full context.
 */
import * as fs from 'fs';
import * as path from 'path';

const STACKS = path.join(__dirname, '..', 'lib', 'stacks');

/** The `timeout: cdk.Duration.seconds(N)` for a named NodejsFunction construct. */
function timeoutSecondsFor(file: string, constructId: string): number {
  const src = fs.readFileSync(path.join(STACKS, file), 'utf8');
  const at = src.indexOf(`new lambdaNodeJs.NodejsFunction(this, '${constructId}'`);
  if (at < 0) throw new Error(`${constructId} not found in ${file} - did the construct get renamed?`);
  // Search only the construct's own props block, so a later function's timeout cannot be read by
  // mistake and quietly satisfy this test.
  const window = src.slice(at, at + 2000);
  const m = window.match(/timeout:\s*cdk\.Duration\.seconds\((\d+)\)/);
  if (!m) throw new Error(`no timeout found for ${constructId} in ${file}`);
  return Number(m[1]);
}

describe('the channel flow outlasts the router it waits on', () => {
  it('flow timeout > router timeout', () => {
    const flow = timeoutSecondsFor('channel-flow-stack.ts', 'ChannelFlowProcessor');
    const router = timeoutSecondsFor('assistant-profile-stack.ts', 'AgentHandler');

    expect(flow).toBeGreaterThan(router);
  });

  it('leaves headroom for the invoke round trip, not just a tie', () => {
    // A flow budget merely EQUAL to the router's still loses: the invoke, the cold start and the
    // placeholder send all happen inside the flow's window and outside the router's.
    const flow = timeoutSecondsFor('channel-flow-stack.ts', 'ChannelFlowProcessor');
    const router = timeoutSecondsFor('assistant-profile-stack.ts', 'AgentHandler');

    expect(flow - router).toBeGreaterThanOrEqual(5);
  });
});
