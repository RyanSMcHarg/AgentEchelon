/**
 * A TEMPLATE IS A MARKDOWN DOCUMENT WHOSE HEADINGS ARE ITS SECTIONS (SPEC-DOCUMENT-TEMPLATES FR1).
 *
 * The parser turns a template into the outline every later step reads: sections by level and position,
 * required or optional, each with its guidance and the column count of each table under it. A template
 * that could not be checked against is refused when it is parsed, with what is wrong named, so it is
 * never discovered at a delivery.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseTemplate, renderTemplateGuidance, renderTemplateChoice, TemplateParseError } from '../../lambda/src/lib/document-template';

const EXAMPLE = readFileSync(join(__dirname, '..', '..', 'demo', 'templates', 'quarterly-account-review.md'), 'utf8');

const tpl = (front: Record<string, unknown>, body: string) => `---\n${JSON.stringify(front)}\n---\n${body}`;

describe('a template parses to its outline', () => {
  it('reads the shipped example: sections in order, levels, optionality, guidance and table columns', () => {
    const t = parseTemplate(EXAMPLE);
    expect(t.name).toBe('quarterly-account-review');
    expect(t.description).toMatch(/quarterly review/);
    expect(t.sections.map((s) => [s.level, s.heading, s.optional])).toEqual([
      [1, 'Quarterly account review', false],
      [2, 'Summary', false],
      [2, 'Metrics', false],
      [2, 'Risks', true],
      [2, 'Next steps', false],
    ]);
    const metrics = t.sections[2];
    expect(metrics.tables).toEqual([4]);
    expect(metrics.tableHeaders[0]).toEqual(['Metric', 'Previous quarter', 'This quarter', 'Change']);
    expect(metrics.guidance).toMatch(/not available/);
    // Guidance lives in the front matter, never in the body a document is checked against.
    expect(t.body).not.toMatch(/guidance/i);
  });

  it('skips headings inside a fenced block', () => {
    const t = parseTemplate(tpl({ name: 'x', description: 'd' }, '# Title\n\n```\n# not a section\n```\n\n## Body\n'));
    expect(t.sections.map((s) => s.heading)).toEqual(['Title', 'Body']);
  });

  it.each([
    ['no front matter', '# Title\n', /front-matter block/],
    ['front matter that is not JSON', '---\nname: x\n---\n# T\n', /not a JSON object/],
    ['a bad name', tpl({ name: 'Bad Name', description: 'd' }, '# T\n'), /not a template name/],
    ['no description', tpl({ name: 'x' }, '# T\n'), /no `description`/],
    ['no headings', tpl({ name: 'x', description: 'd' }, 'just prose\n'), /no sections/],
    ['a table before the first heading', tpl({ name: 'x', description: 'd' }, '| a | b |\n|---|---|\n# T\n'), /before its first heading/],
    ['a sections key naming no heading', tpl({ name: 'x', description: 'd', sections: { Nope: {} } }, '# T\n'), /not a heading/],
    ['every section optional', tpl({ name: 'x', description: 'd', sections: { T: { optional: true } } }, '# T\n'), /no required section/],
    // A tool binding names the state whose action recorded the result AND a path inside it.
    ['a tool binding with no path', tpl({ name: 'x', description: 'd', fill: 'platform', fields: { a: 'tool:crm' } }, '# T\n{{a}}\n'), /tool:<state>.<path>/],
    ['a binding of an unknown kind', tpl({ name: 'x', description: 'd', fill: 'platform', fields: { a: 'crm:total' } }, '# T\n{{a}}\n'), /a binding is/],
    ['an undeclared placeholder', tpl({ name: 'x', description: 'd', fill: 'platform', fields: {} }, '# T\n{{a}}\n'), /no binding/],
  ])('refuses %s, naming it', (_label, source, message) => {
    expect(() => parseTemplate(source)).toThrow(TemplateParseError);
    expect(() => parseTemplate(source)).toThrow(message);
  });
});

describe('the template is rendered into the step guidance (FR5)', () => {
  it('names each section by position and level, its tables and its guidance, and says the language is the conversation\'s', () => {
    const loaded = { name: 'quarterly-account-review', contentHash: 'a'.repeat(64), template: parseTemplate(EXAMPLE) };
    const g = renderTemplateGuidance(loaded);
    expect(g).toContain('## DOCUMENT TEMPLATE: quarterly-account-review (aaaaaaaaaaaa)');
    expect(g).toContain('3. `##` level-2 heading (the template calls it "Metrics")');
    expect(g).toContain('a table with exactly 4 columns (Metric | Previous quarter | This quarter | Change)');
    expect(g).toContain('(the template calls it "Risks"), optional');
    expect(g).toMatch(/conversation's language/);
    expect(g).toMatch(/never appears in the document/);
  });

  it('tells the model a platform-filled document is not its to write', () => {
    const t = parseTemplate(tpl({ name: 'x', description: 'd', fill: 'platform', fields: { a: 'detail:a' } }, '# T\n{{a}}\n'));
    expect(renderTemplateGuidance({ name: 'x', contentHash: 'b'.repeat(64), template: t })).toMatch(/platform fills this document/);
  });

  it('lists each format with its description while nobody has chosen, and states the default', () => {
    const a = { name: 'a', contentHash: 'c'.repeat(64), template: parseTemplate(tpl({ name: 'a', description: 'The full one' }, '# T\n')) };
    const b = { name: 'b', contentHash: 'd'.repeat(64), template: parseTemplate(tpl({ name: 'b', description: 'One page' }, '# T\n')) };
    const open = renderTemplateChoice([a, b], 'a', undefined);
    expect(open).toContain('- `a`: The full one');
    expect(open).toContain('- `b`: One page');
    expect(open).toMatch(/`a` is used: say so as one of the requirements/);
    expect(renderTemplateChoice([a, b], undefined, undefined)).toMatch(/Do not advance until they have chosen/);
    expect(renderTemplateChoice([a, b], 'a', 'b')).toMatch(/chose the format `b`/);
  });
});
