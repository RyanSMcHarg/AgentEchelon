#!/usr/bin/env node
/**
 * Regenerate the context catalog reference from the catalog itself.
 *
 *   npm run gen-context-reference
 *
 * The catalog entries are the single source for both this document and the assistant's
 * `## AVAILABLE CONTEXT` menu. Hand-maintaining the document lets the two disagree, and the
 * disagreement is invisible: the doc reads correctly while the model is shown something else.
 * `context-catalog-reference.test.ts` fails the build when the committed file stops matching.
 *
 * Rendered from the STANDARD classification, because a reference showing every key a deployment could
 * publish is more useful than one showing only the narrowest classification's - and standard is the
 * one the reference deployment actually configures.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadContextSourceCatalog, renderCatalogReference } from '../lib/config/context-sources.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO_ROOT, 'docs', 'reference', 'context-catalog-reference.md');

// Placeholder identifiers: the reference documents KEYS and CONTRACTS, never resources. Real ARNs
// would put one account's identifiers into a tracked document for no reader benefit.
const { entries, source } = loadContextSourceCatalog({
  classification: 'standard',
  attachmentsBucketArn: 'arn:aws:s3:::<attachments-bucket>',
  attachmentsBucketName: '<attachments-bucket>',
  userProfileTableArn: 'arn:aws:dynamodb:<region>:<account>:table/<user-profile>',
  userProfileTableName: '<user-profile>',
  region: '<region>',
  account: '<account>',
});

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, renderCatalogReference(entries), 'utf8');
console.log(`wrote ${path.relative(REPO_ROOT, OUT)} from ${source} (${entries.length} sources)`);
