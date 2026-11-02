/**
 * A LINK TO A MESSAGE, THROUGH THE DASHBOARD. A surface that opens a conversation at a message (a battle row
 * opens it at the /battle message) hands the dashboard the message, the conversation viewer receives it, and
 * the URL carries it as `&msg=<MessageId>&at=<iso>`, so the address someone shares opens at the same message.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const ACCESS = {
  status: 'ready' as const,
  role: 'admins' as const,
  capabilities: new Set(['view-analytics', 'view-experiments', 'manage-experiments', 'view-conversations', 'view-messages']),
  assistants: [] as string[],
  teams: [] as string[],
  owners: {},
  onRequest: null,
};
vi.mock('../../capabilities', () => ({
  useConsoleAccess: () => ACCESS,
  useCan: () => (c: string) => ACCESS.capabilities.has(c),
}));
vi.mock('../../services/analyticsService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  queryAnalytics: vi.fn(async () => ({ data: [], columns: [] })),
}));
vi.mock('../../services/experimentsService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  experimentsAvailable: () => true,
}));

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/x/channel/c-1';
const LINK = { messageId: 'msg-battle-1', at: '2026-10-29T09:59:57.000Z', kind: 'battle' as const };

// The Experiments view stands in for a battle row: one button that opens the conversation at its message.
vi.mock('./ExperimentsTab', () => ({
  default: ({ onOpenConversation }: { onOpenConversation?: (arn: string, m?: unknown) => void }) => (
    <button type="button" onClick={() => onOpenConversation?.(CHANNEL, LINK)}>open battle</button>
  ),
}));
// The viewer stands in as the contract it keeps: take the link, consume it, and report the open conversation with it.
vi.mock('./ConversationsTab', async () => {
  const React = await import('react');
  return {
    default: function ViewerStandIn(p: {
      deepLinkChannelArn?: string | null;
      deepLinkMessage?: { messageId: string | null } | null;
      onDeepLinkConsumed?: () => void;
      onConversationChange?: (arn: string | null, m?: unknown) => void;
    }) {
      const [held, setHeld] = React.useState<{ arn: string; msg: unknown } | null>(null);
      React.useEffect(() => {
        if (!p.deepLinkChannelArn) return;
        setHeld({ arn: p.deepLinkChannelArn, msg: p.deepLinkMessage ?? null });
        p.onDeepLinkConsumed?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [p.deepLinkChannelArn]);
      React.useEffect(() => {
        if (held) p.onConversationChange?.(held.arn, held.msg as never);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [held]);
      return <div data-testid="viewer">{(held?.msg as { messageId?: string } | null)?.messageId ?? 'no message'}</div>;
    },
  };
});

import AdminDashboard from './AdminDashboard';

const param = (k: string) => new URLSearchParams(window.location.search).get(k);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

describe('a link to a message', () => {
  it('a battle row opens the conversation at the /battle message, and the URL says so', async () => {
    window.history.replaceState(null, '', '/?admin=experiments&exp=exp-voice');
    render(<AdminDashboard onBack={() => {}} analyticsMode="aurora" />);
    fireEvent.click(await screen.findByRole('button', { name: 'open battle' }));
    expect(await screen.findByTestId('viewer')).toHaveTextContent('msg-battle-1');
    await waitFor(() => expect(param('msg')).toBe('msg-battle-1'));
    expect(param('admin')).toBe('conversations');
    expect(param('conv')).toBe('c-1');
    expect(param('at')).toBe('2026-10-29T09:59:57.000Z');
    expect(param('kind')).toBe('battle');
  });

  it('a shared address opens the viewer at the message it names', async () => {
    window.history.replaceState(null, '', `/?admin=conversations&conv=${encodeURIComponent(CHANNEL)}&msg=m-7&at=2026-10-29T10:00:00Z`);
    render(<AdminDashboard onBack={() => {}} analyticsMode="aurora" />);
    expect(await screen.findByTestId('viewer')).toHaveTextContent('m-7');
  });
});
