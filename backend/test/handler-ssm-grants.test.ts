/**
 * Every SSM parameter a classification publishes must be a DECIDED question for the handler role:
 * either the handler is granted `ssm:GetParameter` on it, or it is listed below as deliberately
 * not-handler-read, with a reason.
 *
 * Why this shape, rather than asserting a list of expected grants:
 *
 * The synth tests already assert the IAM boundary, so a WIDENED boundary fails the build. They could
 * not catch the inverse - a grant that is MISSING - because the application fails open. The handler
 * read `/agent-echelon/assistant/{classification}/processor-arn` on every single request, was denied
 * every time, fell back to an environment variable, and answered normally. 1700+ unit tests and the
 * full e2e suite stayed green while every turn logged an AccessDenied (found and fixed 2026-07-31).
 *
 * An env-var-driven check would not have caught it either: that path is CONSTRUCTED in the handler
 * (`${SSM_ROOT}/assistant/${classification}/processor-arn`), not passed in as a `*_PARAM` variable.
 *
 * So the gate is on the parameters the stack PUBLISHES. A new parameter forces an explicit decision -
 * grant it, or say why not - instead of defaulting to a silent omission that only shows up as log
 * noise nobody reads.
 */
import { basicClassificationTemplate } from './helpers/synth';


/**
 * Parameters the handler legitimately never reads. Each needs a reason: this list is the only way to
 * silence the check, so an unjustified entry is how the guard would rot.
 */
const NOT_READ_BY_HANDLER: Record<string, string> = {
  guardrails: 'The selectable-guardrail catalog is consumed at SYNTH time (profile validation) and by '
    + 'the admin manage-profiles API, never by the handler at runtime.',
  'router-arn': 'Published FOR the admin console to deep-link this classification\'s router. The handler '
    + 'is that router; it has no reason to look up its own ARN.',
  'assistant-system-prompt': 'Read by the ASYNC PROCESSOR when building the system prompt, not by the '
    + 'handler, which never composes a prompt.',
  'task-service-arn': 'Published FOR the admin plane, which is a different stack and cannot hold a '
    + 'reference. The handler already receives this ARN directly in its environment from the same '
    + 'stack that creates the service, so looking it up would be reading its own wiring back.',
  'vend-arn': 'Published FOR the routing services in other stacks - the channel flow and the battle '
    + 'orchestrator - which ask this classification\'s vend for an assistant session. The handler is in '
    + 'the same stack and receives the vend\'s ARN in its environment (`ASSISTANT_VEND_ARN`).',
  alt: 'The challenger\'s assignment record, `/assistant-assignments/{classification}/{role}/alt`, '
    + 'written by `battle-stack` and rewritten by `admin-experiments` when an experiment arms. The '
    + 'handler IS granted the subtree, since it resolves the addressed assistant from it; the vend '
    + 'reads it to learn which assistant a routed bot is.',
  'exchange-role-arn': 'Published FOR the credential exchange (Identity), which finds the classification\'s person '
    + 'vend role by it at call time. The handler vends no person a credential.',
  'conversation-creator-arn': 'Published FOR the create-conversation API, guest start and path B (Conversations), '
    + 'which find the classification\'s conversation creator by it at call time. The handler creates conversations '
    + 'through its own grant, not through the creator function.',
  'classifier-replay-arn': 'Published FOR the admin backend\'s replay starter, which finds the classification\'s '
    + 'replay function by it at call time (Aurora mode). The handler starts no replay.',
  live: 'The assignment record, `/assistant-assignments/{classification}/{role}/{occupancy}` '
    + '(DESIGN-SEPARATE-ASSISTANTS 3.0). Its reader is the CHANNEL FLOW, which resolves which '
    + 'assistant serves a role before a turn is handed to any handler; the handler is told which '
    + 'identity to answer as and does not choose it. Exempted rather than granted so that a handler '
    + 'that later starts resolving its own occupant has to say so here.',
};

/** `arn:aws:ssm:...:parameter/agent-echelon/x/y` -> `/agent-echelon/x/y`. */
function paramPathFromArn(resource: unknown): string | null {
  if (typeof resource !== 'string') return null;
  const i = resource.indexOf(':parameter/');
  return i === -1 ? null : resource.slice(i + ':parameter'.length);
}

/** Wildcards appear as `/agent-echelon/assistant/＊/definition`; match them as globs. */
function grantCovers(granted: string, wanted: string): boolean {
  if (!granted.includes('*')) return granted === wanted;
  const rx = new RegExp('^' + granted.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
  return rx.test(wanted);
}

describe('the handler role can read every parameter it is expected to read', () => {
  it('each published SSM parameter is either granted to the handler or explicitly exempted', () => {
    const json = basicClassificationTemplate().toJSON() as Record<string, never>;
    const resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> = json.Resources;

    // Every parameter this classification publishes.
    const published = Object.values(resources)
      .filter((r) => r.Type === 'AWS::SSM::Parameter')
      .map((r) => String(r.Properties?.Name ?? ''))
      .filter(Boolean);
    // Guard against the check silently passing because nothing was found to check.
    if (published.length === 0) throw new Error('the stack published no SSM parameters — this check would be vacuous');

    // Every ssm:GetParameter resource on ANY policy in the stack. Scoping to the handler's own role
    // would be more precise, but policies attach by ref and the indirection buys nothing here: an
    // over-grant is what cdk-synth.test.ts already covers, and this test is about omission.
    const grantedPaths: string[] = [];
    for (const r of Object.values(resources)) {
      if (r.Type !== 'AWS::IAM::Policy' && r.Type !== 'AWS::IAM::Role') continue;
      const raw = JSON.stringify(r.Properties ?? {});
      if (!raw.includes('ssm:GetParameter')) continue;
      for (const m of raw.matchAll(/arn:aws:ssm:[^"]*?:parameter(\/[^"]*)/g)) grantedPaths.push(m[1]);
    }

    const ungranted = published.filter((p) => {
      // THE CLASSIFICATION'S ROW OF THE RUNTIME REGISTRY is read through the registry read every function holds,
      // a managed policy the app attaches to each function's role (`ProfileRegistryReaders`), which this stack built
      // alone does not carry; `test/every-function-reads-the-registry-and-none-writes-it.test.ts` pins it.
      if (/\/registry\/classification\/[^/]+$/.test(p)) return false;
      const leaf = p.split('/').pop() || '';
      if (leaf in NOT_READ_BY_HANDLER) return false;
      return !grantedPaths.some((g) => grantCovers(g, p));
    });

    if (ungranted.length > 0) {
      throw new Error(
        'These published SSM parameters have no ssm:GetParameter grant. If the handler reads one, it '
          + 'will be DENIED at runtime and fail open - the turn still succeeds, so no test notices, and '
          + 'the only symptom is an AccessDenied in CloudWatch. Grant it, or add it to '
          + 'NOT_READ_BY_HANDLER with a reason:\n  '
          + ungranted.join('\n  '),
      );
    }
    expect(ungranted).toEqual([]);
  });

  it('pins the processor-arn grant specifically (the read that was denied on every turn)', () => {
    const raw = JSON.stringify(basicClassificationTemplate().toJSON());
    // The handler resolves the async processor from this parameter on every request.
    if (!raw.includes('parameter/agent-echelon/assistant/basic/processor-arn')) {
      throw new Error('no grant for processor-arn: the handler reads it every turn and would be denied');
    }
    expect(raw.includes('parameter/agent-echelon/assistant/basic/processor-arn')).toBe(true);
  });
});
