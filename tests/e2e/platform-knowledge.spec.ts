/**
 * The assistant answers questions about AGENTECHELON ITSELF from the documentation, not from titles.
 *
 * There are two halves to the platform self-knowledge and they fail differently:
 *   - the CURATED index (`platform-knowledge/standard/agentechelon-about.json`, a title plus a ~400-character
 *     summary per doc, read through the `load_platform_info` tool) - seeded with the demo, always there;
 *   - the RAG corpus (`rag/agentechelon/`, every doc chunked and embedded), which needs a deploy-time
 *     `npm run sync-knowledge:rag`, AND needs `agentechelon` to be in the router's retrieval source
 *     types or the chunks are stored and never queried.
 *
 * Both failures are SILENT. The assistant still answers either way - from summaries - so the symptom is
 * a thin, generic answer rather than an error or an empty result. Verified live: the same query returned
 * 0 chunks under the router's original source-type list and 4 chunks at 0.48-0.58 similarity once the
 * platform corpus was included.
 *
 * So this asserts SPECIFICITY: the answer must contain detail that only exists in the body of a doc,
 * never in its summary. A test that merely checked the assistant said something about AgentEchelon
 * would pass in exactly the broken state this exists to catch.
 */
import { test, expect } from './helpers/fixtures';
import { signIn, createConversation, sendAndWaitForResponse } from './helpers/agent-helpers';
import { getStandardUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { WebSocketMonitor } from './helpers/websocket-monitor';
import { aws, awsv } from './helpers/aws';

const RUN = process.env.PLATFORM_KNOWLEDGE_E2E === '1';

/**
 * THE TURN'S OWN RECORD of what it did: the tools that ran and the passages retrieved, written by the
 * processor to the message-analytics table under the answer's message id. This is the evidence a
 * grounded answer rests on, and it does not depend on how the model chose to phrase the reply.
 * Waited for, because the record is written beside the reply rather than before it.
 */
async function turnRecord(messageId: string): Promise<string> {
  const names: string[] = aws('dynamodb list-tables --query "TableNames"') || [];
  const table = names.find((n) => /MessageAnalytics/i.test(n));
  expect(table, 'no message-analytics table in this deployment').toBeTruthy();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    // argv, not a shell string: the key is JSON, and a shell would eat its quotes.
    let r: any = null;
    try { r = awsv(['dynamodb', 'get-item', '--table-name', table!, '--key', JSON.stringify({ messageId: { S: messageId } })]); } catch { /* read again */ }
    if (r?.Item) return JSON.stringify(r.Item);
    await new Promise((res) => setTimeout(res, 3_000));
  }
  throw new Error(`no analytics record for message ${messageId} in ${table} within 60s`);
}

// Watch the two blind spots an assertion on the answer text leaves: the server, and the browser console.
guardConsoleErrors();

