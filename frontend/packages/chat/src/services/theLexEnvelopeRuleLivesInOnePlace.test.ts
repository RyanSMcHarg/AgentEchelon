/**
 * ONE LEX-ENVELOPE RULE, NOT ONE PER READ PATH.
 *
 * A bot reply arrives wrapped - `{"Messages":[{"Content":"...","ContentType":"PlainText"}]}` - and a person
 * must never see that. Two paths read messages: the REST history load (`chimeService.listMessages`) and the
 * realtime websocket (`MessagingProvider.parseMessagePayload`). They each carried their own unwrap, and the
 * copies had already begun to differ: the websocket one never checked that `Messages` was an array.
 *
 * The repo had already learned this lesson for the SIBLING rule and written it down. `isEmptyLexEnvelope`'s
 * docstring says: "They previously each carried their own copy, which is two places for the rule to drift and
 * only one of them visible in any given bug report - a message dropped live but present on reload, or the
 * reverse." That argument applies to the unwrap identically, so this asserts the structure rather than waiting
 * for the two to disagree again in front of someone.
 *
 * A STRUCTURAL CHECK, deliberately. The behavioral tests for the rule itself live with `messageParser`; what
 * cannot be covered that way is "nobody re-implemented it", which is how the drift happened.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { unwrapLexEnvelope, isEmptyLexEnvelope } from '@ae/shared';
import { stripComments } from '../test/stripComments';

const SRC = path.resolve(__dirname, '..');
const READ_PATHS = ['providers/MessagingProvider.tsx', 'services/chimeService.ts'];

/** Comments stripped: the docstrings here quote the envelope shape when explaining it. */
/**
 * Uses the SCANNING stripper, not a regex.
 *
 * `src.replace(/\/\*[\s\S]*?\*\//g, '')` treats a quoted `/*` as the start of a comment. On a backend stack
 * that deleted 87% of the file and hid the very declarations a sibling guard was checking for, while the guard
 * still passed. These two files are smaller, but the failure is silent either way, so neither uses it.
 */
const code = (file: string): string => stripComments(fs.readFileSync(path.join(SRC, file), 'utf8'));

describe('the Lex envelope', () => {
  it('is unwrapped by the shared function on every path that reads a message', () => {
    for (const file of READ_PATHS) {
      expect(code(file), `${file} must call the shared unwrapLexEnvelope`).toMatch(/unwrapLexEnvelope\(/);
    }
  });

  it('is not re-implemented inline on any read path', () => {
    // The shape of the inline copy that was removed: reaching into Messages[0].Content by hand.
    const inline = /Messages\s*(?:\?\.)?\[\s*0\s*\]|Messages\s*\?\.\[0\]/;
    for (const file of READ_PATHS) {
      expect(code(file), `${file} extracts Messages[0] by hand instead of calling the shared rule`).not.toMatch(inline);
    }
  });

  it('still unwraps a real envelope, and leaves a non-envelope alone', () => {
    const LEX = 'application/amz-chime-lex-msgs';
    expect(unwrapLexEnvelope(JSON.stringify({ Messages: [{ Content: 'the real answer' }] }), LEX)).toBe('the real answer');
    // Not marked as an envelope: a coding answer may legitimately contain this JSON and must render verbatim.
    const verbatim = JSON.stringify({ Messages: [{ Content: 'the real answer' }] });
    expect(unwrapLexEnvelope(verbatim, 'text/plain')).toBe(verbatim);
    // Marked but unparseable: left as-is rather than guessed at.
    expect(unwrapLexEnvelope('{not json', LEX)).toBe('{not json');
  });

  it('treats an empty envelope as nothing to render, on the same rule', () => {
    const LEX = 'application/amz-chime-lex-msgs';
    expect(isEmptyLexEnvelope(JSON.stringify({ Messages: [] }), LEX)).toBe(true);
    expect(isEmptyLexEnvelope(JSON.stringify({ Messages: [{ Content: 'x' }] }), LEX)).toBe(false);
  });
});
