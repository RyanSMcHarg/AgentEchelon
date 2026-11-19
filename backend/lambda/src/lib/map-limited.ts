/**
 * RUN A WORKER OVER A LIST WITH A BOUNDED NUMBER IN FLIGHT, the one helper for it. At most `limit` calls of
 * `worker` run at once, every item is visited once, and the results come back in the items' order. A
 * worker that throws rejects the whole run.
 */
export async function mapLimited<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}
