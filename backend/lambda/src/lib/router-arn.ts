/**
 * The per-classification ROUTER, for every dispatcher outside the classification's own stack.
 *
 * The router (`router-agent-handler`) is the Lambda Lex fulfills into, the one the channel flow's
 * `@all` and `/battle` bypasses hand to, and the one task-answer repair, the handover backstop and
 * queue triage re-dispatch through. The battle orchestrator (a rebuttal round and a duel's notices,
 * `battle-orchestrator.ts`) and every service that names a notice or a marker clear
 * (`say-through-router.ts`, `battle-marker-clear.ts`) resolve it here too.
 *
 * BY NAME, AT CALL TIME (`resolveRouterArn`). A shared function carries `ROUTER_ARN_PARAM_ROOT` and reads
 * the named classification's own `/assistant/{classification}/router-arn` parameter, so no shared stack
 * takes a deploy-time value from the classification stacks: it may deploy before them, and a
 * classification added or removed changes nothing in it. A variable named by `routerArnEnvName` still
 * wins where one is set (`routerArnForClassification`), and no stack sets one any more.
 *
 * ONE READER RESOLVES ITS OWN ROUTER FROM ITS OWN PARAMETER: a per-classification function dispatching
 * a turn of its OWN classification (`ROUTER_ARN_PARAM`, `resolveRouterArn` in `turn-triage.ts`). It
 * carries no root, so it cannot resolve another classification's router either.
 *
 * A CLASSIFICATION IS SET OR NOT, AND IT NEVER FALLS BACK (ADR-046). Classifications are a declared
 * set with no order, so there is no neighbor to fall back to. A declared classification resolves to
 * its OWN router and to nothing else. Each of these resolves to `undefined`, and the caller declines
 * the turn:
 *
 *  - a value the deployment does not declare (neither a classification nor an alias of one);
 *  - an admin-plane classification, which has no conversational runtime and so no router;
 *  - a declared classification whose router parameter is absent or unreadable, or is not wired to the
 *    function at all.
 *
 * No classification's turn is answered on another classification's router. That would run it with
 * another assistant, model, guardrail and `context/` scope, and the turn would still look answered,
 * so nothing would report it.
 *
 * THE TABLE IS DERIVED, NOT WRITTEN. The classifications come from the profile registry, and each
 * one's router from the parameter its classification stack publishes. A classification added in the
 * registry is routed without editing this file.
 *
 * AN UNRESOLVED CLASSIFICATION IS LOGGED, ONCE PER CONTAINER AND REASON, as a `[SecurityEvent]` that
 * names it, and this function never throws. Its callers include the channel flow, where a throw would
 * hold up the person's own message; declining the turn is the caller's job and each one logs it.
 *
 * The environment is read per call rather than captured at module load: this module is imported
 * transitively by handlers whose tests set the router variables before importing the handler, and a
 * load-order-sensitive capture turns that ordering into a silent source of wrong ARNs.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { defaultProfileRegistry, type ProfileRegistry } from '../../../lib/profile-registry';
import { classificationEnvName } from './classification-env.js';

/**
 * The environment variable carrying one classification's router ARN (`classificationEnvName`, suffix
 * `ROUTER_ARN`). Shared by the stacks that set the variable and this module that reads it, so the two
 * cannot drift.
 */
export function routerArnEnvName(classification: string): string {
  return classificationEnvName(classification, 'ROUTER_ARN');
}

const reported = new Set<string>();

function reportUnresolved(classification: string, reason: string): void {
  const key = `${classification}\u0000${reason}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.warn('[RouterArn][SecurityEvent] no router for this classification; the turn is declined', {
    classification,
    reason,
  });
}

/** The declared conversational classification `classification` names, or `undefined` (logged) when none. */
function conversationalClassification(classification: string, registry: ProfileRegistry): string | undefined {
  const declared = registry.resolveClassification(classification);
  if (!declared) {
    reportUnresolved(String(classification), 'not a classification this deployment declares');
    return undefined;
  }
  if (!registry.isConversational(declared)) {
    reportUnresolved(declared, 'admin-plane classification, which has no router');
    return undefined;
  }
  return declared;
}

/**
 * The router ARN for `classification`, or `undefined` when it has none. Never another
 * classification's router. See the header for the rule.
 */
export function routerArnForClassification(
  classification: string,
  registry: ProfileRegistry = defaultProfileRegistry,
): string | undefined {
  const declared = conversationalClassification(classification, registry);
  if (!declared) return undefined;
  const arn = (process.env[routerArnEnvName(declared)] || '').trim();
  if (!arn) {
    reportUnresolved(declared, `${routerArnEnvName(declared)} is not set`);
    return undefined;
  }
  return arn;
}

/**
 * THE SAME ANSWER FOR A FUNCTION IN A STACK THAT DEPLOYS BEFORE THE CLASSIFICATION STACKS. Such a stack
 * cannot resolve their `router-arn` parameters at deploy: on a first install they do not exist yet and
 * the deploy fails. Its function carries `ROUTER_ARN_PARAM_ROOT` (the `/{instance}/assistant` root,
 * `sayThroughRouterWiring` with `byName`) in place of the router variables, and the named classification's OWN
 * parameter is read at call time. The registry checks are the same, so it still resolves no other
 * classification's router. Only a found ARN is cached, so a function deployed before its
 * classification resolves the router once that classification is deployed, without a cold start.
 */
const routerArnByName = new Map<string, string>();
let ssm: SSMClient | null = null;

export async function resolveRouterArn(
  classification: string,
  registry: ProfileRegistry = defaultProfileRegistry,
): Promise<string | undefined> {
  const declared = conversationalClassification(classification, registry);
  if (!declared) return undefined;
  const fromEnv = (process.env[routerArnEnvName(declared)] || '').trim();
  if (fromEnv) return fromEnv;
  const root = (process.env.ROUTER_ARN_PARAM_ROOT || '').trim();
  if (!root) {
    reportUnresolved(declared, `${routerArnEnvName(declared)} is not set`);
    return undefined;
  }
  const cached = routerArnByName.get(declared);
  if (cached) return cached;
  const name = `${root}/${declared}/router-arn`;
  try {
    ssm = ssm ?? new SSMClient({});
    const arn = ((await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value || '').trim();
    if (arn) {
      routerArnByName.set(declared, arn);
      return arn;
    }
    reportUnresolved(declared, `${name} is empty`);
  } catch (err) {
    reportUnresolved(declared, `${name} could not be read: ${(err as Error)?.name || 'error'}`);
  }
  return undefined;
}
