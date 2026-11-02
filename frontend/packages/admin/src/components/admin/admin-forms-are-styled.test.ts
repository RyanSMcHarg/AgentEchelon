/**
 * A FORM CONTROL IN THE CONSOLE IS STYLED BY THE STYLESHEET, NOT BY AN INLINE FONT SIZE.
 *
 * Reported as "the assistants configuration has small text and is not properly styled". The persona
 * textarea carried `fontSize: '0.85em'` inline. Two things made that worse than it sounds:
 *
 *   - inline styles outrank the stylesheet, so the rule that sizes every other control lost; and
 *   - `em` resolved against the LABEL, which `.admin-form-grid` deliberately sets to --text-xs (11px)
 *     so a field caption reads as a caption.
 *
 * 0.85 x 11px is about 9px, next to a 14px field directly above it. A relative unit under a rule that
 * shrinks its parent compounds, and nothing about the value 0.85 tells you that.
 *
 * These are SOURCE assertions. jsdom does not apply a stylesheet, so a render test cannot see a
 * computed font size - it would pass whatever the CSS said. What can be checked is the thing that
 * actually went wrong: a hardcoded size at the call site, and a control with no class relying on a
 * fallback selector that misses half the input types.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const HERE = __dirname;
const read = (f: string) => fs.readFileSync(path.join(HERE, f), 'utf8');

const profiles = read('ProfilesTab.tsx');
/** The assistant's page, which holds the external links the tab's page used to. */
const page = read('AssistantPage.tsx');
/** The draft's controls, one area at a time: where the assistant's form fields now live. */
const draftFields = read('DraftAreaFields.tsx');
const groundTruth = read('GroundTruthTab.tsx');
const css = read('AdminDashboard.css');

/** Files whose forms have been brought onto the shared primitives. */
const CLEANED = [
  ['ProfilesTab.tsx', profiles],
  ['DraftAreaFields.tsx', draftFields],
  ['GroundTruthTab.tsx', groundTruth],
] as const;

describe('no control sizes itself at the call site', () => {
  it.each(CLEANED)('%s carries no inline font-size', (_name, source) => {
    // Any inline size is wrong here, not just a relative one: it defeats the stylesheet either way.
    // The message is what a future reader needs, because the fix is never "make the number bigger".
    const hits = source.match(/fontSize:\s*['"][^'"]+['"]/g) ?? [];
    expect(hits, `use a class; an inline size beats the stylesheet and compounds under .admin-form-grid`).toEqual([]);
  });
});

describe('the assistants configuration uses the shared primitives', () => {
  it('gives the persona textarea the shared classes rather than a bare element', () => {
    expect(draftFields).toContain("const PERSONA_INPUT = ['textarea', 'input', 'profiles-persona-input'].join(' ');");
    expect(draftFields).toContain('className={PERSONA_INPUT}');
  });

  it('gives the assistant-name input the shared class', () => {
    expect(draftFields).toMatch(/type="text"\s*className="input"\s*data-testid="draft-name"/);
  });

  it('classes every select, including the per-intent routing pair', () => {
    // The models are edited in Scope and models on the page: one select for the classifier or the default model
    // (`ModelChoice`), a primary + fallback pair on each intent card (its text and image models share one pair), and an
    // override per workflow step (ADR-064). `.select` stands alone (DESIGN-SYSTEM).
    expect((page.match(/<select\b/g) ?? []).length).toBe(4);
    expect((page.match(/<select [^>]*className="select"/g) ?? []).length).toBe(4);
    expect(draftFields).not.toMatch(/<select\b/);
  });

  it('sizes the persona from the stylesheet and keeps only what is the field own business', () => {
    // Monospace and resizable are properties of THIS field. Its size is not - that belongs to .input,
    // which is the rule the inline style used to beat.
    const rule = css.slice(css.indexOf('.profiles-persona-input'));
    expect(rule).toContain('font-family: var(--font-mono)');
    expect(rule).toContain('resize: vertical');
    expect(rule.slice(0, rule.indexOf('}'))).not.toContain('font-size');
  });
});

