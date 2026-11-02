/**
 * THE STOP QUESTION OWNS ITS FOLLOW-UP (ADR-033, owner 2026-09-14).
 *
 * `/stop` cancels the work in progress and asks how the person wants to proceed. Their answer is the
 * next thing they say, in their own words, and ordinary routing cannot be trusted with it.
 *
 * ── OBSERVED LIVE, 2026-09-10 ───────────────────────────────────────────────────────────────────
 *
 * The evaluation asked at 17:20:54. "Drop it, I do not want that report" ran at 17:21:05 as a
 * completely healthy turn and was classified `intent: general`, because nothing told that turn a
 * question was outstanding. A directive on the ordinary turn was the next attempt, and it still left
 * the answer to a turn whose routing had already decided what the message was.
 *
 * So the router reads the message against the question BEFORE drift, the declining guard, the quick
 * reply or task routing, and each reading ends the question: `leave` confirms and returns, `again`
 * routes the restarted request, `other` routes the message as sent.
 */

import {
  buildStopAnswerReading,
  parseStopAnswer,
  restartedRequest,
} from '../../lambda/src/lib/stop-evaluation';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

describe('the reading put to the classifier model', () => {
  const reading = buildStopAnswerReading({
    requests: [{ text: 'Compile a report on our Q2 ARR performance', private: false }],
    message: 'Drop it, I do not want that report.',
  });

  it('shows the cancelled work and the message, so the answer is read against the question', () => {
    expect(reading).toContain('Compile a report on our Q2 ARR performance');
    expect(reading).toContain('Drop it, I do not want that report.');
  });

  it('asks for exactly one word from a closed set', () => {
    for (const word of ['LEAVE', 'AGAIN', 'OTHER']) expect(reading).toContain(word);
    expect(reading).toMatch(/exactly one word/i);
  });

  it('counts a narrowed or corrected version as starting again', () => {
    // "just the EMEA numbers" is still the work, in a different shape. Reading it as `other` would
    // route it as a bare fragment with nothing to be a fragment of.
    expect(reading).toMatch(/AGAIN[^\n]*narrowed or corrected/);
  });

  it('still reads when the requests were not recorded', () => {
    expect(buildStopAnswerReading({ requests: [], message: 'forget it' })).toContain('(not recorded)');
  });
});

describe('reading the answer back', () => {
  it('takes the word, whatever the case or punctuation around it', () => {
    expect(parseStopAnswer('LEAVE')).toBe('leave');
    expect(parseStopAnswer(' again.')).toBe('again');
    expect(parseStopAnswer('Other\n')).toBe('other');
  });

  it('is undefined, never a guess, when the reply is not one of the three', () => {
    // Undefined keeps the question standing; `other` would close it. A failed call must not close a
    // question nobody answered.
    expect(parseStopAnswer(undefined)).toBeUndefined();
    expect(parseStopAnswer('')).toBeUndefined();
    expect(parseStopAnswer('DROP')).toBeUndefined();
    expect(parseStopAnswer('I think they want to leave it')).toBeUndefined();
  });
});

describe('restarting the cancelled work', () => {
  const publicReq = { text: 'Compile a report on our Q2 ARR performance', private: false };
  const privateReq = { text: 'Summarize the layoffs plan', private: true };

  it('is what they asked for, then what they said about it, with nothing wrapped around it', () => {
    // Scaffolding around a person's words is the shape the input guardrail's prompt-attack filter
    // refuses, so the restarted message is only their own text.
    expect(restartedRequest({ requests: [publicReq], followUp: 'Yes, but EMEA only', followUpIsPrivate: false }))
      .toBe('Compile a report on our Q2 ARR performance\n\nYes, but EMEA only');
  });

  it('never restores a private request into a reply to a public message', () => {
    // The restarted turn answers with this message's visibility, so restoring a privately made
    // request here would publish the one thing its targeting withheld.
    expect(restartedRequest({ requests: [privateReq], followUp: 'start again', followUpIsPrivate: false }))
      .toBeUndefined();
    expect(restartedRequest({ requests: [publicReq, privateReq], followUp: 'again', followUpIsPrivate: false }))
      .toBe('Compile a report on our Q2 ARR performance\n\nagain');
  });

  it('restores a private request when the answer is itself private', () => {
    expect(restartedRequest({ requests: [privateReq], followUp: 'start again', followUpIsPrivate: true }))
      .toBe('Summarize the layoffs plan\n\nstart again');
  });

  it('has nothing to restart from when no request text was recorded', () => {
    expect(restartedRequest({ requests: [{ text: '', private: false }], followUp: 'again', followUpIsPrivate: false }))
      .toBeUndefined();
  });
});

