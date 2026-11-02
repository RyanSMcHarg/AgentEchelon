/**
 * THE HALF THAT BINDS.
 *
 * `.claude/hooks/tenets.js` puts the tenets in front of the work that has to obey them, and it is
 * ADVISORY by design: it cannot block, and it only reaches an AI assistant. That pairing is the one
 * `reuse-first.js` already uses - a hook that nudges plus a test that refuses - because either alone
 * is not enough. A hook that blocks on a heuristic trains people to work around it; a test with no
 * hook catches the mistake only after it is written.
 *
 * These assert the tenets that CAN be mechanically checked in this area. Most cannot, and pretending
 * otherwise would be worse than the gap: a green suite that proves nothing about the rule it names.
 * What is checkable here is where a rule was already broken once, which is the honest place to spend
 * a guard.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', 'lambda', 'src');
const STACKS = path.join(__dirname, '..', 'lib', 'stacks');
const CHAT = path.join(__dirname, '..', '..', 'frontend', 'packages', 'chat', 'src');

const read = (base: string, rel: string) => fs.readFileSync(path.join(base, rel), 'utf8');

/** Every .ts under a root, so a new file cannot dodge a rule by being new. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('tenet D6 - event-driven, not polling', () => {
  it('the queue affordance subscribes rather than polling', () => {
    // It polled every four seconds first, with a comment saying the notification "needs neither" a
    // store nor an event. The event existed the whole time: the deferral notice is a message the SPA
    // already receives, and it changes exactly when the queue does.
    const hook = read(CHAT, 'hooks/useTurnState.ts');
    // A REPEATING TIMER IS THE POLL, and it stays banned outright. There is no shape of `setInterval`
    // here that is not the thing this tenet exists to prevent.
    expect(hook).not.toMatch(/setInterval/);
    // The subscription remains the mechanism, not a fallback to it.
    expect(hook).toContain('changeSignal');

    // ── WHY `setTimeout` IS NO LONGER BANNED OUTRIGHT (owner direction, 2026-09-12) ──────────────
    //
    // A queue that cannot be READ says so and tries again, and that retry needs a timer. The rule
    // matches the behavior rather than the word, so it admits that bounded retry and still catches a
    // genuine poll however it is written, recursive `setTimeout` included.
    //
    // A POLL ASKS AGAIN WHETHER OR NOT THE LAST ANSWER ARRIVED. A recovery asks again ONLY because
    // the last one did not. That is the distinction worth enforcing, and it is checkable: there may
    // be exactly one timer, it may be armed from exactly one place, and that place must be the
    // branch where no responder answered. Arm it anywhere else - after a success, or unconditionally
    // at the end of `read` - and this fails, which is precisely when it has become a poll again.
    //
    // ONE MORE TIMER IS ALLOWED, AND ONLY IN ITS OWN SHAPE: the two deadline re-reads after a person's send.
    // A turn that cannot start posts nothing, so no event fires; the hook reads once at
    // each of two fixed deadlines and a reply cancels both. It is a bounded wait, never re-armed by a read.
    const deadline = hook.slice(hook.indexOf('// THE TWO DEADLINES.'), hook.indexOf('// THE SUBSCRIPTION, such as it is.'));
    expect(deadline).toContain('[FIRST_RESPONSE_DEADLINE_MS, TURN_DEADLINE_MS].map(');
    expect(deadline.match(/setTimeout\(/g) || []).toHaveLength(1);
    expect(deadline).not.toContain('scheduleRetry');
    const timers = hook.replace(deadline, '').match(/setTimeout\(/g) || [];
    expect(timers).toHaveLength(1);
    const armings = hook.match(/^\s*scheduleRetry\(\);/gm) || [];
    expect(armings).toHaveLength(1);
    // The one arming sits inside the "nobody answered" branch. Matched as a block rather than by
    // line numbers so ordinary edits above it do not break the guard.
    expect(hook).toMatch(/if \(!answers\) \{[^}]*scheduleRetry\(\);/);
  });
});

describe('tenet D7 - one source per question', () => {
  it('the queue metrics do not count what the ledger already counts', () => {
    // A cancelled turn lands in the ledger as its own phase. Emitting it to CloudWatch as well gave
    // one question two answers in two stores that can disagree.
    const metrics = read(SRC, 'lib/turn-queue-metrics.ts');
    expect(metrics).not.toMatch(/recordCancellation|TurnCancelled/);
  });
});

describe('tenet D11 - no decision depends on recognising a phrase', () => {
  /**
   * The tenet permits matching what the PLATFORM wrote - a declared marker, an ARN, a SQLSTATE. What
   * it forbids is deciding from what a person or a model SAID. The triage contract is the case worth
   * guarding: it reads a model's reply, and the whole point of the declared markers is that a
   * wording choice can never become control flow.
   */
  it('triage decides only from markers it asked for', () => {
    const src = read(SRC, 'lib/turn-triage-proposal.ts');
    // The two declared markers, and the split that keeps prose out of the decision.
    expect(src).toContain('TRIAGE');
    expect(src).toContain('PROPOSAL');
    expect(src).toMatch(/before either is read|BEFORE the marker/i);
  });

  it('the queue copy a model cannot write is a message template rather than fixed', () => {
    // Fixed English broke three tenets at once: a persona never reached it (5, 6) and a conversation
    // in another language got English (11). Each line is now the assistant's template (ADR-062).
    const notice = read(SRC, 'lib/turn-queue-notice.ts');
    expect(notice).toContain('AssistantCopy');
    expect(notice).toMatch(/templateLine\(/);
    expect(notice).toMatch(/'queued-one'/);
  });

  /**
   * The prose literals inside the value of every `content:` or `Content:` property of a source, skipping a
   * message to a model (an object with a `role`). A literal counts when it reads as words a person would read:
   * two words or more with a space between, once interpolations are removed.
   */
  function contentProse(src: string): string[] {
    const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const found: string[] = [];
    for (const m of body.matchAll(/\b(content|Content)\s*:/g)) {
      if (/role\s*:[^,}]*,\s*$/.test(body.slice(Math.max(0, m.index! - 60), m.index))) continue;
      let depth = 0;
      let quote: string | null = null;
      let end = m.index! + m[0].length;
      for (; end < body.length; end++) {
        const ch = body[end];
        if (quote) {
          if (ch === '\\') end++;
          else if (ch === quote) quote = null;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') quote = ch;
        else if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) { if (depth === 0) break; depth--; }
        else if (ch === ',' && depth === 0) break;
      }
      const value = body.slice(m.index! + m[0].length, end);
      for (const lit of value.matchAll(/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`/g)) {
        const text = (lit[1] ?? lit[2] ?? lit[3] ?? '').replace(/\$\{[^}]*\}/g, ' ');
        if (/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(text)) found.push(text.trim());
      }
    }
    return found;
  }

  it.each([
    'router-agent-handler.ts',
    'assistant-async-processor.ts',
    'lib/async-processor-core.ts',
  ])('%s posts no fixed line: what a person reads is a message template (ADR-062)', (file) => {
    // A literal as the content of a post or of a Lex reply is English in every conversation, in no
    // assistant's voice. Each is a message template instead, said with `templateLine` or `noticeLine`.
    expect(contentProse(read(SRC, file))).toEqual([]);
  });

  it('the check reads a fixed line where one is posted', () => {
    expect(contentProse(`formatLexResponse(e, [{ contentType: 'PlainText', content: 'Nothing has been stopped here.' }]);`))
      .toEqual(['Nothing has been stopped here.']);
    expect(contentProse(`x = { content: stopCopy?.line || 'There is nothing to stop.', y: 1 };`)).toEqual(['There is nothing to stop.']);
    expect(contentProse(`messages: [{ role: 'user', content: 'Revise this answer so it fits.' }]`)).toEqual([]);
    expect(contentProse(`{ content: templateLine('stop-ambiguous', words) }`)).toEqual([]);
  });

  /**
   * The prose string literals of a source outside comments, log calls and errors: what a library that composes a
   * person's lines would say in fixed English. Three words or more, so an identifier, a key or a marker is not prose.
   */
  function proseLiterals(src: string): string[] {
    const lines = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^'"`\n]*$/gm, '').split('\n');
    const found: string[] = [];
    let skip = 0;
    for (const line of lines) {
      if (/console\.(log|warn|error|info)\(|throw new|new \w*Error\(/.test(line)) skip = 3;
      if (skip > 0) { skip -= 1; continue; }
      for (const lit of line.matchAll(/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`/g)) {
        const text = (lit[1] ?? lit[2] ?? lit[3] ?? '').replace(/\$\{[^}]*\}/g, ' ');
        if (/[A-Za-z]{2,}[ ,]+[A-Za-z]{2,}[ ,.]+[A-Za-z]{2,}/.test(text)) found.push(text.trim());
      }
    }
    return found;
  }

  it.each([
    'lib/capability-refusal.ts', 'lib/turn-queue-status.ts', 'lib/turn-queue-notice.ts', 'lib/task-reference.ts',
    'lib/resumed-chain-delivery.ts', 'lib/attachment-budget.ts', 'lib/turn-private-followup.ts', 'lib/delivery-options.ts',
    'lib/onboarding-intake.ts', 'lib/task-notify.ts', 'lib/email-copy.ts', 'lib/join-recap.ts',
  ])('%s composes lines from message templates and holds no fixed line of its own (ADR-062)', (file) => {
    // A keyed copy map with shipped English beside it is a second template system: every line these
    // libraries compose is a message template, worded by the assistant's own, the classification's or the shipped.
    expect(proseLiterals(read(SRC, file))).toEqual([]);
  });

  it('the library check reads a fixed line, and passes over a log and an error', () => {
    expect(proseLiterals(`const DEFAULTS = { waiting: 'Reviewing what arrived here' };`)).toEqual(['Reviewing what arrived here']);
    expect(proseLiterals(`console.warn('[x] the notice could not be read', { a });`)).toEqual([]);
    expect(proseLiterals(`throw new Error('the platform ships no message template');`)).toEqual([]);
    expect(proseLiterals(`templateLine('queue-status', words, { section: 'label.waiting' })`)).toEqual([]);
  });

  it('the quick reply is chosen by intent, with no phrase list (ADR-062 decision 7)', () => {
    const src = read(SRC, 'lib/delivery-options.ts');
    expect(src).not.toMatch(/userMessage/);
    // A list of two or more lowercase phrases is what choosing by matching what a person typed looks like.
    expect(src).not.toMatch(/\[\s*'[a-z][a-z ]*'\s*,\s*'[a-z][a-z ]*'/);
    expect(src).toMatch(/quick-acknowledgment/);
  });
});

describe('tenet D3 - two enforcement layers on a sensitive operation', () => {
  it('no module on the turn path reads the task table directly', () => {
    // The service is the second layer only while callers go through the seam. Importing the fronted
    // functions from `task-tracking` instead compiles and passes every behavioral test.
    const FRONTED = ['getTask', 'createTask', 'updateTaskStatus', 'advanceTaskStateTo'];
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      // The seam itself is the one module allowed to, and the store module is what it fronts.
      if (rel === 'lib/task-store.ts' || rel === 'lib/task-tracking.ts') continue;
      // The task SERVICE is the other side of the boundary; it is supposed to reach the table.
      if (rel === 'task-service.ts') continue;
      const src = fs.readFileSync(file, 'utf8');
      for (const line of src.split('\n')) {
        if (!/^import \{/.test(line) || !/task-tracking\.js/.test(line)) continue;
        const named = line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'));
        for (const fn of FRONTED) {
          if (new RegExp(`(^|[,\s])${fn}\s*(,|$)`).test(named)) offenders.push(`${rel}: ${fn}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('tenet D15 - lifecycle is scoped to the prefix it is named for', () => {
  /**
   * THE RULE THIS GUARDS SHIPPED BROKEN, WHICH IS THE ONLY REASON IT IS WORTH A TEST.
   *
   * `DeleteOldAttachments`, `Expiration: 90 days`, was written with no prefix. Read back from the
   * deployed bucket its filter is `Prefix: ""`, so a rule named for member uploads also governs
   * `context/{classification}/` (the seeded company corpus), `platform-knowledge/` (the platform's
   * own self-knowledge) and `generated-docs/` (every assistant deliverable). It had not deleted
   * anything only because re-seeding during `validate` kept resetting the clock.
   *
   * A bucket-wide rule in a bucket with ONE key family is fine and this does not forbid it. What it
   * forbids is a bucket-wide rule in a bucket with several, because there the rule's name describes
   * one owner and its effect reaches all of them - and nobody reading the name would know.
   */
  /**
   * KNOWN BUCKET-WIDE EXPIRIES, each with the reason it is listed rather than fixed.
   *
   * Two kinds of entry, and the difference matters. A bucket with ONE key family may legitimately
   * carry a bucket-wide rule - the rule's name and its effect agree, and there is no other owner to
   * surprise. A bucket with SEVERAL is a finding, listed here only so this guard binds on the NEXT
   * one instead of being deleted for being red.
   */
  // KEYED `file::ruleId`, NOT BY FILE. Keyed by file, the allowlist exempted the FILE rather than the
  // rule it was written about, so a brand-new un-prefixed expiry added to any of these four stacks
  // stayed green - the opposite of "so this guard binds on the NEXT one". A rule with no `id` keys as
  // `(unnamed)`, and the suppression count below is what stops two unnamed rules sharing one entry.
  const BUCKET_WIDE_EXPIRY: Record<string, string> = {
    'notification-stack.ts::(unnamed)':
      'OK. Dedicated briefings bucket, one key family (`briefings/*`), and the objects are ephemeral by '
      + 'design - the presigned link TTL is 7 days and the rule is 30. Name and effect agree.',
    'conversations-stack.ts::DeleteOldAttachments':
      'FINDING. `DeleteOldAttachments`, 90 days, deployed with `Prefix: ""` over FOUR families: the '
      + 'seeded company corpus, platform self-knowledge, assistant deliverables and member uploads. '
      + 'Not yet fired because re-seeding resets the clock.',
    'archive-stack-aurora.ts::(unnamed)':
      'FINDING, and the most serious of the three. This is the CONVERSATION ARCHIVE, which tenet D7 '
      + 'calls "the system of record. Append-only, survives channel deletion, holds the full event '
      + 'sequence". Read back from the deployed bucket: `Expiration: 90 days`, `Filter: {Prefix: ""}`. '
      + 'A system of record with a 90-day expiry is a 90-day window.',
    'archive-stack.ts::(unnamed)':
      'FINDING. The Athena-mode archive carries the same 90-day bucket-wide rule, beside a correctly '
      + 'scoped 7-day rule on `client_events/event_type=unknown/` - so the file already knows how to '
      + 'write a scoped rule.',
  };

  it('no lifecycle rule in a multi-family bucket expires objects without naming its prefix', () => {
    const offenders: string[] = [];
    // How many offending rules each allowlist entry actually silenced. One entry may only ever stand
    // for ONE rule: `(unnamed)` is not a name, so without this a second unnamed un-prefixed expiry in
    // an already-listed file would be absorbed by the first one's entry and reported clean.
    const suppressed = new Map<string, number>();
    for (const file of fs.readdirSync(STACKS).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))) {
      const src = fs.readFileSync(path.join(STACKS, file), 'utf8');
      // EVERY `lifecycleRules:` IN THE FILE, not the first. No stack declares two today - each of the
      // four names exactly one - so this is not fixing an observed miss; it is removing the reason a
      // second bucket would be invisible, which is the cheaper half of the two.
      let cursor = 0;
      for (;;) {
        const open = src.indexOf('lifecycleRules:', cursor);
        if (open < 0) break;
        // Each `{ ... }` entry between `lifecycleRules: [` and its closing `]`. Brace-matched rather
        // than regex-split: a rule body contains braces (`Duration.days(30)` does not, but a
        // `transitions:` array does) and a naive split reports the wrong rule.
        const start = src.indexOf('[', open);
        // NO INLINE ARRAY MEANS STOP, AND THIS GUARD IS NOT HYPOTHETICAL TIDYING. On
        // `lifecycleRules: rules` or `lifecycleRules: buildRules()` there is no `[`, `start` is -1, the
        // brace matcher below then scans from the top of the file and resolves `end` to the first
        // bracket pair in it - almost certainly BEFORE `open` - so `cursor` moves backwards and the
        // next `indexOf` returns the same offset forever. An unkillable jest worker is the one failure
        // this repo has already paid a session's uncommitted work for.
        if (start < 0) break;
        let depth = 0;
        let end = start;
        for (let i = start; i < src.length; i += 1) {
          if (src[i] === '[') depth += 1;
          if (src[i] === ']') { depth -= 1; if (depth === 0) { end = i; break; } }
        }
        cursor = end + 1;
        const block = src.slice(start, end + 1);
        for (const entry of block.split(/\},\s*\{/)) {
          // Only EXPIRATION matters. `noncurrentVersionExpiration` prunes old VERSIONS of an object
          // its owner already replaced or deleted, which is not the cross-owner deletion this guards.
          if (!/(^|[^a-zA-Z])expiration:/.test(entry)) continue;
          if (/prefix:/.test(entry)) continue;
          const id = /id:\s*'([^']+)'/.exec(entry)?.[1] ?? '(unnamed)';
          const key = `${file}::${id}`;
          if (BUCKET_WIDE_EXPIRY[key]) {
            suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
            continue;
          }
          offenders.push(`${file}: lifecycle rule '${id}' expires objects with no prefix`);
        }
      }
    }
    for (const [key, count] of suppressed) {
      if (count > 1) {
        offenders.push(`${key}: ${count} un-prefixed expiring rules share this one debt entry, so `
          + `${count - 1} of them is unreviewed - give each an \`id\` and its own entry`);
      }
    }
    if (offenders.length) {
      throw new Error(
        `${offenders.join('\n')}\n\nA rule named for one key family must not govern the others. `
        + 'Scope it with `prefix`, or split it into one rule per family.',
      );
    }
    expect(offenders).toEqual([]);
  });

  // The debt list cannot be emptied by deleting its entries: every rule it names must still BE an
  // un-prefixed expiry, or the entry is stale and the finding it records has been fixed without
  // anyone saying so. This is the non-vacuity half - a guard whose allowlist has outgrown its subject
  // reports clean for a reason that has nothing to do with the rule.
  it('every named bucket-wide expiry still exists, so the debt list cannot go stale', () => {
    const stale: string[] = [];
    for (const key of Object.keys(BUCKET_WIDE_EXPIRY)) {
      const [file, id] = key.split('::');
      const full = path.join(STACKS, file);
      if (!fs.existsSync(full)) { stale.push(`${key}: listed but the file is gone`); continue; }
      const src = fs.readFileSync(full, 'utf8');
      if (!/lifecycleRules:/.test(src)) {
        stale.push(`${key}: listed but it declares no lifecycleRules any more - retire the entry`);
        continue;
      }
      // THE NAMED RULE, not just the file. An entry naming a rule the file no longer declares is a
      // finding someone fixed without saying so, and the test above would silently stop covering it.
      if (id !== '(unnamed)' && !src.includes(`id: '${id}'`)) {
        stale.push(`${key}: listed but no rule carries that id any more - retire the entry`);
      }
    }
    expect(stale).toEqual([]);
  });
});

/**
 * A Jest call that marks a test as an expected failure or leaves it out, in code (not in a comment): at the
 * start of a statement, or chosen inline (`synthesizes ? it : it.failing`), which parks a check as surely.
 */
const EXPECTED_FAILURE_OR_SKIP = /^\s*(it|test|describe)\.(failing|skip|todo)\b|^\s*x(it|test|describe)\(|^[^/*\n]*[?:]\s*\(?\s*(it|test|describe)\.(failing|skip|todo)\b/m;

describe('tenet D14 - a principal who is a person is their AppInstanceUser id', () => {
  /**
   * The amendment's guard is `a-person-is-their-app-instance-user.test.ts`: it refuses a caller read off
   * a token anywhere but the one resolver and the exchanges. This row keeps that guard where the tenet
   * says it is, scanning the trees it says it scans, and binding rather than parked.
   */
  const GUARD = path.join(__dirname, 'a-person-is-their-app-instance-user.test.ts');

  it('is guarded by a test that scans every tree a caller could be read in, and binds', () => {
    expect(fs.existsSync(GUARD)).toBe(true);
    const src = fs.readFileSync(GUARD, 'utf8');
    for (const root of ['backend/lambda', 'backend/scripts', 'scripts', 'frontend/packages']) {
      expect(src).toContain(`'${root}'`);
    }
    expect(src).toContain('backend/lambda/src/lib/auth.ts');
    expect(src).not.toMatch(EXPECTED_FAILURE_OR_SKIP);
  });
});

describe('tenet D10 - a deployment stands up only the capabilities it declares', () => {
  /**
   * The amendment's guard is the configuration matrix in `deploy-matrix/`: one file per configuration,
   * each synthesizing the real app in both analytics modes and checking its stack set, the component
   * rule, additivity against the configuration before it, and every SSM read's edge to its writer.
   */
  const MATRIX = path.join(__dirname, 'deploy-matrix');

  it('is guarded by the configuration matrix, one file per configuration', () => {
    expect(fs.existsSync(path.join(MATRIX, 'configurations.ts'))).toBe(true);
    expect(fs.existsSync(path.join(MATRIX, 'matrix.ts'))).toBe(true);
    const files = fs.readdirSync(MATRIX).filter((f) => /\.test\.ts$/.test(f));
    expect(files.filter((f) => fs.readFileSync(path.join(MATRIX, f), 'utf8').includes('describeConfiguration(')).length)
      .toBeGreaterThanOrEqual(9);
  });

  it('holds for every configuration, with no check in the matrix an expected failure', () => {
    const parked: string[] = [];
    for (const f of fs.readdirSync(MATRIX).filter((x) => /\.ts$/.test(x))) {
      if (EXPECTED_FAILURE_OR_SKIP.test(fs.readFileSync(path.join(MATRIX, f), 'utf8'))) parked.push(f);
    }
    expect(parked).toEqual([]);
  });
});

describe('the hook that surfaces all of this', () => {
  const HOOK = path.join(__dirname, '..', '..', '.claude', 'hooks', 'tenets.js');

  it('exists and is wired into the prompt hooks', () => {
    expect(fs.existsSync(HOOK)).toBe(true);
    const settings = fs.readFileSync(
      path.join(__dirname, '..', '..', '.claude', 'settings.json'), 'utf8');
    expect(settings).toContain('tenets.js');
  });

  it('reads the tenets from the document rather than restating them', () => {
    // A hardcoded copy is a snapshot, and snapshots rot faster than the documents they describe. If
    // a tenet is edited, the hook must surface the edit rather than the version it was written with.
    const hook = fs.readFileSync(HOOK, 'utf8');
    expect(hook).toContain('TENETS.md');
    expect(hook).toMatch(/readFileSync/);
  });

  it('can never block a turn', () => {
    // A hook that refuses work on a keyword match is worse than none: the false positives train
    // people to route around it, and then it catches nothing.
    const hook = fs.readFileSync(HOOK, 'utf8');
    expect(hook).toContain('process.exit(0)');
    expect(hook).not.toMatch(/process\.exit\([1-9]/);
  });
});
