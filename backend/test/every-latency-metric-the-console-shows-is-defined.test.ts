/**
 * A LATENCY NUMBER THE CONSOLE SHOWS HAS A DEFINITION SOMEBODY CAN READ.
 *
 * WHY THIS EXISTS. `ack_ms` shipped with a view comment, a query comment, a gap row and a frontend
 * tooltip, and no entry in the one chapter a reader goes to for "what does this number mean":
 * LATENCY-TARGETS' metric definitions. Its SUBSET, `ttff_ms`, had a full section. So the document
 * said a rebuttal has no TTFF and never said what does measure it, and the honest conclusion from
 * reading it was that a rebuttal is unmeasured. It is measured, and has been since migration 033.
 *
 * That is the second metric documented only in passing, which is what makes it a class rather than an
 * incident: a column is added to a query, the console renders it, the tooltip explains it in twelve
 * words, and the chapter that is supposed to be the definition never learns about it.
 *
 * WHAT IT PINS. Every `*_ms` column the three latency read paths return - the Latency tab's cards
 * (`getLatencyMetrics`), the Latency by interaction panel (`getLatencyByInteraction`) and the Turn
 * Latency Audit (`getTurnLatencyAudit`, which reads `v_turn_latency` directly) - resolves to a `###`
 * section in the metric-definitions chapter whose heading names it.
 *
 * WHAT IT DOES NOT PIN. The prose. Whether a definition is any good is a judgement, and judgement is
 * reviewed by people. This checks that the reader is not sent to a chapter that has nothing to say.
 *
 * The column lists are read FROM THE CODE rather than restated here, so adding a metric to a query is
 * what makes this fail - the same pairing `docs-code-references` and `a-documented-knob-matches-the-code`
 * use, and the reason a hardcoded copy would rot first.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const ROOT = path.resolve(__dirname, '../..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs/guides/developer/LATENCY-TARGETS.md'), 'utf8');
const QUERY_SRC = fs.readFileSync(
  path.join(__dirname, '../lambda/src/analytics-aurora/analytics-query.ts'), 'utf8',
);

/** The read paths whose columns reach a latency surface of the admin console. */
const LATENCY_READ_PATHS: Record<string, string> = {
  getLatencyMetrics:
    'The Latency tab cards and the metric-target registry read this row by name.',
  getLatencyByInteraction:
    'The Latency by interaction panel, the one surface where a turn nobody sent is reported.',
  getTurnLatencyAudit:
    'The Turn Latency Audit, which returns v_turn_latency columns per response rather than aggregates.',
};

/**
 * A column whose metric is DEFINED UNDER ANOTHER NAME, and why the two are one metric rather than two.
 *
 * Kept separate from the definitions table below so an alias cannot quietly stand in for a missing
 * definition: an alias must still resolve to a documented base.
 */
const SAME_METRIC_AS: Record<string, { base: string; why: string }> = {
  bedrock_ms: {
    base: 'latency_ms',
    why: 'getLatencyMetrics renames messages.latency_ms to avg_bedrock_ms for the "Avg Bedrock" card. '
      + 'One column, one definition, two names on the way to the screen.',
  },
  ttff_warm_ms: {
    base: 'ttff_ms',
    why: 'The same TTFF over warm turns only (G9). A population qualifier on one metric, not a second '
      + 'metric: it is defined by naming the rows it excludes, which the TTFF section does.',
  },
};

/**
 * Every metric this guard expects a `###` section for, and the reason that section has to exist.
 *
 * The key is the column name the section heading must contain. A reason per entry is what stops this
 * table from being extended by reflex when a new column appears: if the reason cannot be written, the
 * column is probably a count or a provenance flag rather than a metric, and does not belong here.
 */
