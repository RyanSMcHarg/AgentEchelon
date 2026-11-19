import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@ae/shared/i18n';
import en from '@ae/shared/locales/en.json';
import { openTranscript, transcriptLinkTarget } from './transcriptLink';
import { CollapsibleText } from '../components/CollapsibleText';

const mockDownload = vi.fn();
vi.mock('../services/attachmentService', () => ({ getDownloadUrl: (...a: unknown[]) => mockDownload(...a) }));

const KEY = 'transcripts/standard/meetconv1/m-1.md';
/** The tab the click opens, blank until the address is signed. */
let tab: { opener: unknown; location: { href: string }; close: ReturnType<typeof vi.fn> };

describe('a transcript link', () => {
  it('names a transcript and the conversation it belongs to', () => {
    expect(transcriptLinkTarget(`?transcript=${encodeURIComponent(KEY)}`)).toEqual({ key: KEY, conversationId: 'meetconv1' });
  });

  it('is nothing else: another family, another origin, a traversal', () => {
    for (const href of [
      `?transcript=${encodeURIComponent('attachments/meetconv1/p1/x.md')}`,
      'https://example.com/?transcript=x',
      `?transcript=${encodeURIComponent('transcripts/standard/../x/m-1.md')}`,
      '?conversation=meetconv1',
    ]) expect(transcriptLinkTarget(href)).toBeNull();
  });
});

describe('the ended card\'s transcript link', () => {
  beforeEach(() => { mockDownload.mockReset(); tab = { opener: {}, location: { href: 'about:blank' }, close: vi.fn() }; vi.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window); });

  it('opens through the signed download path for the meeting\'s conversation', async () => {
    mockDownload.mockResolvedValue('https://signed.example/x');
    render(<CollapsibleText isBot content={`- [Transcript](?transcript=${encodeURIComponent(KEY)})`} />);
    fireEvent.click(screen.getByRole('link', { name: 'Transcript' }));
    await waitFor(() => expect(mockDownload).toHaveBeenCalledWith(KEY, 'meetconv1', '', {}));
  });

  it('resolves false where the server refused to sign it, so the card says so in place, and closes the tab it opened', async () => {
    mockDownload.mockImplementation(() => Promise.reject(new Error('refused')));
    expect(await openTranscript({ key: KEY, conversationId: 'meetconv1' })).toBe(false);
    expect(tab.close).toHaveBeenCalled();
    expect(en.meeting.transcriptLink.failed).toBeTruthy();
  });

  it('opens the tab within the click, before signing, and sends it to the signed address once it arrives', async () => {
    let answer: (url: string) => void = () => undefined;
    mockDownload.mockImplementation(() => new Promise<string>((r) => { answer = r; }));
    const opened = openTranscript({ key: KEY, conversationId: 'meetconv1' });
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(tab.opener).toBeNull();
    await waitFor(() => expect(mockDownload).toHaveBeenCalled());
    answer('https://signed.example/late');
    expect(await opened).toBe(true);
    expect(tab.location.href).toBe('https://signed.example/late');
  });

  it('says so in place when the browser blocks the tab, rather than failing silently', async () => {
    vi.mocked(window.open).mockReturnValue(null);
    expect(await openTranscript({ key: KEY, conversationId: 'meetconv1' })).toBe(false);
    expect(mockDownload).not.toHaveBeenCalled();
  });
});

describe('a meeting\'s transcript and recording are its hosts\' (FR28, FR70)', () => {
  const REC = 'recordings/standard/meetconv1/m-1/p-1/media/composited-video/cat-1.mp4';
  const card = `- [Transcript](?transcript=${encodeURIComponent(KEY)})\n- [Recording](?recording=${encodeURIComponent(REC)})`;
  beforeEach(() => { mockDownload.mockReset(); tab = { opener: {}, location: { href: 'about:blank' }, close: vi.fn() }; vi.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window); });

  it('offers a host each to view and to download, the download signed to save the file', async () => {
    mockDownload.mockResolvedValue('https://signed.example/x');
    render(<CollapsibleText isBot content={card} meetingFiles={{ hosts: ['host-1'], viewerId: 'host-1' }} />);
    expect(screen.getAllByRole('link', { name: en.meeting.transcriptLink.download })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('link', { name: en.meeting.transcriptLink.download })[0]);
    await waitFor(() => expect(mockDownload).toHaveBeenCalledWith(KEY, 'meetconv1', '', { disposition: 'attachment' }));
    fireEvent.click(screen.getByRole('link', { name: 'Recording' }));
    await waitFor(() => expect(mockDownload).toHaveBeenLastCalledWith(REC, 'meetconv1', '', {}));
  });

  it('a card naming no host offers the links to every reader, and the server decides who is signed for', () => {
    render(<CollapsibleText isBot content={card} meetingFiles={{ hosts: [], viewerId: 'moderator-3' }} />);
    expect(screen.getByRole('link', { name: 'Recording' })).toBeTruthy();
    expect(screen.queryByText(`(${en.meeting.transcriptLink.hostsOnly})`)).toBeNull();
  });

  it('tells a member who did not host it that they are the hosts\', with no link to follow', () => {
    render(<CollapsibleText isBot content={card} meetingFiles={{ hosts: ['host-1'], viewerId: 'member-2' }} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getAllByText(`(${en.meeting.transcriptLink.hostsOnly})`)).toHaveLength(2);
    expect(mockDownload).not.toHaveBeenCalled();
  });
});

describe('the ended card\'s recording link (FR70)', () => {
  const REC = 'recordings/standard/meetconv1/m-1/p-1/media/composited-video/cat-1.mp4';
  beforeEach(() => { mockDownload.mockReset(); tab = { opener: {}, location: { href: 'about:blank' }, close: vi.fn() }; vi.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window); });

  it('names the recording and its conversation, and nothing else of the family', () => {
    expect(transcriptLinkTarget(`?recording=${encodeURIComponent(REC)}`)).toEqual({ key: REC, conversationId: 'meetconv1' });
    for (const key of [
      'recordings/standard/meetconv1/m-1/p-1/capture/composited-video/1.mp4',
      'recordings/standard/../x/m-1/p-1/media/composited-video/cat-1.mp4',
      'transcripts/standard/meetconv1/m-1.md',
    ]) expect(transcriptLinkTarget(`?recording=${encodeURIComponent(key)}`)).toBeNull();
  });

  it('opens through the signed download path for the meeting\'s conversation', async () => {
    mockDownload.mockResolvedValue('https://signed.example/r');
    render(<CollapsibleText isBot content={`- [Recording](?recording=${encodeURIComponent(REC)})`} />);
    fireEvent.click(screen.getByRole('link', { name: 'Recording' }));
    await waitFor(() => expect(mockDownload).toHaveBeenCalledWith(REC, 'meetconv1', '', {}));
  });
});
