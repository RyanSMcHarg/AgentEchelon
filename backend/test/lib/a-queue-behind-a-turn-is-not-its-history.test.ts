/**
 * A QUEUE BEHIND A TURN IS NOT ITS HISTORY, AND A READING CHECKS THE WORK IT AMENDS IS STILL RUNNING
 * (owner report 2026-09-14).
 *
 * Four messages sent back to back. The turn answering the first loaded the other three from channel
 * history and answered them; the reading then proposed them anyway, recorded two as amendments against
 * a turn that had already delivered, the notice said "caught up", the handover returned the amendments
 * to the queue, and a second reading proposed them again. The answer itself was split around the
 * notice with its first part ending on a heading.
 *
 * The history bound is exercised behaviorally in `channel-history-context.test.ts`. The rest crosses a
 * whole reading turn, so it is pinned at source, the way the other queue tests in this directory are.
 */

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const core = fs.readFileSync(path.resolve(__dirname, '../../lambda/src/lib/async-processor-core.ts'), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { splitIntoChunks } = require('../../lambda/src/lib/async-processor-core');

describe('the turn reads history bounded at its own message', () => {
  it('passes its message id, its sender, and the queue to the history read', () => {
    const at = core.indexOf('conversationHistory = await loadChannelHistory(');
    expect(at).toBeGreaterThan(-1);
    const call = core.slice(at - 900, at + 500);
    expect(call).toContain('readTurnState({');
    expect(call).toContain('currentMessageId: event.userMessageId');
    expect(call).toContain('senderArn: event.senderArn');
    expect(call).toContain('excludeIds: [...(historyState.queued ?? []), ...(historyState.amendments ?? [])]');
    // A reading or stop evaluation has no message of its own; anchoring on its prompt would warn every time.
    expect(call).toContain('const ownMessage = !event.triage && !event.stopEvaluation;');
  });

  it('a turn that answers the room declares it, and nothing opts a turn into private messages', () => {
    const at = core.indexOf('conversationHistory = await loadChannelHistory(');
    const call = core.slice(at, at + 900);
    expect(call).toContain('...(event.broadcastAnswer || event.battleContext ? { answeredInPublic: true } : {}),');
    expect(core).not.toContain('excludeTargeted');
  });
});

describe('an amendment needs work that is still running', () => {
  const at = core.indexOf('let workStillInFlight = !!event.triage.inFlight;');
  const block = core.slice(at, at + 2200);

  it('re-reads who holds the conversation before recording amendments', () => {
    expect(at).toBeGreaterThan(-1);
    expect(block).toContain('readTurnState({');
    expect(block).toContain('!(live.busy && live.holder !== event.correlationId)');
  });

  it('reads them as new work, without the prose written about the finished work', () => {
    expect(block).toContain("intent: 'new' as const");
    expect(block).toContain('spoken: undefined');
  });

  it('records amendments and suppresses their tasks only while the work is still in flight', () => {
    expect(core).toContain('if (amending.length && workStillInFlight) {');
    expect(core).toContain('hasWorkInFlight: workStillInFlight,');
    expect(core).not.toContain('if (amending.length && event.triage.inFlight) {');
  });
});

describe('the notice does not settle over amendments nothing will fold', () => {
  it('counts orphaned amendments as still waiting', () => {
    expect(core).toContain('const stillWaiting = queueNow.unreadable ? 1 : queueNow.queued.length + orphanedAmendments;');
  });
});

describe('a long answer never ends a part on a heading', () => {
  it('keeps the heading with the content under it', () => {
    const para = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(30);
    const text = `${para}\n\n## Who created it?\n\n${'Created by the maintainer. '.repeat(200)}`;
    const chunks: string[] = splitIntoChunks(text, 3600 - 700, 3600);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].trim().endsWith('Who created it?')).toBe(false);
  });
});

describe('a reading does not ask for a placeholder it does not have', () => {
  it('skips the target read when there is no message id', () => {
    expect(core).toContain("if (!messageId) throw Object.assign(new Error('no placeholder to read'), { noPlaceholder: true });");
  });
});
