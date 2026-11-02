/**
 * THE CONVERSATION ARCHIVE'S PARTITIONS ARE REGISTERED BY THE ARCHIVAL PATH, AS THEY ARE WRITTEN.
 *
 * The archive's Firehose writes each record under `conversations/user_type=<classification>/year=/month=/day=/`,
 * the classification the turn declared (or `unknown`). The `conversations` Glue table registers its partitions
 * rather than projecting them: a projected `user_type` would have to enumerate the deployment's classifications
 * in the table (an `enum`), so adding one would change the archive's template, and an `injected` projection would
 * refuse every query that scans across classifications (Athena refuses a query on an injected column without a
 * static equality on it). So every object the Firehose creates under that prefix invokes this function (an S3
 * event notification), which registers its `(user_type, year, month, day)` partition, idempotently. Every
 * existing query reads the registered partitions exactly as it read the projected ones, and a classification
 * added or removed changes no table.
 *
 * Event-driven (tenet D6): Firehose writes a partition's objects every buffer interval, so a partition whose first
 * registration was missed is registered by the next object written to it. An invocation that fails every retry
 * lands on the registrar's dead-letter queue, which is alarmed.
 *
 * AND ONCE AT DEPLOY: the same function is the onEvent handler of a custom resource in the archive's stack, and on
 * Create and Update it lists the partition prefixes already in the bucket and registers each, so objects archived
 * before the registrar existed are read too. Every registration is idempotent: an existing partition is success,
 * and Glue is the only record of what is registered (nothing is remembered per container).
 */
import { GlueClient, GetTableCommand, CreatePartitionCommand, BatchCreatePartitionCommand, type StorageDescriptor } from '@aws-sdk/client-glue';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

/** The partition an archive key is written under, or null for a key that is not a conversation record. */
export function partitionOfKey(key: string, prefix = 'conversations/'): string[] | null {
  if (!key.startsWith(prefix)) return null;
  const m = /^user_type=([^/]+)\/year=(\d{4})\/month=(\d{2})\/day=(\d{2})\//.exec(key.slice(prefix.length));
  return m ? [m[1], m[2], m[3], m[4]] : null;
}

/** An S3 event's object key, decoded (S3 URL-encodes it, with `+` for a space). */
export function decodedKey(raw: string): string {
  return decodeURIComponent(raw.replace(/\+/g, ' '));
}

interface S3EventLike {
  Records?: Array<{ s3?: { bucket?: { name?: string }; object?: { key?: string } } }>;
}

interface CustomResourceEventLike {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties?: { BucketName?: string };
}

const glue = new GlueClient({});
const s3 = new S3Client({});
const DATABASE = process.env.ARCHIVE_DATABASE || '';
const TABLE = process.env.ARCHIVE_TABLE || 'conversations';
const PREFIX = process.env.ARCHIVE_PREFIX || 'conversations/';

/** How long a container keeps the table's storage descriptor before it reads it again. */
export const DESCRIPTOR_TTL_MS = 10 * 60_000;
let tableDescriptor: { sd: StorageDescriptor; at: number } | undefined;

async function storageDescriptor(): Promise<StorageDescriptor> {
  if (!tableDescriptor || Date.now() - tableDescriptor.at >= DESCRIPTOR_TTL_MS) {
    const table = await glue.send(new GetTableCommand({ DatabaseName: DATABASE, Name: TABLE }));
    const sd = table.Table?.StorageDescriptor;
    if (!sd) throw new Error(`archive-partition-registrar: ${DATABASE}.${TABLE} has no storage descriptor`);
    tableDescriptor = { sd, at: Date.now() };
  }
  return tableDescriptor.sd;
}

const locationOf = (bucket: string, [userType, year, month, day]: string[]): string =>
  `s3://${bucket}/${PREFIX}user_type=${userType}/year=${year}/month=${month}/day=${day}/`;

