import { describe, it, expect } from 'vitest';
import { accessKind, accessExpiry, accessAssistant } from './accessLogRow';
import type { AccessLogRecord } from '../../services/accessLogService';

const rec = (event: string, detail: Record<string, unknown> | null = null, at = '2026-10-26T15:00:00.000Z'): AccessLogRecord => ({
  id: 'r', event, at, actor: 'p1', conversation: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c', capabilities: [], reason: 'review', detail,
});

describe('what an access record means', () => {
  it('tells a temporary moderation credential from a temporary read', () => {
    expect(accessKind(rec('admin_scoped_credential_vend', { moderation: true, ttlSeconds: 1800 }))).toBe('temporaryModeration');
    expect(accessKind(rec('admin_scoped_credential_vend', { plane: 'archive', ttlSeconds: 1800 }))).toBe('temporaryRead');
  });

  it('names a team member\'s read and a de-identified read as their own kinds', () => {
    expect(accessKind(rec('team_conversation_read', { assistant: 'hr' }))).toBe('teamRead');
    expect(accessKind(rec('clean_conversation_read'))).toBe('deidentifiedRead');
  });

  it('keeps an event it does not know, rather than calling it something it is not', () => {
    expect(accessKind(rec('something_new'))).toBe('other');
  });

  it('says when a temporary credential stopped working', () => {
    expect(accessExpiry(rec('admin_scoped_credential_vend', { ttlSeconds: 1800 }))?.toISOString()).toBe('2026-10-26T15:30:00.000Z');
  });

  it('gives no expiry to an access that was not a timed credential', () => {
    expect(accessExpiry(rec('team_conversation_read', { assistant: 'hr' }))).toBeNull();
    expect(accessExpiry(rec('access_log_read'))).toBeNull();
  });

  it('names the assistant a team member read through', () => {
    expect(accessAssistant(rec('team_conversation_read', { assistant: 'hr' }))).toBe('hr');
    expect(accessAssistant(rec('admin_scoped_credential_vend', { moderation: true }))).toBeNull();
  });
});
