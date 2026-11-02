import { describe, it, expect } from 'vitest';
import {
  parseMessageContent,
  parseActiveTaskFromMetadata,
  isEmptyLexEnvelope,
  unwrapLexEnvelope,
  declaresFinalAnswer,
  decodeMessageText,
} from './messageParser';

const LEX = 'application/amz-chime-lex-msgs';

/**
 * The client half of duplicate suppression (ADR-022).
 *
 * The router answers a retried Lex fulfillment with `messages: []`. Amazon Chime SDK posts that
 * envelope into the channel either way, so whether the user sees a clean conversation or raw JSON is
 * decided HERE. Both ingestion paths - the REST history load and the realtime websocket - route
 * through this predicate for exactly that reason.
 */
describe('isEmptyLexEnvelope', () => {
  it('recognises the envelope the router emits to suppress a retry', () => {
    expect(isEmptyLexEnvelope(JSON.stringify({ Messages: [] }), LEX)).toBe(true);
  });

  it('keeps a real Lex reply, which carries messages', () => {
    const real = JSON.stringify({ Messages: [{ Content: 'Here is your answer.', ContentType: 'PlainText' }] });
    expect(isEmptyLexEnvelope(real, LEX)).toBe(false);
  });

  it('ignores an ordinary message that happens to contain the same JSON', () => {
    // A coding answer may legitimately quote `{"Messages":[]}` in a fenced block. Only Lex's OWN
    // envelope is suppressed, so the gate is the ContentType and not the text.
    expect(isEmptyLexEnvelope(JSON.stringify({ Messages: [] }), 'text/plain')).toBe(false);
    expect(isEmptyLexEnvelope(JSON.stringify({ Messages: [] }), undefined)).toBe(false);
  });

  it('keeps an unparseable envelope rather than silently dropping it', () => {
    // Not provably empty. Dropping here would lose a message we merely failed to understand.
    expect(isEmptyLexEnvelope('not json at all', LEX)).toBe(false);
    expect(isEmptyLexEnvelope('', LEX)).toBe(false);
  });

  it('keeps an envelope whose Messages is absent or not an array', () => {
    expect(isEmptyLexEnvelope(JSON.stringify({}), LEX)).toBe(false);
    expect(isEmptyLexEnvelope(JSON.stringify({ Messages: null }), LEX)).toBe(false);
    expect(isEmptyLexEnvelope(JSON.stringify({ Messages: 'nope' }), LEX)).toBe(false);
  });
});

describe('unwrapLexEnvelope', () => {
  it('unwraps a Lex reply to its text, so the user never sees the envelope', () => {
    const real = JSON.stringify({ Messages: [{ Content: 'Here is your answer.', ContentType: 'PlainText' }] });
    expect(unwrapLexEnvelope(real, LEX)).toBe('Here is your answer.');
  });

  it('leaves an ordinary message untouched', () => {
    expect(unwrapLexEnvelope('Just text', 'text/plain')).toBe('Just text');
  });

  it('does NOT unwrap an empty envelope, which is why the drop must happen first', () => {
    // This is the coupling between the two functions: unwrap returns the raw JSON for an empty
    // envelope, so any ingestion path that unwraps WITHOUT dropping first renders `{"Messages":[]}`
    // to the user. Both call sites drop first; this asserts the reason they must.
    const empty = JSON.stringify({ Messages: [] });
    expect(unwrapLexEnvelope(empty, LEX)).toBe(empty);
  });
});

