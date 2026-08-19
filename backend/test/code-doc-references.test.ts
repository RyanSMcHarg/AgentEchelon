/**
 * CODE THAT CITES A DOCUMENT MUST CITE ONE THAT EXISTS. The mirror of `docs-code-references.test.ts`.
 *
 * THE ASYMMETRY IS THE FINDING. `docs-code-references` has checked docs -> code for
 * months: every path a document names must resolve, every cited line number must be in range. **Nothing
 * checked code -> docs**, and in that unguarded direction 12 document names accumulated across 117 file
 * references that resolved to nothing at all. A reader of the PUBLIC repo, opening the files most
 * likely to be opened first and following a citation, found no such document. **The direction nobody
 * guards is the direction that rots** - which is a claim about process, not about these particular
 * citations, and it is why this file exists rather than a one-off cleanup commit.
 *
 * WHAT THE 2026-08-16 SWEEP FOUND WHEN THIS WAS WRITTEN, and it is the reason the guard covers
 * `tests/` and not just `backend/` + `frontend/`: an earlier session repointed six renamed documents
 * and reported them fixed. Every one of those renames had SURVIVING references in `tests/` -
 * `SPEC-SEPARATE-ADMIN-APP` in eight e2e specs, `SPEC-CONTEXT-SOURCE-CATALOG` in two,
 * `SPEC-PORTABLE-VERSIONED-PROFILES` in one. The fix's scope was set by where someone happened to
 * look, which is exactly the failure this tracker's rule 2 exists for.
 *
 * THREE THINGS THAT ARE DELIBERATELY *NOT* FAILURES, each learned from a real false positive:
 *
 *  1. **An unambiguous abbreviation.** `SPEC-PORTABLE §5` is written 18 times for
 *     `SPEC-PORTABLE-PROFILES`, and `DESIGN-EXPERIMENTS-BATTLE §3.4` for
 *     `DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP`. A reader searching `docs/` for the short form finds
 *     the document, so it is navigable and not a defect. An AMBIGUOUS prefix - one extending to two or
 *     more documents - IS a failure, because then the reader has to guess.
 *  2. **A citation wrapped across a comment line break.** `chimeService.ts:231` ends a line with
 *     `SPEC-CONVERSATION-` and continues `// ARCHIVE, ADR-017` on the next. A line-at-a-time scanner
 *     reports two dangling names and both are fiction, so continuations are rejoined before matching.
 *  3. **A name embedded in a longer one.** The private `COE-…-OVERCLAIM` decision record ends with a
 *     substring the scanner would otherwise read as a document of its own; the lookbehind stops it
 *     inventing one from the tail of a real name. That mechanism was strong enough that the
 *     hand-written exemption for it was redundant, and the ratchet below said so on the first run -
 *     which is the behaviour the ratchet exists for, arriving immediately.
 *
 * The allow-list is the only way to silence this check and every entry carries a reason, so an
 * unjustified one is visible as debt rather than as absence. Resolving a citation REMOVES a line here
 * rather than editing a test.
 *
 * A NOTE ON WHAT "DOES NOT EXIST" MEANS IN A PUBLIC REPO, because the first pass got it wrong.
 * `SPEC-CAPABILITY-PROFILES` and `SPEC-ADMIN-CONSOLE-EFFECTIVENESS` sat here as unwritten specs, and
 * were recorded that way for months. They were not unwritten: both existed, in full, in a private
 * working vault, with internal structure matching the citations exactly. **This repository is public,
 * so from a reader's position here the effect was identical** - a citation led nowhere - but the fix
 * was a publishing decision rather than authoring work, and estimating it as authoring is how it
 * stayed open. Both are published now and neither needs an entry.
 *
 * THE SECOND SWEEP IN THIS FILE checks one level deeper: that a cited SECTION exists in the document
 * it names. See its own header below for why the name check alone was not enough.
 */
import * as fs from 'fs';
import * as path from 'path';
import { excludeIgnored } from './helpers/shipped-files';

