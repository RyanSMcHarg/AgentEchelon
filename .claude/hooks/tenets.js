#!/usr/bin/env node
/**
 * UserPromptSubmit hook - put the tenets in front of the work that has to obey them.
 *
 * The tenets are the project's own standard and they are exactly the thing an assistant reasons past
 * without noticing. Not by disagreeing with them: by not having them in mind while making a choice
 * that a tenet already settled. In one session a client polled on an interval with a comment saying
 * the notification "needs neither" a store nor an event - D6 seen and stepped over; a metric was
 * emitted to CloudWatch that the ledger already counted - D7; and user-facing copy was written as
 * fixed English in three places - P5 and D11. Every one was caught later by a person reading
 * the diff and asking. That is the review this hook tries to move earlier.
 *
 * ── IT INJECTS, IT NEVER BLOCKS ──────────────────────────────────────────────────────────────────
 *
 * A hook that refuses work on a heuristic is worse than no hook: the false positives train people to
 * work around it, and then it catches nothing. This one adds context and exits 0 always. The half
 * that BINDS is a test - `backend/test/tenets-are-enforced.test.ts` - and the pairing is the same one
 * `reuse-first.js` uses: a hook that nudges plus a test that refuses.
 *
 * ── IT NAMES THE TENET, NOT A RULE ───────────────────────────────────────────────────────────────
 *
 * The full text lives in docs/overview/TENETS.md and is READ FROM THERE rather than restated here. A
 * hardcoded copy is a snapshot, and snapshots rot faster than the documents they describe - the same
 * reason `reuse-first.js` counts implementations live instead of remembering them.
 *
 * Contract (Claude Code UserPromptSubmit hook):
 *   stdin  - JSON: { prompt: string, cwd: string, ... }
 *   stdout - additional context injected before the model reads the prompt
 *   exit 0 - always. Any throw is swallowed; this hook must NEVER stop work.
 */

const fs = require('fs');
const path = require('path');

/**
 * Which tenets a prompt is most likely to walk into, by the shape of what is being asked.
 *
 * DELIBERATELY OVER-INCLUSIVE ON THE CHEAP ONES. Surfacing a tenet that turns out not to apply costs
 * a few lines of context; missing the one that did apply costs a defect nobody sees until review.
 * The triggers are the words that appear when the decision is being MADE, not when it is being
 * described - "poll", "interval", "message the user", "count", "store" - because that is the moment
 * the tenet is either honoured or lost.
 */
const TRIGGERS = [
  {
    tenets: ['D6'],
    why: 'Anything that waits, retries on a timer, or asks repeatedly.',
    words: [
      'poll', 'polling', 'interval', 'setinterval', 'every few seconds', 'refresh',
      'check again', 'retry loop', 'heartbeat', 'cron', 'schedule', 'watch for',
    ],
  },
  {
    tenets: ['D7'],
    why: 'Anything that records a fact, or reads one that already exists somewhere.',
    words: [
      'metric', 'metrics', 'counter', 'count', 'emit', 'cloudwatch', 'dashboard',
      'analytics', 'report on', 'track', 'store', 'persist', 'record', 'ledger', 'archive',
    ],
  },
  {
    tenets: ['P5', 'D11'],
    why: 'Anything a person will read. It carries a persona and a language, or it should.',
    words: [
      'message', 'copy', 'wording', 'text', 'notice', 'prompt the user', 'tell the user',
      'error message', 'label', 'string', 'says', 'reply', 'response text', 'tooltip', 'placeholder',
    ],
  },
  {
    tenets: ['D11'],
    why: 'Any decision taken by looking at what someone wrote.',
    words: [
      'parse', 'regex', 'match', 'detect', 'recognise', 'recognize', 'keyword',
      'contains', 'starts with', 'phrase', 'intent from', 'classify',
    ],
  },
  {
    tenets: ['P4', 'D1', 'D3', 'D4'],
    why: 'Anything that reads or writes on someone else\'s behalf.',
    words: [
      'iam', 'grant', 'policy', 'permission', 'role', 'auth', 'access', 'admin',
      'membership', 'visible', 'private', 'scope', 'boundary', 'credential', 'token',
    ],
  },
  {
    tenets: ['D8', 'D9'],
    why: 'Anything new. There is usually already a seam for it.',
    words: [
      'new lambda', 'new table', 'new endpoint', 'new service', 'new module',
      'add a hook', 'build a', 'create a', 'introduce', 'from scratch', 'own implementation',
    ],
  },
  {
    tenets: ['D12', 'D13', 'D15'],
    why: 'Anything shared across classifications, and anywhere an artifact or a row comes to rest.',
    words: [
      'shared', 'share', 'reuse', 'reused', 'across classification', 'across classifications',
      'per classification', 'one instance', 'single table', 'global', 'cross-classification',
      'bucket', 'prefix', 'partition key', 'retention', 'lifecycle', 'ttl', 'expiry', 'transcript',
      'attachment', 'artifact', 'owns', 'ownership', 'factor out', 'consolidate', 'de-duplicate',
    ],
  },
  {
    tenets: ['P3'],
    why: 'Anything that pins a model, a version, or a shape other things read.',
    words: [
      'model id', 'schema', 'contract', 'version', 'migration', 'breaking change', 'interface',
    ],
  },
];

