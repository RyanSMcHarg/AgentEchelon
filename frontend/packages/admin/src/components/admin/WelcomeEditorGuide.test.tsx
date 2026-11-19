/**
 * THE OPENING SAYS HOW IT IS MADE, AND THE PREVIEW IS WHAT THE ROUTER POSTS.
 *
 * What it proves: the guide says what the built-in opening is made of and lists every field Opening text may name,
 * inserting one on a click; the preview renders the built-in opening itself when no opening text applies; a
 * template's line naming a field the sample lacks is dropped; a conversation type's own welcome replaces the one for
 * every other room in that type and the guide says which one applies (W1, the router's `welcomeWorkflowOf`); and on
 * several inputs the preview equals what the server's renderer produces from the same opening and conversation.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WelcomeEditorGuide, { GreetedWith, previewWelcome } from './WelcomeEditorGuide';
import {
  composeWelcome,
  renderWelcomeTemplate,
  type WelcomeOpeningStep,
  type WelcomeOrientation,
} from '../../../../../../backend/lambda/src/lib/welcome-orientation.ts';
import type { EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';

const TEMPLATE = "Hi, I'm the {{role}} assistant.\nI opened this conversation because {{eventSummary}}\nHappy to help with {{topic}}.";
const OPS = 'An alert opened this conversation: {{eventSummary}}\nI can read the metrics behind it.';
const opens = (opening: WelcomeOpeningStep, types?: string[]): EventWorkflow => ({
  on: 'assistant-joined', ...(types ? { types } : {}), initial: 'opening',
  states: { opening: { opening, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } },
});
/** An assistant whose own openings are for its conversation types, beside a welcome for every other room with prompts only. */
const BY_TYPE: Record<string, EventWorkflow> = {
  welcome: opens({ examples: ['Summarize the Q3 renewals'] }),
  'welcome-ops': opens({ text: OPS }, ['ops']),
  'welcome-ops-team': opens({ text: 'The ops team is here. {{eventSummary}}', examples: ['Summarize the Q3 renewals'] }, ['ops-team']),
};

describe('the welcome guide', () => {
  it('previews a conversation created with no topic first, which carries no conversation fields', () => {
    render(<WelcomeEditorGuide workflows={null} context={{ deployment: { companyName: 'Stratum' }, isPrimary: true }} />);
    expect((screen.getByTestId('welcome-sample') as HTMLSelectElement).value).toBe('none');
    expect(screen.getByTestId('welcome-preview').textContent).toContain('Stratum');
    expect(screen.getByTestId('welcome-preview').textContent).not.toContain('Q3 renewal forecast');
  });

  it('says what a blank opening says for this assistant, and shows a conditional line and a per-type example', () => {
    const { unmount } = render(<WelcomeEditorGuide workflows={null} context={{ deployment: { companyName: 'Stratum' }, isPrimary: true }} />);
    expect(screen.getByTestId('welcome-built-in')).toHaveTextContent("the deployment's welcome");
    unmount();
    render(<WelcomeEditorGuide workflows={null} />);
    expect(screen.getByTestId('welcome-built-in')).toHaveTextContent('built-in greeting');
  });

  it('renders the built-in opening itself when no opening text applies', () => {
    render(<WelcomeEditorGuide workflows={BY_TYPE} />);
    fireEvent.change(screen.getByTestId('welcome-sample'), { target: { value: 'topic' } });
    const preview = screen.getByTestId('welcome-preview');
    expect(preview.textContent).toBe(composeWelcome({ examples: ['Summarize the Q3 renewals'], topic: 'the Q3 renewal forecast' }).content);
    expect(preview.textContent).toContain('I can help with the Q3 renewal forecast.');
    expect(preview.textContent).toContain('- Summarize the Q3 renewals');
    expect(screen.getByTestId('welcome-applies')).toHaveTextContent('No opening text applies, so the built-in opening is used.');
    fireEvent.change(screen.getByTestId('welcome-sample'), { target: { value: 'continued' } });
    expect(preview.textContent).toContain('This conversation picks up the Q3 renewal forecast');
  });

  it('previews a template for a sample conversation, dropping a line naming a field the sample lacks', () => {
    render(<WelcomeEditorGuide workflows={{ welcome: opens({ text: TEMPLATE, examples: ['Summarize the Q3 renewals'] }) }} role="primary" />);
    fireEvent.change(screen.getByTestId('welcome-sample'), { target: { value: 'topic' } });
    const preview = screen.getByTestId('welcome-preview');
    expect(preview.textContent).toBe("Hi, I'm the primary assistant.\nHappy to help with the Q3 renewal forecast.");
    expect(screen.getByTestId('welcome-applies')).toHaveTextContent('The default welcome\x27s opening text applies.');
    fireEvent.change(screen.getByTestId('welcome-sample'), { target: { value: 'event' } });
    expect(preview.textContent).toContain('I opened this conversation because p95 latency on the checkout API');
    expect(preview.textContent).not.toContain('Happy to help with');
  });

  it('follows the selected conversation type: its own welcome replaces the one for every other room, and says so', () => {
    const own = { ...BY_TYPE, welcome: opens({ text: 'Default for {{topic}}.', examples: ['Summarize the Q3 renewals'] }) };
    const { rerender } = render(<WelcomeEditorGuide workflows={own} conversationType="ops" />);
    fireEvent.change(screen.getByTestId('welcome-sample'), { target: { value: 'event' } });
    expect(screen.getByTestId('welcome-preview').textContent)
      .toBe('An alert opened this conversation: p95 latency on the checkout API crossed its target for 10 minutes.\nI can read the metrics behind it.');
    expect(screen.getByTestId('welcome-applies')).toHaveTextContent('The opening text for ops applies.');
    rerender(<WelcomeEditorGuide workflows={own} conversationType="incident" />);
    fireEvent.change(screen.getByTestId('welcome-sample'), { target: { value: 'topic' } });
    expect(screen.getByTestId('welcome-preview').textContent).toBe('Default for the Q3 renewal forecast.');
    expect(screen.getByTestId('welcome-applies')).toHaveTextContent('incident has no welcome of its own, so the default welcome applies.');
  });

  it('names the deployment parameter when the welcome that applies says nothing of its own', () => {
    render(<WelcomeEditorGuide workflows={{ 'welcome-ops': opens({ text: OPS }, ['ops']) }} classification="premium" />);
    expect(screen.getByTestId('welcome-applies')).toHaveTextContent('/agent-echelon/assistant/premium/welcome-orientation');
  });
});

