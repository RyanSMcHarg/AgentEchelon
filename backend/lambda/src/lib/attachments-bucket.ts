/**
 * THE CONVERSATION RECORD'S BUCKET, as an exchange finds it: by name at call time, under the key the conversations stack
 * publishes (`SHARED_SSM.attachmentsBucketArn`), so the exchange's stack does not depend on the stack that owns the bucket.
 *
 * One resolver for both exchanges: the admin exchange vends a team's read of a delivered document, and the person exchange a
 * member's read of their conversation's dashboard. A value is kept once read; a read that fails is tried again on the next
 * call, so a throttle costs one request and never the container's life. `EXCHANGE_ATTACHMENTS_BUCKET_ARN` names it directly.
 */
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

let ssm: SSMClient | null = null;
let resolved = '';

export async function resolveAttachmentsBucketArn(logPrefix: string): Promise<string> {
  if (resolved) return resolved;
  if (process.env.EXCHANGE_ATTACHMENTS_BUCKET_ARN) return (resolved = process.env.EXCHANGE_ATTACHMENTS_BUCKET_ARN);
  const param = process.env.EXCHANGE_ATTACHMENTS_BUCKET_ARN_PARAM || '';
  if (!param) return '';
  try {
    const r = await (ssm ??= new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' })).send(new GetParameterCommand({ Name: param }));
    resolved = r.Parameter?.Value || '';
  } catch (err) {
    console.error(`${logPrefix} the attachments bucket could not be resolved`, { err: (err as Error)?.name });
  }
  return resolved;
}

/** The bucket's name from its ARN (`arn:aws:s3:::<name>`). */
export const bucketNameOf = (bucketArn: string): string => bucketArn.split(':::')[1] ?? '';
