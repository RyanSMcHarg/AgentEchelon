/**
 * THE ONE INVOKE OF A TASK SERVICE OPERATION.
 *
 * A task service takes `{ op, input }` and answers with JSON (`task-service.ts`). Every caller reaches it
 * through this function: the turn seam (`task-service-client.ts`, the service of its own classification),
 * the operator plane (`admin-tasks.ts`, every classification's) and the work-item route
 * (`user-tasks-api.ts`, the classification of the conversation it writes into). Which client sends the
 * call is the caller's, because which role it acts as is the caller's decision.
 *
 * A `FunctionError` throws, carrying the start of the body, so a caller that treats a failure as an empty
 * answer says so where it catches. `Event` returns as soon as Lambda accepts the payload and reads nothing.
 */
import { InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';

export async function invokeTaskServiceOp<T>(
  client: Pick<LambdaClient, 'send'>,
  arn: string,
  op: string,
  input: unknown,
  invocationType: 'RequestResponse' | 'Event' = 'RequestResponse',
): Promise<T | null> {
  const resp = await client.send(new InvokeCommand({
    FunctionName: arn,
    InvocationType: invocationType,
    Payload: Buffer.from(JSON.stringify({ op, input })),
  }));
  if (invocationType === 'Event') return null;
  const raw = resp.Payload ? Buffer.from(resp.Payload).toString() : '';
  if (resp.FunctionError) {
    throw new Error(`task-service '${op}' FunctionError=${resp.FunctionError}: ${raw.slice(0, 300)}`);
  }
  return raw ? (JSON.parse(raw) as T) : null;
}
