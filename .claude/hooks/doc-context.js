#!/usr/bin/env node
/**
 * UserPromptSubmit hook — dogfood the OSS docs.
 *
 * Triggers on planning- or troubleshooting-shaped prompts. Greps the docs
 * the project actually publishes (AGENTS.md + CLAUDE.md + docs/*.md, minus internal
 * handoffs/snapshots), and injects the most relevant excerpts as context
 * before Claude responds.
 *
 * Goal: every "design X" / "fix Y" turn forces a doc lookup. If the docs
 * don't have what's needed, that gap surfaces during a normal session —
 * which is exactly the experience an OSS user would have. No gap is more
 * findable than the one Claude just hit.
 *
 * Wired in .claude/settings.json under hooks.UserPromptSubmit.
 *
 * Contract (Claude Code UserPromptSubmit hook):
 *   stdin  — JSON: { prompt: string, cwd: string, ... }
 *   stdout — additional context injected before the model reads the prompt
 *   exit 0 — proceed (with our stdout as context)
 *   any throw — caught + swallowed; we exit 0 with no output rather than
 *               blocking the user's turn. This hook must NEVER stop work.
 */

const fs = require('fs');
const path = require('path');

const PLAN_KEYWORDS = [
  'plan', 'design', 'architect', 'approach', 'propose',
  'how do i', 'how should', 'how would', 'how to',
  'implement', 'build', 'add a', 'add an', 'set up', 'wire up',
  'refactor', 'restructure', 'migrate',
];

const TROUBLE_KEYWORDS = [
  'broken', 'breaking', 'fail', 'failing', 'failed', 'error',
  'debug', 'fix', 'crash', 'crashed', 'throws', 'throwing',
  'not working', "doesn't work", "isn't working", "won't ",
  'timeout', 'timing out', 'hangs', 'stuck',
  'regression', 'flake', 'flaky',
];

// Every doc under docs/ is shareable, so nothing is skipped. Add a pattern
// here if a future doc should be excluded from the context lookup.
const SKIP_DOC_PATTERNS = [];

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'what', 'where', 'when',
  'should', 'would', 'could', 'about', 'from', 'into', 'than', 'then',
  'have', 'has', 'had', 'are', 'was', 'were', 'been', 'being', 'will',
  'plan', 'design', 'fix', 'debug', 'help', 'please', 'thanks',
  'something', 'anything', 'nothing', 'everything',
  'http', 'https', 'true', 'false', 'null', 'undefined',
]);

function classify(prompt) {
  const lower = prompt.toLowerCase();
  return {
    isPlanning: PLAN_KEYWORDS.some((k) => lower.includes(k)),
    isTroubleshooting: TROUBLE_KEYWORDS.some((k) => lower.includes(k)),
  };
}

function extractKeywords(prompt) {
  // Words 4+ chars, alphanumeric + hyphen + underscore + dot (so e.g.
  // "lex-bot", "router_agent_handler", "tier.basic" all survive).
  const raw = prompt.match(/\b[A-Za-z][A-Za-z0-9._-]{3,}\b/g) || [];
  const unique = [];
  const seen = new Set();
  for (const w of raw) {
    const k = w.toLowerCase();
    if (STOPWORDS.has(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(w); // preserve original casing for display
  }
  // Cap to keep grep budget bounded. Longer words tend to be more specific
  // (acronyms, identifiers, feature names), so prefer them.
  unique.sort((a, b) => b.length - a.length);
  return unique.slice(0, 12);
}

function collectDocs(cwd, isTroubleshooting) {
  const candidates = [];
  // AGENTS.md is the vendor-neutral assistant guide (the main source of truth); CLAUDE.md is
  // now a thin Claude Code pointer. Include both, AGENTS.md first.
  const agentsMd = path.join(cwd, 'AGENTS.md');
  if (fs.existsSync(agentsMd)) candidates.push('AGENTS.md');
  const claudeMd = path.join(cwd, 'CLAUDE.md');
  if (fs.existsSync(claudeMd)) candidates.push('CLAUDE.md');

  const troubleshooting = path.join(cwd, 'docs', 'guides', 'user', 'TROUBLESHOOTING.md');
  if (fs.existsSync(troubleshooting)) candidates.push('docs/guides/user/TROUBLESHOOTING.md');

  // docs/ is organized into subfolders (overview/ guides/ specs/ design/), so
  // walk it recursively. images/ and dot-dirs are skipped.
  const docsDir = path.join(cwd, 'docs');
  if (fs.existsSync(docsDir)) {
    const walkDocs = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'images') continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) { walkDocs(abs); continue; }
        if (!entry.name.endsWith('.md')) continue;
        const rel = path.relative(cwd, abs).split(path.sep).join('/');
        if (rel === 'docs/guides/user/TROUBLESHOOTING.md') continue; // already added
        if (SKIP_DOC_PATTERNS.some((rx) => rx.test(rel))) continue;
        candidates.push(rel);
      }
    };
    walkDocs(docsDir);
  }

  // For troubleshooting prompts, TROUBLESHOOTING.md goes first; for
  // planning, AGENTS.md leads (it is first in the candidates list). Order
  // matters because we cap hits at the end.
  if (isTroubleshooting) {
    candidates.sort((a, b) => {
      if (a === 'docs/guides/user/TROUBLESHOOTING.md') return -1;
      if (b === 'docs/guides/user/TROUBLESHOOTING.md') return 1;
      return 0;
    });
  }
  return candidates;
}

