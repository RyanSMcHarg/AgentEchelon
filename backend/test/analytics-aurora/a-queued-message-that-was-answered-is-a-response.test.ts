/**
 * A QUEUED MESSAGE THAT WAS ANSWERED IS A RESPONSE, AND ITS ROW SAYS IT WAITED.
 *
 * "Queued responses are still responses. They should be tracked as responses for all messages being
 * answered in the queue but clearly labeled as messages that were in queue so they can be looked at
 * separate from exchanges that are 1 to 1."
 *
 * ── WHY THIS IS NOT THE MAPPING ADR-033 REFUSED ────────────────────────────────────────────────
 *
 * That record argues an affordance marking each queued message with the answer that addressed it
 * "has no correct behavior to implement: the mapping does not exist". The objection is about
 * INFERRING the mapping from adjacency or transcript ordering, and it stands for that. Nothing here
 * infers: the reading produces one entry per queued message and labels it `amends`, `new` or
 * `unclear`, and the turn that folds the `amends` entries into its answer writes down which ids it
 * folded. Three messages folded into one reply produce three rows pointing at that reply.
 *
 * The tests below are in that order: the reading declares, the fold carries the declaration, the
 * archive flattens it, one row is minted per id with the label, and a 1:1 exchange is NOT labeled.
 */
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

const archival = read('lambda/src/analytics-aurora/kinesis-archival.ts');
const core = read('lambda/src/lib/async-processor-core.ts');
const triage = read('lambda/src/lib/turn-triage.ts');
const proposal = read('lambda/src/lib/turn-triage-proposal.ts');
const router = read('lambda/src/router-agent-handler.ts');

const SCHEMA_DIR = path.resolve(__dirname, '../../lambda/src/analytics-aurora/schema');
const migration = (name: string) => fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8');
const m052 = migration('052-a-queued-message-that-was-answered-is-a-response.sql');

/** Compare SQL by its tokens rather than by its indentation. */
const flat = (s: string) => s.replace(/\s+/g, ' ');
/**
 * The SQL with its `--` explanations removed.
 *
 * Needed by every assertion that flattens: flattening merges a comment into the line after it, so a
 * clause with an explanation above it can never be matched. It also keeps a comment ABOUT a trap
 * from being read as the trap - this file's own "no CONCURRENTLY" note is the first example.
 */
const code = (s: string) => s.replace(/--[^\n]*/g, '');

describe('triage declares the mapping, which is what this whole decision rests on', () => {
  it('records one entry per queued message, never merging two into one item', () => {
    // `parseTriageProposal` refuses a repeated id and refuses an id that was not queued, so a
    // reading cannot classify a message that does not exist or name one twice.
    expect(proposal).toContain('if (!expected.has(messageId)) return null;');
    expect(proposal).toContain('if (seen.has(messageId)) return null;');
  });

  it('gives each queued request its own task keyed to its own message', () => {
    // ADR-033: "the task carries userMessageId set to the queued message id". This is the half of
    // the mapping that goes to the TASK surface; the fold below is the half that gets answered.
    expect(proposal).toContain('userMessageId: item.messageId,');
  });
});

describe('the fold writes the mapping down at the moment it becomes true', () => {
  it('the dispatch declares the queued ids the answer will address', () => {
    expect(triage).toContain('foldedMessageIds: args.foldedMessageIds?.length');
    expect(triage).toContain('? args.foldedMessageIds');
    expect(triage).toContain(': amendments.map((m) => m.messageId),');
  });

  it('accumulates across folds, so a second fold does not drop the first batch', () => {
    expect(flat(core)).toContain(flat(`foldedMessageIds: [
            ...(event.foldedMessageIds ?? []),
            ...foldable.map((m) => m.messageId),
          ],`));
  });

  it('survives the router hop as a checked value, never a mangled id', () => {
    // A request attribute is a string a hop may truncate, and a half-written id names nothing while
    // looking exactly like a value - the same rule `turn-declaration.ts` applies to its own marker.
    expect(router).toContain("const BYPASS_FOLDED_IDS_ATTR = 'AE.turn.foldedIds';");
    expect(router).toContain('req.foldedMessageIds?.filter(isDeclarableValue).length');
    expect(router).toContain('.filter((id) => id && isDeclarableValue(id));');
  });

  it('the answer stamps what it addressed, and that field is not shed under size pressure', () => {
    expect(core).toContain('...(event.foldedMessageIds?.length ? { answeredQueued: event.foldedMessageIds } : {}),');
    // It is the only record these messages will ever have of being answered. A field dropped to
    // save a step metric would lose them.
    const shedOrder = core.slice(core.indexOf('const METADATA_SHED_ORDER'), core.indexOf('export function safeMetadataString'));
    expect(shedOrder).not.toContain('answeredQueued');
  });
});

