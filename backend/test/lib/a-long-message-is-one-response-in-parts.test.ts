/**
 * A LONG MESSAGE IS ONE RESPONSE, IN ORDERED PARTS, EVERYWHERE (tenet D9). The Amazon Chime SDK caps Content at 4096
 * characters of the encoded string and refuses a request over it whole (`BadRequestException`). An answer, an event
 * step, a voiced send, a prompt welcome and an admin notice each post text whose length a model or a template chose,
 * and each splits it through the one splitter (`splitIntoChunks`, `lib/chime/send.ts`) into a first message and
 * continuation parts the chat app shows as one response.
 *
 * The sample is the shape that was refused: a targeted brief of about 2850 characters of prose, which encodes past
 * 4096 once every space and newline costs three characters.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SendChannelMessageCommand } from '@aws-sdk/client-chime-sdk-messaging';
import {
  CHIME_CONTENT_MAX, CHIME_CONTENT_SAFE, CHIME_METADATA_MAX, PartRefused, responseParts, sendInParts, splitIntoChunks,
} from '../../lambda/src/lib/chime/send';
import { runAgentStep } from '../../lambda/src/lib/event-agent-step';
import { turnDeclarationOf, withTurnDeclaration } from '../../lambda/src/lib/turn-declaration';
import { correlationMarkerOf } from '../../lambda/src/lib/correlation';
import { shippedMessageTemplates } from '../../lambda/src/lib/shipped-message-templates';

const encodedLen = (s: string) => encodeURIComponent(s).length;
const words = (s: string) => s.split(/\s+/).filter(Boolean);
const brief = Array.from({ length: 30 }, (_, i) => `- Item ${i + 1}: Dana, as the lead, reviews the open alarms, the runbook, and the on-call rota today.\n`).join('');
const lead = 'arn:aws:chime:us-east-1:1:app-instance/ai/user/lead-1';
const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/ai/channel/ch-1';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/ai/bot/b-1';
const src = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', ...p), 'utf8');

/** A client that records each request, answers each with an id, and refuses the sends `refuse` names (1-based). */
function client(refuse: number[] = []) {
  const sent: SendChannelMessageCommand[] = [];
  return {
    sent,
    send: async (c: SendChannelMessageCommand) => {
      sent.push(c);
      if (refuse.includes(sent.length)) throw Object.assign(new Error('Channel Messages size limit exceeded'), { name: 'BadRequestException' });
      return { MessageId: `m-${sent.length}` } as never;
    },
  };
}

describe('the one splitter', () => {
  it('the refused shape is over the cap as written', () => {
    expect(brief.length).toBeLessThan(CHIME_CONTENT_MAX);
    expect(encodedLen(brief)).toBeGreaterThan(CHIME_CONTENT_MAX);
  });

  it('splits it into ordered parts, each within its encoded budget, losing no word and adding none', () => {
    const parts = splitIntoChunks(brief);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(encodedLen(p)).toBeLessThanOrEqual(CHIME_CONTENT_SAFE);
    expect(parts.flatMap(words)).toEqual(words(brief));
    expect(parts.join('')).not.toContain('…');
  });

  it('cuts on a boundary: no part ends inside a word', () => {
    const parts = splitIntoChunks(brief);
    const all = words(brief);
    let at = 0;
    for (const p of parts) {
      const w = words(p);
      expect(w[w.length - 1]).toBe(all[at + w.length - 1]);
      at += w.length;
    }
  });

  it('never ends a part on a heading: the heading travels with its content', () => {
    const body = 'Some prose about the service and what it does. '.repeat(30);
    const text = `${body}\n\n## Who owns it?\n\n${body}`;
    for (const p of splitIntoChunks(text, 2000)) expect(p.trim()).not.toMatch(/##[^\n]*$/);
  });

  it('leaves a message that fits as one part, untouched', () => {
    expect(splitIntoChunks('Welcome, Dana.')).toEqual(['Welcome, Dana.']);
  });

  it('never splits a surrogate pair: every part encodes, and the parts rejoin to the text', () => {
    const emoji = '\u{1F680}'.repeat(2000);
    const parts = splitIntoChunks(emoji, 600);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(() => encodeURIComponent(p)).not.toThrow();
      expect(encodedLen(p)).toBeLessThanOrEqual(600);
    }
    expect(parts.join('')).toBe(emoji);
  });

  it('takes a smaller first budget where the answer path appends a marker to its first part', () => {
    const parts = splitIntoChunks(brief, 2900, CHIME_CONTENT_SAFE);
    expect(encodedLen(parts[0])).toBeLessThanOrEqual(2900);
    for (const p of parts.slice(1)) expect(encodedLen(p)).toBeLessThanOrEqual(CHIME_CONTENT_SAFE);
  });
});

