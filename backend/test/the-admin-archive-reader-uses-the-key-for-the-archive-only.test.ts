/**
 * THE ADMIN CONVERSATION READER USES A KMS KEY THROUGH S3, FOR THE CONVERSATION ARCHIVE'S OBJECTS ALONE.
 *
 * The archive bucket is SSE-KMS, and the reader's key grant names no key ARN (the archive's key is the Archive
 * stack's). It is bounded instead by how the key is used: through S3 (`kms:ViaService`), and for the archive
 * bucket's objects (`kms:EncryptionContext:aws:s3:arn`), so no other bucket's key use is reachable through it.
 */
import { adminServicesOnLiteralsTemplate, TEST_ENV } from './helpers/synth';
import { ANALYTICS_PREFIX } from '../lib/stacks/agent-classification-common';

type Statement = { Effect?: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
const list = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

describe('the admin conversation reader and the archive key', () => {
  const t = adminServicesOnLiteralsTemplate({});
  const [, role] = (Object.entries(t.findResources('AWS::IAM::Role')) as Array<[string, any]>)
    .find(([id]) => id.startsWith('AdminConversationRole'))!;
  const kms: Statement[] = (role.Properties.Policies as any[])
    .flatMap((p) => p.PolicyDocument.Statement as Statement[])
    .filter((s) => s.Effect !== 'Deny' && list(s.Action).some((a) => a.startsWith('kms:')));
  const BUCKET = `arn:aws:s3:::${ANALYTICS_PREFIX}-conversation-archive-${TEST_ENV.account}-${TEST_ENV.region}`;

  it('decrypts and generates data keys only, through S3, for the archive bucket and its objects', () => {
    expect(kms).toHaveLength(1);
    expect(list(kms[0].Action).sort()).toEqual(['kms:Decrypt', 'kms:GenerateDataKey']);
    expect(kms[0].Condition?.StringEquals?.['kms:ViaService']).toBe(`s3.${TEST_ENV.region}.amazonaws.com`);
    expect(kms[0].Condition?.StringLike?.['kms:EncryptionContext:aws:s3:arn']).toEqual([BUCKET, `${BUCKET}/*`]);
  });
});
