/**
 * AN EXCHANGE IS DECLARED BY THE TURN, NOT RECONSTRUCTED FROM EVIDENCE.
 *
 * An exchange is "an assistant answered this message", and the turn knows which message that is:
 * `userMessageId` is defined on the event as exactly that. Archival did not use it. It rebuilt the
 * pairing from four proxies - a `<!--corr:` marker in the CONTENT, a one-hour reply bound, an absence
 * of intervening user messages, and a 24-hour lookback - in two places that did not even agree with
 * each other.
 *
 * ── THE TWO PATHS DISAGREED, WHICH IS THE PART NOBODY HAD NOTICED ───────────────────────────────
 *
 * `createExchangesFromDatabase` (the sweep) applies all four tests. `createExchangesFromRecords`
 * (in-batch) applied NONE: it took the first bot message after a user message and inserted. So the
 * same conversation paired by different rules depending on whether both halves landed in one Kinesis
 * batch - and during a drain the reading's proposal is often the first thing back, so it claimed the
 * pairing and the real answer arrived to find the turn already taken.
 *
 * An answer is paired by what it declares, not by adjacency, which stays reliable when messages queue
 * and interleave. The in-batch path applies the sweep's own three tests
 * where nothing was declared, from one definition of the bound rather than two.
 *
 * ── WHAT EACH PROXY COST ────────────────────────────────────────────────────────────────────────
 *
 * The marker lives in content, so a reply the PROCESSOR posts itself carries none: the broadcast
 * answer (`async-processor-core.ts:3570`) is a real reply to a real message and could never pair.
 * The bounds are inference about intent. The lookback makes a missed pairing permanent. Measured on
 * the deployment 2026-09-10: 62 unpaired bot rows carrying ordinary turn intents (`general`,
 * `financial_metric`) and 48 that were marked and still did not pair.
 *
 * Additive by construction: a row with no declaration takes the identical path it always took, so
 * nothing regresses and no backfill is needed.
 */
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

const archival = read('lambda/src/analytics-aurora/kinesis-archival.ts');
const core = read('lambda/src/lib/async-processor-core.ts');

/**
 * Compare SQL by its tokens rather than by its indentation.
 *
 * These assertions are about WHICH COLUMNS a query reads, and a reformat that changes nothing about
 * that should not fail them - nor should it be able to hide a removed COALESCE branch behind a
 * whitespace diff.
 */
const flat = (s: string) => s.replace(/\s+/g, ' ');
const archivalSql = flat(archival);

describe('the turn declares what it answered', () => {
  it('stamps the id it was given, on the update it already performs', () => {
    // A handed-over turn declares the HANDOVER it answers (answersMessageId); every other turn the
    // person's message it was given (userMessageId).
    expect(core).toContain('...((event.answersMessageId || event.userMessageId) && { answersMessageId: event.answersMessageId || event.userMessageId }),');
  });

  it('pairs a handover only with the reply its receiver declared, and never as a reply itself', () => {
    expect(archival).toContain('function isHandoverRecord(');
    expect(archival).toContain('if (isHandoverRecord(botRecord)) continue;');
    expect(archival).toContain("declaredTarget !== userRecord.message_id || botRecord.sender_arn !== userRecord.targeted_to");
    expect(archivalSql).toContain("AND NOT (COALESCE(am.metadata, '{}'::jsonb) ? 'aeHandover')");
    expect(archivalSql).toContain("OR (COALESCE(um.metadata, '{}'::jsonb) ? 'aeHandover' AND am.sender_arn = um.targeted_to");
  });

  it('carries the declaration onto the archival record, for both paths to read', () => {
    // The in-batch path has no SQL to read metadata JSON with; it works from flattened fields.
    expect(archival).toContain('answers_message_id: answersMessageId,');
    expect(archival).toContain('turn_kind: turnKind,');
  });

  it('reads a declaration out of CONTENT too, which is all a handler-answered turn has', () => {
    // A DIRECT answer is returned by the Lex fulfillment and materialized by Amazon Chime SDK, and a
    // fulfillment return carries no message metadata at all. Without this the fastest turn in the
    // system could never declare anything, whatever it said.
    expect(archival).toContain('const declared = isBot ? turnDeclarationOf(content) : {};');
    expect(archival).toContain('? analytics.answersMessageId : (declared.answers || null)');
    expect(archival).toContain('analytics.deliveryOption || declared.delivery || null');
  });

  it('reads a content declaration off BOT records only', () => {
    // A declaration is a statement a turn makes about its own answer. Read off a person's message it
    // would let anyone who can type assert who answered what.
    expect(archival).toContain('isBot ? turnDeclarationOf(content) : {}');
  });
});

