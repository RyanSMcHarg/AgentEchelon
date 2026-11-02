/**
 * ONE LIST OF ASSISTANTS, HOWEVER EACH WAS CREATED (owner decision, 2026-10-23).
 *
 * What it proves: a declared assistant and one created in the console are rows of the same table, with
 * how each was created as a detail under its name and no separate "runtime" section; every build state is
 * shown, a failed one with what it left behind; the team filter narrows the rows and the count says so;
 * a team member whose team owns nothing is told so and how to get one; retire is offered only to an admin,
 * on every assistant the route accepts (every one but a classification's primary), whoever asked for it, and a
 * declared assistant retired in the console is a retired row; the list offers no import at all, because an import
 * lands on one assistant and lives in that assistant's Versions group.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import AssistantsList, { assistantRows } from './AssistantsList';
import { retireAssistant } from '../../services/rosterService';
import type { ProfileListing, RuntimeAssistant } from '../../services/profileService';

vi.mock('../../services/rosterService', () => ({ retireAssistant: vi.fn() }));

const profiles = [
  { profileName: 'ops-premium', displayName: 'Ops', activeVersion: 3, versions: [], hasDraft: true, classification: 'premium', role: 'ops', ownerTeam: 'ops', origin: 'deployed', retirable: true },
  { profileName: 'analyst', activeVersion: 1, versions: [], hasDraft: false, classification: 'standard', role: 'primary', ownerTeam: null, origin: 'deployed', retirable: false },
  { profileName: 'finance-advisor', displayName: 'Finance', activeVersion: null, versions: [], hasDraft: false, classification: 'premium', role: 'primary', ownerTeam: 'finance', origin: 'console', retirable: true },
] as ProfileListing[];
const runtime: RuntimeAssistant[] = [
  { assistant: 'finance-advisor', classification: 'premium', role: 'primary', status: 'active', displayName: 'Finance', ownerTeam: 'finance' },
  { assistant: 'new-advisor', classification: 'standard', role: 'primary', status: 'provisioning', ownerTeam: 'ops' },
  { assistant: 'bad-advisor', classification: 'premium', role: 'primary', status: 'failed', error: 'denied', leftover: ['Lex bot X'] },
  { assistant: 'old-advisor', classification: 'basic', role: 'primary', status: 'retired' },
];

const row = (name: string) => document.querySelector(`tr[data-assistant="${name}"]`) as HTMLElement;
const renderList = (over: Partial<React.ComponentProps<typeof AssistantsList>> = {}) => render(
  <AssistantsList rows={assistantRows(profiles, runtime)} teams={['finance', 'ops']} isAdmin canRetire
    onOpen={vi.fn()} onChanged={vi.fn()} {...over} />,
);

beforeEach(() => {
  vi.mocked(retireAssistant).mockReset().mockResolvedValue({ assistantId: 'x', status: 'retired' });
  // These cases read every row, retired ones included; the default that hides them is its own case below.
  window.localStorage.setItem('ae.admin.assistants.showRetired', '1');
});

describe('retired assistants', () => {
  it('are left out by default, and the toggle that brings them back says how many there are', () => {
    window.localStorage.removeItem('ae.admin.assistants.showRetired');
    renderList();
    expect(screen.queryByText('old-advisor')).toBeNull();
    const toggle = screen.getByRole('checkbox', { name: 'Show retired (1)' });
    fireEvent.click(toggle);
    expect(row('old-advisor')).toBeTruthy();
    expect(window.localStorage.getItem('ae.admin.assistants.showRetired')).toBe('1');
  });

  it('offers no toggle when nothing is retired', () => {
    render(<AssistantsList rows={assistantRows(profiles, [])} teams={['ops']} isAdmin canRetire onOpen={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.queryByTestId('assistants-show-retired')).toBeNull();
  });
});

describe('one list', () => {
  it('lists declared and console-created assistants in one table, with no runtime section', () => {
    renderList();
    expect(screen.getAllByRole('table')).toHaveLength(1);
    for (const name of ['ops-premium', 'analyst', 'finance-advisor', 'new-advisor', 'bad-advisor', 'old-advisor']) expect(row(name)).toBeTruthy();
    expect(screen.queryByText(/Runtime assistants/i)).toBeNull();
    expect(within(row('ops-premium')).getByText('Declared in deploy.config.json')).toBeTruthy();
    expect(within(row('finance-advisor')).getByText('Created in the console')).toBeTruthy();
  });

  it('shows each row its classification, role, owning team, status and profile', () => {
    renderList();
    const ops = within(row('ops-premium'));
    expect(ops.getByText('premium')).toBeTruthy();
    expect(ops.getByText('ops')).toBeTruthy();
    expect(ops.getByText('Ops team')).toBeTruthy();
    expect(ops.getByText('Active')).toBeTruthy();
    expect(ops.getByText(/v3/)).toBeTruthy();
    expect(within(row('analyst')).getByText('No team')).toBeTruthy();
  });

  it('shows every build state, and what a failed create left behind', () => {
    renderList();
    expect(within(row('new-advisor')).getByText('Being created')).toBeTruthy();
    expect(within(row('old-advisor')).getByText('Retired')).toBeTruthy();
    expect(within(row('bad-advisor')).getByText(/Lex bot X/)).toBeTruthy();
  });

  it('opens an assistant that has a profile, and offers no open for one still being built', () => {
    const onOpen = vi.fn();
    renderList({ onOpen });
    fireEvent.click(within(row('ops-premium')).getByRole('button', { name: 'Open Ops' }));
    expect(onOpen).toHaveBeenCalledWith('ops-premium');
    expect(within(row('new-advisor')).queryByRole('button', { name: /Open/ })).toBeNull();
  });
});

describe('the team filter and the count', () => {
  it('narrows to one team and says how many of how many are shown', () => {
    renderList();
    expect(screen.getByTestId('assistants-count')).toHaveTextContent('6 assistants');
    fireEvent.change(within(screen.getByTestId('assistants-team-filter')).getByRole('combobox'), { target: { value: 'ops' } });
    expect(row('ops-premium')).toBeTruthy();
    expect(row('new-advisor')).toBeTruthy();
    expect(row('analyst')).toBeNull();
    expect(screen.getByTestId('assistants-count')).toHaveTextContent('2 of 6 assistants');
  });

  it('shows a team member with one team their team as a fixed label, not a select', () => {
    renderList({ rows: assistantRows([profiles[0]], []), teams: ['ops'], isAdmin: false, canRetire: false });
    const filter = screen.getByTestId('assistants-team-filter');
    expect(within(filter).queryByRole('combobox')).toBeNull();
    expect(filter).toHaveTextContent('Ops team');
  });

  it('tells a team member whose team owns nothing so, and how to get one', () => {
    renderList({ rows: [], teams: ['ops'], isAdmin: false, canRetire: false });
    const empty = screen.getByTestId('assistants-empty');
    expect(empty).toHaveTextContent('Your team owns no assistants yet.');
    expect(empty).toHaveTextContent('Create an assistant');
    expect(empty).toHaveTextContent('ask an administrator');
  });
});

describe('actions', () => {
  it('offers retire on a declared assistant and a console-created one alike, never on a primary, and remove for a failed one', () => {
    renderList();
    expect(within(row('finance-advisor')).queryByText('Retire')).toBeTruthy();
    expect(within(row('ops-premium')).queryByText('Retire')).toBeTruthy();
    expect(within(row('bad-advisor')).queryByText('Remove')).toBeTruthy();
    // A classification's primary is not retired: every room needs one.
    expect(within(row('analyst')).queryByText('Retire')).toBeNull();
    expect(within(row('old-advisor')).queryByText('Retire')).toBeNull();
    expect(within(row('new-advisor')).queryByText('Retire')).toBeNull();
  });

  it('offers no retire to a team member', () => {
    renderList({ isAdmin: false, canRetire: false });
    expect(screen.queryByText('Retire')).toBeNull();
    expect(screen.queryByText('Remove')).toBeNull();
  });

  it('sends nothing when the retire confirmation is declined, and retires when confirmed', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderList();
    fireEvent.click(within(row('finance-advisor')).getByText('Retire'));
    expect(retireAssistant).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(within(row('finance-advisor')).getByText('Retire'));
    expect(retireAssistant).toHaveBeenCalledWith('finance-advisor');
    confirm.mockRestore();
  });

  it('offers no import anywhere in the list, not even for a console-created assistant with no version', () => {
    renderList();
    // An import names the assistant it lands on, so the only place it is offered is that assistant's own
    // configuration. A list-level control could not say which assistant would get the manifest.
    expect(screen.queryByText(/import/i)).toBeNull();
    expect(document.querySelector('[data-testid="assistants-list"] input[type="file"]')).toBeNull();
    expect(within(row('finance-advisor')).getByText('No active version')).toBeTruthy();
  });
});

describe('what a row says about ownership, removal and its first draft', () => {
  it('shows "No team" for an owner an admin cleared, not the team the assistant was created for', () => {
    // The listing's owner is the tag (cleared: null); the roster entry still names the team it was created for.
    const cleared = [{ ...profiles[2], ownerTeam: null }] as ProfileListing[];
    render(<AssistantsList rows={assistantRows(cleared, [runtime[0]])} teams={['finance']} isAdmin canRetire onOpen={vi.fn()} onChanged={vi.fn()} />);
    const r = within(row('finance-advisor'));
    expect(r.getByText('No team')).toBeTruthy();
    expect(r.queryByText('Finance team')).toBeNull();
  });

  it('adds no note to a declared assistant: how it was created is the quiet detail under its name, nothing more', () => {
    renderList();
    const ops = within(row('ops-premium'));
    expect(ops.getByRole('button', { name: /Retire/ })).toBeTruthy();
    expect(ops.queryByRole('link')).toBeNull();
    expect(ops.queryByRole('note')).toBeNull();
  });

  it('lists a declared assistant retired in the console as a retired row, like any other', () => {
    const retired: RuntimeAssistant[] = [{ assistant: 'ops-premium', classification: 'premium', role: 'ops', status: 'retired', origin: 'declared', retirable: true }];
    render(<AssistantsList rows={assistantRows([profiles[1]], retired)} teams={['ops']} isAdmin canRetire onOpen={vi.fn()} onChanged={vi.fn()} />);
    const r = within(row('ops-premium'));
    expect(r.getByText('Retired')).toBeTruthy();
    expect(r.getByText('Declared in deploy.config.json')).toBeTruthy();
    expect(r.queryByRole('button', { name: /Retire|Open/ })).toBeNull();
  });

  it('shows a seeded first draft as ready to activate rather than offering an import', () => {
    const drafted = [{ ...profiles[2], hasDraft: true }] as ProfileListing[];
    render(<AssistantsList rows={assistantRows(drafted, [runtime[0]])} teams={['finance']} isAdmin canRetire onOpen={vi.fn()} onChanged={vi.fn()} />);
    expect(within(row('finance-advisor')).getByTestId('draft-ready')).toHaveTextContent('Draft ready to activate');
    expect(within(row('finance-advisor')).queryByText(/import/i)).toBeNull();
  });

  it('says why a team cannot open its new assistant when the owner tag was not written', () => {
    const rt = [{ ...runtime[0], ownerSeedError: 'Unhandled' }];
    render(<AssistantsList rows={assistantRows(profiles, rt)} teams={['finance']} isAdmin canRetire onOpen={vi.fn()} onChanged={vi.fn()} />);
    expect(within(row('finance-advisor')).getByRole('note')).toHaveTextContent('Its owning team was not recorded (Unhandled)');
  });

  it('says a first draft was not created, while there is no version and no draft', () => {
    const rt = [{ ...runtime[0], firstDraftError: 'pack unreadable' }];
    render(<AssistantsList rows={assistantRows(profiles, rt)} teams={['finance']} isAdmin canRetire onOpen={vi.fn()} onChanged={vi.fn()} />);
    expect(within(row('finance-advisor')).getByRole('note')).toHaveTextContent('Its first draft was not created (pack unreadable)');
  });
});

describe('the event workflows column', () => {
  const listed = [
    { ...profiles[0], activeEventWorkflows: [
      { name: 'welcome', on: 'assistant-joined' },
      { name: 'welcome-ops', on: 'assistant-joined', types: ['ops'] },
      { name: 'ops-room', on: 'conversation-opened', types: ['ops'] },
    ], activeOnboarding: false },
    { ...profiles[1], activeEventWorkflows: [], activeOnboarding: true },
    { ...profiles[1], profileName: 'quiet', activeEventWorkflows: [], activeOnboarding: false },
    { ...profiles[1], profileName: 'unread' },
  ] as ProfileListing[];
  const renderColumn = () => render(<AssistantsList rows={assistantRows(listed, [])} teams={[]} isAdmin canRetire={false} onOpen={vi.fn()} onChanged={vi.fn()} />);

  it('names each assistant\'s workflows by the event that starts them, with each one\'s rooms', () => {
    renderColumn();
    expect(screen.getByRole('columnheader', { name: 'Event workflows' })).toBeTruthy();
    const cell = screen.getByTestId('assistant-workflows-ops-premium');
    const welcome = cell.querySelector('[data-event="assistant-joined"]') as HTMLElement;
    expect(welcome).toHaveTextContent('Welcome welcomewelcome-ops');
    expect(within(welcome).getByText('welcome-ops')).toHaveAttribute('title', 'In ops conversations');
    expect(cell.querySelector('[data-event="conversation-opened"]')).toHaveTextContent('Conversation opened ops-room');
  });

  it('says how an assistant with none welcomes people, and leaves an unread one unclaimed', () => {
    renderColumn();
    expect(screen.getByTestId('assistant-workflows-analyst')).toHaveTextContent('Welcomes through onboarding');
    expect(screen.getByTestId('assistant-workflows-quiet')).toHaveTextContent('None');
    expect(within(row('unread')).getByText('Not read')).toBeTruthy();
  });

  it('carries the listing\'s workflows onto a row the roster also names', () => {
    const rows = assistantRows([listed[0]], [{ assistant: 'ops-premium', classification: 'premium', role: 'ops', status: 'active' }]);
    expect(rows[0].eventWorkflows?.map((w) => w.name)).toEqual(['welcome', 'welcome-ops', 'ops-room']);
  });
});