describe('archival folds the declaration onto a column, because the pairing pass is SQL', () => {
  it('reads it off a BOT record only, and only as ids', () => {
    // Read off a person's message it would let anyone who can type assert who answered what.
    expect(archival).toContain('const answeredQueued: string[] = isBot && Array.isArray(analytics.answeredQueued)');
    expect(archival).toContain("(id): id is string => typeof id === 'string' && !!id");
  });

  it('writes NULL rather than an empty array on an ordinary answer', () => {
    // `{}` is a claim - "this answer addressed no queued messages" - and almost every answer has
    // never been near a queue. Absence is the honest record, and every reader tests for NULL.
    expect(archival).toContain('answered_queued: r.answered_queued.length ? r.answered_queued : null,');
    expect(archival).toContain("'answered_queued',");
  });
});

describe('one row per queued message, labeled, against the answer that folded it', () => {
  const sql = flat(archival.slice(archival.indexOf('async function createQueuedExchanges')));

  it('expands the declared list into one exchange per id', () => {
    expect(sql).toContain('UNNEST(COALESCE(am.answered_queued, am_upd.answered_queued)) AS queued_message_id');
    expect(sql).toContain('JOIN messages um ON um.channel_arn = d.channel_arn AND um.message_id = d.queued_message_id');
  });

  it('labels every row it mints as having been queued', () => {
    expect(sql).toContain('paired_by, queued_as, e2e_ms');
    // The turn named this message, so the pairing is declared - and the label says the wait was
    // deliberate, which is the half `paired_by` cannot carry.
    expect(sql).toContain("'declared',");
    expect(sql).toContain("'folded',");
  });

  it('joins only real user messages, so a declaration cannot invent a row', () => {
    expect(sql).toContain('AND um.is_bot = false');
    expect(sql).toContain("AND um.event_type = 'CREATE_CHANNEL_MESSAGE'");
  });

  it('is idempotent under a redelivered batch', () => {
    // The (user_message_id, agent_message_id) pair is unique since migration 017.
    expect(sql).toContain('ON CONFLICT DO NOTHING');
  });

  it('runs after the update fold, because the declaration rides the update', () => {
    const foldAt = archival.indexOf('await backfillFromUpdateEvents(updateMessages);');
    const queuedAt = archival.indexOf('await createQueuedExchanges(touchedChannels);');
    expect(foldAt).toBeGreaterThan(-1);
    expect(queuedAt).toBeGreaterThan(foldAt);
  });

  it('carries no backtick, which would end the template literal mid-query', () => {
    const body = archival.slice(archival.indexOf('async function createQueuedExchanges'));
    const literal = body.slice(body.indexOf('`'), body.indexOf('[channelArns]'));
    expect(literal.split('`').length - 1).toBe(2);
  });
});

describe('a 1 to 1 exchange is not labeled, which is what makes the label mean anything', () => {
  it('neither existing pairer writes queued_as', () => {
    // Non-vacuity. If every exchange carried the label, separating the populations would separate
    // nothing - and the number an analyst reads as "1 to 1" would be the whole table.
    const inBatch = archival.slice(
      archival.indexOf('async function createExchangesFromRecords'),
      archival.indexOf('async function createExchangesFromDatabase'),
    );
    const sweep = archival.slice(
      archival.indexOf('async function createExchangesFromDatabase'),
      archival.indexOf('async function createQueuedExchanges'),
    );
    expect(inBatch).not.toContain('queued_as');
    expect(sweep).not.toContain('queued_as');
  });

  it('the column defaults to nothing, so every historical row reads as 1 to 1', () => {
    expect(m052).toContain('ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS queued_as VARCHAR(16);');
    expect(m052).not.toContain('DEFAULT');
  });
});

