/**
 * THE SEED: A THIN CLOUDFORMATION ADAPTER THAT ASKS THE PROVISIONER FOR A DECLARATION (ADR-048, amended 2026-10-24).
 *
 * The handler of each stack's seed custom resource (`DeclaredAssistantsSeed`). Its properties are the declaration:
 * the classification, the roles deployed on it, and each declared assistant. It builds nothing and removes nothing
 * itself: it invokes the provisioner (`assistant-provisioner-function.ts`, `op: 'seed-declared'`), the one
 * principal that builds and retires every assistant, and hands CloudFormation the provisioner's answer
 * (`PrimaryBotArn`) or its refusal.
 *
 * ITS ROLE HOLDS THREE GRANTS, all its own: invoking the provisioner; writing a claim under
 * `{root}/provisioner-claims/seed/{its classification}/`, which proves to the provisioner that the request is this
 * classification's seed's (`lib/provisioner-claim.ts`), and which no other role in the app may write; and reading
 * its own stack's status, which tells a rollback from an update.
 *
 * A ROLLBACK IS NOT A WITHDRAWAL. CloudFormation undoes a failed update by sending the seed another update, with the
 * properties swapped, so a role the failed update added reads as withdrawn while the assistant that update built
 * still fills it. The seed reads its stack's status and says so (`rollback`), and the provisioner then removes what
 * the failed update built instead of refusing, so the rollback completes.
 *
 * A DELETE NEVER FAILS THE STACK. A stack being deleted (or a create being rolled back) must be able to finish, so
 * whatever stops the provisioner removing a declared assistant (a declaration that does not parse, a refusal, an
 * invoke that fails) is logged and reported in the response, and the teardown's sweep (`scripts/teardown.mjs`)
 * removes what the directory still records.
 *
 * What the provisioner does with a declaration (seed once, a role withdrawn only once no assistant fills it) is
 * `lib/declared-assistants.ts`.
 */
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { SSMClient } from '@aws-sdk/client-ssm';
import type { Declaration, SeedResult } from './lib/declared-assistants.js';
import type { SeedDeclaredRequest } from './assistant-provisioner-function.js';
import { writeClaim } from './lib/provisioner-claim.js';

export type { DeclaredAssistant, Declaration } from './lib/declared-assistants.js';

/** Parse a declaration property. Throws on one that is not JSON; the provisioner checks its shape. */
export function declarationProperty(props: Record<string, unknown> | undefined): Declaration {
  const raw = props?.declaration;
  try {
    return JSON.parse(typeof raw === 'string' ? raw : '') as Declaration;
  } catch {
    throw new Error('seed: the declaration property is not JSON');
  }
}

/** The stack statuses in which CloudFormation is undoing an update rather than making one. */
const ROLLING_BACK = new Set(['UPDATE_ROLLBACK_IN_PROGRESS']);

/** Whether a stack status is a rollback of an update. */
export const isRollback = (stackStatus: string | undefined): boolean => !!stackStatus && ROLLING_BACK.has(stackStatus);

/**
 * The provisioner request for one CloudFormation event, from the seed's own classification and fulfillment, before
 * its claim is written. `rollback` is the stack's own word that this update undoes the one before it.
 */
export function requestFor(
  event: CloudFormationCustomResourceEvent,
  own: { classification: string; fulfillmentArn: string },
  rollback = false,
): Omit<SeedDeclaredRequest, 'claim'> {
  const physicalResourceId = (event as { PhysicalResourceId?: string }).PhysicalResourceId;
  const old = event.RequestType === 'Update' ? (event as { OldResourceProperties?: Record<string, unknown> }).OldResourceProperties : undefined;
  let oldDeclaration: Declaration | undefined;
  if (old) {
    try { oldDeclaration = declarationProperty(old); } catch { oldDeclaration = undefined; }
  }
  return {
    op: 'seed-declared',
    callerClassification: own.classification,
    requestType: event.RequestType,
    logicalResourceId: event.LogicalResourceId,
    ...(physicalResourceId ? { physicalResourceId } : {}),
    fulfillmentArn: own.fulfillmentArn,
    declaration: declarationProperty(event.ResourceProperties),
    ...(oldDeclaration ? { oldDeclaration } : {}),
    ...(event.RequestType === 'Update' && rollback ? { rollback: true } : {}),
  };
}

