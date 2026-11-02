/**
 * EVERY MESSAGE AN ASSISTANT SENDS SAYS WHICH ASSISTANT SENT IT.
 *
 * ── WHAT THIS PINS, AND WHY A SOURCE GUARD RATHER THAN A BEHAVIOR TEST ─────────────────────────
 *
 * The four reporting dimensions are written straight off a message's own metadata
 * (`kinesis-archival.ts`: `agent_type`, `assistant_role`, `profile_version`, `profile_config_id`), and
 * the archival writes NULL for anything the message did not declare. That rule is deliberate and is
 * NOT what these tests challenge: an earlier `extractAgentType(senderArn)` guess was removed because
 * every miss "landed as an 'unknown' row that looked like a measurement".
 *
 * The consequence was that a sender which declared nothing produced a row nobody could attribute, and
 * the send still succeeded. Nothing failed, nothing errored, and the defect surfaced only as a count
 * in a dashboard filter weeks later. There is no runtime assertion that could have caught it, because
 * posting a message with thin metadata is a perfectly valid Chime call. The guard therefore has to be
 * on the source: a send that stamps `botResponse: true` and nothing else is the defect, spelled out.
 *
 * `botMessageMetadata` is the one shape, so these tests check that every sender goes through it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { botMessageMetadata } from '../../lambda/src/lib/bot-message-attribution';

const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', rel), 'utf8');

describe('the metadata a bot message carries', () => {
  it('always says it is a bot response, so the frontend still renders it', () => {
    expect(JSON.parse(botMessageMetadata())).toEqual({ botResponse: true });
  });

  it('declares each dimension the archive reads, under the name it reads', () => {
    const meta = JSON.parse(botMessageMetadata({
      agentType: 'premium-assistant',
      assistantRole: 'primary',
      profileVersion: 7,
      profileConfigId: 'cfg-abc',
      classification: 'premium',
    }));
    // The exact keys `kinesis-archival` and the Firehose partition JQ read. A rename here is a
    // silent attribution loss, which is why they are spelled out rather than round-tripped.
    expect(meta.agentType).toBe('premium-assistant');
    expect(meta.assistantRole).toBe('primary');
    expect(meta.profileVersion).toBe(7);
    expect(meta.profileConfigId).toBe('cfg-abc');
    expect(meta.classification).toBe('premium');
  });

  // ABSENT IS OMITTED, NEVER NULL. The archival's rule is "declared or NULL"; sending an explicit null
  // would be a declaration of nothing, which is a different claim from never having known.
  it('omits what the sender did not know rather than sending it as null', () => {
    const meta = JSON.parse(botMessageMetadata({ agentType: 'basic-assistant' }));
    expect(meta).toEqual({ botResponse: true, agentType: 'basic-assistant' });
    expect('assistantRole' in meta).toBe(false);
    expect('profileVersion' in meta).toBe(false);
  });

  it('keeps per-message facts alongside the attribution', () => {
    const meta = JSON.parse(botMessageMetadata({ agentType: 'a' }, { targetedSender: 'arn:user/1' }));
    expect(meta.targetedSender).toBe('arn:user/1');
    expect(meta.agentType).toBe('a');
  });

  // A NOTICE IS NOT A TURN, and saying so is the whole point of the kind. No profile produced it, so
  // a version recorded for one would answer "which version said this" with an unrelated number.
  it('carries a notice kind, and invents no version for one', () => {
    const meta = JSON.parse(botMessageMetadata({
      agentType: 'premium-assistant', assistantRole: 'primary', classification: 'premium', turnKind: 'battle-notice',
    }));
    expect(meta.turnKind).toBe('battle-notice');
    expect('profileVersion' in meta).toBe(false);
  });
});

describe('no sender stamps a bare bot-response metadata', () => {
  // THE FILES THAT POST AS AN ASSISTANT. A new one added here without going through
  // `botMessageMetadata` is exactly the regression this guards, so the list is checked rather than
  // discovered: a file that stops posting drops off it, and one that starts has to be added
  // deliberately.
  // The channel flow is not a poster: it speaks as no assistant.
  const POSTERS = ['router-agent-handler.ts'];

  it.each(POSTERS)('%s builds its message metadata through the shared shape', (file) => {
    const text = src(file);
    // `JSON.stringify({ botResponse: true ... })` inline is the shape that loses attribution. The
    // helper is the only sanctioned way to produce it.
    expect(text).not.toMatch(/JSON\.stringify\(\{\s*botResponse:\s*true/);
    expect(text).toContain('botMessageMetadata(');
  });

  // THE ACKNOWLEDGMENT IS THE ONE THAT COUNTS AS A TURN. It carries the turn's `<!--corr:-->` marker,
  // so `ASSISTANT_TURN_SQL` counts it; declaring nothing there made every flow-dispatched turn report
  // an unknown assistant, and flow dispatch is the standard path rather than an edge.
  it('the handler posts its acknowledgment with the turn identity it validated', () => {
    const router = src('router-agent-handler.ts');
    const post = router.slice(router.indexOf('async function postAsAssistant('));
    expect(post).toMatch(/Metadata: botMessageMetadata\(\s*spoke\.attribution\b/);
    // Declared where the identity is VALIDATED, not rebuilt at the send from an ARN.
    expect(router).toContain('spoke.attribution = {');
    // The ADDRESSED assistant, from the turn's assistant profile: a turn to `ops-premium` is attributed to
    // `ops-premium` in the `ops` role, not to the classification's primary. Held by behavior, through
    // the real handler, in `test/a-turn-runs-on-its-assistants-profile.test.ts` (the flow-handed turn).
  });

  // THE ASSISTANT SAYING WHO IT IS MUST SURVIVE THE ASSISTANT FAILING TO SPEAK. When the handler
  // cannot post, the flow posts on its behalf - and that message is still the turn's.
  it('a handed-back message carries the turn identity to the caller that posts it', () => {
    const router = src('router-agent-handler.ts');
    expect(router).toContain('aeAttribution?: BotMessageAttribution;');
    expect(router).toContain('aeAttribution: spoke.attribution');
    // The flow does not post a handed-back reply; the processor posts the answer itself.
    expect(src('channel-flow-processor.ts')).not.toContain('sendBotMessage(');
  });

  // A NOTICE IS SAID BY THE ASSISTANT IT CONCERNS. The flow names the kind and
  // the router posts it as that assistant, with that assistant's attribution and the notice's kind.
  it('the flow posts nothing; every notice goes to the router', () => {
    const flow = src('channel-flow-processor.ts');
    expect(flow).not.toContain('noticeAttribution');
    expect(flow).not.toContain('new SendChannelMessageCommand(');
    expect(flow).not.toContain('new UpdateChannelMessageCommand(');
    expect(flow).toContain('aeNotice: { kind, channelArn, botArn, to');
    // The router declares the speaking assistant and the notice kind on what it posts.
    const router = src('router-agent-handler.ts');
    const say = router.slice(router.indexOf('export async function sayNotice('));
    expect(say).toContain('agentType: assistant.profile.name,');
    expect(say).toContain('turnKind: noticeTurnKind(req.kind),');
  });
});