describe('the preview and the server renderer agree', () => {
  const event: WelcomeOrientation = { eventSummary: 'Checkout p95 crossed its SLA.' };
  const topic: WelcomeOrientation = { topic: 'the board deck' };
  const continued: WelcomeOrientation = { priorSubject: 'the board deck', priorMessage: 'Can you draft slide 3 with the ARR bridge?' };

  const templated: Array<[string, WelcomeOpeningStep, string | undefined, WelcomeOrientation]> = [
    ['a template, a topic', { text: TEMPLATE, examples: ['Draft the update'] }, undefined, topic],
    ['a template, an event', { text: TEMPLATE, examples: ['Draft the update'] }, undefined, event],
    ['a type\'s own, an event', { text: OPS, examples: ['Draft the update'] }, 'ops', event],
    ['a type\'s own, a topic', { text: 'The ops team is here. {{eventSummary}}', examples: ['Draft the update'] }, 'ops-team', topic],
  ];
  it.each(templated)('%s', (_name, opening, type, conversation) => {
    const orientation: WelcomeOrientation = { ...conversation, examples: opening.examples };
    const server = renderWelcomeTemplate(opening.text!, orientation, { role: 'ops' });
    const expected = server.content.trim() ? server.content : composeWelcome(orientation).content;
    expect(previewWelcome({ w: opens(opening, type ? [type] : undefined) }, type, conversation, 'ops').content).toBe(expected);
  });

  const builtIn: Array<[string, WelcomeOpeningStep, WelcomeOrientation]> = [
    ['the built-in opening, a topic', { examples: ['Draft the update'], companyName: 'Stratum', accessBlurb: 'You have standard access.' }, topic],
    ['the built-in opening, a continuation', { examples: ['Draft the update'], companyName: 'Stratum' }, continued],
    ['the built-in opening, nothing configured', {}, event],
  ];
  it.each(builtIn)('%s', (_name, opening, conversation) => {
    const orientation: WelcomeOrientation = { ...opening, ...conversation };
    expect(previewWelcome({ w: opens(opening) }, undefined, conversation).content).toBe(composeWelcome(orientation).content);
  });
});

/**
 * THE PREVIEW SHOWS THE TEXT THE ROOM IS ACTUALLY GREETED WITH. An assistant whose version sets no opening greets a room
 * with the deployment's orientation when it is the classification's primary, as the router does, so the preview composes
 * that orientation rather than the built-in opening.
 */
