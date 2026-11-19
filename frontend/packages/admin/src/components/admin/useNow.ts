/**
 * THE VIEWER'S CLOCK, for a length that grows while it is on screen (a live meeting's "running for"). It ticks a local
 * value only while `running` is true and asks the server for nothing (tenet D6): the figures change when the operator
 * refreshes, and the displayed length follows the clock between.
 */
import { useEffect, useState } from 'react';

export function useNow(running: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [running, everyMs]);
  return now;
}
