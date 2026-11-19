import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { RECORDINGS_FAMILY } from '../../lambda/src/lib/meeting-recording';

/** The Sids the conversation store's policy carries for the meetings capability, attached by the store's own stack. */
export const MEETING_RECORDINGS_WRITE_SID = 'MeetingRecordingsFromMediaPipelines';
export const MEETING_RECORDINGS_LIST_SID = 'MeetingRecordingsListedByMediaPipelines';

/**
 * THE CONVERSATION STORE'S GRANT TO THE AMAZON CHIME SDK MEDIA PIPELINES SERVICE (SPEC-ASSISTANT-MEETINGS FR70), added by
 * the store's own stack where the `meetings` capability is declared. The statements are the developer guide's ("Creating
 * an Amazon S3 bucket for Amazon Chime SDK media capture pipelines" and "Building an Amazon Chime SDK media concatenation
 * pipeline"): the service principal `mediapipelines.chime.amazonaws.com`, held to this account by `aws:SourceAccount` and
 * to its Amazon Chime SDK resources by `aws:SourceArn`; and narrowed to the recording family:
 *  - it writes (`s3:PutObject`, `s3:PutObjectAcl`) and reads back (`s3:GetObject`, which a concatenation reads the capture
 *    chunks with) objects under `recordings/` only, so it can neither write nor read a member's upload, a generated
 *    document or a transcript;
 *  - it lists the bucket only under `recordings/`.
 * The bucket is encrypted with an Amazon S3 managed key, which the guide says needs nothing further; a customer managed
 * key would need the guide's `kms:GenerateDataKey` and `kms:Decrypt` statements for the same principal.
 */
export function meetingRecordingsSinkStatements(bucket: s3.IBucket, account: string, partition = 'aws'): iam.PolicyStatement[] {
  const principal = new iam.ServicePrincipal('mediapipelines.chime.amazonaws.com');
  const fromThisAccount = {
    StringEquals: { 'aws:SourceAccount': account },
    ArnLike: { 'aws:SourceArn': `arn:${partition}:chime:*:${account}:*` },
  };
  return [
    new iam.PolicyStatement({
      sid: MEETING_RECORDINGS_WRITE_SID,
      principals: [principal],
      actions: ['s3:PutObject', 's3:PutObjectAcl', 's3:GetObject'],
      resources: [bucket.arnForObjects(`${RECORDINGS_FAMILY}*`)],
      conditions: fromThisAccount,
    }),
    new iam.PolicyStatement({
      sid: MEETING_RECORDINGS_LIST_SID,
      principals: [principal],
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
      conditions: { ...fromThisAccount, StringLike: { 's3:prefix': [`${RECORDINGS_FAMILY}*`] } },
    }),
  ];
}
