/**
 * The assistant answers questions about AGENTECHELON ITSELF from the documentation, not from titles.
 *
 * There are two halves to the platform self-knowledge and they fail differently:
 *   - the CURATED index (`platform-knowledge/agentechelon-about.json`, a title plus a ~400-character
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
import { test, expect } from '@playwright/test';
import { signIn, createConversation, sendAndWaitForResponse } from './helpers/agent-helpers';
import { getStandardUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

const RUN = process.env.PLATFORM_KNOWLEDGE_E2E === '1';

// Watch the two blind spots an assertion on the answer text leaves: the server, and the browser console.
guardConsoleErrors();

test.describe('platform self-knowledge', () => {
  guardBackendErrors('platform-knowledge');
  test.skip(!RUN, 'set PLATFORM_KNOWLEDGE_E2E=1 (runs via validate.mjs --only=knowledge-qa)');

  test('answers a platform question from the documentation, not the summary index', async ({ page }) => {
    test.setTimeout(180_000);
    const user = await getStandardUser();
    test.skip(!user.password, missingUserReason('standardUser'));

    await signIn(page, user.email, user.password);
    await createConversation(page, 'Platform knowledge check');

    // Deliberately a MECHANISM question. The curated summary for the portable-profiles spec is its
    // Status line - it names the lifecycle and the files, but nothing about WHERE a persona is kept.
    // Only the doc body carries that, so a correct answer is evidence the body was retrieved.
    const response = await sendAndWaitForResponse(
      page,
      'When AgentEchelon exports an assistant profile to another instance, what happens to the '
      + 'persona text itself? Be specific about where it is stored.',
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
  });
});
