/**
 * WHAT A MEETINGS READ THAT FAILED SAYS (`meetingErrorText`): each code the meetings route answers is worded from the
 * locale, never from the handler's own text, including a read of the meeting's events cut short (`INCOMPLETE`, 503: try
 * again) and a meeting outside the reader's classifications (`OUTSIDE_SCOPE`, 403).
 */
import { describe, it, expect } from 'vitest';
import i18n from '@ae/shared/i18n';
import { ApiError } from '@ae/shared';
import en from '@ae/shared/locales/en.json';
import { meetingErrorText } from './meetingFormat';

describe('a meetings read that failed', () => {
  it('says a read cut short can be tried again, in the locale and not the handler\'s words', async () => {
    await i18n.changeLanguage('en');
    const e = new ApiError(503, 'handler text', { error: 'The meetings could not be read whole; try a shorter window', code: 'INCOMPLETE' });
    expect(meetingErrorText(e, 'admin.meetings.loadFailed')).toBe(en.admin.meetings.errors.INCOMPLETE);
    expect(en.admin.meetings.errors.INCOMPLETE).toMatch(/Try again/);
  });

  it('says a meeting outside the reader\'s classifications is outside them', async () => {
    await i18n.changeLanguage('en');
    const e = new ApiError(403, 'handler text', { error: 'x', code: 'OUTSIDE_SCOPE' });
    expect(meetingErrorText(e, 'admin.meetings.loadFailed')).toBe(en.admin.meetings.errors.OUTSIDE_SCOPE);
  });

  it('reads a code the console has no words for as the caller\'s fallback', async () => {
    await i18n.changeLanguage('en');
    const e = new ApiError(500, 'handler text', { code: 'SOMETHING_NEW' });
    expect(meetingErrorText(e, 'admin.meetings.loadFailed')).toBe(en.admin.meetings.loadFailed);
  });
});
