/**
 * AN ASSISTANT USES A MEETING'S CONTENT AND NEVER HANDS OVER ITS FILES (SPEC-ASSISTANT-MEETINGS FR28, FR57, FR70).
 *
 * A meeting's transcript and recording are signed for its hosts alone (`a-conversation-file-is-signed-only-for-a-cleared-
 * member`). What an assistant reads may hold what was said, but never a way to the files:
 *  - every link the platform writes to a meeting's file is held out of the messages a turn hands the model, words kept;
 *  - no module the assistant's processor runs builds a meeting file's link or signs a URL for one: the one signer it
 *    holds signs generated images, under their own key family only;
 *  - what it says when asked for a file is a prompt template a team can reword, and the recording notices people hear
 *    say the same thing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { holdMeetingFileLinks, MEETING_FILES_PROMPT, withoutMeetingFileLinks } from '../../lambda/src/lib/meeting-file-links';
import { transcriptLink } from '../../lambda/src/lib/meeting-transcript';
import { recordingLink } from '../../lambda/src/lib/meeting-recording';
import { shippedMessageTemplates } from '../../lambda/src/lib/shipped-message-templates';
import { renderMessageTemplate } from '../../lambda/src/lib/message-template';

const SRC = path.join(__dirname, '../../lambda/src');
const TRANSCRIPT = 'transcripts/premium/conv-1/m-1.md';
const RECORDING = 'recordings/premium/conv-1/m-1/p-1/media/composited-video/cp-1.mp4';

describe('a meeting file link never reaches the model', () => {
  it('DENY: the ended card\'s transcript and recording links are held out, and their words kept', () => {
    const card = `**Meeting ended** · 12 min\n\n- [Transcript](${transcriptLink(TRANSCRIPT)})\n- [Recording](${recordingLink(RECORDING)})\n- Recording: [1](${recordingLink(RECORDING)}) · [2](${recordingLink(RECORDING)})`;
    const out = withoutMeetingFileLinks(card);
    expect(out.held).toBe(true);
    expect(out.text).not.toMatch(/\?(transcript|recording)=/);
    expect(out.text).not.toContain('transcripts/');
    expect(out.text).not.toContain('recordings/');
    expect(out.text).toContain('- Transcript');
    expect(out.text).toContain('- Recording');
  });

  it('DENY: a bare link and a full URL are held out too', () => {
    for (const text of [
      `here it is ${transcriptLink(TRANSCRIPT)} thanks`,
      `https://chat.example.com/c/1${recordingLink(RECORDING)}`,
    ]) {
      const out = withoutMeetingFileLinks(text);
      expect(out.held).toBe(true);
      expect(out.text).not.toMatch(/(transcript|recording)=/);
    }
  });

  it('leaves a message with no meeting file link exactly as it was', () => {
    const text = 'The [meeting conversation](?c=meet-1) is read-only now; the recording is processing.';
    expect(withoutMeetingFileLinks(text)).toEqual({ text, held: false });
  });

  it('holds the links out of the messages a turn hands the model, in place, and says it did', () => {
    const messages = [{ role: 'user', content: 'Can I have the recording?' }, { role: 'assistant', content: `[Recording](${recordingLink(RECORDING)})` }];
    expect(holdMeetingFileLinks(messages)).toBe(true);
    expect(messages[1].content).toBe('Recording');
    expect(holdMeetingFileLinks(messages)).toBe(false);
  });

  it('is applied to every turn the processor hands the model, before the model call', () => {
    const processor = fs.readFileSync(path.join(SRC, 'assistant-async-processor.ts'), 'utf8');
    const held = processor.indexOf('holdMeetingFileLinks(bedrockMessages)');
    expect(held).toBeGreaterThan(-1);
    expect(held).toBeLessThan(processor.indexOf('invokeBedrockWithFallback(systemPrompt, bedrockMessages'));
  });
});

/** Every module of the processor's own source tree it reaches by relative import, from its entry. */
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
      const base = path.resolve(path.dirname(file), m[1].replace(/\.js$/, ''));
      for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) if (fs.existsSync(candidate)) { visit(candidate); break; }
    }
  };
  visit(entry);
  return [...seen].filter((f) => f.startsWith(SRC));
}