const ROOT = path.resolve(__dirname, '../..');
const SKIP = new Set(['node_modules', '.git', 'cdk.out', 'dist', 'coverage', 'test-results', 'playwright-report']);

/**
 * Names that may not resolve, and why.
 *
 * A bare name is exempt everywhere; a `path::NAME` key is exempt only in that file, which is the
 * tighter form and the default choice - a repo-wide exemption for a name that is stale in one place
 * would hide the next stale copy of it.
 */
const ALLOWED: Record<string, string> = {
  'backend/test/docs-drift-guard.test.ts::SPEC-STATUS':
    'Prose, not a citation: the comment reads "SPEC-STATUS GATE (PA-3 in ...)", naming a rule rather '
    + 'than a document. File-scoped so the same token elsewhere is still checked.',
  'backend/test/classification-naming-ratchet.test.ts::SPEC-PER-TIER-OWNERSHIP':
    'A HISTORICAL mention inside the comment that records this very rename ("a document renamed to '
    + 'SPEC-PER-PROFILE-OWNERSHIP"). Rewriting it would erase the explanation of why battle-stack.ts '
    + 'left the grandfather list. File-scoped: a live citation of this name anywhere else still fails.',

  // --- Found by the docs->docs sweep on its first run. Each is real debt, not a mis-citation. ---

  'SPEC-ASSISTANT-TEMPLATE':
    'UNWRITTEN. Cited as `templates/SPEC-ASSISTANT-TEMPLATE.md`, a directory that does not exist in '
    + 'this repository. SPEC-ASSISTANT-MEETINGS calls itself "a worked exemplar" of it, so the '
    + 'exemplar is published and the pattern it exemplifies is not.',

  'DESIGN-ASSISTANT-TEMPLATE':
    'UNWRITTEN, the design-tier counterpart of SPEC-ASSISTANT-TEMPLATE and cited the same way. '
    + 'DESIGN-MULTI-AGENT-ORCHESTRATION leans on it twice for where per-assistant delegation config '
    + 'is declared, so the split it defines is load-bearing for a doc that IS published.',

  'docs/guides/developer/METADATA-AND-TAGS.md::SPEC-CHANNEL-METADATA-MINIMIZATION':
    'DELIBERATELY PRIVATE, and the citing sentence says so ("tracked internally until it ships"). The '
    + 'document describes an unshipped confidentiality relocation and carries its own publish trigger: '
    + 'release it once the relocation lands. File-scoped so a citation elsewhere, which would not carry '
    + 'that caveat, still fails.',

  'docs/specs/applications/SPEC-ASSISTANT-MEETINGS.md::SPEC-ASSISTANT':
    'NOT A CITATION: the document\'s own H1 is "# SPEC-ASSISTANT: Meetings assistant", a title prefix '
    + 'naming the per-assistant document family. File-scoped, so the bare name used as a real citation '
    + 'anywhere else is still checked.',
};

interface DocEntry {
  /** Section anchors a citation may name: `5`, `3.2`, `4a`, `D-1`. Upper-cased. */
  anchors: Set<string>;
  /** Heading text with any leading number stripped, lower-cased, for a title-style anchor. */
  titles: Set<string>;
}

/**
 * Every document, indexed by basename, with the anchors a citation is allowed to name.
 *
 * TWO SOURCES OF ANCHOR, because this repo uses both. A numbered heading (`## 4a. Access Matrix`)
 * yields `4A`. A DECISION is written as a bold run inside a decisions section (`**D-2. ...**`) rather
 * than as its own heading, so those are indexed too: `SPEC-CAPABILITY-PROFILES §D-2` is a live
 * citation and would otherwise read as dangling.
 */
