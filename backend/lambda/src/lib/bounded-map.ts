/**
 * `items.map(fn)` with at most `limit` calls in flight, results in the order of `items`.
 *
 * For a fan-out of reads or deletes whose count grows with the data (one per person, one per
 * conversation): run sequentially it costs one round trip per item, and run all at once it is a burst
 * the service throttles. The first rejection rejects the whole call: no further item is started, the
 * calls already in flight settle, and then it throws, so a caller that throws on a failed item still throws.
 */
export async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (!stopped && next < items.length) {
      const at = next++;
      try {
        results[at] = await fn(items[at], at);
      } catch (err) {
        stopped = true;
        throw err;
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failed) throw failed.reason;
  return results;
}
