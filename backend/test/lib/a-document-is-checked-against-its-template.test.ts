/**
 * THE DELIVERY CHECK COMPARES A DOCUMENT TO ITS TEMPLATE BY STRUCTURE (SPEC-DOCUMENT-TEMPLATES FR6).
 *
 * Required sections present and in order, by position and heading level; each declared table present
 * with its column count. Never by heading text (tenet D11): a document written in the conversation's
 * language passes, and heading-text agreement is only measured. A miss is a fault the bounded correction
 * is asked to fix, naming what is missing.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseTemplate, checkAgainstTemplate, describeMissingStructure } from '../../lambda/src/lib/document-template';
import { deliverableIssues, correctionProgressLine } from '../../lambda/src/lib/deliverable-check';

const TEMPLATE = parseTemplate(readFileSync(join(__dirname, '..', '..', 'demo', 'templates', 'quarterly-account-review.md'), 'utf8'));

const ENGLISH = `# Quarterly account review: Coastal Health, Q3

## Summary

Coastal Health grew ARR 12% this quarter. Renewal risk is concentrated in one region.

## Metrics

| Metric | Previous quarter | This quarter | Change |
|---|---|---|---|
| ARR | $1.2M | $1.34M | +12% |
| NRR | 104% | 108% | +4 pts |

## Risks

The northern region has not renewed its support contract.

## Next steps

- Schedule the renewal review with the regional lead.
`;

// The same document in Spanish: every heading's text differs, and the structure is the template's.
const SPANISH = `# Revisión trimestral de la cuenta: Coastal Health, T3

## Resumen

Coastal Health aumentó su ARR un 12 % este trimestre.

## Métricas

| Métrica | Trimestre anterior | Este trimestre | Cambio |
|---|---|---|---|
| ARR | 1,2 M$ | 1,34 M$ | +12 % |

## Próximos pasos

- Programar la revisión de renovación.
`;

describe('a document is checked against its template by structure', () => {
  it('passes a document that carries every section in order', () => {
    const check = checkAgainstTemplate(ENGLISH, TEMPLATE);
    expect(check.passed).toBe(true);
    expect(check.missing).toEqual([]);
    expect(check.headingTextAgreement).toBeLessThan(1); // the title carries the account name
  });

  it('passes a TRANSLATED document, and only the shadow metric sees the different words', () => {
    const check = checkAgainstTemplate(SPANISH, TEMPLATE);
    expect(check.passed).toBe(true);
    expect(check.headingTextAgreement).toBe(0);
    expect(deliverableIssues(SPANISH, null, { template: TEMPLATE })).toEqual([]);
  });

  it('lets an optional section be absent without shifting a required one onto the wrong heading', () => {
    const withoutRisks = ENGLISH.replace(/## Risks\n\n.*\n\n/, '');
    expect(checkAgainstTemplate(withoutRisks, TEMPLATE).passed).toBe(true);
  });

  it('accepts a section the template does not have, between the ones it does', () => {
    const extra = ENGLISH.replace('## Next steps', '## Appendix\n\nNotes.\n\n## Next steps');
    expect(checkAgainstTemplate(extra, TEMPLATE).passed).toBe(true);
  });

  it('names a missing required section by position and level', () => {
    // Only the title and the closing section: the summary and the metrics are both gone.
    const check = checkAgainstTemplate('# Quarterly account review\n\n## Next steps\n\n- Renew.\n', TEMPLATE);
    expect(check.passed).toBe(false);
    expect(check.missing).toContainEqual({ kind: 'section', position: 2, level: 2, heading: 'Summary' });
  });

  it('fails when the sections that remain cannot carry what the template places in them', () => {
    // Three required level-2 sections, two level-2 headings left: no alignment satisfies it.
    const noSummary = ENGLISH.replace(/## Summary\n\n.*\n\n/, '').replace(/## Risks\n\n.*\n\n/, '');
    const check = checkAgainstTemplate(noSummary, TEMPLATE);
    expect(check.passed).toBe(false);
    expect(check.missing.length).toBeGreaterThan(0);
  });

  it('names a table whose column count is wrong', () => {
    const threeColumns = ENGLISH
      .replace('| Metric | Previous quarter | This quarter | Change |', '| Metric | This quarter | Change |')
      .replace('|---|---|---|---|', '|---|---|---|')
      .replace('| ARR | $1.2M | $1.34M | +12% |', '| ARR | $1.34M | +12% |')
      .replace('| NRR | 104% | 108% | +4 pts |', '| NRR | 108% | +4 pts |');
    const check = checkAgainstTemplate(threeColumns, TEMPLATE);
    expect(check.passed).toBe(false);
    expect(check.missing).toContainEqual(expect.objectContaining({ kind: 'table', position: 3, columns: 4 }));
  });

  it('fails a document whose sections are out of order by level', () => {
    // The title demoted below a section: the level-1 heading is no longer first.
    const reordered = ENGLISH.replace('# Quarterly account review: Coastal Health, Q3\n\n', '').concat('\n# Quarterly account review\n');
    expect(checkAgainstTemplate(reordered, TEMPLATE).passed).toBe(false);
  });

  it('never decides by heading text: renaming every heading changes nothing', () => {
    const renamed = ENGLISH.replace(/^(#+) .*$/gm, (_m, hashes: string) => `${hashes} Zzz`);
    expect(checkAgainstTemplate(renamed, TEMPLATE).passed).toBe(true);
  });

  it('becomes a correction fault naming the missing structure, and posts a progress line', () => {
    const bare = '# Quarterly account review\n\nNothing else.\n';
    const issues = deliverableIssues(bare, null, { template: TEMPLATE });
    expect(issues.map((i) => i.kind)).toEqual(['template_structure']);
    expect(issues[0].fix).toContain('"quarterly-account-review" template');
    expect(issues[0].fix).toContain('a level-2 heading');
    expect(issues[0].fix).toContain('conversation\'s language');
    expect(correctionProgressLine(issues, null)).toBe('Fitting the document to its template...');
    expect(describeMissingStructure([{ kind: 'table', position: 3, level: 2, heading: 'Metrics', columns: 4 }], 'q'))
      .toMatch(/the 4-column table in section 3/);
  });

  it('adds nothing for a document with no template', () => {
    expect(deliverableIssues(ENGLISH, null, {})).toEqual([]);
  });
});