function gradeFile(cwd, rel, keywords) {
  const full = path.join(cwd, rel);
  let content;
  try {
    content = fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
  const lines = content.split('\n');
  const hits = [];
  let score = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lowerLine = line.toLowerCase();
    let lineHit = false;
    for (const kw of keywords) {
      if (lowerLine.includes(kw.toLowerCase())) {
        lineHit = true;
        // Whole-word match on a longer keyword scores higher than a
        // partial substring on a short one.
        score += Math.max(1, Math.floor(kw.length / 4));
      }
    }
    if (lineHit) {
      hits.push({ line: i + 1, text: line.trim() });
    }
  }

  if (hits.length === 0) return null;
  return { file: rel, score, hits };
}

function format(graded, classification) {
  const tag = classification.isTroubleshooting ? 'troubleshoot' : 'plan';
  const out = [];
  out.push('');
  out.push(`## Existing docs likely relevant (${tag})`);
  out.push('');
  out.push(
    'Auto-surfaced by the doc-context hook. The OSS repo already ships these — read the matching sections before writing new specs/code or proposing new approaches, and flag if anything is wrong or missing (that\'s a doc bug worth filing).',
  );
  out.push('');

  for (const f of graded) {
    out.push(`**${f.file}** (${f.hits.length} hit${f.hits.length === 1 ? '' : 's'})`);
    for (const h of f.hits.slice(0, 4)) {
      const snippet = h.text.length > 180 ? h.text.slice(0, 177) + '...' : h.text;
      out.push(`  L${h.line}: ${snippet}`);
    }
    if (f.hits.length > 4) {
      out.push(`  ...and ${f.hits.length - 4} more match${f.hits.length - 4 === 1 ? '' : 'es'} in this file.`);
    }
    out.push('');
  }
  return out.join('\n');
}

function main() {
  let event;
  try {
    const raw = fs.readFileSync(0, 'utf8');
    event = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const prompt = event && typeof event.prompt === 'string' ? event.prompt : '';
  const cwd = (event && event.cwd) || process.cwd();
  if (!prompt || prompt.length < 8) process.exit(0);

  const classification = classify(prompt);
  if (!classification.isPlanning && !classification.isTroubleshooting) {
    process.exit(0);
  }

  const keywords = extractKeywords(prompt);
  if (keywords.length === 0) process.exit(0);

  const docs = collectDocs(cwd, classification.isTroubleshooting);
  if (docs.length === 0) process.exit(0);

  const graded = [];
  for (const rel of docs) {
    const g = gradeFile(cwd, rel, keywords);
    if (g) graded.push(g);
  }
  if (graded.length === 0) process.exit(0);

  graded.sort((a, b) => b.score - a.score);
  // Top 5 files keeps the injected context tight — we want a nudge, not a
  // dump. The hook fires every turn.
  const top = graded.slice(0, 5);

  process.stdout.write(format(top, classification));
  process.exit(0);
}

try {
  main();
} catch {
  // Never block the user's turn — the hook is best-effort context.
  process.exit(0);
}