describe('posting one response in parts', () => {
  it('a targeted step: every part to the same member, in order, the first with the caller\'s Metadata and the rest grouped under it', async () => {
    const c = client();
    const out = await sendInParts(c, {
      ChannelArn: CHANNEL,
      ChimeBearer: BOT,
      text: brief,
      Metadata: { botResponse: true, eventStep: { outcome: 'posted' }, targetedSender: lead },
      Target: [{ MemberArn: lead }],
    });
    const inputs = c.sent.map((s) => s.input);
    expect(inputs.length).toBeGreaterThan(1);
    expect(out).toMatchObject({ MessageId: 'm-1', totalParts: inputs.length });
    expect(inputs.flatMap((i) => words(decodeURIComponent(i.Content!)))).toEqual(words(brief));
    for (const i of inputs) {
      expect(i).toMatchObject({ ChannelArn: CHANNEL, ChimeBearer: BOT, Type: 'STANDARD', Persistence: 'PERSISTENT', Target: [{ MemberArn: lead }] });
      expect(i.Content!.length).toBeLessThanOrEqual(CHIME_CONTENT_MAX);
      expect(i.Metadata!.length).toBeLessThanOrEqual(CHIME_METADATA_MAX);
    }
    expect(JSON.parse(inputs[0].Metadata!)).toEqual({ botResponse: true, eventStep: { outcome: 'posted' }, targetedSender: lead });
    inputs.slice(1).forEach((i, n) => {
      expect(JSON.parse(i.Metadata!)).toEqual({
        parentMessageId: 'm-1', responseGroup: out.responseGroup, continuation: true, part: n + 2, totalParts: inputs.length,
      });
    });
  });

  it('a room message stays a room message in every part', async () => {
    const c = client();
    await sendInParts(c, { ChannelArn: CHANNEL, ChimeBearer: BOT, text: brief, Metadata: { botResponse: true } });
    for (const s of c.sent) expect(s.input.Target).toBeUndefined();
  });

  it('a message that fits is one send with no continuation Metadata', async () => {
    const c = client();
    const out = await sendInParts(c, { ChannelArn: CHANNEL, ChimeBearer: BOT, text: 'Welcome, Dana.', Metadata: { botResponse: true } });
    expect(c.sent.map((s) => s.input.Content)).toEqual([encodeURIComponent('Welcome, Dana.')]);
    expect(out).toMatchObject({ totalParts: 1 });
    expect(out.responseGroup).toBeUndefined();
  });

  it('a refused part throws PartRefused naming it, and no part after it is sent', async () => {
    const c = client([2]);
    const err = await sendInParts(c, { ChannelArn: CHANNEL, ChimeBearer: BOT, text: brief.repeat(2) }).catch((e) => e);
    expect(err).toBeInstanceOf(PartRefused);
    expect(err).toMatchObject({ name: 'PartRefused', part: 2 });
    expect(err.message).toMatch(/BadRequestException/);
    expect(c.sent).toHaveLength(2);
  });
});

describe('an agent step\'s run records one outcome for its response', () => {
  const template = shippedMessageTemplates().get('ops-first-look')!.template;
  const run = (c: ReturnType<typeof client>, warned: Array<Record<string, unknown>>) => runAgentStep({ template, values: {}, deadlineMs: 1000 }, {
    meter: async () => true,
    invoke: async () => ({ response: brief }),
    claim: async () => true,
    postOutput: async (text: string) => { await sendInParts(c, { ChannelArn: CHANNEL, ChimeBearer: BOT, text, Target: [{ MemberArn: lead }] }); },
    postFallback: async () => undefined,
    warn: (e) => { warned.push(e); },
  });

  it('posted, when every part posted', async () => {
    const c = client();
    const out = await run(c, []);
    expect(out).toMatchObject({ outcome: 'posted', posted: true });
    expect(c.sent.length).toBeGreaterThan(1);
  });

  it('post_failed, at warning level, when one part was refused: the router takes the failure edge', async () => {
    const warned: Array<Record<string, unknown>> = [];
    const out = await run(client([2]), warned);
    expect(out).toMatchObject({ outcome: 'post_failed', posted: false, won: true });
    expect(warned).toEqual([expect.objectContaining({ outcome: 'post_failed', posted: false, postFailed: 'PartRefused' })]);
  });
});

