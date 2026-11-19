import { describe, it, expect } from 'vitest';
import { accessActor, accessKind, accessExpiry, accessAssistant, accessScope, reasonRequired, servedOnConsoleSession } from './accessLogRow';
import type { AccessLogRecord } from '../../services/accessLogService';
import i18n from '@ae/shared/i18n';

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

  it('names a meeting transcript read and a meeting ended for everyone in words, each reason-gated', () => {
    const read = rec('meeting_transcript_read', { meetingId: 'm-1', classification: 'premium', scope: 'full' });
    const ended = rec('meeting_ended_for_all', { meetingId: 'm-1', classification: 'premium', scope: 'full' });
    expect(accessKind(read)).toBe('meetingTranscriptRead');
    expect(accessKind(ended)).toBe('meetingEnded');
    expect(reasonRequired(read) && reasonRequired(ended)).toBe(true);
    expect(i18n.t(`admin.accessLog.kind.${accessKind(read)}`)).toBe('Meeting transcript and summary read');
    expect(i18n.t(`admin.accessLog.kind.${accessKind(ended)}`)).toBe('Meeting ended for everyone');
    expect(i18n.t('admin.accessLog.allows.end-meetings')).toBe('End a meeting for everyone');
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

  it('names an analytics content read and a team responses read as their own kinds, each reason-gated and read on the session', () => {
    const content = rec('analytics_content_read', { queryType: 'ground_truth', scope: 'basic' });
    const team = rec('team_quality_read', { assistant: 'hr', queryType: 'flagged_responses' });
    expect(accessKind(content)).toBe('contentRead');
    expect(accessKind(team)).toBe('teamResponsesRead');
    for (const r of [content, team]) {
      expect(reasonRequired(r)).toBe(true);
      expect(servedOnConsoleSession(r)).toBe(true);
    }
    expect(accessScope(content)).toEqual({ role: null, assistant: null, classifications: 'basic', query: 'ground_truth' });
  });

  it('asks no reason of a console sign-in or a read of this log', () => {
    expect(reasonRequired(rec('admin_console_session_vend', { role: 'admins' }))).toBe(false);
    expect(reasonRequired(rec('access_log_read'))).toBe(false);
    expect(reasonRequired(rec('admin_scoped_credential_vend', { ttlSeconds: 1800 }))).toBe(true);
  });
});

describe('who was given the access', () => {
  it('names a person by id, and a reader that is not a person by its IAM role', () => {
    expect(accessActor(rec('x'))).toEqual({ kind: 'person', id: 'p1' });
    const assumed = 'arn:aws:sts::111122223333:assumed-role/App-AdminRole-def/ops-automation';
    expect(accessActor({ ...rec('x'), actor: 'iam#' + assumed, actorKind: 'iam', actorPrincipalArn: assumed })).toEqual({ kind: 'iam', name: 'App-AdminRole-def', arn: assumed });
    const role = 'arn:aws:iam::111122223333:role/service/OpsAutomation';
    expect(accessActor({ ...rec('x'), actorKind: 'iam', actorPrincipalArn: role })).toMatchObject({ name: 'OpsAutomation' });
    expect(accessActor({ ...rec('x'), actor: null })).toBeNull();
  });
});
