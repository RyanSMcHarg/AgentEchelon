/**
 * A DIAGRAM THAT DOES NOT RENDER IS WORSE THAN NO DIAGRAM.
 *
 * It occupies the space where the explanation would be, and the reader cannot tell whether they are
 * looking at a broken picture or a broken system. Two shipped in this repository and both were found
 * by a person looking at the page - one in MESSAGE-FLOW, one in SPEC-ADD-USER-ESCALATION that had
 * been broken since it was written.
 *
 * ── WHAT THIS CHECKS, AND WHAT IT DOES NOT ──────────────────────────────────────────────────────
 *
 * It is a lint over the source text, NOT a render. Rendering needs mermaid and a DOM, which is 150
 * packages of devDependency for a documentation check, and this repository already carries a
 * measured preference for a cheap guard over an expensive one. So this cannot prove a diagram is
 * correct - only that it does not contain the specific constructs that have actually broken one here.
 *
 * Each rule below exists because it shipped, and each names what it costs. When a new breakage gets
 * through, the honest response is to add its shape to this list rather than to widen the rules by
 * guesswork.
 *
 * Verified against the real mermaid parser at the time of writing: every diagram in `docs/` parses,
 * and each rule below was confirmed to be a genuine parse error or mis-render rather than a style
 * preference.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..');
const DOCS = path.join(REPO_ROOT, 'docs');
const NL = String.fromCharCode(10);

interface Block {
  file: string;
  /** 1-based line of the opening fence, so a failure names somewhere to look. */
  line: number;
  kind: string;
  body: string[];
}

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function mermaidBlocks(): Block[] {
  const blocks: Block[] = [];
  for (const file of markdownFiles(DOCS)) {
    const lines = fs.readFileSync(file, 'utf8').split(NL);
    let open = -1;
    let body: string[] = [];
    lines.forEach((l, i) => {
      if (l.trim() === '```mermaid') { open = i; body = []; return; }
      if (open >= 0 && l.trim() === '```') {
        blocks.push({
          file: path.relative(REPO_ROOT, file),
          line: open + 1,
          kind: (body.find((b) => b.trim()) || '').trim().split(/\s+/)[0],
          body,
        });
        open = -1;
        return;
      }
      if (open >= 0) body.push(l);
    });
  }
  return blocks;
}

const blocks = mermaidBlocks();
const at = (b: Block) => `${b.file}:${b.line}`;

describe('every mermaid diagram in the documentation', () => {
  it('finds the diagrams at all (guards against a silently empty scan)', () => {
    // Without this, a moved docs directory makes every assertion below pass over nothing.
    expect(blocks.length).toBeGreaterThan(5);
  });

  it('declares a diagram type mermaid understands', () => {
    const known = ['flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'stateDiagram',
      'stateDiagram-v2', 'erDiagram', 'journey', 'gantt', 'pie', 'gitGraph', 'timeline'];
    const bad = blocks.filter((b) => !known.some((k) => b.kind === k));
    expect(bad.map((b) => `${at(b)}: "${b.kind}"`)).toEqual([]);
  });

  it('never puts a semicolon in a sequence diagram note or message', () => {
    // THE ONE THAT SHIPPED TWICE. A `;` ends a statement, so everything after it on that line is
    // parsed as syntax and the whole diagram fails - not the line, the diagram. Both instances were
    // ordinary English punctuation inside a Note.
    const bad: string[] = [];
    for (const b of blocks.filter((x) => x.kind === 'sequenceDiagram')) {
      b.body.forEach((line, i) => {
        const text = line.trim();
        if (!text.startsWith('Note ') && !/^[A-Za-z0-9_]+\s*-?->>?/.test(text)) return;
        if (text.includes(';')) bad.push(`${b.file}:${b.line + i + 1}: ${text.slice(0, 80)}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('never puts a bare # inside a node label', () => {
    // `#` opens a character entity in a mermaid label (`#35;` is how you write one), so a key like
    // `corr#id` renders mangled. It PARSES, which is what makes it worth a lint: the diagram appears
    // and is simply wrong, so nothing errors and a reader cannot tell.
    //
    // Colour definitions are exempt: `fill:#eef4ff` is the documented syntax.
    const bad: string[] = [];
    for (const b of blocks) {
      b.body.forEach((line, i) => {
        if (/classDef|^\s*class\s|style\s/.test(line)) return;
        for (const m of line.matchAll(/"([^"]*)"/g)) {
          if (m[1].includes('#')) bad.push(`${b.file}:${b.line + i + 1}: ${m[1].slice(0, 70)}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it('gives a node its shape before drawing an edge to it', () => {
    // A node named on an edge before it is declared is created as a plain box with its ID as the
    // label. The later declaration usually wins, but not always, and the failure mode is a stray
    // one-letter box in the middle of the picture - which is exactly what "the diagram is not
    // displaying correctly" looked like.
    const bad: string[] = [];
    for (const b of blocks.filter((x) => x.kind === 'flowchart' || x.kind === 'graph')) {
      const declared = new Set<string>();
      const pending = new Map<string, number>();
      b.body.forEach((line, i) => {
        for (const m of line.matchAll(/([A-Za-z][A-Za-z0-9_]*)\s*[[({]/g)) declared.add(m[1]);
        const edge = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*(?:-->|---|-\.->|==>)(?:\|[^|]*\|)?\s*([A-Za-z][A-Za-z0-9_]*)\s*$/.exec(line);
        if (!edge) return;
        for (const id of [edge[1], edge[2]]) {
          if (!declared.has(id) && !pending.has(id)) pending.set(id, b.line + i + 1);
        }
      });
      for (const [id, lineNo] of pending) {
        if (declared.has(id)) bad.push(`${b.file}:${lineNo}: "${id}" is drawn to before it is declared`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('balances its brackets and quotes', () => {
    const count = (s: string, ch: string) => s.split(ch).length - 1;
    const bad: string[] = [];
    for (const b of blocks) {
      // ARROW SYNTAX IS NOT A BRACKET. A sequence diagram writes an async message as `A-)B`, so a
      // naive count reports one unmatched `)` per async arrow and the rule fires on a diagram the
      // real parser accepts. Caught by checking this lint against mermaid itself rather than
      // trusting it - the first version reported a false positive in SPEC-ADD-USER-ESCALATION.
      const t = b.body.join(NL).replace(/-\)/g, '->');
      for (const [o, c] of [['[', ']'], ['{', '}'], ['(', ')']]) {
        if (count(t, o) !== count(t, c)) bad.push(`${at(b)}: ${o} ${count(t, o)} vs ${c} ${count(t, c)}`);
      }
      if (count(t, '"') % 2) bad.push(`${at(b)}: odd number of quotes`);
    }
    expect(bad).toEqual([]);
  });
});