/** The provisioner's answer, or its refusal as the error CloudFormation shows. */
export function answerOf(out: { FunctionError?: string; Payload?: Uint8Array }): SeedResult | Record<string, never> {
  const text = out.Payload ? Buffer.from(out.Payload).toString('utf8') : '';
  const body = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (out.FunctionError) throw new Error(String(body.errorMessage || `the provisioner failed: ${out.FunctionError}`));
  return body as SeedResult | Record<string, never>;
}

/** What a seed needs from AWS, so a test can hand it fakes. */
export interface SeedDeps {
  classification: string;
  fulfillmentArn: string;
  ssmRoot: string;
  provisionerFunctionName: string;
  ssm: Pick<SSMClient, 'send'>;
  lambda: Pick<LambdaClient, 'send'>;
  cloudformation: Pick<CloudFormationClient, 'send'>;
}

/** The answer a delete gives CloudFormation whatever happened: the resource is gone, and what is left is said. */
function deleteAnswer(event: CloudFormationCustomResourceEvent, unremoved: string): SeedResult {
  return {
    PhysicalResourceId: (event as { PhysicalResourceId?: string }).PhysicalResourceId || event.LogicalResourceId,
    Data: { PrimaryBotArn: '', Summary: JSON.stringify({ unremoved }) },
  };
}

/** The stack's status, or undefined when it cannot be read (an update is then treated as an update). */
async function stackStatusOf(cloudformation: SeedDeps['cloudformation'], stackId: string): Promise<string | undefined> {
  try {
    const out = await cloudformation.send(new DescribeStacksCommand({ StackName: stackId }));
    return out?.Stacks?.[0]?.StackStatus;
  } catch (err) {
    console.error('[seed-declared-assistants] could not read the stack status; this update is treated as an update', { stackId, error: (err as Error)?.message });
    return undefined;
  }
}

/** One CloudFormation event, end to end. */
export async function seedEvent(event: CloudFormationCustomResourceEvent, deps: SeedDeps): Promise<SeedResult | Record<string, never>> {
  const ask = async (): Promise<SeedResult | Record<string, never>> => {
    const rollback = event.RequestType === 'Update' && isRollback(await stackStatusOf(deps.cloudformation, event.StackId));
    if (rollback) console.log('[seed-declared-assistants] the stack is rolling back the update before this one; what it built is removed');
    const unclaimed = requestFor(event, deps, rollback);
    const { request, release } = await writeClaim(deps.ssm, deps.ssmRoot, unclaimed as unknown as Record<string, unknown>);
    try {
      return answerOf(await deps.lambda.send(new InvokeCommand({
        FunctionName: deps.provisionerFunctionName,
        Payload: Buffer.from(JSON.stringify(request)),
      })));
    } finally {
      await release();
    }
  };
  if (event.RequestType !== 'Delete') return ask();
  try {
    return await ask();
  } catch (err) {
    const unremoved = (err as Error)?.message || String(err);
    console.error('[seed-declared-assistants] the declared assistants could not all be removed; the stack deletes, and the teardown sweep removes what is left', {
      classification: deps.classification, logicalResourceId: event.LogicalResourceId, unremoved,
    });
    return deleteAnswer(event, unremoved);
  }
}

const REGION = process.env.AWS_REGION || 'us-east-1';
// Asked once per claim: a claim is spent on its first read, so an SDK retry would arrive unclaimed and be refused.
const lambdaClient = new LambdaClient({ region: REGION, maxAttempts: 1 });
const ssmClient = new SSMClient({ region: REGION });
const cloudformationClient = new CloudFormationClient({ region: REGION });

export const handler = async (event: CloudFormationCustomResourceEvent): Promise<SeedResult | Record<string, never>> => seedEvent(event, {
  classification: process.env.CLASSIFICATION || '',
  fulfillmentArn: process.env.FULFILLMENT_ARN || '',
  ssmRoot: process.env.SSM_ROOT || '/agent-echelon',
  provisionerFunctionName: process.env.PROVISIONER_FUNCTION_NAME || '',
  ssm: ssmClient,
  lambda: lambdaClient,
  cloudformation: cloudformationClient,
});