describe('parseMessageContent', () => {
  it('returns content unchanged when no markers present', () => {
    const result = parseMessageContent('Hello, how can I help?');
    expect(result.content).toBe('Hello, how can I help?');
    expect(result.activeTask).toBeNull();
  });

  it('strips <!--corr:uuid--> markers', () => {
    const result = parseMessageContent('Hello<!--corr:a1b2c3d4-e5f6-7890-abcd-ef1234567890-->');
    expect(result.content).toBe('Hello');
  });

  it('strips the <!--turn:--> declaration, using the id shape Amazon Chime SDK actually issues', () => {
    // Reported live, 2026-09-18: this reached the screen when answering a turn clarification. That is
    // the handler-answered path, which posts once and is never rewritten by an update, so unlike a
    // placeholder's marker nothing downstream removed it.
    const result = parseMessageContent(
      'Which quarter did you mean?<!--turn:answers=638da1616fc8361e574203efb374ed545f6f9dba8b95b93221161a9ac6debb96;phase=final-->'
    );
    expect(result.content).toBe('Which quarter did you mean?');
  });

  it('still reads the declaration off the RAW content after the stripper exists', () => {
    // The two must not fight: `declaresFinalAnswer` reads raw content and the ledger depends on it.
    // Stripping for display must not make a finished turn look unfinished.
    const raw = 'Done.<!--turn:answers=abc123;phase=final-->';
    expect(declaresFinalAnswer(raw)).toBe(true);
    expect(parseMessageContent(raw).content).toBe('Done.');
  });

  it('strips a quoted marker too, exactly as the sibling markers do', () => {
    // KNOWN AND DELIBERATE. A regex replace has no notion of a code fence, so an assistant answer
    // that QUOTES the marker loses the quotation. That is the same behaviour `corr:` and ACTIVE_TASK
    // have had all along, and matching them is worth more than a special case here: the alternative
    // is a fence-aware stripper in one marker's path and not the others'. Recorded as a test so the
    // trade is visible rather than discovered.
    const raw = 'Use this shape:\n```\n<!--turn:answers=X-->\n```';
    expect(parseMessageContent(raw).content).not.toContain('turn:answers');
  });

  it('strips multiple correlation markers', () => {
    const result = parseMessageContent(
      '<!--corr:aaaa-bbbb-cccc-dddd-->Hello<!--corr:1111-2222-3333-4444-5555-->world'
    );
    expect(result.content).toBe('Helloworld');
  });

  it('extracts ACTIVE_TASK JSON marker', () => {
    const task = { type: 'troubleshooting', status: 'diagnosing', label: 'Fixing issue' };
    const raw = `Analyzing the problem...<!--ACTIVE_TASK:${JSON.stringify(task)}-->`;
    const result = parseMessageContent(raw);
    expect(result.content).toBe('Analyzing the problem...');
    expect(result.activeTask).toEqual(task);
  });

  it('handles malformed ACTIVE_TASK JSON gracefully', () => {
    const raw = 'Response<!--ACTIVE_TASK:not valid json-->';
    const result = parseMessageContent(raw);
    expect(result.content).toBe('Response');
    expect(result.activeTask).toBeNull();
  });

  it('strips both ACTIVE_TASK and corr markers together', () => {
    const task = { type: 'report', status: 'generating', label: 'Report' };
    const raw = `Working...<!--ACTIVE_TASK:${JSON.stringify(task)}--><!--corr:abcd-1234-ef01-5678-->`;
    const result = parseMessageContent(raw);
    expect(result.content).toBe('Working...');
    expect(result.activeTask).toEqual(task);
  });

  it('trims whitespace after stripping markers', () => {
    const result = parseMessageContent('  Hello  <!--corr:aaaa-bbbb-cccc-dddd-->  ');
    expect(result.content).toBe('Hello');
  });

  it('handles empty string', () => {
    const result = parseMessageContent('');
    expect(result.content).toBe('');
    expect(result.activeTask).toBeNull();
  });

  it('handles content that is only markers', () => {
    const result = parseMessageContent('<!--corr:aaaa-bbbb-cccc-dddd-->');
    expect(result.content).toBe('');
  });

  // What Amazon Bedrock Guardrails leaves where it masked one of the markers above. The backend strips
  // it at the guardrail boundary, which covers everything written from that point on - it does NOT
  // reach a message already stored in Amazon Chime SDK, and this parser is what the person re-opening
  // that conversation sees. The reported leak was exactly such a message.
  it('strips the guardrail mask token left where a marker was masked', () => {
    const result = parseMessageContent(
      'Here is the summary in this condensed 1-2 page report format.{MetadataMarkerFilter}'
    );
    expect(result.content).toBe('Here is the summary in this condensed 1-2 page report format.');
  });

  // The mask is the intended output for a PII entity rule: removing it would hide that a redaction
  // happened. Only the internal-marker filter's token is noise to the reader.
  it('leaves a PII mask alone', () => {
    const result = parseMessageContent('Reach the team at {EMAIL}.');
    expect(result.content).toBe('Reach the team at {EMAIL}.');
  });
});