describe('a long message\'s markers ride its first part', () => {
  const marked = withTurnDeclaration(`${brief} <!--corr:turn-abc-123-->`, { kind: 'welcome' });

  it('lifts every marker into part 1, keeps it within budget, and leaves the later parts plain', () => {
    const parts = responseParts(marked);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(encodedLen(p)).toBeLessThanOrEqual(CHIME_CONTENT_SAFE);
    expect(correlationMarkerOf(parts[0])).toBe('turn-abc-123');
    expect(turnDeclarationOf(parts[0]).kind).toBe('welcome');
    for (const p of parts.slice(1)) expect(p).not.toContain('<!--');
    expect(parts.flatMap((p) => words(p.replace(/<!--[\s\S]*?-->/g, ' ')))).toEqual(words(brief));
  });

  it('a message that fits keeps its markers where they are', () => {
    const short = withTurnDeclaration('Welcome, Dana. <!--corr:turn-abc-123-->', { kind: 'welcome' });
    expect(responseParts(short)).toEqual([short]);
  });

  it('a declaration is read from the encoded Content a reader is handed, as the correlation is', () => {
    const encoded = encodeURIComponent(responseParts(marked)[0]);
    expect(turnDeclarationOf(encoded).kind).toBe('welcome');
    expect(correlationMarkerOf(encoded)).toBe('turn-abc-123');
  });
});