function docIndex(): Map<string, DocEntry> {
  const out = new Map<string, DocEntry>();
  (function walk(d: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.md')) continue;
      const text = fs.readFileSync(p, 'utf8');
      const anchors = new Set<string>();
      const titles = new Set<string>();
      for (const m of text.matchAll(/^#{1,4}\s+(.+)$/gm)) {
        const heading = m[1].trim();
        const numbered = /^([A-Z]?-?\d+(?:\.\d+)*[a-z]?)[.)]?\s/.exec(heading);
        if (numbered) anchors.add(numbered[1].toUpperCase());
        titles.add(heading.replace(/^[A-Z]?-?[\d.]+[a-z]?[.)]?\s*/, '').replace(/[*`]/g, '').toLowerCase());
      }
      for (const m of text.matchAll(/\*\*([A-Z]-?\d+)\./g)) anchors.add(m[1].toUpperCase());
      out.set(e.name.replace(/\.md$/, ''), { anchors, titles });
    }
  })(path.join(ROOT, 'docs'));
  return out;
}

/** Document basenames, without `.md`. */
function docNames(): Set<string> {
  return new Set(docIndex().keys());
}

/**
 * This file, excluded from its own sweep.
 *
 * Its header and its allow-list NAME the stale documents on purpose - that is the record of what was
 * found and why each exemption exists. Scanning itself, the guard reported eight failures, every one
 * of them a name written in prose ABOUT a citation rather than a citation. A guard that fails on its
 * own documentation teaches the next person to delete the documentation.
 */
const SELF = 'code-doc-references.test.ts';

/**
 * Every hand-written file whose citations a reader can follow: the source trees, and `docs` itself.
 *
 * DOCS CITE DOCS, and that direction went unchecked for as long as the code->docs one did. The
 * existing drift guard runs docs->CODE, this guard was built for CODE->docs, and between the two a
 * document citing a document that does not exist resolved to nobody's job. It was not hypothetical:
 * `SPEC-PORTABLE-PROFILES` cited `SPEC-EXPERIMENT-ANALYTICS`, a document that exists only in a private
 * vault, so a public reader following it reached nothing. The manual sweep that fixed a batch of these
 * left no check behind, which is the same shape as the README's e2e counts - corrected by hand, then
 * free to drift again.
 */
function sourceFiles(): string[] {
  const out: string[] = [];
  for (const base of ['backend', 'frontend', 'tests', 'docs']) {
    const start = path.join(ROOT, base);
    if (!fs.existsSync(start)) continue;
    (function walk(d: string) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (SKIP.has(e.name) || e.name === SELF) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        // `.d.ts` is generated from the `.ts` beside it; flagging both doubles every finding.
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
        // Generated documents are excluded: their citations come from the generator, so a finding here
        // would name a file nobody can correct by editing it.
        else if (e.name.endsWith('.md') && !isGenerated(p)) out.push(p);
      }
    })(start);
  }
  // Gitignored files are not the shipped surface. A private working file under `docs/` cites documents
  // by their historical names on purpose, so scanning it reports drift that is a record rather than a
  // defect - and the citation cannot be "fixed" without destroying the record.
  return excludeIgnored(out, ROOT);
}

/**
 * A generated document is owned by its generator, not by an author, so a finding in one would name a
 * file nobody can correct by editing it.
 *
 * BOTH banner forms are matched because this repo uses both, and matching only the HTML-comment form
 * let `e2e-coverage-matrix.md` through on the first run: it announces itself in prose ("Do not edit by
 * hand. Generated from ...") rather than in a comment. A detector that recognises one of two
 * conventions is a detector that quietly half-works.
 */
function isGenerated(file: string): boolean {
  const head = fs.readFileSync(file, 'utf8').slice(0, 400);
  return /^<!--\s*GENERATED/m.test(head) || /Do not edit by hand/i.test(head);
}

/**
 * The document names a file cites.
 *
 * `(?<![A-Z-])` is load-bearing: without it `COE-SPEC-VS-CODE-OVERCLAIM` yields a phantom
 * `SPEC-VS-CODE-OVERCLAIM`, and the guard reports a document that nobody ever cited.
 */
const CITATION = /(?<![A-Z-])((?:SPEC|DESIGN|GUIDE|HOW-TO)-[A-Z0-9]+(?:-[A-Z0-9]+)*)/g;

function citationsIn(text: string): string[] {
  // Rejoin a citation split across a comment line break before matching - see note 2 in the header.
  const joined = text.replace(/-\r?\n\s*(?:\/\/|\*)\s*/g, '-');
  return [...joined.matchAll(CITATION)].map((m) => m[1]);
}

interface Finding { file: string; name: string; detail: string }

function sweep(): { findings: Finding[]; cited: number; resolved: Set<string> } {
  const docs = docNames();
  const docList = [...docs];
  const findings: Finding[] = [];
  const resolved = new Set<string>();
  let cited = 0;

  for (const f of sourceFiles()) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    for (const name of new Set(citationsIn(fs.readFileSync(f, 'utf8')))) {
      cited++;
      if (docs.has(name)) { resolved.add(name); continue; }
      if (ALLOWED[name] || ALLOWED[`${rel}::${name}`]) continue;

      // An abbreviation is fine when exactly one document extends it, and a guess when several do.
      const extensions = docList.filter((d) => d.startsWith(`${name}-`));
      if (extensions.length === 1) { resolved.add(extensions[0]); continue; }
      if (extensions.length > 1) {
        findings.push({ file: rel, name, detail: `AMBIGUOUS - extends to ${extensions.join(', ')}` });
        continue;
      }
      findings.push({ file: rel, name, detail: 'no such document' });
    }
  }
  return { findings, cited, resolved };
}

describe('code cites documents that exist', () => {
  const { findings, cited, resolved } = sweep();

  it('finds citations to check, so the sweep cannot pass vacuously', () => {
    // A regex that matched nothing would satisfy every assertion below while verifying nothing. This
    // is the check the docs->code guard already carries, for the same reason.
    expect(sourceFiles().length).toBeGreaterThan(100);
    expect(cited).toBeGreaterThan(100);
    expect(resolved.size).toBeGreaterThan(20);
  });

  it('every SPEC/DESIGN/GUIDE/HOW-TO name a source file cites resolves to a document', () => {
    if (findings.length > 0) {
      const byName = new Map<string, string[]>();
      for (const f of findings) {
        if (!byName.has(f.name)) byName.set(f.name, []);
        byName.get(f.name)!.push(f.file);
      }
      const lines = [...byName.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([name, files]) => `  ${name} (${files.length} file(s)) - e.g. ${files.slice(0, 3).join(', ')}`);
      throw new Error(
        'Source files cite documents that do not exist:\n'
          + lines.join('\n')
          + '\n\nEither repoint the citation at the document that exists, or - if the document is '
          + 'genuinely unwritten - add it to ALLOWED in this file WITH A REASON, so it reads as debt '
          + 'rather than as an absence nobody noticed. Writing the document removes the entry.',
      );
    }
  });

  it('every allow-list entry is still needed, so the list can only shrink', () => {
    // A ratchet, and the same rule the classification-naming ratchet enforces: an entry that no longer
    // corresponds to a real citation makes the list a historical artefact instead of a debt register,
    // and a stale exemption silently covers the next real defect that lands under the same name.
    const docs = docNames();
    const stale: string[] = [];

    for (const key of Object.keys(ALLOWED)) {
      const [scope, scoped] = key.includes('::') ? key.split('::') : [null, key];
      const name = scoped;

      if (docs.has(name)) { stale.push(`${key} - the document EXISTS now; delete this entry`); continue; }

      const files = scope
        ? [path.join(ROOT, scope)].filter((p) => fs.existsSync(p))
        : sourceFiles();
      const stillCited = files.some((f) => citationsIn(fs.readFileSync(f, 'utf8')).includes(name));
      if (!stillCited) stale.push(`${key} - nothing cites it any more; delete this entry`);
    }

    expect(stale).toEqual([]);
  });

  it('every allow-list entry carries a reason', () => {
    for (const [key, reason] of Object.entries(ALLOWED)) {
      expect(typeof reason).toBe('string');
      // Long enough to be an explanation rather than a shrug. The docs->code guard makes the same
      // demand, and it is what stops the list becoming a place to put things.
      expect(reason.length).toBeGreaterThan(40);
      expect(key).not.toBe('');
    }
  });
});

/**
 * A CITED SECTION MUST EXIST IN THE DOCUMENT IT NAMES.
 *
 * The sweep above checks the document NAME. It cannot see `SPEC-CAPABILITY-PROFILES §D-2`, which named
 * a decision that had never been written: the spec had no D-numbered decisions at all, and the section
 * it should have pointed at said the OPPOSITE of what the code did. That citation was dead for months
 * with every guard green, because no check looked one level deeper than the filename.
 *
 * FIRST RUN: 196 anchored citations, 145 resolving and 51 not. The distribution is the finding rather
 * than the total - **34 of the 51 have a single cause**, which is that `SPEC-PORTABLE-PROFILES` uses
 * prose headings and numbers no section, while code cites five different numbers in it. A per-citation
 * backlog of 51 is daunting; five causes is a morning.
 *
 * The allow-list is keyed by the RESOLVED document, not by how the citation spelled it, so
 * `SPEC-PORTABLE §6` and `SPEC-PORTABLE-PROFILES §6` share one entry instead of drifting apart.
 */
/** The one cause behind 34 of the 51, stated once so the entries cannot drift apart. */
const PORTABLE_REASON = (n: number): string =>
  `${n} citation(s). SPEC-PORTABLE-PROFILES numbers NO section - it uses prose headings ("Lifecycle", `
  + '"Portability: export and import across instances and regions") - so every numeric anchor into it '
  + 'is dead. ONE decision retires all five entries: number that document\'s sections, or repoint the '
  + 'citations at heading titles. Numbering is cheaper to write and dearer to verify, because each '
  + 'cited number then has to land on the section its author meant.';

const IAM_REASON =
  'DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT does not reach these section numbers. Four citations across '
  + 'three anchors, so this is a restructure that renumbered the document and left the code behind '
  + 'rather than three independent slips.';

const ANCHOR_DEBT: Record<string, string> = {
  'SPEC-PORTABLE-PROFILES §1': PORTABLE_REASON(2),
  'SPEC-PORTABLE-PROFILES §3': PORTABLE_REASON(1),
  'SPEC-PORTABLE-PROFILES §5': PORTABLE_REASON(9),
  'SPEC-PORTABLE-PROFILES §6': PORTABLE_REASON(21),
  'SPEC-PORTABLE-PROFILES §7': PORTABLE_REASON(1),
  'SPEC-CREDENTIAL-EXCHANGE §5B':
    '5 citations. The document has `### 5a. Vend planes and per-request capability scoping` and no 5b, '
    + 'so this is an off-by-one into a real section or a subsection that was merged away. One lookup '
    + 'decides which, and it is the cheapest entry here to retire.',
  'SPEC-BATTLE §ANALYTICS':
    '3 citations naming a section by TITLE rather than number. SPEC-BATTLE has eight numbered headings '
    + 'and none of them is Analytics, so the title is stale rather than the form being unsupported - '
    + 'this guard resolves title anchors against heading text and still cannot find it.',
  'SPEC-BATTLE §413':
    '1 citation. No such section; the document numbers 1 to 8. Most likely a mangled 4.1.3 or a '
    + 'requirement id that lost its punctuation. Needs whoever wrote the surrounding comment, which is '
    + 'why it is debt rather than a mechanical fix.',
  'SPEC-ADMIN-IDENTITY §8':
    '2 citations. The document stops short of 8. An off-by-N from a restructure.',
  'SPEC-CONFIGURABLE-ASSISTANTS §2':
    '2 citations. The document carries no numbered section 2. Same shape as the entry above.',
  'DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT §6.5': IAM_REASON,
  'DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT §10': IAM_REASON,
  'DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT §11': IAM_REASON,
};

/**
 * Anchored citations: `SPEC-FOO §5`, `SPEC-FOO.md §4a`, `DESIGN-BAR section 3.2`.
 *
 * A LITERAL, not `new RegExp(...)` over template strings, and that is not a style preference. Built
 * that way, this pattern silently lost every backslash: `[\s,(:]` compiled to `[s,(:]` and `[\w.-]`
 * to `[w.-]`, so it matched nothing anywhere. **The sweep then reported zero findings, which reads
 * exactly like a clean repository.** Only the non-vacuity assertion told the difference between "no
 * dangling anchors" and "no anchors examined". A literal cannot be corrupted that way.
 */
const ANCHORED = /(?<![A-Z-])((?:SPEC|DESIGN|GUIDE|HOW-TO|ADR)-[A-Z0-9]+(?:-[A-Z0-9]+)*)(?:\.md)?[\s,(:]*(?:§+\s*([\w.-]+)|[Ss]ection\s+([\w.-]+))/g;

interface AnchorFinding { key: string; file: string }

function sweepAnchors(): { findings: AnchorFinding[]; checked: number; resolved: number } {
  const index = docIndex();
  const names = [...index.keys()];
  const findings: AnchorFinding[] = [];
  let checked = 0;
  let resolved = 0;

  for (const f of sourceFiles()) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    const text = fs.readFileSync(f, 'utf8').replace(/-\r?\n\s*(?:\/\/|\*)\s*/g, '-');
    for (const m of text.matchAll(ANCHORED)) {
      // Resolve the document first, through the same abbreviation rule the name sweep uses.
      let docName = m[1];
      let entry = index.get(docName);
      if (!entry) {
        const ext = names.filter((d) => d.startsWith(`${docName}-`));
        if (ext.length !== 1) continue; // the NAME sweep owns this failure; do not double-report it
        docName = ext[0];
        entry = index.get(docName)!;
      }
      checked++;
      const anchor = (m[2] || m[3]).replace(/[.)]+$/, '').toUpperCase();
      if (entry.anchors.has(anchor) || entry.titles.has(anchor.toLowerCase())) { resolved++; continue; }
      const key = `${docName} §${anchor}`;
      if (ANCHOR_DEBT[key]) continue;
      findings.push({ key, file: rel });
    }
  }
  return { findings, checked, resolved };
}

describe('a cited section exists in the document it names', () => {
  const { findings, checked, resolved } = sweepAnchors();

  it('finds anchored citations to check, so the sweep cannot pass vacuously', () => {
    expect(checked).toBeGreaterThan(100);
    expect(resolved).toBeGreaterThan(100);
  });

  it('every cited section resolves, or is named debt', () => {
    if (findings.length > 0) {
      const byKey = new Map<string, string[]>();
      for (const f of findings) {
        if (!byKey.has(f.key)) byKey.set(f.key, []);
        byKey.get(f.key)!.push(f.file);
      }
      const lines = [...byKey.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([key, files]) => `  ${key} (${files.length}) - e.g. ${files.slice(0, 3).join(', ')}`);
      throw new Error(
        'Code cites a section that does not exist in the document it names:\n'
          + lines.join('\n')
          + '\n\nRepoint the citation, add the section, or record it in ANCHOR_DEBT with a reason. '
          + 'Numbering a document that uses prose headings can retire many entries at once.',
      );
    }
  });

  it('the debt list can only shrink', () => {
    // Same ratchet as the name allow-list. An entry that no longer matches a live citation is a
    // historical artefact, and a stale one silently covers the next real dangle under the same key.
    const index = docIndex();
    const names = [...index.keys()];
    const live = new Set<string>();
    for (const f of sourceFiles()) {
      const text = fs.readFileSync(f, 'utf8').replace(/-\r?\n\s*(?:\/\/|\*)\s*/g, '-');
      for (const m of text.matchAll(ANCHORED)) {
        let docName = m[1];
        if (!index.has(docName)) {
          const ext = names.filter((d) => d.startsWith(`${docName}-`));
          if (ext.length !== 1) continue;
          docName = ext[0];
        }
        live.add(`${docName} §${(m[2] || m[3]).replace(/[.)]+$/, '').toUpperCase()}`);
      }
    }
    const stale = Object.keys(ANCHOR_DEBT).filter((k) => !live.has(k));
    expect(stale).toEqual([]);
  });

  it('every debt entry carries a reason', () => {
    for (const [key, reason] of Object.entries(ANCHOR_DEBT)) {
      expect(key).toMatch(/§/);
      expect(reason.length).toBeGreaterThan(40);
    }
  });
});