/** Read the tenet's own words, so this hook can never drift from the document. */
function tenetText(root, ids) {
  // TWO ROOTS, because the cwd a host hands a hook is not always resolvable from inside it (a shell
  // that reports a POSIX path on Windows is the ordinary case). Silently finding nothing would make
  // this hook look like it had decided the prompt was fine.
  const candidates = [root, process.cwd(), path.resolve(__dirname, '..', '..')];
  let raw = null;
  for (const base of candidates) {
    try {
      raw = fs.readFileSync(path.join(base, 'docs', 'overview', 'TENETS.md'), 'utf8');
      break;
    } catch { /* try the next */ }
  }
  if (!raw) return null;
  const out = [];
  for (const id of ids) {
    // The tenet's own paragraph: "**D6. Title** - body". Take it and stop at the next tenet or section,
    // so a tenet with sub-rules (D11 is one) arrives whole rather than truncated to its first sentence,
    // which is where its actual rules live.
    const start = raw.search(new RegExp(`^\\*\\*${id}\\. `, 'm'));
    if (start < 0) continue;
    const rest = raw.slice(start);
    const nextIdx = rest.slice(1).search(/^(\*\*[PD]\d+\. |## |---)/m);
    const body = (nextIdx < 0 ? rest : rest.slice(0, nextIdx + 1)).trim();
    // Bounded: the point is to put the rule in mind, not to paste the document into every prompt.
    out.push(body.length > 1400 ? `${body.slice(0, 1400)}...` : body);
  }
  return out.length ? out : null;
}

function main() {
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch {
    return;
  }

  let prompt = '';
  let cwd = process.cwd();
  try {
    const parsed = JSON.parse(input);
    prompt = String(parsed.prompt || '');
    cwd = parsed.cwd || cwd;
  } catch {
    return;
  }
  if (!prompt) return;

  const haystack = prompt.toLowerCase();
  const matched = new Set();
  const reasons = [];
  for (const trigger of TRIGGERS) {
    if (!trigger.words.some((w) => haystack.includes(w))) continue;
    for (const t of trigger.tenets) matched.add(t);
    reasons.push(trigger.why);
  }
  if (!matched.size) return;

  // Project tenets first, then design tenets, each in order.
  const order = (id) => (id[0] === 'P' ? 0 : 100) + Number(id.slice(1));
  const ids = [...matched].sort((a, b) => order(a) - order(b));
  const text = tenetText(cwd, ids);
  if (!text) return;

  const lines = [
    '## Tenets this turn is likely to touch',
    '',
    'Auto-surfaced. These are the project\'s own standard, read from `docs/overview/TENETS.md`.',
    'They are listed because of the SHAPE of the request, so one may not apply - say so and move on.',
    'What is not fine is deciding against one without noticing: that is how each of these was broken',
    'before, every time with a comment explaining the shortcut.',
    '',
    ...reasons.map((r) => `- ${r}`),
    '',
    ...text,
    '',
    'If the work genuinely needs an exception, say which tenet and why in the code, where the next',
    'reader will find it - not in the commit message, which nobody reads at the call site.',
  ];
  process.stdout.write(lines.join('\n'));
}

try {
  main();
} catch {
  // Never block a turn.
}
process.exit(0);