describe('the in-batch path, which had no correctness at all before this', () => {
  it('obeys a declared target rather than taking the first bot message', () => {
    expect(archival).toContain(
      'if (declaredTarget && declaredTarget !== userRecord.message_id) continue;',
    );
  });

  it('reads the declaration off the UPDATE row, which is the only row that carries one', () => {
    // The stamp lands on the update the turn already performs, because the placeholder is created
    // before the turn knows what it answered. This path read the CREATE row alone, and found the
    // update below the checks - so every processor-delivered answer, which is the whole population
    // the declaration was added for, looked undeclared to the pairer that runs first.
    expect(archivalSql).toContain(
      flat('const declaredTarget = updateRecord?.answers_message_id || botRecord.answers_message_id;'),
    );
    expect(archival).toContain(
      'const declaredKind = updateRecord?.turn_kind || botRecord.turn_kind;',
    );
  });

  it('skips a declared kind by the closed set, not by naming one kind', () => {
    // Every kind a turn may declare is a non-answer by construction, and an ordinary answer declares
    // none. Testing `=== 'reading'` was already stale the moment `drift` was added.
    expect(archival).toContain('if (declaredKind) continue;');
    expect(archival).not.toContain("botRecord.turn_kind === 'reading'");
  });

  it('CONTINUES rather than breaking, because the real answer may be further down the batch', () => {
    // `break` here would abandon the user message entirely the moment a reading appeared, which is
    // the same defect one layer along: the turn goes unpaired rather than mispaired.
    const at = archival.indexOf('if (declaredKind) continue;');
    expect(at).toBeGreaterThan(-1);
    expect(archival.slice(at, at + 60)).toContain('continue;');
  });

  it("applies the sweep's three tests where nothing was declared, rather than none", () => {
    const at = archival.indexOf('AND WHERE NOTHING WAS DECLARED, THIS PATH STOPS GUESSING');
    expect(at).toBeGreaterThan(-1);
    const block = archival.slice(at, at + 4000);
    expect(block).toContain('if (!declaredTarget) {');
    expect(block).toContain('isResponseAnchored(botRecord.content');
    expect(block).toContain('REPLY_BOUND_MS');
    expect(block).toContain('interveningUser');
  });

  it('makes the guess from ONE definition, so the two paths cannot drift apart', () => {
    // The bound was a literal in the SQL and absent from the TypeScript, so the in-batch pairer could
    // not have applied it even once it started trying - and a later edit would change the rule for
    // half the rows with nothing failing.
    expect(archival).toContain('const REPLY_BOUND_MINUTES = 60;');
    expect(archival).toContain("INTERVAL '${REPLY_BOUND_MINUTES} minutes'");
  });

  it('states how the pair was made rather than leaving it to be read off an absence', () => {
    expect(archival).toContain("declaredTarget ? 'declared' : 'in_batch',");
  });
});

