/**
 * EVERY DECISION RECORD'S HEADER IS VALID YAML.
 *
 * The header above an ADR is read by anything that renders or indexes the decisions, so a status that
 * a strict YAML reader rejects makes the whole record unreadable to it. A colon inside a plain scalar
 * is the usual cause; a folded block (`status: >-`) carries any text.
 */
import * as fs from 'fs';
import * as path from 'path';
// A strict YAML reader the test tree already carries (through ts-jest); a missing reader fails the suite.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml: { load(text: string): unknown } = require('js-yaml');

const DECISIONS = path.resolve(__dirname, '..', '..', 'docs', 'design', 'decisions');

const records = fs.readdirSync(DECISIONS).filter((n) => /^\d{3}-.*\.md$/.test(n));

describe('decision record headers', () => {
  it('finds the decision records', () => {
    expect(records.length).toBeGreaterThan(50);
  });

  it.each(records)('%s has a header a strict YAML reader parses, with a title and a status', (name) => {
    const text = fs.readFileSync(path.join(DECISIONS, name), 'utf8');
    const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(header).not.toBeNull();
    const parsed = yaml.load(header![1]) as Record<string, unknown>;
    expect(typeof parsed.title).toBe('string');
    expect(typeof parsed.status).toBe('string');
  });
});