describe('parseMessageContent — NAVIGATE_CHANNEL marker (drift redirect)', () => {
  it('extracts a NAVIGATE_CHANNEL marker into navigateChannel', () => {
    const raw = "Sure, let's switch. NAVIGATE_CHANNEL:arn:aws:chime:us-east-1:111:app-instance/i/channel/c2|Q3 Forecasting";
    const result = parseMessageContent(raw);
    expect(result.navigateChannel).toEqual({
      channelArn: 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c2',
      channelName: 'Q3 Forecasting',
    });
  });

  it('strips the NAVIGATE_CHANNEL marker from displayed content', () => {
    const raw = "Going there now. NAVIGATE_CHANNEL:arn:foo|Bar";
    const result = parseMessageContent(raw);
    expect(result.content).toBe('Going there now.');
  });

  it('returns navigateChannel: null when no marker present', () => {
    const result = parseMessageContent('Just a regular bot reply');
    expect(result.navigateChannel).toBeNull();
  });

  it('handles channel name with spaces in it', () => {
    const raw = "NAVIGATE_CHANNEL:arn:aws:chime:us-east-1:111:app-instance/i/channel/conv-123|My Long Channel Name";
    const result = parseMessageContent(raw);
    expect(result.navigateChannel?.channelName).toBe('My Long Channel Name');
  });
});

describe('parseMessageContent — battle marker (/battle SPEC-BATTLE.md)', () => {
  const battleId = 'a1b2c3d4e5f60718';
  const rivalArn = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/Alt-premium';

  it('extracts a round-1 battle marker', () => {
    const raw = `One moment... <!--corr:battle-r1-default-1234--><!--battle:battleId=${battleId},round=1,total=2,rivalArn=${rivalArn}-->`;
    const result = parseMessageContent(raw);
    expect(result.battle).toEqual({
      battleId,
      round: 1,
      totalRounds: 2,
      rivalArn,
      rivalReplyMsgId: undefined,
    });
  });

  it('extracts a round-2 battle marker with rivalReplyMsgId', () => {
    const raw = `<!--battle:battleId=${battleId},round=2,total=2,rivalArn=${rivalArn},rivalReplyMsgId=msg-rival-r1-->`;
    const result = parseMessageContent(raw);
    expect(result.battle).toEqual({
      battleId,
      round: 2,
      totalRounds: 2,
      rivalArn,
      rivalReplyMsgId: 'msg-rival-r1',
    });
  });

  it('strips the battle marker from displayed content', () => {
    const raw = `My reply<!--battle:battleId=${battleId},round=1,total=2,rivalArn=${rivalArn}-->`;
    const result = parseMessageContent(raw);
    expect(result.content).toBe('My reply');
  });

  it('returns battle: null when no marker present', () => {
    const result = parseMessageContent('Just a regular bot reply');
    expect(result.battle).toBeNull();
  });

  it('returns battle: null when round is invalid', () => {
    const raw = `<!--battle:battleId=${battleId},round=3,total=2,rivalArn=${rivalArn}-->`;
    const result = parseMessageContent(raw);
    expect(result.battle).toBeNull();
  });

  it('returns battle: null when battleId is missing', () => {
    const raw = `<!--battle:round=1,total=2,rivalArn=${rivalArn}-->`;
    const result = parseMessageContent(raw);
    expect(result.battle).toBeNull();
  });

  it('handles widened corr-marker pattern (battle correlation IDs have prefixes)', () => {
    const raw = `My reply <!--corr:battle-r1-Alt-premium-1735000000000-abc123-->`;
    const result = parseMessageContent(raw);
    expect(result.content).toBe('My reply');
  });

  it('strips both battle marker AND corr marker AND keeps content clean', () => {
    const raw = `Both options have merit. <!--corr:battle-r2-default-xyz--><!--battle:battleId=${battleId},round=2,total=2,rivalArn=${rivalArn},rivalReplyMsgId=msg-A-->`;
    const result = parseMessageContent(raw);
    expect(result.content).toBe('Both options have merit.');
    expect(result.battle?.round).toBe(2);
    expect(result.battle?.rivalReplyMsgId).toBe('msg-A');
  });

  it('battle marker + ACTIVE_TASK + corr marker together — all parsed independently', () => {
    const task = { type: 'general', status: 'thinking', label: 'Comparing answers' };
    const raw = `Working...<!--ACTIVE_TASK:${JSON.stringify(task)}--><!--corr:battle-r1-default-xyz--><!--battle:battleId=${battleId},round=1,total=2,rivalArn=${rivalArn}-->`;
    const result = parseMessageContent(raw);
    expect(result.content).toBe('Working...');
    expect(result.activeTask).toEqual(task);
    expect(result.battle?.battleId).toBe(battleId);
    expect(result.battle?.round).toBe(1);
  });

  it('totalRounds defaults to 2 when total= is absent', () => {
    const raw = `<!--battle:battleId=${battleId},round=1,rivalArn=${rivalArn}-->`;
    const result = parseMessageContent(raw);
    expect(result.battle?.totalRounds).toBe(2);
  });
});

