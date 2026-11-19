/**
 * THE PLATFORM DRAWS A DASHBOARD (DESIGN-CONVERSATION-DASHBOARDS section 2): numbers in, HTML and SVG out.
 *
 * One renderer for both delivery tools. `renderDashboardFragment` is what the chat app shows in a sandboxed frame, and
 * `renderDashboardPage` wraps the same fragment as the hosted page. No model writes markup here: every value is a
 * number or a string the platform escapes, and every word a person reads arrives in `labels`, worded by the assistant's
 * message template, so nothing here is fixed English.
 *
 * THE CHARTS FOLLOW ONE METHOD. The alarm is a status tile (icon, label and state color, never color alone). The watched
 * metric is one line against its threshold. The deployment's four measures are small multiples, each on its own axis,
 * never two scales on one chart. Lines are 2px, gridlines hairline, the end point labelled; each point has a hover band
 * with a native tooltip, and a table carries every value. Light and dark are each selected, never an inversion.
 */
import type { DashboardData, DashboardSeries } from './dashboard-data.js';

/** Every word the dashboard shows, from the assistant's `dashboard` template. */
export interface DashboardLabels {
  title: string;
  /** One line under the title saying what the dashboard shows. */
  about?: string;
  /** The heading over the deployment's own assistant health. */
  deployment?: string;
  updated: string;
  stateAlarm: string;
  stateOk: string;
  stateInsufficient: string;
  /** No alarm reading: the conversation watches none, or it could not be read. */
  stateUnread: string;
  threshold: string;
  invocations: string;
  errors: string;
  throttles: string;
  durationMs: string;
  /** The heading over the metrics published beside the watched one. */
  related: string;
  noData: string;
  unavailable: string;
  values: string;
  time: string;
}

/** The two chart sizes, in SVG units that render near 1:1: the watched metric wide, each small multiple half as wide. */
const SIZES = {
  wide: { W: 640, H: 200, PAD: { top: 16, right: 76, bottom: 28, left: 44 } },
  small: { W: 320, H: 150, PAD: { top: 12, right: 44, bottom: 26, left: 40 } },
} as const;

/** Escape text for HTML and SVG. Every string from data passes through this. */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** A language tag a page can be written in. */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** The language a dashboard's numbers are written in, set once per render. */
let numbersIn = 'en';

/** One formatter per language and shape: a dashboard formats every point of every series. */
const formatters = new Map<string, Intl.NumberFormat>();
function formatterFor(locale: string, shape: 'compact' | 'whole' | 'decimal'): Intl.NumberFormat {
  const key = `${locale} ${shape}`;
  let found = formatters.get(key);
  if (!found) {
    const opts: Intl.NumberFormatOptions = shape === 'compact' ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: shape === 'whole' ? 0 : 2 };
    try { found = new Intl.NumberFormat(locale, opts); } catch { found = new Intl.NumberFormat('en', opts); }
    formatters.set(key, found);
  }
  return found;
}

/** A clean number in the reader's language: in full under 10,000, compact above, at most two decimals. */
export function fmt(v: number): string {
  const a = Math.abs(v);
  return formatterFor(numbersIn, a >= 1e4 ? 'compact' : a >= 100 || Number.isInteger(v) ? 'whole' : 'decimal').format(v);
}

const hhmm = (iso: string): string => iso.slice(11, 16);

/** Up to four clean ticks from zero to the first round number at or above `max`. */
export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let t = 0; t <= max + step * 0.999; t += step) ticks.push(+t.toPrecision(12));
  return ticks;
}

