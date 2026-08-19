/**
 * ONE upload MIME contract, held across its three enforcers.
 *
 * The chain a user's file crosses: the CLIENT allowlist (attachmentService.ts) admits it, the
 * PRESIGNER allowlist (lambda/presigned-url) signs it, and the Converse mapping
 * (docFormatFromContentType / imageFormatFromContentType) attaches it to the model turn. These lists
 * drifted three ways and every drift failed silently or late: empty-type files were admitted then
 * rejected by the presigner as octet-stream (a guaranteed late 400), and application/json passed
 * both allowlists but had no Converse mapping - the file uploaded, the assistant answered as if
 * nothing was sent, and no error surfaced anywhere.
 *
 * The client and presigner cannot share an import (different packages, different runtimes), so this
 * pins their LITERAL lists against each other and against the mapping the model hop actually uses.
 * Add a type in one place and this fails until you add it in all three.
 */
import * as fs from 'fs';
import * as path from 'path';
import { docFormatFromContentType, imageFormatFromContentType } from '../../lambda/src/lib/async-processor-core';

function literalList(src: string, marker: string): string[] {
  const at = src.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const block = src.slice(at, src.indexOf(']', at));
  return [...block.matchAll(/'([a-z0-9./+-]+)'/gi)].map((m) => m[1]).filter((t) => t.includes('/'));
}

const clientSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'frontend', 'packages', 'chat', 'src', 'services', 'attachmentService.ts'),
  'utf8',
);
const presignerSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'lambda', 'presigned-url', 'index.js'),
  'utf8',
);

const clientTypes = literalList(clientSrc, 'const ALLOWED_TYPES');
const presignerTypes = literalList(presignerSrc, 'const ALLOWED_MIME_TYPES');

describe('the upload MIME contract holds across client, presigner and Converse', () => {
  it('the client and the presigner admit exactly the same types', () => {
    expect([...clientTypes].sort()).toEqual([...presignerTypes].sort());
    expect(clientTypes.length).toBeGreaterThan(5);
  });

  it('every admitted type reaches the model: a doc format or an image format, never a silent drop', () => {
    for (const t of clientTypes) {
      const reaches = Boolean(docFormatFromContentType(t) || imageFormatFromContentType(t));
      expect(`${t}: ${reaches ? 'mapped' : 'DROPPED at the Converse hop'}`).toBe(`${t}: mapped`);
    }
  });

  it("the client's extension inference emits only admitted types", () => {
    const inferred = literalList(clientSrc, 'const TYPE_BY_EXTENSION');
    expect(inferred.length).toBeGreaterThan(3);
    for (const t of inferred) {
      expect(`${t}: ${clientTypes.includes(t) ? 'admitted' : 'NOT in ALLOWED_TYPES'}`).toBe(`${t}: admitted`);
    }
  });
});