describe('parseMessageContent — battlestats marker (#1 emission wiring)', () => {
  const battleId = 'a1b2c3d4e5f60718';
  const MID = 'anthropic.claude-sonnet-4-6';

  it('builds battle from a battlestats-only reply (placeholder marker is gone on UPDATE)', () => {
    const raw = `Cache it.<!--battlestats:battleId=${battleId},round=1,responseMs=1840,estCostUsd=0.0123,modelId=${MID}-->`;
    const result = parseMessageContent(raw);
    expect(result.content).toBe('Cache it.');
    expect(result.battle).toMatchObject({
      battleId,
      round: 1,
      totalRounds: 2,
      responseMs: 1840,
      estCostUsd: 0.0123,
    });
    expect(result.battle?.steps).toEqual([
      { stepLabel: 'round1-generate', modelId: MID, durationMs: 1840 },
    ]);
  });

  it('empty estCostUsd parses to null (honesty contract — scorecard shows "—")', () => {
    const raw = `x<!--battlestats:battleId=${battleId},round=1,responseMs=900,estCostUsd=,modelId=${MID}-->`;
    const result = parseMessageContent(raw);
    expect(result.battle?.estCostUsd).toBeNull();
  });

  it('round=2 yields a round2-rebuttal step label', () => {
    const raw = `Rebuttal<!--battlestats:battleId=${battleId},round=2,responseMs=700,estCostUsd=0.004,modelId=${MID}-->`;
    const result = parseMessageContent(raw);
    expect(result.battle?.round).toBe(2);
    expect(result.battle?.steps?.[0].stepLabel).toBe('round2-rebuttal');
  });

  it('strips the battlestats marker from displayed content', () => {
    const raw = `Answer<!--battlestats:battleId=${battleId},round=1,responseMs=100,estCostUsd=0.001,modelId=${MID}-->`;
    expect(parseMessageContent(raw).content).toBe('Answer');
  });

  it('augments an existing battle marker when both are present (edge)', () => {
    const raw =
      `Hi<!--battle:battleId=${battleId},round=1,total=2,rivalArn=arn:rival-->` +
      `<!--battlestats:battleId=${battleId},round=1,responseMs=1200,estCostUsd=0.01,modelId=${MID}-->`;
    const result = parseMessageContent(raw);
    expect(result.battle?.rivalArn).toBe('arn:rival'); // kept from <!--battle:-->
    expect(result.battle?.responseMs).toBe(1200); // added from battlestats
    expect(result.content).toBe('Hi');
  });

  it('does not produce a battle when battleId is missing', () => {
    const raw = `x<!--battlestats:round=1,responseMs=100,estCostUsd=0.001,modelId=${MID}-->`;
    expect(parseMessageContent(raw).battle).toBeNull();
  });

  it('no synthesized steps when responseMs is absent', () => {
    const raw = `x<!--battlestats:battleId=${battleId},round=1,estCostUsd=0.001,modelId=${MID}-->`;
    const result = parseMessageContent(raw);
    expect(result.battle?.battleId).toBe(battleId);
    expect(result.battle?.steps).toBeUndefined();
  });

  it('parses the variant displayName from the name= field into battle.label', () => {
    const raw = `Cache it.<!--battlestats:battleId=${battleId},round=1,responseMs=1840,estCostUsd=0.0123,modelId=${MID},name=Atlas-->`;
    const result = parseMessageContent(raw);
    expect(result.battle?.label).toBe('Atlas');
    expect(result.content).toBe('Cache it.');
  });

  it('URI-decodes a name= containing the marker delimiters', () => {
    // sanitizeDisplayName doesn't strip , or = ; the async processor
    // encodeURIComponent's it, so a name with delimiters survives intact.
    const encoded = encodeURIComponent('A, B=C');
    const raw = `x<!--battlestats:battleId=${battleId},round=1,responseMs=100,estCostUsd=0.001,modelId=${MID},name=${encoded}-->`;
    expect(parseMessageContent(raw).battle?.label).toBe('A, B=C');
  });

  it('label is absent (not clobbered) when the marker carries no name=', () => {
    const raw = `x<!--battlestats:battleId=${battleId},round=1,responseMs=100,estCostUsd=0.001,modelId=${MID}-->`;
    expect(parseMessageContent(raw).battle?.label).toBeUndefined();
  });

  it('merges name= onto an existing <!--battle:--> placeholder marker', () => {
    const raw =
      `Hi<!--battle:battleId=${battleId},round=1,total=2,rivalArn=arn:rival-->` +
      `<!--battlestats:battleId=${battleId},round=1,responseMs=1200,estCostUsd=0.01,modelId=${MID},name=Echo-->`;
    const result = parseMessageContent(raw);
    expect(result.battle?.rivalArn).toBe('arn:rival'); // kept from placeholder
    expect(result.battle?.label).toBe('Echo'); // added from battlestats
  });
});


