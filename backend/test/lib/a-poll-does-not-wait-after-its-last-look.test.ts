/**
 * NOTHING POLLS FOR A PLACEHOLDER ANY MORE, ANYWHERE.
 *
 * This file used to pin the poll's sleep schedule: six attempts, no sleep after the last read. The
 * poll is gone entirely now, so what it pins is the stronger claim - that resolving a placeholder is
 * a read and, when that misses, a lookup against the channel, with no timer at any point.
 *
 * THE MEASUREMENT THAT REMOVED IT. Over seven days across the three live processors, 230 polls
 * resolved: 7 on the first read, 212 on the second (~150ms), none after the sixth; 27 never
 * resolved. Every population was better off without the wait - a flow-dispatched turn is handed the
 * id from the send, a reading opens no placeholder ever, a Lex turn's mapping lands ~150ms after
 * dispatch (thousands of milliseconds before any answer is ready), and the turns that still miss are
 * the ones whose mapping is never written at all.
 *
 * These are source assertions rather than behavioral ones on purpose: the property is the ABSENCE of
 * a construct, and the cheapest way to stop it coming back is to fail when it does.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

const core = read('lib/async-processor-core.ts');
const assistant = read('assistant-async-processor.ts');

describe('nothing polls for a placeholder', () => {
  it('the poll function no longer exists', () => {
    expect(core).not.toContain('export async function pollForPlaceholderMessage');
  });

  it('nothing calls it', () => {
    // Prose may still explain why it was removed; a CALL is what must not come back.
    expect(core).not.toMatch(/await\s+pollForPlaceholderMessage\s*\(/);
    expect(assistant).not.toMatch(/await\s+pollForPlaceholderMessage\s*\(/);
  });

  it('no setTimeout-based retry survives in the resolution path', () => {
    // The shape the poll had. A reader adding one back would have to reintroduce this.
    const at = core.indexOf('export async function resolveDeliveryMessageId');
    expect(at).toBeGreaterThan(-1);
    expect(core.slice(at, at + 900)).not.toContain('setTimeout');
  });

  it('delivery resolves from ONE read, then gives the caller null', () => {
    const at = core.indexOf('export async function resolveDeliveryMessageId');
    const body = core.slice(at, at + 900);
    expect(body).toContain('await readPlaceholderMapping(correlationId)');
    expect(body).toContain('return target.messageId || null;');
  });

  it('the success path reads the mapping BEFORE reaching for the billed scan', () => {
    // Without this read a Lex turn - which now legitimately arrives with no resolved id - would go
    // straight to ListChannelMessages, buying with a billed search what a point read already knows.
    const scanAt = assistant.indexOf('deliverMessageId = await scanForPlaceholderMessage(');
    const readAt = assistant.indexOf('deliverMessageId = await resolveDeliveryMessageId(');
    expect(readAt).toBeGreaterThan(-1);
    expect(scanAt).toBeGreaterThan(-1);
    expect(readAt).toBeLessThan(scanAt);
  });

  it('a reading still pays for neither', () => {
    // It opens no placeholder ever, so both the read and the scan can only come back empty.
    expect(assistant).toContain('const readingOwnsNoPlaceholder = !!event.triage;');
    const at = assistant.indexOf('const readingOwnsNoPlaceholder = !!event.triage;');
    const after = assistant.slice(at, at + 1400);
    expect(after).toContain('!deliverMessageId && !readingOwnsNoPlaceholder');
  });
});
