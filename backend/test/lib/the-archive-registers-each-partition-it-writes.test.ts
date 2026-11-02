/**
 * THE ARCHIVE REGISTERS EACH PARTITION IT WRITES (the classification-independence plan, the archive's partition).
 *
 * The `conversations` table registers its partitions rather than projecting them, so it names no classification.
 * Each object the archive's Firehose creates invokes the registrar (an S3 event notification), which creates the
 * object's `(user_type, year, month, day)` partition in Glue, an existing one being success, and remembers nothing
 * across invocations. At deploy a custom resource runs it over the partitions already in the bucket (the backfill),
 * and an invocation that fails every retry lands on an alarmed dead-letter queue.
 */
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-glue', () => {
  const cmd = (type: string) => jest.fn().mockImplementation((input: unknown) => ({ type, input }));
  return {
    GlueClient: jest.fn(() => ({ send: mockSend })),
    GetTableCommand: cmd('GetTable'),
    CreatePartitionCommand: cmd('CreatePartition'),
    BatchCreatePartitionCommand: cmd('BatchCreatePartition'),
  };
});
const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  ListObjectsV2Command: jest.fn().mockImplementation((input: unknown) => ({ type: 'ListObjectsV2', input })),
}));

process.env.ARCHIVE_DATABASE = 'agent_echelon_analytics';
process.env.ARCHIVE_TABLE = 'conversations';
process.env.ARCHIVE_PREFIX = 'conversations/';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const registrar = require('../../lambda/src/archive-partition-registrar') as typeof import('../../lambda/src/archive-partition-registrar');

const SD = { Columns: [{ Name: 'line', Type: 'string' }], Location: 's3://b/conversations/', SerdeInfo: { SerializationLibrary: 'x' } };
const record = (key: string) => ({ s3: { bucket: { name: 'archive-bucket' }, object: { key } } });
const sent = (type: string) => mockSend.mock.calls.map(([c]) => c).filter((c) => c.type === type);

