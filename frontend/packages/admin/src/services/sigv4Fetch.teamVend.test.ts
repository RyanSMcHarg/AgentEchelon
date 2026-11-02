/**
 * A TEAM MEMBER'S VEND GOES TO ITS ASSISTANT'S ROUTE (SPEC-ADMIN-CONSOLE FR48).
 *
 * A team console session reaches only `.../assistants/{assistant}/...` paths, so the attachment a team
 * member opens is requested under the assistant the console is scoped to, where the exchange binds it
 * to that assistant. An admin's vend is unchanged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@ae/shared/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@ae/shared', () => ({
  REGION: 'us-east-1',
  ApiError: class ApiError extends Error {},
  ensureFreshIdToken: async () => 'id-token',
}));
vi.stubEnv('VITE_ADMIN_API_URL', 'https://admin.example.com/');

import { vendUrl } from './sigv4Fetch';
import { setTeamAssistant } from './teamScope';

describe('where a capability is vended', () => {
  afterEach(() => setTeamAssistant(null));

  it('is the admin route for an admin', () => {
    expect(vendUrl('attachment-read')).toBe('https://admin.example.com/exchange-credentials/admin/attachment-read');
  });

  it('is the assistant\'s route for a team member', () => {
    setTeamAssistant('hr assistant');
    expect(vendUrl('attachment-read')).toBe('https://admin.example.com/exchange-credentials/admin/assistants/hr%20assistant/attachment-read');
  });
});