describe('the two populations can be read apart', () => {
  it('the label is what separates them, and the column comment says how to read it', () => {
    expect(m052).toContain("COMMENT ON COLUMN exchanges.queued_as IS");
    expect(m052).toContain('response_latency_ms on a labeled row INCLUDES the queue wait');
  });

  it('a view publishes the queued population rather than leaving it to a hand-written join', () => {
    expect(m052).toContain('CREATE OR REPLACE VIEW v_queued_exchange AS');
    expect(m052).toContain('WHERE ex.queued_as IS NOT NULL;');
    // Several rows may name the same answer, so the count is published rather than re-derived.
    expect(flat(code(m052))).toContain('COUNT(*) OVER (PARTITION BY ex.agent_message_id) AS answered_together');
  });

  it('does not recompute a queued message\'s first feedback, which already has one source', () => {
    // tenet D7: `v_queue_acknowledgement.ack_ms` owns that question, keyed on the acknowledged
    // message because several queued sends share one notice. This joins it; it does not redefine it.
    expect(m052).toContain('LEFT JOIN v_queue_acknowledgement qa');
    expect(m052).toContain('qa.ack_ms,');
    const view = m052.slice(m052.indexOf('CREATE OR REPLACE VIEW v_queued_exchange'));
    expect(view).not.toContain('acknowledged_at -');
  });

  it('keeps a queued exchange out of a turn\'s latency anchor', () => {
    // A folded answer carries one exchange per queued message it rolled in, all on that same
    // message. Taking one as the anchor would measure the turn from a message it was not answering.
    const latency = m052.slice(m052.indexOf('CREATE OR REPLACE VIEW v_turn_latency'));
    expect(flat(code(latency))).toContain('WHERE ex.agent_message_id = m.id AND ex.queued_as IS NULL');
  });

  it('keeps migration 051 intact rather than reverting it', () => {
    const latency = m052.slice(m052.indexOf('CREATE OR REPLACE VIEW v_turn_latency'));
    expect(latency).toContain("HAVING bool_or(kind <> 'notice_posted')");
  });
});

describe('the migration is safe to apply at runtime on a cold start', () => {
  it('is idempotent in every statement it makes', () => {
    for (const ddl of [
      'ALTER TABLE messages ADD COLUMN IF NOT EXISTS answered_queued TEXT[];',
      'ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS queued_as VARCHAR(16);',
      'CREATE INDEX IF NOT EXISTS idx_messages_answered_queued',
      'CREATE INDEX IF NOT EXISTS idx_exchanges_queued_as',
      'CREATE OR REPLACE VIEW v_turn_latency AS',
      'CREATE OR REPLACE VIEW v_queued_exchange AS',
    ]) {
      expect(m052).toContain(ddl);
    }
  });

  it('is transaction-safe: nothing here can run outside one', () => {
    // Pending migrations apply inside ONE transaction on a cold start, so a CONCURRENTLY index
    // would fail the whole batch and leave the data plane erroring on every invocation.
    expect(code(m052)).not.toMatch(/CONCURRENTLY/i);
    expect(code(m052)).not.toMatch(/VACUUM|REINDEX/i);
  });

  it('owns its migration number alone', () => {
    // Two files sharing a number apply in an order nothing states, so the number has to be unique.
    //
    // "AND IT IS THE HIGHEST" IS NOT ASSERTED HERE, deliberately. That claim is true of exactly one
    // migration at a time and goes stale the day the next one lands, which turns a real guard into a
    // chore every later change has to edit. The newest migration's own test makes it - today
    // a-sweep-waits-for-the-answer-it-is-pairing.test.ts, for 053.
    const numbers = fs.readdirSync(SCHEMA_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => parseInt(f.slice(0, 3), 10));
    expect(numbers.filter((n) => n === 52)).toHaveLength(1);
  });
});