describe('parseActiveTaskFromMetadata', () => {
  it('returns null for null metadata', () => {
    expect(parseActiveTaskFromMetadata(null as any)).toBeNull();
  });

  it('returns null when no activeTask field', () => {
    expect(parseActiveTaskFromMetadata({ someOther: 'data' })).toBeNull();
  });

  it('returns null when activeTask is missing required fields', () => {
    expect(parseActiveTaskFromMetadata({ activeTask: { type: 'test' } })).toBeNull();
    expect(parseActiveTaskFromMetadata({ activeTask: { type: 'test', status: 'ok' } })).toBeNull();
  });

  it('extracts valid activeTask from metadata', () => {
    const metadata = {
      activeTask: { type: 'troubleshooting', status: 'diagnosing', label: 'Fix bug' },
    };
    const result = parseActiveTaskFromMetadata(metadata);
    expect(result).toEqual({
      type: 'troubleshooting',
      status: 'diagnosing',
      label: 'Fix bug',
    });
  });
});

describe('parseMessageContent — battlewaiting marker', () => {
  const BID = 'a1b2c3d4e5f60718';
  const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/Alt-premium';

  it('extracts battleWaiting and strips the marker from displayed content', () => {
    const r = parseMessageContent(
      `Assistant is waiting for your response.<!--battlewaiting:battleId=${BID},botArn=${BOT}-->`,
    );
    expect(r.content).toBe('Assistant is waiting for your response.');
    expect(r.battleWaiting).toEqual({ battleId: BID, botArn: BOT });
    expect(r.battle).toBeNull();
  });

  it('battleWaiting is null when no marker present', () => {
    expect(parseMessageContent('Just a normal reply.').battleWaiting).toBeNull();
  });

  it('ignores a malformed marker missing botArn (no false waiting state)', () => {
    const r = parseMessageContent(`Waiting.<!--battlewaiting:battleId=${BID}-->`);
    expect(r.battleWaiting).toBeNull();
    expect(r.content).toBe('Waiting.'); // marker still stripped
  });

  it('preserves a bot ARN containing colons/slashes intact', () => {
    const r = parseMessageContent(`x<!--battlewaiting:battleId=${BID},botArn=${BOT}-->`);
    expect(r.battleWaiting?.botArn).toBe(BOT);
  });

  it('reads the duel owner the side waits on', () => {
    const r = parseMessageContent(`x<!--battlewaiting:battleId=${BID},botArn=${BOT},owner=owner%2D1-->`);
    expect(r.battleWaiting).toEqual({ battleId: BID, botArn: BOT, ownerId: 'owner-1' });
  });

  it('a task step the side parks on carries both its scorecard and its waiting state', () => {
    const r = parseMessageContent(
      'Who is the audience?'
      + `<!--battlestats:battleId=${BID},round=1,responseMs=900,estCostUsd=,modelId=m1-->`
      + `<!--battlewaiting:battleId=${BID},botArn=${BOT},owner=owner-1-->`,
    );
    expect(r.content).toBe('Who is the audience?');
    expect(r.battle?.battleId).toBe(BID);
    expect(r.battleWaiting).toEqual({ battleId: BID, botArn: BOT, ownerId: 'owner-1' });
  });
});



