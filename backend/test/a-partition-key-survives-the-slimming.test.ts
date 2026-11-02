/**
 * THE S3 ARCHIVE PARTITIONS ON A FIELD THE PRODUCER MUST STILL BE SENDING.
 *
 * WHAT WENT WRONG. The conversation archive's Firehose sets its `user_type` partition with a JQ
 * expression over the Chime message `Metadata`, reading `classification`. Aurora mode later slimmed
 * that Metadata to `FRONTEND_METADATA_KEYS` and moved the rest out of band to DynamoDB, and
 * `classification` went with it. The archival Lambda was unaffected, because it follows the hop and
 * re-reads the full blob; FIREHOSE CANNOT. So the JQ's fallback fired on every record and the whole
 * archive partitioned as `user_type=unknown` for the life of Aurora mode. Nothing errored: a JQ type
 * error would have gone to the error prefix, but a missing key is just a fallback, so the pipeline
 * looked healthy while its only non-date partition became a constant.
 *
 * THE SECOND HALF. `user_type` was an Athena projected-partition enum, and a value absent from it is NOT
 * SCANNED - the objects sit in S3 and no query over the table returns them. The enum was hand-written as
 * `basic,standard,premium,unknown` while the admin alert paths were emitting `admin`, so those records were
 * written and then invisible. An enum derived from the registry closed that, and named every classification
 * in the archive's table, so adding one changed it. The table now registers each partition as the archival
 * path writes it (`registerArchivePartitions`), so every value that is written is read, and the table names
 * no classification.
 *
 * WHAT THIS PINS. The producer, the two Firehose copies and the projection are four places that have
 * to agree, and nothing made them. Here they do:
 *   1. every metadata key the JQ reads survives `pickFrontendMetadata`;
 *   2. the Aurora-mode and Athena-mode Firehose definitions carry the SAME expression;
 *   3. neither table projects `user_type`: both register each partition the Firehose writes.
 */
import * as fs from 'fs';
import * as path from 'path';
import { FRONTEND_METADATA_KEYS, pickFrontendMetadata } from '../lambda/src/lib/analytics-metadata';
import { ARCHIVE_CONVERSATIONS_PREFIX } from '../lib/constructs/archive-partitions';

const AURORA_MODE = path.join(__dirname, '../lib/constructs/conversation-archive.ts');
const ATHENA_MODE = path.join(__dirname, '../lib/stacks/archive-stack.ts');

/** The `MetadataExtractionQuery` value out of a CDK source, or null when it has moved. */
function extractionQuery(file: string): string | null {
  const src = fs.readFileSync(file, 'utf8');
  const m = /parameterValue:\s*\n?\s*'(\{user_type:[^']*)'/.exec(src);
  return m ? m[1] : null;
}

/**
 * The top-level Metadata keys a JQ expression reads. `.analytics.classification` and `.classification`
 * both depend on `classification` surviving, since `analytics` is a nested block built from it.
 */
function metadataKeysRead(jq: string): string[] {
  const keys = new Set<string>();
  for (const m of jq.matchAll(/\.(?:analytics\.)?([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
    // `Payload`/`Metadata` are the envelope, `fromjson`/`analytics` the traversal, not leaf keys.
    if (!['Payload', 'Metadata', 'fromjson', 'analytics'].includes(m[1])) keys.add(m[1]);
  }
  return [...keys];
}

describe('the archive partition key survives Aurora-mode slimming', () => {
  const jq = extractionQuery(AURORA_MODE);

  it('still finds the Firehose partition expression (the guard is wired to the file)', () => {
    expect(jq).toBeTruthy();
    expect(jq).toContain('user_type');
    expect(metadataKeysRead(jq!)).toContain('classification');
  });

  it('every metadata key the partition reads is one the slimmed Metadata still carries', () => {
    const missing = metadataKeysRead(jq!).filter(
      (k) => !(FRONTEND_METADATA_KEYS as readonly string[]).includes(k),
    );
    // Firehose reads the message and nothing else. A key dropped from the slim Metadata cannot be
    // recovered by it, and the partition silently becomes the JQ's fallback for every record.
    expect(missing).toEqual([]);
  });

  it('survives the real slimming function, not just the key list', () => {
    const full = {
      bedrockModel: 'claude-opus-5', intent: 'GENERAL', classification: 'premium',
      inputTokens: 10, latencyMs: 200, messageNumber: 3,
    } as unknown as Parameters<typeof pickFrontendMetadata>[0];
    const slim = pickFrontendMetadata(full) as Record<string, unknown>;
    expect(slim.classification).toBe('premium');
    // ...and the slimming is still doing its job, or this test would pass by it doing nothing.
    expect(slim.inputTokens).toBeUndefined();
    expect(slim.latencyMs).toBeUndefined();
  });

  it('partitions both modes identically, so an archive does not depend on which engine is on', () => {
    expect(extractionQuery(ATHENA_MODE)).toBe(jq);
  });
});

describe('every partition that gets written is read, and the table names no classification', () => {
  it('projects no partition of the conversations table in either mode, and registers each one the Firehose writes', () => {
    for (const file of [AURORA_MODE, ATHENA_MODE]) {
      const src = fs.readFileSync(file, 'utf8');
      const table = src.slice(src.indexOf("CfnTable(this, 'ConversationsTable'"));
      const body = table.slice(0, table.indexOf('addDependency(glueDatabase)'));
      expect({ file: path.basename(file), projects: /projection\./.test(body) }).toEqual({ file: path.basename(file), projects: false });
      expect(body).toContain("{ name: 'user_type', type: 'string' }");
      expect(src).toContain('registerArchivePartitions(this, archiveBucket);');
    }
  });

  it('registers the partitions under the prefix both Firehose copies write to', () => {
    for (const file of [AURORA_MODE, ATHENA_MODE]) {
      const src = fs.readFileSync(file, 'utf8').replace(/prefix:\s+'/g, "prefix: '");
      expect(src).toContain(`prefix: '${ARCHIVE_CONVERSATIONS_PREFIX}user_type=!{partitionKeyFromQuery:user_type}/`);
    }
  });
});