describe('the sweep', () => {
  it('pairs on the declaration where there is one, with none of the guesses attached', () => {
    expect(archivalSql).toContain(flat(`COALESCE(
             am_upd.answers_message_id, am.answers_message_id,
             am_upd.metadata->>'answersMessageId', am.metadata->>'answersMessageId'
           ) = um.message_id`));
  });

  it('reads the COLUMN before the JSON, so a content declaration reaches it too', () => {
    // A placeholder is created before the turn knows what it answered, so the CREATE row's metadata
    // is the wrong place to ask - the same reason `intent` is read from the UPDATE row. And the
    // column is the archival fold of whichever carrier the turn had, which for a DIRECT answer is
    // content and never metadata.
    const at = archival.indexOf('am_upd.answers_message_id, am.answers_message_id,');
    expect(at).toBeGreaterThan(-1);
  });

  it('keeps the inference for rows that declared nothing, so nothing regresses', () => {
    const at = archival.indexOf('INFERRED: the pre-declaration fallback');
    expect(at).toBeGreaterThan(-1);
    const block = flat(archival.slice(at, at + 2600));
    expect(block).toContain("am.content LIKE '%<!--corr:%'");
    expect(block).toContain("INTERVAL '${REPLY_BOUND_MINUTES} minutes'");
    expect(block).toContain('nxt.is_bot = false');
  });

  it('applies the fallback ONLY where nothing was declared', () => {
    const at = archival.indexOf('INFERRED: the pre-declaration fallback');
    const block = flat(archival.slice(at, at + 1200));
    expect(block).toContain(flat("am.metadata->>'answersMessageId' ) IS NULL"));
  });

  it('excludes a declared kind because it SAYS what it is, not because it lacks a marker', () => {
    // The marker coincidence also excludes a broadcast answer, which is a real reply, so absence
    // could never be read as intent. Saying which it is makes the two separable.
    //
    // And the test is the CLOSED SET: "did it declare a kind", not "is it a reading". A kind added
    // later is excluded the day its producer ships rather than the day somebody remembers this line.
    expect(archivalSql).toContain(flat(`AND (COALESCE(
               am_upd.turn_kind, am.turn_kind,
               am_upd.metadata->>'turnKind', am.metadata->>'turnKind'
             ) IS NULL`));
    // With one exception, which is still declared: a queue notice whose message reached a final answer
    // holds the answer written into it when it could not be posted at the end.
    expect(archivalSql).toContain("= 'queue_ack' AND am.agent_final_at IS NOT NULL))");
  });

  it('records the delivery option, which it never did', () => {
    // exchanges.delivery_option has existed since 001 and only the in-batch pairer ever set it, so
    // every exchange this path minted landed in the `unknown` bucket whatever the turn actually did.
    expect(archivalSql).toContain(flat(`COALESCE(
           am_upd.delivery_option, am.delivery_option,
           am_upd.metadata->>'deliveryOption', am.metadata->>'deliveryOption'
         )`));
  });

  it('says which of its rows were declared, which were named by the marker, and which were swept', () => {
    // Recording a delivery option here makes this necessary rather than tidy: `latency_metrics`
    // partitioned TTFF on `delivery_option IS NULL` as a stand-in for "the sweep minted this", and
    // that partition kept 93% of a seven-day total out of the headline.
    //
    // THREE CARRIERS, NOT TWO. `mention` is a pairing the CORRELATION MARKER named: on the
    // channel-flow path the id is minted as mention-<MessageId>, so the turn identity is derived from
    // the very message being answered. That is declaration-grade evidence and must not be filed under
    // `swept`, which readers exclude from the TTFF average as a guess.
    expect(archivalSql).toContain(flat("THEN 'declared'"));
    expect(archivalSql).toContain(flat("THEN 'mention'"));
    expect(archivalSql).toContain(flat("ELSE 'swept' END"));
  });

  it('pairs on the mention marker without a time bound or an intervening-message test', () => {
    // Those tests exist only to GUESS at what the marker states outright, so applying them to it
    // would reintroduce the failure it fixes: an answer refused a pairing because the person typed
    // again while the assistant was working. Measured live at 77 unpaired corr-marked answers in
    // three days, every one of them a real answer carrying an intent.
    const at = archivalSql.indexOf("OR substring(am.content from '<!--corr:mention-");
    expect(at).toBeGreaterThan(-1);
    // The clause is a peer of the declared one, not nested inside the inferred branch - which is
    // gated on the declaration being absent and carries all three of the guesses.
    const inferredAt = archivalSql.indexOf('INFERRED: the pre-declaration fallback');
    expect(at).toBeLessThan(inferredAt);
  });

  it('leaves the queued many-to-one pass alone', () => {
    // A burst folded onto a running turn already pairs many-to-one through answered_queued. The
    // mention clause is about the 1:1 case and must not disturb it.
    expect(archivalSql).toContain('answered_queued');
  });
});
