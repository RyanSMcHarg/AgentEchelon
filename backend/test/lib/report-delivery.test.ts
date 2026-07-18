/**
 * isDeliverableDocument — the DETERMINISTIC gate for attaching a document-producing task's output
 * (report_generation OR data_extraction) as a downloadable file. Keyed on the OUTPUT (substantial +
 * structured), not the task's non-deterministic machine state. Guards both directions: a full report
 * or a formatted extraction IS delivered; a short clarifying/outline turn is NOT (the original
 * "clarifying text saved as a file" bug).
 */
import { isDeliverableDocument } from '../../lambda/src/lib/async-processor-core';

// A realistic full report the model produces on the delivery turn (live-verified shape).
const FULL_REPORT = `Here's your full report, delivered as a downloadable Markdown file:

# Monorepo vs. Multi-Repo: Decision Brief for Engineering Leadership

**Audience:** Engineering Leadership | **Org context:** 5 teams

## Executive Summary

This brief evaluates monorepo and multi-repo strategies across delivery velocity, code
ownership, and CI cost. Neither approach is universally superior; the right choice depends
on team autonomy and tooling maturity.

## Delivery Velocity

- Monorepo: atomic cross-team changes, one CI graph, simpler refactors.
- Multi-repo: independent release cadence, smaller blast radius per change.

## CI Cost

Monorepos need selective builds to stay affordable at 5 teams; multi-repo cost scales with
duplicated pipelines. Recommendation: start monorepo with affected-target CI.`;

describe('isDeliverableDocument', () => {
  it('delivers a full, structured report document', () => {
    expect(isDeliverableDocument(FULL_REPORT)).toBe(true);
  });

  it('delivers a report whose structure is a markdown table', () => {
    const withTable = 'Here is the comparison you asked for, summarizing the two repository approaches '
      + 'across the dimensions that matter most for a five-team engineering organisation so that '
      + 'leadership can weigh the trade-offs and make the call quickly. Each row captures the '
      + 'practical difference our teams would feel day to day, and the closing note gives a '
      + 'recommendation grounded in our current tooling maturity and release cadence.\n\n'
      + '| Dimension | Monorepo | Multi-repo |\n'
      + '| --- | --- | --- |\n'
      + '| Velocity | Atomic cross-team changes | Independent release cadence |\n'
      + '| CI cost | Needs selective builds to stay affordable | Duplicated pipelines per repo |\n'
      + '| Ownership | Shared conventions, one graph | Clear per-team boundaries |\n\n'
      + 'Recommendation: start monorepo with affected-target CI, revisit if team autonomy needs grow.';
    expect(withTable.length).toBeGreaterThan(500);
    expect(isDeliverableDocument(withTable)).toBe(true);
  });

  it('delivers a formatted data extraction (the table an extraction task produces)', () => {
    const extraction = 'Here are the enterprise accounts currently flagged as churn risk, pulled from '
      + 'the customer records with their ARR, renewal date, and the reason each is at risk so the team '
      + 'can prioritise outreach this quarter before the renewals come due.\n\n'
      + '| Account | ARR | Renewal | Risk reason |\n'
      + '| --- | --- | --- | --- |\n'
      + '| Coastal Health Systems | $155K | 2026-09-30 | Evaluating a competitor |\n'
      + '| Meridian Corp | $210K | 2026-08-15 | Low product adoption |\n'
      + '| Apex Manufacturing | $98K | 2026-10-01 | Executive sponsor left |\n';
    expect(isDeliverableDocument(extraction)).toBe(true);
  });

  it('does NOT deliver a short clarifying question (the original bug)', () => {
    const clarifying = 'To ensure the report meets your needs, who is the audience and what '
      + 'metrics should it include?';
    expect(isDeliverableDocument(clarifying)).toBe(false);
  });

  it('does NOT deliver a brief follow-up saved as a file (the exact reported symptom)', () => {
    const followup = 'Sure — want me to adjust the tone or add a recommendation section?';
    expect(isDeliverableDocument(followup)).toBe(false);
  });

  it('does NOT deliver a short outline-for-approval', () => {
    const outline = '## Proposed outline\n- Executive summary\n- Delivery velocity\n- CI cost\n\nWant me to adjust the structure?';
    expect(isDeliverableDocument(outline)).toBe(false);
  });

  it('does NOT deliver a long unstructured prose blob (no headings/table/list)', () => {
    const prose = 'x'.repeat(900);
    expect(isDeliverableDocument(prose)).toBe(false);
  });

  it('is null/undefined-safe', () => {
    expect(isDeliverableDocument(null)).toBe(false);
    expect(isDeliverableDocument(undefined)).toBe(false);
    expect(isDeliverableDocument('')).toBe(false);
  });
});