/** One line chart: a series, optionally a threshold, with hover bands and an end label. */
export function lineChart(series: DashboardSeries, opts: { label: string; threshold?: number; thresholdLabel: string; noData: string; unit?: string; size?: keyof typeof SIZES }): string {
  const { W, H, PAD } = SIZES[opts.size ?? 'wide'];
  const pts = series.points;
  if (!pts.length) {
    return `<figure class="chart"><figcaption>${esc(opts.label)}</figcaption><p class="empty">${esc(opts.noData)}</p></figure>`;
  }
  const t0 = Date.parse(pts[0].t);
  const t1 = Date.parse(pts[pts.length - 1].t);
  const span = Math.max(t1 - t0, 1);
  const max = Math.max(...pts.map((p) => p.v), opts.threshold ?? 0);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (t: string) => PAD.left + ((Date.parse(t) - t0) / span) * iw;
  const y = (v: number) => PAD.top + ih - (v / top) * ih;
  const grid = ticks.map((t) => `<line class="grid" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="tick" x="${PAD.left - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${esc(fmt(t))}</text>`).join('');
  const xTicks = [0, Math.floor((pts.length - 1) / 2), pts.length - 1].filter((i, n, a) => a.indexOf(i) === n)
    .map((i) => `<text class="tick" x="${x(pts[i].t).toFixed(1)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}">${esc(hhmm(pts[i].t))}</text>`).join('');
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  const threshold = typeof opts.threshold === 'number'
    ? `<line class="ref" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(opts.threshold).toFixed(1)}" y2="${y(opts.threshold).toFixed(1)}"/><text class="reflabel" x="${W - PAD.right + 6}" y="${(y(opts.threshold) + 4).toFixed(1)}">${esc(opts.thresholdLabel)} ${esc(fmt(opts.threshold))}</text>`
    : '';
  const band = iw / Math.max(pts.length, 1);
  const hover = pts.map((p) => {
    const cx = x(p.t);
    return `<g class="pt"><rect class="hit" x="${(cx - band / 2).toFixed(1)}" y="${PAD.top}" width="${band.toFixed(1)}" height="${ih}"/><line class="cross" x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${PAD.top}" y2="${PAD.top + ih}"/><circle class="hl" cx="${cx.toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4"/><title>${esc(hhmm(p.t))} UTC  ${esc(opts.label)}: ${esc(fmt(p.v))}${esc(opts.unit ?? '')}</title></g>`;
  }).join('');
  const last = pts[pts.length - 1];
  const end = `<circle class="end" cx="${x(last.t).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="4"/><text class="endlabel" x="${(x(last.t) + 8).toFixed(1)}" y="${(y(last.v) + 4).toFixed(1)}">${esc(fmt(last.v))}</text>`;
  return `<figure class="chart"><figcaption>${esc(opts.label)}</figcaption>`
    + `<svg class="${opts.size ?? 'wide'}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label)}">`
    + `${grid}<line class="axis" x1="${PAD.left}" x2="${W - PAD.right}" y1="${PAD.top + ih}" y2="${PAD.top + ih}"/>${xTicks}${threshold}`
    + `<path class="line" d="${path}"/>${end}${hover}</svg></figure>`;
}

const ICONS = {
  ALARM: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1z" fill="var(--status-critical)"/><path d="M8 6v3.5M8 11.5v.5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
  OK: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="var(--status-good)"/><path d="m4.8 8.2 2.2 2.2 4.2-4.6" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  INSUFFICIENT_DATA: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="var(--status-warning)"/><path d="M8 4.5v4M8 11v.5" stroke="#0b0b0b" stroke-width="1.6" stroke-linecap="round"/></svg>',
} as const;