const DEFINED_IN_THE_METRIC_CHAPTER: Record<string, string> = {
  ttff_ms:
    'The perceived-responsiveness SLO, held against a published response-time limit. The one number '
    + 'on this surface with a band, so what is inside it has to be exact.',
  ack_ms:
    'The GENERAL trigger-to-first-signal metric, of which ttff_ms is the user-triggered subset. '
    + 'Without a section a reader concludes a rebuttal is unmeasured; it is measured, and the two '
    + 'sections have to point at each other or either one read alone misleads.',
  total_ms: 'Worker compute: the server-side cost of the turn, and the number a slow turn is chased with.',
  latency_ms: 'The Converse tool loop, the dominant component of worker compute on most turns.',
  model_ms: 'Model inference alone, so a RAG-heavy turn does not read as a slow model.',
  tool_ms: 'In-loop tool execution, the other half of that split.',
  e2e_ms: 'User message to final answer: the wait an SLA or a UX complaint is actually about.',
  turn_ms:
    'Every turn\'s own start to its final post, including the turns no person\'s message anchors. Its '
    + 'start differs by kind of turn and one of its four sources crosses clocks, so the section is where a '
    + 'reader learns which start a row\'s average is over.',
  inbound_ms: 'The front-of-turn hop, and the only cross-clock figure here, so its approximation has to be stated.',
  router_ms: 'The handler compute that sits in front of the placeholder, so it is inside TTFF.',
  router_other_ms: 'The router less its classifier step, a derived residual that can be misread as a sibling.',
  to_flow_ms: 'The message reaching the channel flow: cross-clock, so the section has to say it is approximate.',
  flow_to_router_ms: 'The flow handing the turn to the router, on two server clocks.',
  placeholder_return_ms: 'The placeholder travelling back, derived as what the other two leave of the time outside the router.',
  ttff_outside_router_ms:
    'The rest of TTFF once the router leg is taken out, and the largest share of it on most turns. '
    + 'It needs a section more than most: it is a per-ROW difference of two durations on two clocks, '
    + 'which is sound, and it looks exactly like the group-average subtraction that is not - so a '
    + 'reader has to be told which one it is. It also goes NEGATIVE legitimately, when the flow '
    + 'posted the placeholder before the router finished, and a negative latency with no explanation '
    + 'reads as corruption.',
  classifier_ms: 'The largest controllable step inside TTFF, and NULL when no model was asked rather than zero.',
  guard_ms: 'Admission: the per-turn cost that lets the processor leg reconcile.',
  placeholder_resolve_ms: 'What locating the message to answer on cost, and what a handshake regression moves.',
  poll_ms: 'The fallback scan only. Read as a rate beside its count, which the section is where a reader learns.',
  processor_tail_ms: 'The residual that closes the processor leg, derived rather than stamped.',
  answer_ms: 'Placeholder to final answer, per response, on the audit surface.',
  unattributed_ms: 'The reconciliation residual a negative value of is a finding, so it needs to say so.',
  overhead_ms: 'Worker compute the model loop and the scan do not explain, per response.',
};

/** Columns returned by `fn`, read from the `columns:` contract the function itself returns. */
function columnsReturnedBy(fn: string): string[] {
  const sf = ts.createSourceFile('analytics-query.ts', QUERY_SRC, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const collect = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node)
        && ts.isIdentifier(node.name) && node.name.text === 'columns'
        && ts.isArrayLiteralExpression(node.initializer)) {
      for (const el of node.initializer.elements) {
        if (ts.isStringLiteral(el)) out.push(el.text);
      }
    }
    ts.forEachChild(node, collect);
  };
  const find = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === fn) collect(node);
    else ts.forEachChild(node, find);
  };
  find(sf);
  return out;
}

/** The aggregate prefixes a metric column wears on its way to a card. */
const AGGREGATE = /^(avg|p50|p95|p99|min|max)_/;

/** The metric a column reports, with its aggregate prefix and any alias resolved. */
function metricOf(column: string): string {
  const base = column.replace(AGGREGATE, '');
  return SAME_METRIC_AS[base]?.base ?? base;
}