test.describe('platform self-knowledge', () => {
  guardBackendErrors('platform-knowledge');
  test.skip(!RUN, 'set PLATFORM_KNOWLEDGE_E2E=1 (runs via validate.mjs --only=knowledge-qa)');

  test('answers a platform question from the documentation, not the summary index', async ({ page }) => {
    test.setTimeout(180_000);
    const user = await getStandardUser();
    test.skip(!user.password, missingUserReason('standardUser'));

    // THE RAW REPLY, NOT THE PAGE. A long answer is collapsed to a preview and a link keeps its URL in
    // `href`, so the rendered text can lack what the answer said.
    const ws = new WebSocketMonitor();
    await signIn(page, user.email, user.password, ws);
    // STANDARD, NOT THE DEFAULT BASIC: the platform's documentation is internal material, retrievable only by a
    // classification that grants `standard`. Basic is given the public overview alone.
    await createConversation(page, 'Platform knowledge check', 'Standard');

    // Deliberately a MECHANISM question. The curated summary for the portable-profiles spec is its
    // Status line - it names the lifecycle and the files, but nothing about WHERE a persona is kept.
    // Only the doc body carries that, so a correct answer is evidence the body was retrieved.
    const response = await sendAndWaitForResponse(
      page,
      'When AgentEchelon exports an assistant profile to another instance, what happens to the '
      + 'persona text itself? Be specific about where it is stored.',
      120_000,
      ws,
    );

    const text = (response.text || '').toLowerCase();

    // The answer has to engage with the mechanism. Any ONE of these is body-only detail: the S3 body
    // store, the pointer in the definition, or the export-inlines-the-body rule.
    const bodyOnlySignals = [
      's3',
      'personaref',
      'pointer',
      'inline',
      'content-address',
      'configid',
    ].filter((s) => text.includes(s));

    // Always reported, pass or fail. On a pass it is the evidence the answer was grounded rather than
    // fluent; on a failure it is the first thing to look at.
    console.log(`[platform-knowledge] matched body-only signals: ${bodyOnlySignals.join(', ') || '(none)'}`);
    console.log(`[platform-knowledge] answer:\n${response.text}`);

    expect(
      bodyOnlySignals.length,
      'The answer contained none of the detail that lives only in the doc BODY (the S3 body store, the '
      + 'pointer in the definition, or export inlining the body). That is what a summary-only answer '
      + 'looks like: fluent, on-topic, and sourceless. Check that rag/agentechelon/ is ingested '
      + '(`npm run sync-knowledge:rag`) and that RAG_SOURCE_TYPES includes `agentechelon`.\n\n'
      + `Answer was:\n${response.text}`,
    ).toBeGreaterThan(0);

    // And it must be a real answer, not a deflection.
    expect(text).not.toMatch(/i (don't|do not) have|no information|cannot find|unable to find/);

    // THE BODY WAS RETRIEVED: a passage the turn was given carries the body-only detail. Read from the
    // passages, not a file name, because the profile guide carries the same detail as the spec.
    const messageId = ws.lastBotMessageId;
    expect(messageId, 'the reply carried no message id to look its record up by').toBeTruthy();
    const record = await turnRecord(messageId!);
    expect(record, 'no retrieved passage carried the persona body store (personaRef, profile-bodies)').toMatch(/personaRef|profile-bodies/);
  });

  /**
   * WHO MADE IT (owner-reported, 2026-09-05).
   *
   * Asked this on a live premium conversation, the assistant answered that the retrieved context
   * does not name a creator or founding team, and reached for the deploying company's documents to
   * try - the right instinct and the wrong shelf, since Stratum has no reason to carry the
   * authorship of a platform it merely runs.
   *
   * It was telling the truth: the curated self-knowledge held a project name and a license string
   * and nothing else about its own provenance. A unit test now pins the FIELDS; this pins that a
   * person actually gets the answer, which is a different claim - the fields can be present and the
   * tool still not be called, because the model chooses that from the tool's description alone.
   */
  test('says who made it, under what licence, and where the source lives', async ({ page }) => {
    test.setTimeout(180_000);
    const user = await getStandardUser();
    test.skip(!user.password, missingUserReason('standardUser'));

    const ws = new WebSocketMonitor();
    await signIn(page, user.email, user.password, ws);
    await createConversation(page, 'Platform provenance check');

    const response = await sendAndWaitForResponse(page, 'Who created AgentEchelon, and where can I get the source?', 120_000, ws);
    const text = (response.text || '').toLowerCase();
    console.log(`[platform-knowledge] provenance answer:\n${response.text}`);

    // Read from the artifact rather than written here, for the same reason the generator derives
    // them: a fork must pass this against ITS authorship, not against mine.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const about = require('../../backend/demo/platform-knowledge/basic/agentechelon-about.json');
    expect(about.author, 'the curated knowledge carries no author: check LICENSE and run the knowledge phase').toBeTruthy();
    expect(about.repository, 'the curated knowledge carries no repository: the sync found no forge remote').toBeTruthy();

    // THE FACT CAME FROM THE TOOL, not from the model's general knowledge of the project.
    const record = await turnRecord(ws.lastBotMessageId || '');
    expect(record, 'the turn never loaded the platform information').toContain('load_platform_info');

    expect(
      text,
      `the answer did not name the author the curated knowledge carries (${about.author})\n\n${response.text}`,
    ).toContain(String(about.author).toLowerCase());
    expect(
      text,
      `the answer did not point at the repository (${about.repository})\n\n${response.text}`,
    ).toContain(String(about.repository).toLowerCase().replace(/^https:\/\//, ''));

    // THE DEFLECTION THAT WAS THE BUG. "I don't have that" is exactly what it said before, and it is
    // the one answer that must not come back now the fact is there to find.
    expect(text).not.toMatch(/(don't|do not) (have|know)|no information|not (named|in|available)|outside .* knowledge/);
  });
});
