/**
 * An unnamed room is a platform fact, shown in the reader's language.
 *
 * The client used to send its translated "New conversation" as the title, while the server renamed only a room called
 * exactly the English marker, so in any other language a room was never named from its first message. The client now
 * sends no title, the server writes its own marker, and the client translates that marker for display only.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { conversationTitleFor, isUnnamedConversation, UNNAMED_CONVERSATION_MARKER } from './conversationTitle';

describe('what a conversation is called on screen', () => {
  it('a room carrying the platform marker is shown in the reader\'s language', () => {
    expect(conversationTitleFor(UNNAMED_CONVERSATION_MARKER, 'Nueva conversación')).toBe('Nueva conversación');
    expect(conversationTitleFor('', 'Nueva conversación')).toBe('Nueva conversación');
  });

  it('a named room is shown as it is, even when its name is a translated label', () => {
    expect(conversationTitleFor('Quarterly plan', 'Nueva conversación')).toBe('Quarterly plan');
    expect(isUnnamedConversation('Nueva conversación')).toBe(false);
  });

  it('the marker is the server\'s own placeholder, character for character', () => {
    const server = fs.readFileSync(path.resolve(__dirname, '../../../../../backend/lambda/src/lib/conversation-name.ts'), 'utf8');
    expect(server).toContain(`export const PLACEHOLDER_TITLE = '${UNNAMED_CONVERSATION_MARKER}';`);
  });

  it('a new conversation is asked for with no title, so the server names it unnamed in every language', () => {
    const modal = fs.readFileSync(path.resolve(__dirname, '../components/NewConversationModal.tsx'), 'utf8');
    expect(modal).not.toMatch(/newConversation\.defaultTitle/);
    const service = fs.readFileSync(path.resolve(__dirname, '../services/chimeService.ts'), 'utf8');
    expect(service).toMatch(/\.\.\.\(title \? \{ title \} : \{\}\)/);
  });
});
