/**
 * `mapBounded` (lambda/src/lib/bounded-map.ts): a fan-out with a cap on what is in flight.
 */
import { mapBounded } from '../../lambda/src/lib/bounded-map';

const tick = () => new Promise((r) => setImmediate(r));

describe('mapBounded', () => {
  it('answers in the order of the items, whatever order the calls finish in', async () => {
    const out = await mapBounded([30, 10, 20], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(['0:30', '1:10', '2:20']);
  });

  it('never has more than the limit in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapBounded(Array.from({ length: 25 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
    });
    expect(peak).toBe(4);
  });

  it('rejects on the first failure and starts nothing after it', async () => {
    const started: number[] = [];
    await expect(mapBounded([0, 1, 2, 3, 4, 5], 1, async (n) => {
      started.push(n);
      if (n === 2) throw new Error('no');
    })).rejects.toThrow('no');
    expect(started).toEqual([0, 1, 2]);
  });

  it('answers an empty list without calling', async () => {
    const fn = jest.fn();
    expect(await mapBounded([], 8, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});
