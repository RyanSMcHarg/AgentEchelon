/**
 * A CONVERSATION'S DASHBOARD (DESIGN-CONVERSATION-DASHBOARDS): its card is drawn only from an assistant's own message, the
 * in-app dashboard is read with the member's own signed request and shown in a frame that runs nothing, an open dashboard
 * reads again when its message is updated, and the page opens on a signed link.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import '@ae/shared/i18n';
import { DashboardCard } from './DashboardCard';
import { dashboardFromMetadata, dashboardDocument, dashboardPageLink, presignedGet, readDashboardSnapshot, DashboardError } from '../services/dashboardService';

const shared = vi.hoisted(() => ({
  person: 'p1',
  served: true,
  exchange: vi.fn(),
  sessionEnded: [] as Array<() => void>,
}));
vi.mock('@ae/shared', async (actual) => ({
  ...await actual<typeof import('@ae/shared')>(),
  ensureFreshIdToken: async () => 'token',
  resolvePersonIdentity: async () => ({ personId: shared.person, userArn: '', consoleRole: null }),
  exchangeCredentials: shared.exchange,
  onSessionEnd: (listener: () => void) => { shared.sessionEnded.push(listener); },
  personApiServes: () => shared.served,
  personUrl: (path: string) => `https://person.example${path}`,
}));

const ROOM = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/esc-1';
const OPS = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops';
const PERSON = 'arn:aws:chime:us-east-1:1:app-instance/i/user/p1';
const snapshot = { kind: 'snapshot' as const, conversationId: 'esc-1', updatedAt: '2026-11-08T13:00:00.000Z', state: 'ALARM' as const };

describe('the dashboard message', () => {
  it('is drawn from an assistant\'s message, and from no person\'s however its Metadata reads', () => {
    const metadata = { botResponse: true, dashboard: snapshot };
    expect(dashboardFromMetadata(metadata, OPS)).toEqual(snapshot);
    expect(dashboardFromMetadata(metadata, PERSON)).toBeUndefined();
  });

  it('accepts a conversation id with an underscore, and refuses one that is not an id', () => {
    expect(dashboardFromMetadata({ dashboard: { ...snapshot, conversationId: 'conv-incident_room-1' } }, OPS)?.conversationId).toBe('conv-incident_room-1');
    expect(dashboardFromMetadata({ dashboard: { ...snapshot, conversationId: '../x' } }, OPS)).toBeUndefined();
  });
});

describe('the in-app dashboard', () => {
  /** A tab the app opened: its own blank document, which the card paints the dashboard into. */
  let tab: { opener: unknown; closed: boolean; document: Document; close: () => void };
  let open: ReturnType<typeof vi.spyOn>;
  const frameIn = () => tab.document.querySelector('iframe');
  beforeEach(() => {
    tab = { opener: {}, closed: false, document: document.implementation.createHTMLDocument(''), close: vi.fn() };
    open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
  });
  afterEach(() => { open.mockRestore(); });

  it('opens in a tab of its own, so the conversation stays usable, in a frame that runs nothing', async () => {
    const user = userEvent.setup();
    const read = vi.fn().mockResolvedValue('<main class="dash">figures</main>');
    render(<DashboardCard dashboard={snapshot} channelArn={ROOM} read={read} />);
    await user.click(screen.getByRole('button', { name: 'Open dashboard' }));
    await vi.waitFor(() => expect(frameIn()).not.toBeNull());
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(tab.opener).toBeNull();
    expect(frameIn()!.getAttribute('sandbox')).toBe('');
    expect(frameIn()!.srcdoc).toContain('figures');
    expect(read).toHaveBeenCalledWith(ROOM);
    // Nothing modal is left in the app: the conversation can still be clicked.
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('titles the tab for its conversation, so a reader knows which incident it is', async () => {
    const user = userEvent.setup();
    const read = vi.fn().mockResolvedValue('<main class="dash">figures</main>');
    render(<DashboardCard dashboard={snapshot} channelArn={ROOM} conversationName="AgentEchelon Demo Incident" read={read} />);
    await user.click(screen.getByRole('button', { name: 'Open dashboard' }));
    await vi.waitFor(() => expect(frameIn()).not.toBeNull());
    expect(tab.document.title).toBe('Dashboard: AgentEchelon Demo Incident');
  });

  it('reads again when its message is updated while the tab is open, and leaves a closed tab alone', async () => {
    const user = userEvent.setup();
    const read = vi.fn().mockResolvedValue('<main>figures</main>');
    const { rerender } = render(<DashboardCard dashboard={snapshot} channelArn={ROOM} read={read} />);
    await user.click(screen.getByRole('button', { name: 'Open dashboard' }));
    rerender(<DashboardCard dashboard={{ ...snapshot, updatedAt: '2026-11-08T13:05:00.000Z', state: 'OK' }} channelArn={ROOM} read={read} />);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    tab.closed = true;
    rerender(<DashboardCard dashboard={{ ...snapshot, updatedAt: '2026-11-08T13:10:00.000Z' }} channelArn={ROOM} read={read} />);
    await act(async () => { await Promise.resolve(); });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('lets go of a tab the person sent to another page, rather than failing the app on its document', async () => {
    const user = userEvent.setup();
    const read = vi.fn().mockResolvedValue('<main>figures</main>');
    const { rerender } = render(<DashboardCard dashboard={snapshot} channelArn={ROOM} read={read} />);
    await user.click(screen.getByRole('button', { name: 'Open dashboard' }));
    await vi.waitFor(() => expect(frameIn()).not.toBeNull());
    // Another origin's document: reading it throws, as a browser's cross-origin check does.
    Object.defineProperty(tab, 'document', { get: () => { throw new DOMException('Blocked a frame', 'SecurityError'); } });
    rerender(<DashboardCard dashboard={{ ...snapshot, updatedAt: '2026-11-08T13:05:00.000Z' }} channelArn={ROOM} read={read} />);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('button', { name: 'Open dashboard' })).toBeInTheDocument();
    // Let go: a later update reads nothing for it.
    rerender(<DashboardCard dashboard={{ ...snapshot, updatedAt: '2026-11-08T13:10:00.000Z' }} channelArn={ROOM} read={read} />);
    await act(async () => { await Promise.resolve(); });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps the latest read when an older one answers after it', async () => {
    const user = userEvent.setup();
    const answers: Array<(html: string) => void> = [];
    const read = vi.fn(() => new Promise<string>((resolve) => { answers.push(resolve); }));
    const { rerender } = render(<DashboardCard dashboard={snapshot} channelArn={ROOM} read={read} />);
    await user.click(screen.getByRole('button', { name: 'Open dashboard' }));
    rerender(<DashboardCard dashboard={{ ...snapshot, updatedAt: '2026-11-08T13:05:00.000Z' }} channelArn={ROOM} read={read} />);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => { answers[1]('<main>newer</main>'); });
    await vi.waitFor(() => expect(frameIn()?.srcdoc).toContain('newer'));
    await act(async () => { answers[0]('<main>older</main>'); });
    expect(frameIn()!.srcdoc).toContain('newer');
    expect(frameIn()!.srcdoc).not.toContain('older');
  });

  it('says why it could not open, in the client\'s own words, in the card and in the tab', async () => {
    const user = userEvent.setup();
    const read = vi.fn().mockRejectedValue(new DashboardError('NOT_A_MEMBER'));
    render(<DashboardCard dashboard={snapshot} channelArn={ROOM} read={read} />);
    await user.click(screen.getByRole('button', { name: 'Open dashboard' }));
    expect(await screen.findByText('Only the people in this conversation can open its dashboard.')).toBeTruthy();
    expect(tab.document.body.textContent).toContain('Only the people in this conversation can open its dashboard.');
  });

  it('says so when the browser blocks the tab', async () => {
    open.mockReturnValue(null);
    const user = userEvent.setup();
    render(<DashboardCard dashboard={snapshot} channelArn={ROOM} read={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Open dashboard' }));
    expect(await screen.findByText(/blocked the new tab/)).toBeTruthy();
  });

  it('wraps the markup in a document whose policy loads and runs nothing', () => {
    const doc = dashboardDocument('<main>x</main>', 'en');
    expect(doc).toContain("default-src 'none'");
    expect(doc).not.toMatch(/script-src/);
  });
});

describe('the page dashboard', () => {
  it('opens a tab within the click, and sends it to the signed link', async () => {
    const user = userEvent.setup();
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const link = vi.fn().mockResolvedValue('https://d1.cloudfront.net/dashboards/premium/esc-1/page.html?Signature=x');
    render(<DashboardCard dashboard={{ ...snapshot, kind: 'page' }} channelArn={ROOM} link={link} />);
    await user.click(screen.getByRole('button', { name: 'Open dashboard page' }));
    await vi.waitFor(() => expect(tab.location.href).toContain('Signature=x'));
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(tab.opener).toBeNull();
    open.mockRestore();
  });
});

describe('the page link', () => {
  afterEach(() => { shared.served = true; vi.unstubAllGlobals(); });

  it('DENY: where the deployment does not serve the route, no request is made', async () => {
    shared.served = false;
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    await expect(dashboardPageLink('esc-1')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(fetched).not.toHaveBeenCalled();
  });
});

describe('the exchange\'s answer, held', () => {
  const vended = () => ({
    credentials: { accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c', expiration: new Date(Date.now() + 900_000) },
    dashboard: { bucket: 'ae-attachments', key: 'dashboards/premium/esc-1/snapshot.json', region: 'us-east-1' },
  });
  const answering = (status: number) => vi.fn(async () => ({ status, ok: status < 400, json: async () => ({ html: '<main>x</main>' }) }));

  beforeEach(() => {
    for (const end of shared.sessionEnded) end();
    shared.person = 'p1';
    shared.exchange.mockReset();
    shared.exchange.mockImplementation(async () => vended());
    vi.stubGlobal('fetch', answering(200));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('serves the same person a second read of the conversation without a new exchange', async () => {
    await readDashboardSnapshot(ROOM);
    await readDashboardSnapshot(ROOM);
    expect(shared.exchange).toHaveBeenCalledTimes(1);
  });

  it('DENY: another person signed in on this client never reads with the first person\'s credential', async () => {
    await readDashboardSnapshot(ROOM);
    shared.person = 'p2';
    await readDashboardSnapshot(ROOM);
    expect(shared.exchange).toHaveBeenCalledTimes(2);
  });

  it('DENY: a sign-out drops what was held', async () => {
    await readDashboardSnapshot(ROOM);
    for (const end of shared.sessionEnded) end();
    await readDashboardSnapshot(ROOM);
    expect(shared.exchange).toHaveBeenCalledTimes(2);
  });

  it('DENY: an answer is held no longer than 60 seconds, so a clearance change is checked again', async () => {
    const start = Date.now();
    await readDashboardSnapshot(ROOM);
    vi.spyOn(Date, 'now').mockReturnValue(start + 61_000);
    await readDashboardSnapshot(ROOM);
    expect(shared.exchange).toHaveBeenCalledTimes(2);
  });

  it.each([403, 404])('reads a %i from S3 as not published yet', async (status) => {
    vi.stubGlobal('fetch', answering(status));
    await expect(readDashboardSnapshot(ROOM)).rejects.toMatchObject({ code: 'NOT_PUBLISHED' });
  });

  it('reads any other failure as unavailable', async () => {
    vi.stubGlobal('fetch', answering(500));
    await expect(readDashboardSnapshot(ROOM)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

describe('the member\'s signed read', () => {
  it('signs exactly as the AWS SDK signs, so S3 accepts it', async () => {
    const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'tok/en+=' };
    const loc = { bucket: 'ae-attachments', key: 'dashboards/premium/esc-1/snapshot.json', region: 'us-east-1' };
    const now = new Date('2026-11-08T13:00:00.000Z');
    const ours = new URL(await presignedGet(loc, creds, now));
    const signer = new SignatureV4({ credentials: creds, region: 'us-east-1', service: 's3', sha256: Sha256, uriEscapePath: false });
    const theirs = await signer.presign({
      method: 'GET', protocol: 'https:', hostname: `${loc.bucket}.s3.us-east-1.amazonaws.com`, path: `/${loc.key}`,
      headers: { host: `${loc.bucket}.s3.us-east-1.amazonaws.com`, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' }, query: {},
    }, { signingDate: now, expiresIn: 300, unsignableHeaders: new Set(['x-amz-content-sha256']), unhoistableHeaders: new Set(['x-amz-content-sha256']) });
    expect(ours.searchParams.get('X-Amz-Signature')).toBe(theirs.query?.['X-Amz-Signature']);
  });
});