/** The "Metric definitions" chapter, ending at the next `##` heading. */
function metricChapter(): string {
  const start = DOC.indexOf('\n## Metric definitions');
  if (start === -1) return '';
  const rest = DOC.slice(start + 1);
  const end = rest.indexOf('\n## ', 1);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The chapter's `###` sections, heading included, so a heading alone cannot satisfy a body check. */
function sections(chapter: string): string[] {
  return chapter.split(/\n(?=### )/).filter((s) => s.startsWith('### '));
}

describe('every latency metric the console shows has a definition in LATENCY-TARGETS', () => {
  const chapter = metricChapter();
  const all = sections(chapter);

  // Asserted as its own case: a renamed chapter should fail once, readably, rather than silently
  // emptying every check below into a pass over an empty string.
  it('finds the metric-definitions chapter, so nothing below passes by reading nothing', () => {
    expect(chapter).not.toBe('');
    expect(all.length).toBeGreaterThanOrEqual(12);
  });

  it.each(Object.keys(LATENCY_READ_PATHS))('%s returns metric columns this guard can see', (fn) => {
    // The columns are parsed out of the source. A rename or a refactor that moves the contract out of
    // the function would otherwise leave this suite green while checking nothing at all.
    const cols = columnsReturnedBy(fn);
    expect(cols.length).toBeGreaterThan(3);
    expect(cols.filter((c) => c.endsWith('_ms')).length).toBeGreaterThan(0);
  });

  it('every `*_ms` column those three read paths return resolves to a documented metric', () => {
    const undocumented: string[] = [];
    for (const fn of Object.keys(LATENCY_READ_PATHS)) {
      for (const col of columnsReturnedBy(fn).filter((c) => c.endsWith('_ms'))) {
        if (!DEFINED_IN_THE_METRIC_CHAPTER[metricOf(col)]) {
          undocumented.push(`${fn} -> ${col} (metric \`${metricOf(col)}\`)`);
        }
      }
    }
    // The failure has to say what to do, or the next person deletes the column from the list.
    expect(undocumented).toEqual([]);
  });

  it('every documented metric has a `###` section whose heading names it', () => {
    const missing: string[] = [];
    for (const metric of Object.keys(DEFINED_IN_THE_METRIC_CHAPTER)) {
      const section = all.find((s) => s.split('\n')[0].includes(metric));
      if (!section) {
        missing.push(
          `\`${metric}\`: add a "### " section to the "Metric definitions" chapter of `
          + 'docs/guides/developer/LATENCY-TARGETS.md naming the column in its heading, in the same '
          + 'shape as its siblings (what it means, what it is read from, what NULL means, which '
          + 'surface shows it). Reason it is required: '
          + DEFINED_IN_THE_METRIC_CHAPTER[metric],
        );
        continue;
      }
      // A heading with nothing under it is a worse answer than no heading, because it reads as one.
      if (section.length < 300) missing.push(`\`${metric}\`: the section exists but has no definition under it`);
    }
    expect(missing).toEqual([]);
  });

  /**
   * THE SUBSET RELATIONSHIP, IN BOTH DIRECTIONS.
   *
   * These two sections are the pair that misled: TTFF said a rebuttal has no figure, `ack_ms` had no
   * section to carry the one it does have. Either section read alone has to lead to the other, so
   * neither is checked for its own existence here alone.
   */
  it('TTFF and ack_ms each name the other, so neither section can be read alone and mislead', () => {
    const ttff = all.find((s) => s.split('\n')[0].includes('ttff_ms'));
    const ack = all.find((s) => s.split('\n')[0].includes('ack_ms'));
    expect(ttff).toBeDefined();
    expect(ack).toBeDefined();
    expect(ttff).toContain('ack_ms');
    expect(ttff).toMatch(/subset/i);
    expect(ack).toContain('ttff_ms');
    expect(ack).toMatch(/subset/i);
  });

  /**
   * THE ANCHOR IS THE HALF A READER CANNOT GUESS. `ack_ms` is only meaningful with the instant it is
   * measured from, and that instant is DECLARED by the producer or reconstructed - a distinction the
   * view carries in `ack_source` and the section has to carry too, or the number reads as one figure
   * with one provenance.
   */
  it('the ack_ms section states where its anchor comes from', () => {
    const ack = all.find((s) => s.split('\n')[0].includes('ack_ms')) ?? '';
    expect(ack).toContain('ack_source');
    expect(ack).toContain('declared');
    expect(ack).toContain('derived');
    // The rebuttal is the case the whole metric exists for, and the anchor choice is the part a
    // reader would otherwise get wrong: the rival's completion, not the user's /battle message.
    expect(ack).toMatch(/rebuttal/i);
    expect(ack).toContain('triggerAtMs');
  });
});