describe('the preview shows what the room is greeted with', () => {
  const DEPLOYMENT: WelcomeOrientation = {
    companyName: 'Stratum Technologies',
    accessBlurb: 'You have full internal access.',
    examples: ['What is our current net revenue retention?'],
  };

  it('composes the deployment\'s orientation for the primary, when its version sets no opening', () => {
    const p = previewWelcome(null, '', {}, 'primary', { deployment: DEPLOYMENT, isPrimary: true });
    expect(p.applies).toBe('deployment');
    expect(p.content).toBe(composeWelcome(DEPLOYMENT).content);
    expect(p.content).toContain('Stratum Technologies');
  });

  it('shows the built-in opening for an assistant that is not the primary, as the router greets with', () => {
    const p = previewWelcome(null, '', {}, 'ops', { deployment: DEPLOYMENT, isPrimary: false });
    expect(p.applies).toBe('builtIn');
    expect(p.content).not.toContain('Stratum Technologies');
  });

  it('says where the deployment text is set, and how to replace it', () => {
    render(<WelcomeEditorGuide workflows={null} classification="premium"
      context={{ deployment: DEPLOYMENT, isPrimary: true }} />);
    expect(screen.getByTestId('welcome-preview')).toHaveTextContent('Stratum Technologies');
    expect(screen.getByTestId('welcome-applies')).toHaveTextContent('/agent-echelon/assistant/premium/welcome-orientation');
  });

  it('fills the assistant\'s own name', () => {
    const own = { welcome: opens({ text: 'Good morrow, I am {{assistantName}}.' }) };
    expect(previewWelcome(own, '', {}, 'primary', { assistantName: 'Ye Olde Advisor' }).content).toBe('Good morrow, I am Ye Olde Advisor.');
  });
});

describe('the active version says what a new conversation is greeted with', () => {
  const DEPLOYMENT: WelcomeOrientation = { companyName: 'Stratum Technologies', accessBlurb: 'You have full internal access.' };

  it('shows the deployment text for the primary, and where it is set', () => {
    render(<GreetedWith workflows={null} classification="premium" role="primary" context={{ deployment: DEPLOYMENT, isPrimary: true }} />);
    expect(screen.getByTestId('welcome-greeted-with-text').textContent).toBe(composeWelcome(DEPLOYMENT).content);
    expect(screen.getByTestId('welcome-greeted-with-source')).toHaveTextContent('/agent-echelon/assistant/premium/welcome-orientation');
  });

  it("shows the version's own opening when it has one", () => {
    render(<GreetedWith workflows={{ welcome: opens({ text: 'Good morrow, I am {{assistantName}}.' }) }} role="primary"
      context={{ deployment: DEPLOYMENT, isPrimary: true, assistantName: 'Ye Olde Advisor' }} />);
    expect(screen.getByTestId('welcome-greeted-with-text').textContent).toBe('Good morrow, I am Ye Olde Advisor.');
    expect(screen.getByTestId('welcome-greeted-with-source')).toHaveTextContent('own opening text');
  });
});

describe('a welcome that runs its own steps, and the intake after the opening', () => {
  const RUNS: EventWorkflow = {
    on: 'assistant-joined', initial: 'hello',
    states: {
      hello: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'greet' },
      greet: { send: { to: 'subject', template: 'workflow-subject-welcome' }, onSuccess: 'done' },
      done: { disposition: 'success' },
    },
  };
  const INTAKE = { questions: ['What team are you on?'], source: 'version' as const };

  it('names the steps a welcome with no opening step runs, composes no opening, and starts no intake', () => {
    const preview = previewWelcome({ welcome: RUNS }, undefined, {});
    expect(preview).toMatchObject({ applies: 'runs', runs: ['hello', 'greet'], opens: false, intake: false });
    render(<GreetedWith workflows={{ welcome: RUNS }} context={{ intake: INTAKE }} />);
    expect(screen.getByTestId('welcome-greeted-with-runs')).toHaveTextContent('hello, greet');
    expect(screen.queryByTestId('welcome-greeted-with-text')).toBeNull();
    expect(screen.queryByTestId('welcome-intake')).toBeNull();
  });

  it('shows the opening its opening step posts when it runs further steps after it', () => {
    const wf: EventWorkflow = {
      on: 'assistant-joined', initial: 'opening',
      states: {
        opening: { opening: { text: 'Hello there.' }, onSuccess: 'greet' },
        greet: { send: { to: 'subject', template: 'workflow-subject-welcome' }, onSuccess: 'done' },
        done: { disposition: 'success' },
      },
    };
    expect(previewWelcome({ welcome: wf }, undefined, {})).toMatchObject({ applies: 'runs', runs: ['opening', 'greet'], opens: true, intake: false });
    render(<GreetedWith workflows={{ welcome: wf }} context={{ intake: INTAKE }} />);
    expect(screen.getByTestId('welcome-greeted-with-text').textContent).toBe('Hello there.');
    expect(screen.queryByTestId('welcome-intake')).toBeNull();
  });

  it('follows a welcome the join says with the intake, and not where a person-joined workflow owns the arrivals', () => {
    const said = opens({ text: 'Hello there.' });
    expect(previewWelcome({ welcome: said }, undefined, {}).intake).toBe(true);
    render(<GreetedWith workflows={{ welcome: said }} context={{ intake: INTAKE }} />);
    expect(screen.getByTestId('welcome-intake')).toHaveTextContent('What team are you on?');
    const joined: EventWorkflow = { on: 'person-joined', initial: 'hi', states: { hi: { send: { to: 'joined', template: 'workflow-opening' }, onSuccess: 'done' }, done: { disposition: 'success' } } };
    expect(previewWelcome({ welcome: said, joined }, 'ops', {}).intake).toBe(false);
  });
});
