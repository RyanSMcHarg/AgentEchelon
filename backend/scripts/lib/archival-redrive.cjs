/**
 * The pure half of the archival redrive (`scripts/redrive-archival-dlq.mjs`): what a dead-letter record names,
 * which stream records belong to it, and the event the archival function is handed for them.
 *
 * The Kinesis event source records a failed batch as its POSITION, not its records: the shard, the first and last
 * sequence numbers and the stream. The records are read back from the stream by that range, so a redrive is
 * possible while the stream still holds them (its retention, twenty-four hours) and not after.
 */

/**
 * The batch a dead-letter message names, or null when the body is not a Kinesis batch record.
 * @param {string} body
 * @returns {{ streamArn: string, shardId: string, startSequenceNumber: string, endSequenceNumber: string, batchSize: number, condition: string | null, failedAt: string | null } | null}
 */
function batchOfDeadLetter(body) {
  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    return null;
  }
  const info = doc && doc.KinesisBatchInfo;
  if (!info || !info.shardId || !info.startSequenceNumber || !info.endSequenceNumber || !info.streamArn) return null;
  return {
    streamArn: String(info.streamArn),
    shardId: String(info.shardId),
    startSequenceNumber: String(info.startSequenceNumber),
    endSequenceNumber: String(info.endSequenceNumber),
    batchSize: Number(info.batchSize) || 0,
    condition: (doc.requestContext && doc.requestContext.condition) || null,
    failedAt: doc.timestamp || null,
  };
}

/** Kinesis sequence numbers are decimal strings longer than a double holds, so they compare as BigInt. */
const seq = (s) => BigInt(String(s));

/**
 * Which of the records read from the shard belong to the batch, and whether the read covered all of it.
 * `expired` is true when the first record the stream returned is already past the batch's start: the stream
 * has trimmed the beginning of the range, so the batch cannot be re-run whole.
 * @param {{ startSequenceNumber: string, endSequenceNumber: string }} batch
 * @param {Array<{ SequenceNumber: string }>} records the records read from the batch's start onward, in order
 */
function recordsOfBatch(batch, records) {
  const start = seq(batch.startSequenceNumber);
  const end = seq(batch.endSequenceNumber);
  const expired = records.length === 0 || seq(records[0].SequenceNumber) > start;
  const inRange = records.filter((r) => seq(r.SequenceNumber) >= start && seq(r.SequenceNumber) <= end);
  const reachedEnd = records.some((r) => seq(r.SequenceNumber) >= end);
  return { records: inRange, expired, reachedEnd };
}

/**
 * The Kinesis event the archival function receives from its event source, built from records read with
 * GetRecords (the CLI returns `Data` base64-encoded, the form the event carries).
 * @param {{ streamArn: string, shardId: string }} batch
 * @param {Array<{ SequenceNumber: string, PartitionKey: string, Data: string, ApproximateArrivalTimestamp?: string | number }>} records
 * @param {string} region
 */
function kinesisEventOf(batch, records, region) {
  return {
    Records: records.map((r) => ({
      kinesis: {
        kinesisSchemaVersion: '1.0',
        partitionKey: r.PartitionKey,
        sequenceNumber: r.SequenceNumber,
        data: r.Data,
        approximateArrivalTimestamp: arrivalSeconds(r.ApproximateArrivalTimestamp),
      },
      eventSource: 'aws:kinesis',
      eventVersion: '1.0',
      eventID: `${batch.shardId}:${r.SequenceNumber}`,
      eventName: 'aws:kinesis:record',
      eventSourceARN: batch.streamArn,
      awsRegion: region,
    })),
  };
}

/** The arrival time in epoch seconds, as the event source sends it, from the CLI's ISO string or number. */
function arrivalSeconds(v) {
  if (typeof v === 'number') return v;
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms / 1000 : 0;
}

/** Split `items` into runs of at most `size`. */
function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

module.exports = { batchOfDeadLetter, recordsOfBatch, kinesisEventOf, chunks };
