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

  // A LONG, well-formatted requirements questionnaire clears the old structural bar (>500 chars,
  // >=4 list items, >=800 chars) even though it is ASKING, not delivering. Live-verified on the
  // standard classification: this exact shape was uploaded as report-*.md AND completed the task
  // while it was still collecting requirements, because completeOnDelivery keys on this gate.
  const REQUIREMENTS_QUESTIONNAIRE = `Hi Demo, let's start by gathering the requirements for your `
    + `report on the pros and cons of a monorepo versus multi-repo for a 5-team organization. `
    + `Please provide the following details so the report lands where you need it:\n\n`
    + `1. Audience: is this for engineering leadership, the platform team, or a wider org readout?\n`
    + `2. Scope: should it cover build tooling and CI cost, or only repository structure?\n`
    + `3. Current state: how are the five teams' repositories organised today, and what hurts most?\n`
    + `4. Constraints: are there compliance, release-cadence, or tooling constraints I should honour?\n`
    + `5. Length and format: a one-page brief, or a fuller document with appendices?\n`
    + `6. Decision timeline: when do you need to make the call, and who signs off on it?\n\n`
    + `Once I have these I will draft the outline for your approval before writing the full report.`;

  it('does NOT deliver a long requirements questionnaire (live standard-classification bug)', () => {
    // Guard the premise: it clears every structural bar, so only the intent veto can reject it.
    expect(REQUIREMENTS_QUESTIONNAIRE.length).toBeGreaterThan(800);
    expect((REQUIREMENTS_QUESTIONNAIRE.match(/(^|\n)\s*(?:[-*]\s+|\d+\.\s+)\S/g) || []).length)
      .toBeGreaterThanOrEqual(4);
    expect(isDeliverableDocument(REQUIREMENTS_QUESTIONNAIRE)).toBe(false);
  });

  it('does NOT deliver a long bulleted question list with no heading and no table', () => {
    // Exercises the SECOND signal specifically: no recognised solicitation opener, so only the
    // "several questions in a body with no heading and no table" clause can reject it. It clears
    // the list-only structural branch, so without that clause it would be delivered as a file.
    const questions = 'Thanks for the request. The shape of this document changes a lot depending '
      + 'on scope and audience, and getting that wrong wastes a draft, so it is worth settling a '
      + 'handful of points up front before any substantial writing happens for the five teams:\n\n'
      + '- Who is the primary audience, and what decision are they actually trying to make?\n'
      + '- How deep should the CI cost modelling go, given most readers will skim that section?\n'
      + '- Is there an existing internal standard or earlier write-up this should build on?\n'
      + '- What is the deadline, and who ultimately signs off on the recommendation?\n'
      + '- Should the recommendation be a single call, or a set of options with trade-offs?\n\n'
      + 'Answering these turns the draft from a generic topic overview into something specific to '
      + 'how the teams actually work today, which is the difference between a document that gets '
      + 'used in the decision and one that gets skimmed once and quietly forgotten afterwards.';
    // Guard the premise: it clears the structural bar the old gate used.
    expect(questions.length).toBeGreaterThan(800);
    expect((questions.match(/(^|\n)\s*(?:[-*]\s+|\d+\.\s+)\S/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(/(^|\n)#{1,6}\s+\S/.test(questions)).toBe(false);
    expect(isDeliverableDocument(questions)).toBe(false);
  });

  it('still delivers a report that merely MENTIONS a solicitation phrase in its body', () => {
    // The veto is scoped to the OPENING window on purpose: a finished report may sign off with
    // "let me know" without becoming a questionnaire. A body-anywhere match would drop real files.
    const reportWithSignoff = FULL_REPORT + '\n\nIf you want the CI cost section expanded with our '
      + 'actual pipeline numbers, let me know and I will fold them into a second revision.';
    expect(isDeliverableDocument(reportWithSignoff)).toBe(true);
  });
});