describe('every post of model-written or template text uses the one splitter', () => {
  const processor = src('assistant-async-processor.ts');
  const branch = (from: string, to: string) => processor.slice(processor.indexOf(from), processor.indexOf(to));

  it('the event step, the voiced send and the prompt welcome post in parts', () => {
    for (const [from, to] of [['if (event.eventStep) {', 'if (event.voiceSend) {'], ['if (event.voiceSend) {', 'if (event.welcomePrompt) {'], ['if (event.welcomePrompt) {', '[AssistantAsyncProcessor] active profile']]) {
      const b = branch(from, to);
      expect(b).toMatch(/await sendInParts\(messagingClient, \{[\s\S]{0,120}text: content,/);
      expect(b).not.toMatch(/fitEncoded|Content: encodeURIComponent\(content\)/);
    }
  });

  it('an answer with no placeholder posts its first part, and delivery posts the rest', () => {
    expect(processor).toMatch(/Content: encodeURIComponent\(splitIntoChunks\(response\)\[0\]\)/);
    expect(processor).not.toMatch(/Content: encodeURIComponent\(response\)/);
  });

  it('the answer path splits with the same splitter and sends the same continuations', () => {
    const core = src('lib', 'async-processor-core.ts');
    expect(core).not.toMatch(/function splitIntoChunks|function cutIndexByEncoded/);
    expect(core).toMatch(/splitIntoChunks\(response, firstBudget, CHIME_CONTENT_SAFE\)/);
    expect(core).toMatch(/await sendContinuations\(messagingClient, \{/);
    expect(core).not.toMatch(/continuation: true/);
  });

  it('the admin notice posts its body in parts, and fits only its email subject', () => {
    const admin = src('lib', 'admin-channel-post.ts');
    expect(admin).toMatch(/await sendInParts\(messaging, \{[\s\S]{0,160}text: notice\.content,/);
    expect(admin).not.toMatch(/Content: encodeURIComponent\(fitEncoded/);
  });

  it('the router posts its template and platform text in parts, percent-encoded as every other message', () => {
    const router = src('router-agent-handler.ts');
    for (const text of [
      'text: handoverAcknowledgement(', // the handover receipt
      'text: content,', // the intake offer, the welcome's opening, a workflow send, a notice
      'text: askedLine,', // the stop acknowledgment
      'text: formatReferenceNotFound(', // a reference that named nothing
      'text: declared,', // a refusal
      'text: composed.access,', // its access lines
    ]) expect(router).toContain(text);
    // The intake offer, the welcome's opening, a workflow send, a notice, and the turn's own reply on a flow entry.
    expect(router.match(/await sendInParts\(chimeClient, \{\s*ChannelArn: (args\.)?channelArn,\s*text: content,/g)?.length).toBe(5);
    expect(router).toMatch(/const sent = await sendInParts\(chimeClient, \{\s*ChannelArn: channelArn,\s*text: content,/);
    expect(router).not.toMatch(/^\s*Content: content,$/m);
  });

  it('a reply on the Amazon Lex entry over the Lex message cap is posted in parts, never refused', () => {
    const router = src('router-agent-handler.ts');
    expect(router).toContain('export const LEX_MESSAGE_MAX = 1000;');
    expect(router).toContain('if (!isFlowEntry(event)) return replyThroughLex(event, response, spoke);');
    const at = router.indexOf('async function replyThroughLex(');
    const body = router.slice(at, router.indexOf('\n}\n', at));
    expect(body).toMatch(/\(m\.content \?\? ''\)\.length > LEX_MESSAGE_MAX\)\) return response;/);
    expect(body).toMatch(/await sendInParts\(chimeClient, \{/);
    // Fails closed: addressed to the person who spoke, save the room's own welcome.
    expect(body).toMatch(/const toSender = !roomWelcome && !!senderArn;/);
    expect(body).toMatch(/return formatLexNothingToPost\(event\);/);
  });

  it('the only single sends left are single by construction', () => {
    const singles: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !p.endsWith(path.join('chime', 'send.ts'))) {
          const n = (fs.readFileSync(p, 'utf8').match(/sendChannelMessage\(/g) ?? []).length;
          if (n) singles.push(`${path.relative(path.join(__dirname, '..', '..', 'lambda', 'src'), p).split(path.sep).join('/')}:${n}`);
        }
      }
    };
    walk(path.join(__dirname, '..', '..', 'lambda', 'src'));
    expect(singles.sort()).toEqual([
      // The answer's first part where no placeholder exists; delivery posts the rest as continuations.
      'assistant-async-processor.ts:1',
      // A person's own email reply, sent as that person: a person's message, never split into several turns.
      'email-reply.ts:1',
      // Four "..." carriers a reading writes into, updated in place.
      'lib/async-processor-core.ts:4',
      // The queue's notice, the one message updated in place as more arrives.
      'lib/turn-queue-notice.ts:1',
      // A handover instruction the receiving assistant takes as its turn's one message, and two placeholders.
      'router-agent-handler.ts:3',
    ]);
  });

  it('a message is never cut: fitEncoded fits only a value the medium holds once', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && /Content:\s*encodeURIComponent\(fitEncoded\(/.test(fs.readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    walk(path.join(__dirname, '..', '..', 'lambda', 'src'));
    expect(offenders).toEqual([]);
  });
});

describe('every part of a reply goes to the audience of the message it continues', () => {
  const core = src('lib', 'async-processor-core.ts');
  const handler = core.slice(core.indexOf('export async function handleLongResponse('));
  const body = handler.slice(0, handler.indexOf('\n}\n'));

  it('takes the placeholder\'s Target for every continuation, so a private reply stays private in every part', () => {
    expect(body).toMatch(/GetChannelMessageCommand/);
    expect(body).toMatch(/\.\.\.\(chunkTarget \? \{ Target: chunkTarget \} : \{\}\)/);
  });

  it('sends no continuation when that audience cannot be read, rather than posting a private tail to the room', () => {
    expect(body).not.toMatch(/sending continuation chunks untargeted/);
    expect(body).toMatch(/audienceKnown = true;/);
    const withhold = body.indexOf('if (!audienceKnown && !suppressContinuations && chunks.length > 1)');
    const send = body.indexOf('await sendContinuations(');
    expect(withhold).toBeGreaterThan(-1);
    expect(withhold).toBeLessThan(send);
  });
});
