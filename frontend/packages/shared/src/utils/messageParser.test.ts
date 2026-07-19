import { describe, it, expect } from 'vitest';
import { parseMessageContent, parseActiveTaskFromMetadata, isAllowedBattleImageUrl } from './messageParser';

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
  const rivalArn = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/AltSlot0';

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
    const raw = `My reply <!--corr:battle-r1-AltSlot0-1735000000000-abc123-->`;
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

describe('parseMessageContent — battleimage marker (Phase 4 generation-out)', () => {
  const PRESIGNED =
    'https://bkt.s3.amazonaws.com/battle-images/c/2026-05-16T0-0.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=ab=cd,ef';

  it('extracts urls/modelId/count and strips the marker (URL has =,&, — JSON-only survives)', () => {
    const raw = `Generated an image with Amazon Nova Canvas.<!--battleimage:${JSON.stringify({
      urls: [PRESIGNED],
      modelId: 'amazon.nova-canvas-v1:0',
      count: 1,
    })}-->`;
    const result = parseMessageContent(raw);
    expect(result.content).toBe('Generated an image with Amazon Nova Canvas.');
    expect(result.battleImage).toEqual({
      urls: [PRESIGNED],
      modelId: 'amazon.nova-canvas-v1:0',
      count: 1,
    });
  });

  it('count defaults to urls.length when absent', () => {
    // F3: fixture URLs must satisfy isAllowedBattleImageUrl
    const urls = [
      'https://my-bucket.s3.amazonaws.com/u1.png',
      'https://my-bucket.s3.amazonaws.com/u2.png',
    ];
    const raw = `x<!--battleimage:${JSON.stringify({ urls, modelId: 'm' })}-->`;
    expect(parseMessageContent(raw).battleImage).toEqual({
      urls,
      modelId: 'm',
      count: 2,
    });
  });

  it('honest empty: a failure/withheld line carries NO marker → battleImage null, text shown', () => {
    const result = parseMessageContent(
      'The generated image was withheld by the content filter.',
    );
    expect(result.battleImage).toBeNull();
    expect(result.content).toBe('The generated image was withheld by the content filter.');
  });

  it('malformed JSON or invalid shape is ignored (never a fabricated image)', () => {
    expect(parseMessageContent('y<!--battleimage:not json-->').battleImage).toBeNull();
    expect(
      parseMessageContent(`y<!--battleimage:${JSON.stringify({ urls: [], modelId: 'm' })}-->`)
        .battleImage,
    ).toBeNull();
    expect(
      parseMessageContent(`y<!--battleimage:${JSON.stringify({ urls: [123], modelId: 'm' })}-->`)
        .battleImage,
    ).toBeNull();
    // marker still stripped from displayed content even when ignored
    expect(parseMessageContent('y<!--battleimage:not json-->').content).toBe('y');
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
  const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/AltSlot0';

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
});

describe('isAllowedBattleImageUrl — F3 URL allow-list', () => {
  it.each([
    'https://my-bucket.s3.amazonaws.com/path/key.png',
    'https://my-bucket.s3.us-east-1.amazonaws.com/path/key.png',
    'https://s3.amazonaws.com/bucket/key.png',
    'https://s3.us-west-2.amazonaws.com/bucket/key.png',
  ])('accepts AWS https URL: %s', (u) => {
    expect(isAllowedBattleImageUrl(u)).toBe(true);
  });

  it.each([
    'http://my-bucket.s3.amazonaws.com/key.png',         // non-https
    'javascript:alert(1)',                                // script scheme
    'data:image/png;base64,AAAA',                        // data URL
    'file:///etc/passwd',                                 // file URL
    'https://attacker.com/exfil.png',                    // wrong host
    'https://evil.s3.amazonaws.com.attacker.io/key.png', // suffix-spoof
    'https://amazonaws.com.evil/key.png',                 // suffix-spoof
    'not a url at all',                                   // unparseable
    '',                                                   // empty
  ])('rejects %s', (u) => {
    expect(isAllowedBattleImageUrl(u)).toBe(false);
  });

  it('rejects overlong URLs', () => {
    expect(isAllowedBattleImageUrl('https://' + 'a'.repeat(9000))).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(isAllowedBattleImageUrl(undefined as unknown as string)).toBe(false);
    expect(isAllowedBattleImageUrl(null as unknown as string)).toBe(false);
    expect(isAllowedBattleImageUrl(42 as unknown as string)).toBe(false);
  });
});

describe('battleimage marker — F3 integration', () => {
  it('drops the image payload when any URL fails the allow-list', () => {
    const marker = JSON.stringify({
      urls: ['https://my-bucket.s3.amazonaws.com/ok.png', 'javascript:bad()'],
      modelId: 'nova-canvas',
      count: 2,
    });
    const r = parseMessageContent(`done<!--battleimage:${marker}-->`);
    expect(r.battleImage).toBeNull();
    expect(r.content).toBe('done');
  });

  it('keeps the image when all URLs are AWS-hosted https', () => {
    const marker = JSON.stringify({
      urls: ['https://my-bucket.s3.amazonaws.com/ok.png'],
      modelId: 'nova-canvas',
      count: 1,
    });
    const r = parseMessageContent(`done<!--battleimage:${marker}-->`);
    expect(r.battleImage?.urls).toEqual(['https://my-bucket.s3.amazonaws.com/ok.png']);
  });
});