/**
 * A MARKED MESSAGE IS NO LONGER NECESSARILY A PLACEHOLDER.
 *
 * The client decides "this is the async placeholder" from a `<!--corr:-->` marker, which was a
 * complete rule for as long as the only marked messages were placeholders. A turn the handler
 * answers itself now carries the same marker so its pairing can be declared rather than guessed at
 * downstream, and it posts once with no update to follow - so read as a placeholder, the clock is
 * never stopped and the turn reports no answer at all.
 */
describe('declaresFinalAnswer', () => {
  it('recognizes a turn that said it is already finished', () => {
    expect(declaresFinalAnswer(
      'Hey, what can I help you with? <!--corr:abcd1234--><!--turn:answers=m-1;delivery=DIRECT;phase=final-->',
    )).toBe(true);
  });

  it('reads it through percent-encoding, because content arrives either way', () => {
    expect(declaresFinalAnswer(
      encodeURIComponent('Hi <!--corr:abcd1234--><!--turn:phase=final-->'),
    )).toBe(true);
  });

  it('says nothing about an ordinary placeholder', () => {
    expect(declaresFinalAnswer('One moment... <!--corr:abcd1234-->')).toBe(false);
  });

  it('says nothing about a declaration that named no phase', () => {
    // A drift suggestion declares its target and its kind and deliberately declares no phase: it
    // opens no response, so it closes none either.
    expect(declaresFinalAnswer('Shall I split that out? <!--turn:answers=m-1;kind=drift-->')).toBe(false);
  });

  it('is not asserted by prose that merely contains the words', () => {
    expect(declaresFinalAnswer('The phase=final flag is set in turn-declaration.ts.')).toBe(false);
  });

  it('is safe on empty and undefined content', () => {
    expect(declaresFinalAnswer('')).toBe(false);
    expect(declaresFinalAnswer(undefined)).toBe(false);
  });
});

describe('decodeMessageText', () => {
  it('decodes percent-encoded text', () => {
    expect(decodeMessageText(encodeURIComponent('usage down 30% - renegotiate?'))).toBe('usage down 30% - renegotiate?');
  });

  // Measured live 2026-10-05: raw text holding a bare % threw "URI malformed" in two unguarded readers
  // and the message was dropped. The reader returns the raw text instead of throwing.
  it('returns raw text holding a bare % unchanged instead of throwing', () => {
    expect(() => decodeMessageText('usage down 30% this year')).not.toThrow();
    expect(decodeMessageText('usage down 30% this year')).toBe('usage down 30% this year');
  });

  it('leaves plain text alone', () => {
    expect(decodeMessageText('no escapes here')).toBe('no escapes here');
  });
});
