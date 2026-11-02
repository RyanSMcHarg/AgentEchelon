/**
 * A MEMBERSHIP-AUDIT FINDING IS READ UNDER THE NAME IT WAS WRITTEN.
 *
 * `writeFinding` persists by SPREADING its own argument (`{ ...f }`), so the stored item's keys are
 * exactly that function's parameter names. The admin console declared two of them differently -
 * `subjectTier` and `channelTier` against the stored `subjectClearance` and `channelClassification` -
 * so both columns rendered EMPTY on every finding. Nothing failed: `DataTable` renders a missing key as
 * blank, TypeScript cannot see across the HTTP boundary, and a security audit whose two most
 * load-bearing fields are empty looks like an audit that found nothing interesting.
 *
 * THIS IS A CONTRACT TEST ACROSS A BOUNDARY NO COMPILER SPANS, which is the only place it can live. The
 * writer is a Lambda and the reader is a browser bundle; the shape travels as JSON. So it is asserted
 * from SOURCE on both sides: every field the writer persists must be declared by the reader.
 *
 * DIRECTION MATTERS AND IS DELIBERATE. A written field the reader does not declare is the defect (an
 * invisible column). The reverse is fine and expected: the reader also declares `pk`, `sk`, `ts`,
 * `status` and the review fields, which `writeFinding` adds itself or which the review path writes
 * later. So this asserts writer-subset-of-reader, not equality - an equality assertion here would fail
 * on correct code and get deleted.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WRITER = path.join(REPO_ROOT, 'backend', 'lambda', 'src', 'membership-audit.ts');
const READER = path.join(REPO_ROOT, 'frontend', 'packages', 'admin', 'src', 'services', 'membershipAuditService.ts');

/** The keys `writeFinding` persists, read off its parameter type literal. */
function writtenFields(): string[] {
  const src = fs.readFileSync(WRITER, 'utf-8');
  const at = src.indexOf('async function writeFinding(f: {');
  expect(at).toBeGreaterThan(-1); // the scrape found the function, not nothing
  const block = src.slice(at, src.indexOf('}', at));
  return [...block.matchAll(/(\w+)\s*:\s*string/g)].map((m) => m[1]);
}

/** The fields the console declares on a finding. */
function declaredFields(): string[] {
  const src = fs.readFileSync(READER, 'utf-8');
  const at = src.indexOf('export interface MembershipAuditFinding');
  expect(at).toBeGreaterThan(-1);
  const block = src.slice(at, src.indexOf('\n}', at));
  return [...block.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
}

describe('a membership-audit finding is read under the name it was written', () => {
  it('scrapes a realistic number of fields from both sides (the guard is wired, not empty)', () => {
    expect(writtenFields().length).toBeGreaterThanOrEqual(5);
    expect(declaredFields().length).toBeGreaterThanOrEqual(8);
  });

  it('declares every field the writer persists, so no column can render blank', () => {
    const declared = declaredFields();
    const missing = writtenFields().filter((f) => !declared.includes(f));
    expect(missing).toEqual([]);
  });

  it('names the clearance and the classification specifically, because those are the two that were wrong', () => {
    // Pinned by name as well as by the subset rule: these are the fields an operator reads to decide
    // whether a finding is real, and they were the ones blank for weeks.
    const declared = declaredFields();
    expect(declared).toContain('subjectClearance');
    expect(declared).toContain('channelClassification');
    expect(declared).not.toContain('subjectTier');
    expect(declared).not.toContain('channelTier');
  });

  it('renders those keys in the console, not just declares them', () => {
    const tab = fs.readFileSync(
      path.join(REPO_ROOT, 'frontend', 'packages', 'admin', 'src', 'components', 'admin', 'MembershipAuditTab.tsx'),
      'utf-8',
    );
    // A declared-but-unrendered field is the same invisible column by another route.
    expect(tab).toContain("key: 'subjectClearance'");
    expect(tab).toContain("key: 'channelClassification'");
  });
});
