import { useEffect, useState } from 'react';

/**
 * The rendered width of an element, kept current as it resizes, so an SVG chart draws at its container's width with
 * text at its true size. Where the browser has no ResizeObserver, it stays at `fallback`.
 */
export function useMeasuredWidth<T extends HTMLElement>(fallback: number): [(el: T | null) => void, number] {
  // A CALLBACK REF, so an element that appears after the first render (a chart drawn once its readings arrive) is measured too.
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const read = () => { const w = Math.floor(el.getBoundingClientRect().width); if (w > 0) setWidth(w); };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}
