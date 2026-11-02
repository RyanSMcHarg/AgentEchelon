/**
 * THE DRAIN'S RETURN PATH MUST BE DEPLOYABLE, AND IT MUST BE WIRED (ADR-033).
 *
 * When a turn ends holding queued messages, the processor dispatches a triage turn by invoking the
 * ROUTER - the same entry every other re-dispatch uses. Two ways that ships broken, and only one of
 * them is loud:
 *
 * THE LOUD ONE, WHICH ALREADY HAPPENED. The router carries the processor's ARN, and CDK makes a
 * function depend on its role's default policy. So handing the ROUTER's arn to the PROCESSOR - by
 * environment variable, or by `grantInvoke`, or by both - closes
 * `AsyncProcessor -> AgentHandler -> AgentHandlerRoleDefaultPolicy -> AsyncProcessor` and the template
 * cannot deploy AT ALL. That trap was written down forty lines above the code that fell into it, which
 * is the argument for asserting it rather than describing it again.
 *
 * THE QUIET ONE. Drop the invoke grant, or the parameter the ARN is read from, and everything still
 * synthesizes, every unit test still passes, and a queue is simply never triaged: the messages sit
 * until somebody speaks again. That is the same class of failure as a reader without `s3:GetObject` -
 * a permission gap the code cannot see, on a path no unit test crosses.
 */
import { basicClassificationTemplate } from './helpers/synth';


function template() {
  // `Template.fromStack` runs the cycle check. A cycle throws HERE, before any assertion below runs,
  // which is precisely the guard this file exists for.
  return basicClassificationTemplate();
}

/**
 * The statements the processor's own role holds, and nothing else. The dispatch to the router is the
 * processor's own record of a turn, not something the assistant does, so it
 * is `ProcessorRole`'s grant and never the acting role's.
 *
 * Scoped deliberately. `lambda:InvokeFunction` and `ssm:GetParameter` both appear all over this
 * template - the router invokes the processor, half the stack reads parameters - so an unscoped search
 * would pass whether or not the processor holds either, which is a test that cannot fail.
 */
function processorStatements(json: Record<string, never>): Array<{ Action?: unknown; Resource?: unknown }> {
  const resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> = json.Resources;
  const roleIds = Object.entries(resources)
    .filter(([id, r]) => r.Type === 'AWS::IAM::Role' && id.startsWith('ProcessorRole'))
    .map(([id]) => id);
  expect(roleIds).toHaveLength(1);

  return Object.values(resources)
    .filter((r) => r.Type === 'AWS::IAM::Policy')
    .filter((r) => {
      const roles = (r.Properties?.Roles ?? []) as Array<{ Ref?: string }>;
      return roles.some((ref) => ref?.Ref && roleIds.includes(ref.Ref));
    })
    .flatMap((r) => {
      const doc = r.Properties?.PolicyDocument as { Statement?: unknown[] } | undefined;
      return (doc?.Statement ?? []) as Array<{ Action?: unknown; Resource?: unknown }>;
    });
}

const actionsOf = (s: { Action?: unknown }): string[] => (
  Array.isArray(s.Action) ? s.Action as string[] : [s.Action as string].filter(Boolean)
);

describe('the triage dispatch is deployable', () => {
  it('synthesizes without a dependency cycle', () => {
    // The whole assertion is that this does not throw. `Template.fromStack` refuses a template with a
    // cycle, and a cycle here is not a degraded deployment - it is no deployment.
    expect(() => template()).not.toThrow();
  });
});

describe('the triage dispatch is wired', () => {
  const json = template().toJSON() as Record<string, never>;

  it('the processor may INVOKE the router, or it can never dispatch triage', () => {
    const invokes = processorStatements(json).filter((s) => actionsOf(s).includes('lambda:InvokeFunction'));
    expect(invokes.length).toBeGreaterThan(0);
    // On the ROUTER specifically. A grant on some other function deploys clean and denies at runtime.
    expect(JSON.stringify(invokes)).toContain('AgentHandler');
  });

  it('the processor may READ the parameter the router ARN lives in', () => {
    // Read at runtime rather than handed over, because handing it over is the cycle above. Without
    // this grant the lookup fails, the dispatch returns false, and the queue is silently never read.
    const reads = processorStatements(json).filter((s) => actionsOf(s).includes('ssm:GetParameter'));
    expect(reads.length).toBeGreaterThan(0);
    expect(JSON.stringify(reads)).toContain('router-arn');
  });

  it('the processor is TOLD which parameter to read', () => {
    const resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> = json.Resources;
    const processors = Object.entries(resources)
      .filter(([id, r]) => r.Type === 'AWS::Lambda::Function' && id.startsWith('AsyncProcessor'));
    expect(processors).toHaveLength(1);
    const vars = ((processors[0][1].Properties?.Environment ?? {}) as {
      Variables?: Record<string, string>;
    }).Variables ?? {};
    // A NAME, not an ARN. The name refers to nothing, which is the only reason it can travel this
    // direction at all.
    expect(vars.ROUTER_ARN_PARAM).toContain('router-arn');
    expect(Object.keys(vars).filter((k) => k.endsWith('_ROUTER_ARN'))).toEqual([]);
  });
});