describe('the field rule covers every input type, not the ones somebody happened to use', () => {
  it('no longer enumerates text and untyped inputs, which missed number and checkbox', () => {
    // `type="number"` matched neither `input[type="text"]` nor `input:not([type])`, so the Ground
    // Truth score field fell through to a raw browser default - a white box on a dark theme.
    expect(css).not.toContain('.admin-form-grid input[type="text"],');
    expect(css).not.toContain('.admin-form-grid input:not([type]),');
  });

  it('styles every input except those that carry their own appearance', () => {
    expect(css).toContain(
      '.admin-form-grid input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"])',
    );
  });

  it('themes the checkbox rather than leaving it browser-default blue', () => {
    const rule = css.slice(css.indexOf('.admin-form-grid input[type="checkbox"]'));
    expect(rule).toContain('accent-color: var(--accent-500)');
  });
});

describe('uppercase is a label treatment and never reaches content', () => {
  it('opts code, table cells and prose back out of the container transform', () => {
    // The container uppercases so a field caption reads as a caption, and direct-child controls reset
    // it. Anything nested deeper inherited it, so tool names and intent identifiers - literal
    // snake_case strings a person types elsewhere - rendered as LOAD_COMPANY_CONTEXT. The console was
    // showing a different string from the one the system uses, which is a correctness bug wearing a
    // styling costume.
    const at = css.indexOf('.admin-form-grid code,');
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf('}', at));
    expect(rule).toContain('.admin-form-grid td');
    expect(rule).toContain('.admin-form-grid th');
    expect(css.slice(at)).toContain('text-transform: none');
  });

  it('renders tool names in a code element, so that opt-out actually reaches them', () => {
    // The rule above is only worth anything if the markup uses the element it names.
    expect(draftFields).toContain('<code>{tool.name}</code>');
  });
});

describe('a size is a token, never a ratio of whatever it landed in', () => {
  it('uses no relative font-size anywhere in the admin stylesheets', () => {
    // `em` compounds. The same `font-size: 0.85em` rule produced roughly 11px in a section, 9px inside
    // a field label (which .admin-form-grid sets to 11px on purpose) and something else again inside a
    // chip within a label - one rule, three sizes, none of them chosen. The tokens are the whole
    // point of having a scale.
    const sheets = ['AdminDashboard.css', 'UserManagementTab.css', 'DataTable.css', 'AdminHelp.css'];
    for (const name of sheets) {
      let css: string;
      try {
        css = read(name);
      } catch {
        continue; // a stylesheet that no longer exists is not a finding for this test
      }
      // Strip comments first: the rules above EXPLAIN the old value, and a whole-file match would hit
      // the explanation and fail on a correct stylesheet - a trap this suite has fallen into before.
      const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const relative = rules.match(/font-size:\s*[0-9.]+em\b/g) ?? [];
      expect(relative, `${name} sizes text relative to its container`).toEqual([]);
    }
  });

  it('gives the read-only configuration panel an explicit size', () => {
    // It is the view an operator lands on when opening an assistant, and it used to inherit whatever
    // an ancestor happened to set. It shows the same fields as the draft editor, so it reads at the
    // same size - two different sizes make one assistant look like two kinds of object.
    const at = css.indexOf('.admin-config-list {');
    expect(at, '.admin-config-list must set its own size').toBeGreaterThan(-1);
    expect(css.slice(at, css.indexOf('}', at))).toContain('font-size: var(--text-md)');
  });
});

describe('outbound links are consistently safe', () => {
  it('pairs noopener with noreferrer on every external anchor', () => {
    // One anchor had `rel="noreferrer"` alone. Modern browsers imply noopener from it, so this was
    // never exploitable - it is pinned because the inconsistency is what makes a reviewer stop and
    // work out whether THIS one was deliberate.
    for (const source of [profiles, page]) {
      expect(source).not.toMatch(/rel="noreferrer"/);
      const blanks = (source.match(/target="_blank"/g) ?? []).length;
      const rels = (source.match(/rel="noopener noreferrer"/g) ?? []).length;
      expect(rels).toBe(blanks);
    }
    // The page opens every AWS console page through DocLink, which carries the pair once for the whole console.
    expect(page).toMatch(/<DocLink href=/);
  });
});