describe("no tool of the assistant's processor answers a meeting file", () => {
  const modules = reachable(path.join(SRC, 'assistant-async-processor.ts'));

  it('reaches the modules it runs, its tools among them', () => {
    expect(modules.length).toBeGreaterThan(20);
    expect(modules.some((f) => f.endsWith(path.join('lib', 'async-processor-core.ts')))).toBe(true);
  });

  it("DENY: builds no link to a meeting's transcript or recording, outside the ended card the router posts", () => {
    // The router writes the ended card, a platform post whose links the model never reads (above); no tool answers one.
    const building = modules.filter((f) => /\b(transcriptLink|recordingLink)\s*\(/.test(fs.readFileSync(f, 'utf8'))
      && !/meeting-(transcript|recording)\.ts$/.test(f));
    expect(building.map((f) => path.relative(SRC, f))).toEqual(['router-agent-handler.ts']);
    const router = fs.readFileSync(path.join(SRC, 'router-agent-handler.ts'), 'utf8');
    for (const m of router.matchAll(/\b(transcriptLink|recordingLink)\s*\(/g)) {
      // Each one is a value of a card template the router renders.
      expect(router.slice(Math.max(0, m.index! - 40), m.index!)).toMatch(/(transcript_link|recording_link|recording_parts)/);
    }
  });

  it("DENY: signs no URL for a meeting's file: the one signer it runs signs generated images under their own family", () => {
    const signers = modules.filter((f) => /\bgetSignedUrl\b/.test(fs.readFileSync(f, 'utf8')));
    expect(signers.map((f) => path.relative(SRC, f).replace(/\\/g, '/'))).toEqual(['lib/image-gen-output.ts']);
    const signer = fs.readFileSync(path.join(SRC, 'lib/image-gen-output.ts'), 'utf8');
    expect(signer).not.toMatch(/TRANSCRIPTS_FAMILY|RECORDINGS_FAMILY|transcripts\/|recordings\//);
  });

  it("DENY: reads a meeting's transcript as text only, never its key", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { latestTranscriptOf } = require('../../lambda/src/lib/meeting-transcript');
    return latestTranscriptOf({
      send: async (cmd: { list?: boolean }) => (cmd.list
        ? { Contents: [{ Key: TRANSCRIPT, LastModified: new Date() }] }
        : { Body: { transformToString: async () => 'Ana: we ship Friday.' } }),
    }, 'bucket', 'premium', 'arn:aws:chime:us-east-1:111:app-instance/i/channel/conv-1', {
      list: () => ({ list: true }), get: () => ({ get: true }),
    }).then((text: string | null) => {
      expect(text).toBe('Ana: we ship Friday.');
      expect(text).not.toContain('transcripts/');
    });
  });
});

describe('what an assistant and the people in a meeting are told', () => {
  const catalog = shippedMessageTemplates();

  it('the guidance is a prompt template, telling a host to download from the ended card and anyone else to ask a host', () => {
    const entry = catalog.get(MEETING_FILES_PROMPT);
    expect(entry?.entry.kind).toBe('prompt');
    const said = renderMessageTemplate(entry!.template, {}, { sections: ['prompt'], refusedValue: 'empty' });
    expect(said.ok).toBe(true);
    const text = said.ok ? said.sections.prompt ?? '' : '';
    expect(text).toMatch(/hosts download it from the meeting's ended card/);
    expect(text).toMatch(/not a host can ask a host/);
    expect(text).toMatch(/never hand over/);
  });

  // THE NOTICES SAY ONLY THAT THE MEETING IS BEING RECORDED; where its files are is the assistant's
  // guidance above, said to whoever asks.
  it.each(['meeting-recording-started', 'meeting-recording-started-media'])('the %s notice says only that the meeting is being recorded', (name) => {
    expect(catalog.get(name)!.entry.sections.chat.text).toBe('This meeting is being recorded.');
  });

  it('the app\'s join notices say the same', () => {
    const en = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../frontend/packages/shared/src/locales/en.json'), 'utf8'));
    const meeting = JSON.stringify(en);
    for (const key of ['recordingJoinNotice', 'recordingJoinNoticeMedia']) {
      const match = new RegExp(`"${key}":"([^"]*)"`).exec(meeting);
      expect(match?.[1]).toBe('This meeting is being recorded.');
    }
  });
});
