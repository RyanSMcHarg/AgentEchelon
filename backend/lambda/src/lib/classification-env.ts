/**
 * The environment variable carrying one classification's per-classification value (its router, its
 * processor, its task service): the classification upper-cased, with any character an environment
 * variable name cannot hold replaced by `_`, then `_` and the suffix.
 *
 * ONE NAMING RULE for every stack that sets such a variable and every handler that reads it, so a
 * classification whose value carries a `-` or a `.` resolves to the same name on both sides.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { defaultProfileRegistry, type ProfileRegistry } from '../../../lib/profile-registry';

export function classificationEnvName(classification: string, suffix: string): string {
  return `${classification.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${suffix}`;
}

/**
 * The task service for one classification. No fallback in either direction: tasks never cross one.
 *
 * Derived from the registry like the router (`routerArnForClassification`): a value this deployment
 * does not declare, or an admin-plane classification, has no task service, and neither does a declared
 * one whose variable is not set. No stack sets one any more; a shared function finds the service by name
 * (`resolveTaskServiceArn`, below), and this is the variable that lookup still lets win.
 */
export function taskServiceArnForClassification(
  classification: string,
  registry: ProfileRegistry = defaultProfileRegistry,
): string | undefined {
  const declared = registry.resolveClassification(classification);
  if (!declared || !registry.isConversational(declared)) return undefined;
  return (process.env[classificationEnvName(declared, 'TASK_SERVICE_ARN')] || '').trim() || undefined;
}

/**
 * THE TASK SERVICE FOR ONE CLASSIFICATION, FOUND BY NAME AT CALL TIME. A shared function (the channel flow,
 * the operator task routes) carries `TASK_SERVICE_ARN_PARAM_ROOT` (the `/{instance}/assistant` root,
 * `taskServiceByNameEnvironment` in the stacks) rather than one variable per classification, and reads the
 * named classification's own `task-service-arn` parameter, so it takes no deploy-time value from the
 * classification stacks and a classification added or removed changes nothing in its stack. The registry
 * checks are the same as `taskServiceArnForClassification`'s, so no other classification's service is
 * resolved; a wired variable still wins. Only a found ARN is cached, so a classification deployed after the
 * function resolves once it exists. An unreadable parameter resolves to `undefined`, and the caller declines.
 */
const taskServiceArnByName = new Map<string, string>();
let ssm: SSMClient | null = null;

export async function resolveTaskServiceArn(
  classification: string,
  registry: ProfileRegistry = defaultProfileRegistry,
): Promise<string | undefined> {
  const declared = registry.resolveClassification(classification);
  if (!declared || !registry.isConversational(declared)) return undefined;
  const fromEnv = taskServiceArnForClassification(declared, registry);
  if (fromEnv) return fromEnv;
  const root = (process.env.TASK_SERVICE_ARN_PARAM_ROOT || '').trim();
  if (!root) return undefined;
  const cached = taskServiceArnByName.get(declared);
  if (cached) return cached;
  const name = `${root}/${declared}/task-service-arn`;
  try {
    ssm = ssm ?? new SSMClient({});
    const arn = ((await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value || '').trim();
    if (arn) {
      taskServiceArnByName.set(declared, arn);
      return arn;
    }
  } catch (err) {
    console.warn('[TaskServiceArn] the task service could not be read; the call is declined', {
      classification: declared, name, error: (err as Error)?.name || 'error',
    });
  }
  return undefined;
}
