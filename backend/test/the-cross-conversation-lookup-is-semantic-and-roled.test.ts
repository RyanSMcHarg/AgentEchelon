/**
 * ADR-004 surface 3: the cross-conversation lookup is SEMANTIC, and every statement in it is ROLED.
 *
 * WHY A STRUCTURAL GUARD AND NOT ONLY A BEHAVIORAL ONE. What was wrong here for months was not a
 * wrong answer - it was a branch that could never be taken, and three independent reasons for it that
 * all failed closed. A behavioral test of `findRelatedConversations` passed the whole time, because
 * falling back to keyword matching IS a correct-looking answer. The things worth pinning are
 * therefore the ones a reader cannot see from the outside: which table the vector path reads, that
 * the gate which could not succeed is gone, and that no statement runs unroled.
 *
 * Each assertion below names the specific mistake it refuses, because every one of them was shipped.
 */
import * as fs from 'fs';
import * as path from 'path';
import { stripComments } from './lib/strip-comments';

const SRC = path.join(__dirname, '..', 'lambda', 'src', 'analytics-aurora');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

/** Code only. A rule asserted against comments is satisfied by prose describing the bug. */
const code = (f: string) => stripComments(read(f));

describe('the cross-conversation lookup', () => {
  it('reads conversation vectors from summary_embeddings, not the dormant embeddings table', () => {
    const src = code('cross-conversation-context.ts');

    // The vector path must query the table that is actually populated. `summary_embeddings` is
    // 1024-dim (ADR-002) and written by `embedding-writer` on every summary version; the generic
    // `embeddings` table is 1536-dim and dormant - migration 005 says so in its own header.
    expect(src).toContain('summary_embeddings');

    // THE GATE THAT COULD NOT SUCCEED. `embeddings WHERE source_type = 'conversation_context'`
    // counted rows nothing has ever written, in the wrong table, through an unroled connection. It
    // selected the vector path and therefore guaranteed the vector path never ran.
    expect(src).not.toMatch(/source_type\s*=\s*'conversation_context'/);
  });

  it('issues no unroled statement, so row-level security cannot silently empty a read', () => {
    const src = code('cross-conversation-context.ts');

    // ADR-028: these tables carry FORCE ROW LEVEL SECURITY and the owner has no policy, so a
    // statement issued on the pooled connection reads ZERO rows rather than all of them. That is the
    // trap `document-ingestion.ts` documents for its ingest COUNT, and it was live here in the one
    // place that chose between semantic and keyword search.
    //
    // Asserted as the ABSENCE OF THE IMPORT rather than by scanning call sites: `client.query(...)`
    // inside `withReaderRole` is correct and a text match cannot tell the two apart, while the
    // import is the single thing that has to be present for the wrong one to be reachable at all.
    expect(src).not.toMatch(/import\s*\{[^}]*\bquery\b[^}]*\}\s*from\s*'\.\/db-client\.js'/);

    // Both roles are still used - this is not "removed the import and stopped reading".
    expect(src).toContain('withReaderRole');
    expect(src).toContain('withWriterRole');
  });

  it('applies BOTH bounds on the vector read: membership and classification', () => {
    const src = code('cross-conversation-context.ts');
    const vectorQuery = src.slice(src.indexOf('findRelatedByEmbedding'));

    // Membership: the live-resolved scope. SPEC-CONTEXT-SOURCES-AND-STORES defines the content as
    // "which channels a set of principals are all members of", and the archive is never the
    // authority for it (ADR-012), so the list must come from the caller.
    expect(vectorQuery).toContain('scopedChannelArns');

    // Classification: the reader role. Membership protects the PEOPLE; the classification protects
    // the CONVERSATION. Neither subsumes the other, so a vector read missing either is wrong.
    expect(vectorQuery).toContain('withReaderRole');
  });

  it('keeps one Titan implementation for the CONVERSATION vector space', () => {
    // THE THREE CONSUMERS OF `summary_embeddings`, and only those. Drift compares a message to one
    // conversation's vector, the writer produces them, and this lookup ranks across them - one
    // 1024-dim space (ADR-002), so one call. Two of the three had grown byte-identical private
    // copies differing only in timeout, and a third was about to be written for ADR-004 surface 3.
    //
    // DOCUMENTS ARE DELIBERATELY NOT IN THIS LIST. `document-ingestion` and `document-retrieval`
    // embed their own corpus, and ADR-004 keeps document embeddings a separate concern in Bedrock
    // KB's own table. Folding them in here would assert a decision nobody has made. The other
    // Bedrock clients in this directory (`analytics-query`, `evaluation-runner`, `summary-updater`)
    // call models rather than embed, which is why this matches the EMBEDDING REQUEST and not the
    // client: a blanket ban on `BedrockRuntimeClient` would fail on five files doing nothing wrong.
    const conversationSpace = ['drift-detection.ts', 'embedding-writer.ts', 'cross-conversation-context.ts'];

    const rollTheirOwn = conversationSpace.filter((f) => /new InvokeModelCommand/.test(code(f)));
    expect(rollTheirOwn).toEqual([]);

    const routed = conversationSpace.filter((f) => /from '\.\/embed-text\.js'/.test(code(f)));
    expect(routed.sort()).toEqual([...conversationSpace].sort());
  });

  it('degrades to keyword search rather than failing when no embedding is available', () => {
    const src = code('cross-conversation-context.ts');

    // An embedding is a better ranking, never a gate (tenet D5: a best-effort side path never blocks
    // a reply). No Titan vector, nothing embedded in scope yet, or nothing above the floor must all
    // reach the keyword path - which is what a deployment whose summaries are not yet embedded gets.
    expect(src).toMatch(/if\s*\(\s*semantic\.length\s*>\s*0\s*\)\s*return\s+semantic;/);
    expect(src).toMatch(/return\s+findRelatedByKeyword\(/);

    // And the vector path returns empty rather than throwing when Titan gives nothing back.
    const vectorQuery = src.slice(src.indexOf('async function findRelatedByEmbedding'));
    expect(vectorQuery).toMatch(/if\s*\(\s*!embedding\s*\)\s*return\s*\[\];/);
  });
});