describe('the router reads the answer before it routes anything', () => {
  const router = read('lambda/src/router-agent-handler.ts');
  const at = router.indexOf('THE STOP QUESTION OWNS ITS FOLLOW-UP');
  const block = router.slice(at, router.indexOf('const driftResponse', at));

  it('the block exists, so the assertions below are not vacuous', () => {
    expect(at).toBeGreaterThan(-1);
    expect(block.length).toBeGreaterThan(1000);
  });

  it('runs before drift, the declining guard, the quick reply and task routing', () => {
    // Each of those can claim the message for something else. Drift RETURNS; the declining guard
    // RETURNS; the quick reply RETURNS; task routing opens or absorbs a task.
    const drift = router.indexOf('const driftResponse = isMachineWrittenTurn');
    const decline = router.indexOf("a turn is already owed on this task; declining to start a second");
    const quick = router.indexOf('const quickResponse = quickReply(');
    // Matched on the call, not its full argument list: what this asserts is ORDER, and pinning every
    // argument made it fail the day one was added (the classified pack), which says nothing about order.
    const deliver = router.indexOf('selectDeliveryOption(classification.intent');
    for (const [name, later] of Object.entries({ drift, decline, quick, deliver })) {
      // Named, so a -1 reports WHICH anchor moved rather than "expected > 236159, received -1".
      expect(later).toBeGreaterThan(-1);
      expect({ [name]: later > at }).toEqual({ [name]: true });
    }
  });

  it('never reads a machine-written turn, and reads as the SPEAKER', () => {
    // A stop evaluation's own prompt is not somebody answering it, and a question put to one person
    // is not another member's to answer.
    expect(block).toContain('if (!isMachineWrittenTurn(event) && !isAmendmentFold(event) && channelArn && personId)');
    expect(block).toMatch(/readStopDecision\(\{\s*channelArn, responderId: stopResponderId, speakerId: personId,/);
    const lock = read('lambda/src/lib/turn-lock.ts');
    expect(lock).toContain('if (pending.askedOf !== args.speakerId) return undefined;');
  });

  it('reads with a model call on the classifier model, not a word list', () => {
    expect(block).toContain('parseStopAnswer(await classifierReading(');
    expect(block).toContain('{ modelId: classifierModelId }');
    expect(read('lambda/src/lib/stop-evaluation.ts')).not.toMatch(/DROP_ANSWERS|KEEP_ANSWERS/);
  });

  it('closes the question on any reading, and leaves it standing when there is none', () => {
    expect(block).toMatch(/if \(answer\) \{\s*await clearStopDecision\(/);
  });

  it('confirms `leave` in the configured words and returns', () => {
    const leave = block.slice(block.indexOf("if (answer === 'leave')"), block.indexOf("if (answer === 'again')"));
    expect(leave).toContain("templateLine('stop-left-cancelled', await turnWords())");
    expect(leave).toContain('return formatLexResponse(');
  });

  it('routes `again` as the restarted request, classified afresh', () => {
    const again = block.slice(block.indexOf("if (answer === 'again')"));
    expect(again).toContain('userMessage = restarted;');
    expect(again).toMatch(/Object\.assign\(classification, usesLlmClassifier\s*\?\s*await classifyIntent\(restarted/);
  });

  it('pays for the visibility lookup only when a private request is at stake', () => {
    const again = block.slice(block.indexOf("if (answer === 'again')"));
    expect(again).toMatch(/requests\.some\(\(r\) => r\.private\)\s*\?\s*!!\(await inboundMessage\(\)\)\.targeted/);
  });
});

describe('the record that carries the question forward', () => {
  const lock = read('lambda/src/lib/turn-lock.ts');
  const router = read('lambda/src/router-agent-handler.ts');

  // THE GUARD EXPRESSION ITSELF, not the function text: the prose above each guard names the wrong gate
  // on purpose (it explains the defect), and a bare search for the symbol finds the explanation.
  const firstGate = (fn: string): string => {
    const at = lock.indexOf(`export async function ${fn}(`);
    expect(at).toBeGreaterThan(-1);
    const rel = lock.slice(at).indexOf('if (!turn');
    expect(rel).toBeGreaterThan(-1);
    return lock.slice(at + rel, at + rel + 40);
  };

  it('gates on the TABLE and never on the queue flag, so the hatch works without queueing', () => {
    // Suppressing an answer somebody asked to stop is not part of queueing, and neither is reading
    // what they said to do next. Asserted at source level because the failure is a configuration this
    // suite does not deploy.
    for (const fn of ['rememberStopDecision', 'readStopDecision', 'clearStopDecision', 'recordStop', 'wasStoppedSince']) {
      expect(firstGate(fn)).toContain('turnStopEnabled()');
      expect(firstGate(fn)).not.toContain('turnQueueEnabled()');
    }
  });

  it('remembers exactly the work the stop cancelled, and what each piece was', () => {
    expect(router).toContain('taskIds: held.map(({ summary }) => summary.taskId)');
    expect(router).toMatch(/requests: held\.map\(\(\{ full \}\) => \(\{[\s\S]{0,200}private: isPrivateVisibility\(full\.visibility\)/);
  });

  it('reads an older record without requests as private-by-default and restartable from nothing', () => {
    expect(lock).toContain("private: r.private !== false");
  });

  it('does not hold the conversation waiting for the answer', () => {
    // A stop RELEASES deliberately. Holding the lock until they answer would turn an escape hatch
    // into a second thing that has to be escaped.
    expect(lock).toContain('NOT `awaitingPerson`, and not the lock');
  });

  it('the processor no longer reads or settles the question', () => {
    // Two readers of one question would settle it twice, or disagree about how.
    const proc = read('lambda/src/assistant-async-processor.ts');
    expect(proc).not.toContain('readStopDecision');
    expect(proc).not.toContain('clearStopDecision');
    expect(proc).not.toContain('cancelStoppedTasks');
  });
});

/**
 * WHAT A MESSAGE ANSWERS IS DECLARED, NOT RECONSTRUCTED.
 *
 * An exchange is "an assistant answered this message", and the turn knows which message that is:
 * `userMessageId` is defined on the event as exactly that. Archival did not use it - it rebuilt the
 * pairing from a `<!--corr:` marker in the CONTENT, a one-hour reply bound, an absence of intervening
 * user messages, and a 24-hour lookback.
 *
 * Each proxy fails in a way the declared fact does not. The marker lives in content, so a reply the
 * PROCESSOR posts itself carries none and can never pair however plainly it is an answer. The bounds
 * are inference about intent. The lookback makes a missed pairing permanent. Measured live: 62
 * unpaired bot rows carrying ordinary turn intents that no marker rule could have paired, and 48 that
 * were marked and still did not.
 *
 * The precedent is two lines above the stamp: `trigger` is carried inline as "THE DECLARED CAUSE"
 * because deriving it downstream "recorded null on every turn ever measured". Same failure, same fix.
 */
describe('the answer says what it is answering', () => {
  const core = read('lambda/src/lib/async-processor-core.ts');

  // A handed-over turn declares the handover message instead (`answersMessageId`, lib/assistant-handover.ts),
  // which is where its work started; otherwise the message the turn was given.
  const STAMP = 'answersMessageId: event.answersMessageId || event.userMessageId';

  it('stamps the id the turn was given, or the handover it took over', () => {
    expect(core).toContain(`...((event.answersMessageId || event.userMessageId) && { ${STAMP} }),`);
  });

  it('rides the update the turn already performs, beside the other declared fact', () => {
    // Costs nothing: no extra write, no extra read. It lands on the UPDATE row, which is where
    // archival already reads `intent` from, so the builder can find it in the place it already looks.
    const at = core.indexOf(STAMP);
    expect(at).toBeGreaterThan(-1);
    // From the declaration the stamp sits in, not a fixed window: the object grows as facts are added.
    const declared = core.lastIndexOf('const messageMetadata', at);
    expect(declared).toBeGreaterThan(-1);
    const near = core.slice(declared, at);
    expect(near).toContain('trigger: event.trigger');
  });

  it('declares only when the id was already paid for', () => {
    // Absent means no component has resolved it, and this is not the place to buy it: a channel read
    // here sits in front of the person's answer. The heuristic remains for those rows, so the change
    // is additive and needs no backfill.
    expect(core).toContain('(event.answersMessageId || event.userMessageId) &&');
    const at = core.indexOf(STAMP);
    expect(core.slice(at - 700, at)).toMatch(/WHEN KNOWN, NOT AT ANY PRICE/);
  });
});

/**
 * A READING IS QUEUE WORK, AND SAYS SO.
 *
 * A reading answers a BURST, not a message, so there is no single id it could name. It declares its
 * KIND instead, and queue analytics owns it: drain depth, time to drain, work created.
 *
 * ── WHY DECLARING IT MATTERS WHEN IT ALREADY DOES NOT PAIR ──────────────────────────────────────
 *
 * It fails to mint an exchange today by ACCIDENT: it posts its proposal as a fresh message with no
 * `<!--corr:` marker, and the pairing rule happens to require one. That same coincidence lets a
 * broadcast answer - a real reply to a real message - go unpaired too, so the exclusion cannot be read
 * as intent by anyone downstream. Saying which it is makes the two separable: this one belongs outside
 * the exchange population, and the other is a defect.
 */
describe('a reading declares that it is queue work', () => {
  const core = read('lambda/src/lib/async-processor-core.ts');

  it('stamps the kind rather than relying on failing to pair', () => {
    expect(core).toContain("{ turnKind: 'reading'");
  });

  it('carries what the drain actually did, not just that it happened', () => {
    // A count of readings says nothing. A reading that read four messages on its second pass says
    // what happened, and is the unit queue analytics is built on.
    const at = core.indexOf("{ turnKind: 'reading'");
    expect(at).toBeGreaterThan(-1);
    expect(core.slice(at, at + 200)).toContain('queueRead: event.triage.ids.length');
    expect(core.slice(at, at + 200)).toContain('queuePass: event.triage.pass');
  });

  it('says nothing on an ordinary turn', () => {
    // Gated on the reading's own ids, so a normal answer carries no queue fields at all and the
    // population stays clean from both sides.
    const at = core.indexOf("{ turnKind: 'reading'");
    expect(core.slice(at - 220, at)).toContain('event.triage?.ids.length');
  });
});

/**
 * EVERY TURN THAT ANSWERS SOMETHING SAYS WHAT (2026-09-10).
 *
 * The declaration is only worth having where the turn actually has the id. Three dispatch sites can:
 * the ordinary turn, the amendment fold, and the stop evaluation. Each is additive - absent means the
 * pairing falls back to the inference it always used - so the test is that they declare when they CAN,
 * never that they buy the id to do it.
 */
describe('the fold and the stop declare their targets too', () => {
  const core = read('lambda/src/lib/async-processor-core.ts');
  const stop = read('lambda/src/lib/stop-evaluation.ts');
  const router = read('lambda/src/router-agent-handler.ts');

  it('a fold answers the same message the turn was already answering', () => {
    // A fold is a re-run of ONE turn, not a new one. Declaring a different target - or none - would
    // make the amended pass a separate exchange from the turn it replaces.
    const at = core.indexOf('dispatchAmendedTurn({');
    expect(at).toBeGreaterThan(-1);
    expect(core.slice(at, at + 900)).toContain(
      '...(event.userMessageId ? { userMessageId: event.userMessageId } : {}),',
    );
  });

  it('a stop evaluation answers the stop', () => {
    expect(stop).toContain('...(args.userMessageId ? { userMessageId: args.userMessageId } : {}),');
  });

  it('the stop takes the id only when a bypass caller declared it', () => {
    // The Lex path cannot supply one - Amazon Chime SDK sends Lex three request attributes and the
    // message id is not among them - and resolving it here would put a channel read on the one path
    // whose whole promise is immediacy.
    const at = router.indexOf('dispatchStopEvaluationTurn({');
    expect(at).toBeGreaterThan(-1);
    expect(router.slice(at, at + 6000)).toContain('BYPASS_MESSAGE_ID_ATTR');
  });
});

describe('the question about a stop never opens work of its own', () => {
  it('a stop-evaluation turn is not classified, so its prompt about the cancelled work cannot start that work again', () => {
    // Measured live 2026-09-15: the prompt for a stopped report classified as REPORT_GENERATION and the
    // question turn opened a new report, so "start it again" continued that task instead of restarting.
    const src = read('lambda/src/router-agent-handler.ts');
    const at = src.indexOf('const isStopQuestionTurn = !!parseStopEvaluationContext(');
    expect(at).toBeGreaterThan(-1);
    const decl = src.slice(at, src.indexOf("markRouterStep('classified');", at));
    expect(decl).toMatch(/isStopQuestionTurn\s*\?\s*\{ intent: IntentType\.GENERAL/);
    expect(decl.indexOf('IntentType.GENERAL')).toBeLessThan(decl.indexOf('classifyIntent('));
  });
});