/** Register one partition at `location`; an existing one is success. */
async function register(values: string[], location: string): Promise<void> {
  const id = values.join('/');
  const sd = await storageDescriptor();
  try {
    await glue.send(new CreatePartitionCommand({
      DatabaseName: DATABASE,
      TableName: TABLE,
      PartitionInput: { Values: values, StorageDescriptor: { ...sd, Location: location } },
    }));
    console.log(JSON.stringify({ _event: 'archive_partition_registered', partition: id }));
  } catch (err) {
    if ((err as { name?: string })?.name !== 'AlreadyExistsException') throw err;
  }
}

/** The common prefixes one level below `prefix` (each ending in `/`), every page of them. */
async function childPrefixes(bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let ContinuationToken: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/', ContinuationToken }));
    for (const p of page.CommonPrefixes ?? []) if (p.Prefix) out.push(p.Prefix);
    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);
  return out;
}

/** Every partition already written under the prefix in `bucket`, found by listing its four levels. */
export async function existingPartitions(bucket: string): Promise<string[][]> {
  let level = [PREFIX];
  for (let depth = 0; depth < 4; depth++) level = (await Promise.all(level.map((p) => childPrefixes(bucket, p)))).flat();
  return level.map((p) => partitionOfKey(`${p}x`, PREFIX)).filter((v): v is string[] => !!v);
}

/** Register every partition already in `bucket`, a hundred to a call; an existing one is success. */
export async function backfill(bucket: string): Promise<number> {
  const all = await existingPartitions(bucket);
  if (!all.length) return 0;
  const sd = await storageDescriptor();
  for (let i = 0; i < all.length; i += 100) {
    const batch = all.slice(i, i + 100);
    const out = await glue.send(new BatchCreatePartitionCommand({
      DatabaseName: DATABASE,
      TableName: TABLE,
      PartitionInputList: batch.map((values) => ({ Values: values, StorageDescriptor: { ...sd, Location: locationOf(bucket, values) } })),
    }));
    const failed = (out.Errors ?? []).filter((e) => e.ErrorDetail?.ErrorCode !== 'AlreadyExistsException');
    if (failed.length) {
      const named = failed.map((e) => `${(e.PartitionValues ?? []).join('/')} ${e.ErrorDetail?.ErrorCode}`).join(', ');
      throw new Error(`archive-partition-registrar: ${failed.length} partition(s) not registered: ${named}`);
    }
  }
  console.log(JSON.stringify({ _event: 'archive_partitions_backfilled', bucket, partitions: all.length }));
  return all.length;
}

const isCustomResourceEvent = (e: unknown): e is CustomResourceEventLike =>
  !!e && typeof e === 'object' && typeof (e as { RequestType?: unknown }).RequestType === 'string';

type Result = { registered: number } | { PhysicalResourceId: string; Data: { partitions: number } };

export const handler = async (event: S3EventLike | CustomResourceEventLike): Promise<Result> => {
  if (isCustomResourceEvent(event)) {
    const bucket = event.ResourceProperties?.BucketName || '';
    const PhysicalResourceId = event.PhysicalResourceId || `archive-partitions-backfill-${bucket}`;
    if (event.RequestType === 'Delete' || !bucket) return { PhysicalResourceId, Data: { partitions: 0 } };
    return { PhysicalResourceId, Data: { partitions: await backfill(bucket) } };
  }
  let count = 0;
  const seen = new Set<string>();
  for (const record of event.Records ?? []) {
    const bucket = record.s3?.bucket?.name;
    const raw = record.s3?.object?.key;
    if (!bucket || !raw) continue;
    const values = partitionOfKey(decodedKey(raw), PREFIX);
    if (!values) continue;
    count++;
    // One Glue call per partition per event; nothing is remembered across invocations.
    const id = `${bucket}/${values.join('/')}`;
    if (seen.has(id)) continue;
    seen.add(id);
    await register(values, locationOf(bucket, values));
  }
  return { registered: count };
};