const STYLE = `
.dash{min-height:100vh;--surface:#fcfcfb;--plane:#f9f9f7;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--border:rgba(11,11,11,.10);--series-1:#2a78d6;--status-good:#0ca30c;--status-warning:#fab219;--status-critical:#d03b3b;color-scheme:light;background:var(--plane);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px;margin:0}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .dash{--surface:#1a1a19;--plane:#0d0d0d;--ink:#f0efec;--ink2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);--series-1:#3987e5;color-scheme:dark}}
:root[data-theme="dark"] .dash{--surface:#1a1a19;--plane:#0d0d0d;--ink:#f0efec;--ink2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);--series-1:#3987e5;color-scheme:dark}
.dash *{box-sizing:border-box}
.dash header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 16px;align-items:baseline;margin-bottom:12px}
.dash h1{font-size:18px;margin:0}
.dash h2{font-size:14px;font-weight:600;color:var(--ink2);margin:12px 0 0}
.dash .updated{color:var(--ink2);font-size:13px}
.dash .tile{display:flex;gap:12px;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:12px}
.dash .tile svg{width:24px;height:24px;flex:none}
.dash .tile .state{font-weight:600}
.dash .tile .name{color:var(--ink2);font-size:13px;overflow-wrap:anywhere}
.dash .tile .now{margin-left:auto;text-align:right;font-size:22px;font-weight:600}
.dash .tile .now small{display:block;font-size:12px;font-weight:400;color:var(--ink2)}
.dash .grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 12px}
.dash .both>.chart:last-child{display:none}
@media (max-width:560px){.dash .grid2{grid-template-columns:1fr}.dash .both>.chart:first-child{display:none}.dash .both>.chart:last-child{display:block}}
.dash .chart{margin:0 0 12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px}
.dash figcaption{font-weight:600;margin-bottom:4px}
.dash svg{width:100%;height:auto;display:block;overflow:visible}
.dash .grid{stroke:var(--grid);stroke-width:1}
.dash .axis{stroke:var(--axis);stroke-width:1}
.dash .tick,.dash .reflabel{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.dash .ref{stroke:var(--ink2);stroke-width:1;stroke-dasharray:4 3}
.dash .line{fill:none;stroke:var(--series-1);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.dash .end,.dash .hl{fill:var(--series-1);stroke:var(--surface);stroke-width:2}
.dash .endlabel{fill:var(--ink);font-size:12px;font-weight:600}
.dash .hit{fill:transparent}
.dash .cross,.dash .hl{opacity:0}
.dash .cross{stroke:var(--axis);stroke-width:1}
.dash .pt:hover .cross,.dash .pt:hover .hl{opacity:1}
.dash .empty{color:var(--ink2);margin:8px 0}
.dash .about{color:var(--ink2);margin:0 0 12px;font-size:14px}
.dash details{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 12px}
.dash table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:13px}
.dash th,.dash td{text-align:right;padding:2px 8px;border-bottom:1px solid var(--grid)}
.dash th:first-child,.dash td:first-child{text-align:left}
`;

/**
 * A METRIC IN WORDS: its own name without its namespace, its words split (`AgentEchelon/Demo/SuccessRate` is "Success rate",
 * `LatencyP95` is "Latency P95"). The name is the metric's publisher's, read as an identifier, never a reader's text.
 */
export function metricWords(metric: string): string {
  const name = metric.split('/').pop() || metric;
  const words = name.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/\s+/);
  return words.map((w, i) => (i > 0 && /^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : w)).join(' ');
}

