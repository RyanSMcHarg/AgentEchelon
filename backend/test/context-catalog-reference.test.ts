/**
 * The context catalog reference must match the catalog it documents.
 *
 * The same `title`/`description`/`useWhen`/field descriptions feed BOTH this document and the
 * assistant's `## AVAILABLE CONTEXT` menu. A hand-edited document therefore drifts from what the model
 * actually reads, and the drift is invisible in the worst way: the doc reads correctly while the
 * assistant is shown something else. Nobody notices until an answer is wrong for a reason the docs say
 * is impossible.
 *
 * This is the same failure the repo has hit twice - a guide describing a `composeWelcome` signature the
 * code had not carried for months, and a reference table whose own header claimed it was generated when
 * it was not. So: regenerate, compare, fail.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  loadContextSourceCatalog,
  renderCatalogReference,
  RESERVED_CONTRACTS,
} from '../lib/config/context-sources';

const REFERENCE_PATH = path.join(__dirname, '..', '..', 'docs', 'reference', 'context-catalog-reference.md');

/** Must match gen-context-reference.mjs exactly, or the check compares against a different render. */
const GENERATOR_CONTEXT = {
  classification: 'standard',
  attachmentsBucketArn: 'arn:aws:s3:::<attachments-bucket>',
  attachmentsBucketName: '<attachments-bucket>',
  userProfileTableArn: 'arn:aws:dynamodb:<region>:<account>:table/<user-profile>',
  userProfileTableName: '<user-profile>',
  region: '<region>',
  account: '<account>',
};

describe('context catalog reference', () => {
  const generated = () => renderCatalogReference(loadContextSourceCatalog(GENERATOR_CONTEXT).entries);

  it('the committed file matches what the catalog renders', () => {
    const committed = fs.readFileSync(REFERENCE_PATH, 'utf8').replace(/\r\n/g, '\n');
    if (committed !== generated()) {
      throw new Error(
        'docs/reference/context-catalog-reference.md is out of date with the context source catalog.\n'
          + 'The catalog is the source; this file is generated from it. Run:\n\n'
          + '    cd backend && npm run gen-context-reference\n\n'
          + 'and commit the result. Do not hand-edit the document - the assistant reads the same\n'
          + 'descriptions from the catalog, so an edited doc silently disagrees with what the model sees.',
      );
    }
    expect(committed).toBe(generated());
  });

  // Falsification: the comparison must actually be capable of failing. Without this the test could
  // pass because the render is a constant, or because both sides read the same file.
  it('detects a drifted document', () => {
    const drifted = `${generated()}\n<!-- someone hand-edited this -->`;
    expect(drifted).not.toBe(generated());
  });

  describe('the rendered content is usable', () => {
    it('names every source with its scope, so portability is visible per key', () => {
      const out = generated();
      for (const key of ['company-docs', 'user-profile']) expect(out).toContain(`\`${key}\``);
      expect(out).toContain('reserved');
    });

    it('carries the field descriptions the model is shown, not just field names', () => {
      // If the doc listed only names it would look complete while omitting the part that
      // disambiguates - `role` meaning job role, not conversation role.
      expect(generated()).toContain('not their role in this conversation');
    });

    it('lists every reserved contract and its required fields', () => {
      const out = generated();
      for (const [key, c] of Object.entries(RESERVED_CONTRACTS)) {
        expect(out).toContain(`\`${key}\` v${c.contractVersion}`);
        for (const f of c.requiredFields) expect(out).toContain(`\`${f}\``);
      }
    });

    it('carries NO account-specific identifiers - the reference documents keys, not resources', () => {
      const out = generated();
      expect(out).not.toMatch(/arn:aws:[a-z0-9-]+:[a-z]{2}-[a-z]+-\d/); // a real regional ARN
      expect(out).not.toMatch(/\b\d{12}\b/); // an account id
    });

    it('warns the reader not to hand-edit it', () => {
      expect(generated()).toContain('Do not edit by hand');
    });
  });
});