beforeEach(() => {
  mockSend.mockReset().mockImplementation(async (cmd: { type: string }) => (cmd.type === 'GetTable' ? { Table: { StorageDescriptor: SD } } : {}));
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('the partition of an archive key', () => {
  it('reads the classification and the date from a conversation record key', () => {
    expect(registrar.partitionOfKey('conversations/user_type=enterprise/year=2026/month=10/day=22/x.gz')).toEqual(['enterprise', '2026', '10', '22']);
    expect(registrar.partitionOfKey('conversations/user_type=unknown/year=2026/month=01/day=02/a')).toEqual(['unknown', '2026', '01', '02']);
  });

  it('reads nothing from a key outside the records or not shaped as a partition', () => {
    expect(registrar.partitionOfKey('errors/processing-failed/year=2026/month=10/day=22/x')).toBeNull();
    expect(registrar.partitionOfKey('conversations/user_type=x/2026/10/22/x')).toBeNull();
  });

  it('decodes the key S3 sends', () => {
    expect(registrar.decodedKey('conversations/user_type=a+b%2Fc/x')).toBe('conversations/user_type=a b/c/x');
  });
});

describe('the registrar', () => {
  it('creates the partition of each record it is told of, at that partition\'s own location, with the table\'s descriptor', async () => {
    const out = await registrar.handler({ Records: [record('conversations/user_type=legal/year=2026/month=10/day=21/a.gz'), record('errors/x')] });
    expect(out).toEqual({ registered: 1 });
    const [create] = sent('CreatePartition');
    expect(create.input).toEqual({
      DatabaseName: 'agent_echelon_analytics',
      TableName: 'conversations',
      PartitionInput: {
        Values: ['legal', '2026', '10', '21'],
        StorageDescriptor: { ...SD, Location: 's3://archive-bucket/conversations/user_type=legal/year=2026/month=10/day=21/' },
      },
    });
  });

  it('asks Glue once per partition per event, and takes an existing one as success', async () => {
    await registrar.handler({ Records: [record('conversations/user_type=finance/year=2026/month=10/day=21/a.gz'), record('conversations/user_type=finance/year=2026/month=10/day=21/b.gz')] });
    expect(sent('CreatePartition')).toHaveLength(1);
    mockSend.mockImplementation(async (cmd: { type: string }) => {
      if (cmd.type === 'GetTable') return { Table: { StorageDescriptor: SD } };
      throw Object.assign(new Error('exists'), { name: 'AlreadyExistsException' });
    });
    await expect(registrar.handler({ Records: [record('conversations/user_type=research/year=2026/month=10/day=21/a.gz')] })).resolves.toEqual({ registered: 1 });
  });

  it('fails the invocation on any other Glue error, so S3 retries it', async () => {
    mockSend.mockImplementation(async (cmd: { type: string }) => {
      if (cmd.type === 'GetTable') return { Table: { StorageDescriptor: SD } };
      throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    });
    await expect(registrar.handler({ Records: [record('conversations/user_type=audit/year=2026/month=10/day=21/a.gz')] })).rejects.toThrow(/throttled/);
  });

  it('remembers nothing across invocations, so a partition removed from Glue is registered again', async () => {
    const key = 'conversations/user_type=ops/year=2026/month=10/day=21/a.gz';
    await registrar.handler({ Records: [record(key)] });
    await registrar.handler({ Records: [record(key)] });
    expect(sent('CreatePartition')).toHaveLength(2);
  });
});

describe('the backfill at deploy', () => {
  /** A bucket listing: each prefix's common prefixes one level down. */
  const TREE: Record<string, string[]> = {
    'conversations/': ['conversations/user_type=basic/', 'conversations/user_type=unknown/'],
    'conversations/user_type=basic/': ['conversations/user_type=basic/year=2026/'],
    'conversations/user_type=unknown/': ['conversations/user_type=unknown/year=2025/'],
    'conversations/user_type=basic/year=2026/': ['conversations/user_type=basic/year=2026/month=09/'],
    'conversations/user_type=unknown/year=2025/': ['conversations/user_type=unknown/year=2025/month=12/'],
    'conversations/user_type=basic/year=2026/month=09/': ['conversations/user_type=basic/year=2026/month=09/day=01/', 'conversations/user_type=basic/year=2026/month=09/day=02/'],
    'conversations/user_type=unknown/year=2025/month=12/': ['conversations/user_type=unknown/year=2025/month=12/day=31/'],
  };
  beforeEach(() => {
    mockS3Send.mockReset().mockImplementation(async (cmd: { input: { Prefix: string } }) => ({ CommonPrefixes: (TREE[cmd.input.Prefix] ?? []).map((Prefix) => ({ Prefix })) }));
  });
  const created = { RequestType: 'Create' as const, ResourceProperties: { BucketName: 'archive-bucket' } };

  it('registers every partition already in the bucket on Create, each at its own location', async () => {
    const out = await registrar.handler(created);
    expect(out).toEqual({ PhysicalResourceId: 'archive-partitions-backfill-archive-bucket', Data: { partitions: 3 } });
    const [batch] = sent('BatchCreatePartition');
    expect(batch.input.PartitionInputList.map((p: { Values: string[] }) => p.Values)).toEqual([
      ['basic', '2026', '09', '01'], ['basic', '2026', '09', '02'], ['unknown', '2025', '12', '31'],
    ]);
    expect(batch.input.PartitionInputList[2].StorageDescriptor.Location).toBe('s3://archive-bucket/conversations/user_type=unknown/year=2025/month=12/day=31/');
  });

  it('takes an existing partition as success and fails the deploy on any other error', async () => {
    const answering = (code: string) => async (cmd: { type: string }) => (cmd.type === 'GetTable' ? { Table: { StorageDescriptor: SD } }
      : { Errors: [{ PartitionValues: ['basic', '2026', '09', '01'], ErrorDetail: { ErrorCode: code } }] });
    mockSend.mockImplementation(answering('AlreadyExistsException'));
    await expect(registrar.handler(created)).resolves.toMatchObject({ Data: { partitions: 3 } });
    mockSend.mockImplementation(answering('InternalServiceException'));
    await expect(registrar.handler(created)).rejects.toThrow(/not registered: basic\/2026\/09\/01 InternalServiceException/);
  });

  it('does nothing on Delete', async () => {
    await registrar.handler({ RequestType: 'Delete', PhysicalResourceId: 'x', ResourceProperties: { BucketName: 'archive-bucket' } });
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(sent('BatchCreatePartition')).toEqual([]);
  });
});

describe('the registrar as synthesized', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cdk = require('aws-cdk-lib') as typeof import('aws-cdk-lib');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Template } = require('aws-cdk-lib/assertions') as typeof import('aws-cdk-lib/assertions');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const s3 = require('aws-cdk-lib/aws-s3') as typeof import('aws-cdk-lib/aws-s3');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { registerArchivePartitions } = require('../../lib/constructs/archive-partitions');
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new cdk.Stack(app, 'Archive', { env: { account: '123456789012', region: 'us-east-1' } });
  registerArchivePartitions(stack, new s3.Bucket(stack, 'Bucket'));
  const t = Template.fromStack(stack);
  type Res = { Properties: Record<string, any> };

  it('keeps an event every retry failed on a dead-letter queue, and alarms on it', () => {
    const fn = (Object.values(t.findResources('AWS::Lambda::Function')) as Res[]).find((f) => String(f.Properties.Description ?? '').startsWith('Registers each conversation archive partition'))!;
    expect(fn.Properties.DeadLetterConfig.TargetArn).toBeDefined();
    const alarms = Object.values(t.findResources('AWS::CloudWatch::Alarm')) as Res[];
    expect(alarms.filter((a) => a.Properties.MetricName === 'ApproximateNumberOfMessagesVisible')).toHaveLength(1);
  });

  it('runs the backfill at deploy through a custom resource, listing only the conversations prefix', () => {
    const backfill = Object.values(t.findResources('AWS::CloudFormation::CustomResource')) as Res[];
    expect(backfill).toHaveLength(1);
    expect(backfill[0].Properties.Prefix).toBe('conversations/');
    const statements = (Object.values(t.findResources('AWS::IAM::Policy')) as Res[]).flatMap((p) => p.Properties.PolicyDocument.Statement as Array<Record<string, any>>);
    const list = statements.find((st) => st.Sid === 'ListTheConversationsPartitionPrefixes')!;
    expect(list.Action).toBe('s3:ListBucket');
    expect(list.Condition).toEqual({ StringLike: { 's3:prefix': ['conversations/*'] } });
  });
});