/** The dashboard as a fragment: its style and its body, for a sandboxed frame or the hosted page. */
export function renderDashboardFragment(data: DashboardData, labels: DashboardLabels, lang = 'en'): string {
  numbersIn = LANGUAGE_TAG.test(lang) ? lang : 'en';
  const named: Record<Exclude<DashboardSeries['key'], 'related'>, string> = {
    invocations: labels.invocations, errors: labels.errors, throttles: labels.throttles, durationMs: labels.durationMs,
    alarmMetric: data.alarm?.metric ? metricWords(data.alarm.metric) : labels.title,
  };
  const of = (key: DashboardSeries['key']) => data.series.find((s) => s.key === key) ?? { key, points: [] };
  const alarm = data.alarm;
  const stateWord = alarm ? ({ ALARM: labels.stateAlarm, OK: labels.stateOk, INSUFFICIENT_DATA: labels.stateInsufficient })[alarm.state] : '';
  const latest = of('alarmMetric').points.at(-1);
  const tile = alarm
    ? `<section class="tile">${ICONS[alarm.state]}<div><div class="state">${esc(stateWord)}</div><div class="name">${esc(alarm.name)}</div></div>`
      + (latest ? `<div class="now">${esc(fmt(latest.v))}${typeof alarm.threshold === 'number' ? `<small>${esc(labels.threshold)} ${esc(fmt(alarm.threshold))}</small>` : ''}</div>` : '')
      + '</section>'
    : data.alarmUnavailable ? `<section class="tile"><div class="state">${esc(labels.unavailable)}</div></section>` : '';
  // THE WATCHED METRIC AT BOTH SIZES, one shown by the screen's width, so its text stays readable on a phone.
  const alarmOpts = alarm?.metric ? { label: named.alarmMetric, threshold: alarm.threshold, thresholdLabel: labels.threshold, noData: labels.noData } : undefined;
  const alarmChart = alarmOpts
    ? `<div class="both">${lineChart(of('alarmMetric'), alarmOpts)}${lineChart(of('alarmMetric'), { ...alarmOpts, size: 'small' })}</div>`
    : '';
  // THE METRICS PUBLISHED BESIDE THE WATCHED ONE, small multiples under one heading, each named by its own metric.
  const related = alarm?.metric ? data.series.filter((s) => s.key === 'related' && s.metric) : [];
  const relatedCharts = related.length
    ? `<section class="related"><h2>${esc(labels.related)}</h2><div class="grid2">${related.map((s) => lineChart(s, { label: metricWords(s.metric!), thresholdLabel: labels.threshold, noData: labels.noData, size: 'small' })).join('')}</div></section>`
    : '';
  const keys: Array<Exclude<DashboardSeries['key'], 'related' | 'alarmMetric'>> = ['invocations', 'errors', 'throttles', 'durationMs'];
  const multiples = data.metricsUnavailable
    ? `<p class="empty">${esc(labels.unavailable)}</p>`
    : `<section class="related">${labels.deployment ? `<h2>${esc(labels.deployment)}</h2>` : ''}<div class="grid2">${keys.map((k) => lineChart(of(k), { label: named[k], thresholdLabel: labels.threshold, noData: labels.noData, size: 'small', ...(k === 'durationMs' ? { unit: ' ms' } : {}) })).join('')}</div></section>`;
  const shown: Array<{ name: string; series: DashboardSeries }> = [
    ...(alarm?.metric ? [{ name: named.alarmMetric, series: of('alarmMetric') }] : []),
    ...related.map((s) => ({ name: metricWords(s.metric!), series: s })),
    ...(data.metricsUnavailable ? [] : keys.map((k) => ({ name: named[k], series: of(k) }))),
  ];
  const times = [...new Set(shown.flatMap((c) => c.series.points.map((p) => p.t)))].sort();
  const table = times.length
    ? `<details><summary>${esc(labels.values)}</summary><table><thead><tr><th>${esc(labels.time)}</th>${shown.map((c) => `<th>${esc(c.name)}</th>`).join('')}</tr></thead><tbody>`
      + times.map((t) => `<tr><td>${esc(hhmm(t))}</td>${shown.map((c) => { const p = c.series.points.find((q) => q.t === t); return `<td>${p ? esc(fmt(p.v)) : ''}</td>`; }).join('')}</tr>`).join('')
      + '</tbody></table></details>'
    : '';
  return `<style>${STYLE}</style><main class="dash"><header><h1>${esc(labels.title)}</h1><span class="updated">${esc(labels.updated)}</span></header>${labels.about ? `<p class="about">${esc(labels.about)}</p>` : ''}${tile}${alarmChart}${relatedCharts}${multiples}${table}</main>`;
}

/** The content security policy every dashboard document carries: styles inline, nothing loaded, nothing run. */
export const DASHBOARD_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The hosted page: the fragment in a whole document that loads nothing and runs nothing. */
export function renderDashboardPage(data: DashboardData, labels: DashboardLabels, lang = 'en'): string {
  return `<!doctype html><html lang="${esc(LANGUAGE_TAG.test(lang) ? lang : 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta http-equiv="Content-Security-Policy" content="${DASHBOARD_CSP}"><meta name="robots" content="noindex"><title>${esc(labels.title)}</title>`
    + `<style>html,body{margin:0}</style></head><body>${renderDashboardFragment(data, labels, lang)}</body></html>`;
}
