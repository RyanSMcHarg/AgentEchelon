/**
 * An assistant's welcome is ITS OWN and knows what kind of room it is opening in, so two
 * assistants added to one conversation do not open with the same sentence.
 *
 * WHY THIS GUARD EXISTS RATHER THAN A CODE REVIEW. The duplicate was diagnosed wrongly once and placed
 * wrongly once. First an orientation-inheritance gate shipped, on the reasoning that the ops assistant
 * was rendering the premium primary's configured copy - true of the SSM parameters, and not the cause of
 * what a person saw, because a room carrying `priorSubject` is spawned and the orientation is suppressed
 * entirely. Then the per-role copy was put on the conversation TYPE, which moved an assistant's words
 * onto the room and made adding an assistant an edit to compiled config.
 *
 * It lives on the assistant's versioned profile, as its welcome workflows, each naming the conversation types it
 * opens (W1). So what has to hold is the selection: the room's own type wins, a version whose welcomes name some types
 * only says nothing of its own in other rooms, and a template cannot print a hole or unbounded member text.
 */
import {
  selectOpening,
  renderWelcomeTemplate,
  composeWelcome,
} from '../../lambda/src/lib/welcome-orientation';
import { welcomePlan, welcomeWorkflowOf, type EventWorkflow } from '../../lambda/src/lib/event-workflow';

/** What an assistant's own opening says in a room of this type, or null for the classification's copy. */
const openingOf = (own: Record<string, EventWorkflow> | undefined, conversationType: string | undefined) =>
  selectOpening(welcomePlan(welcomeWorkflowOf(own, conversationType).workflow).opening);
import { OPS_WELCOME, ADVISOR_WELCOME } from '../../demo/welcomes';
import { CONVERSATION_TYPES } from '../../lib/config/conversation-types';

describe('an assistant\'s welcome knows what kind of room it is in', () => {
  it('prefers the welcome for this conversation type over the assistant\'s ordinary one', () => {
    expect(welcomeWorkflowOf(OPS_WELCOME, 'ops').name).toBe('welcome-ops');
    expect(openingOf(OPS_WELCOME, 'ops')?.template).toBeTruthy();
  });

  it('gives the assistant its ordinary opening in an ordinary room', () => {
    const inGeneral = openingOf(OPS_WELCOME, 'general');
    expect(inGeneral?.template).toBeUndefined();
    expect(inGeneral?.orientation?.accessBlurb).toMatch(/operations access/i);
  });

  it('welcomes that name some types only are not a welcome for any other room', () => {
    // This is what lets the premium primary be given an alert-room line without changing how it opens
    // anywhere else: every other type runs the platform's welcome, whose opening is the classification parameter.
    expect(openingOf(ADVISOR_WELCOME, 'general')).toBeNull();
    expect(openingOf(ADVISOR_WELCOME, undefined)).toBeNull();
    expect(welcomeWorkflowOf(ADVISOR_WELCOME, 'general').declared).toBe(false);
    expect(openingOf(ADVISOR_WELCOME, 'ops')?.template).toBeTruthy();
  });

  it('opens the operations team\'s standing room on what the room is, not on a company introduction', () => {
    // ops-team has no event behind it, so the classification orientation (company intro, leadership
    // examples) answered a question nobody there asks. Its variant names the room's topic and why its
    // membership changes on its own, and never claims another thread.
    const t = openingOf(ADVISOR_WELCOME, 'ops-team')!.template!;
    const out = renderWelcomeTemplate(t, { topic: 'payments on-call' });
    expect(out.content).toContain('payments on-call');
    expect(out.content).toMatch(/ops group/);
    expect(out.content).not.toMatch(/Stratum|ARR|other thread/);
    // With no topic carried, its line drops rather than printing a hole.
    expect(renderWelcomeTemplate(t, {}).content).not.toMatch(/\{topic\}|It is for \./);
  });

  it('treats no welcome at all as nothing to say, rather than throwing', () => {
    expect(openingOf(undefined, 'ops')).toBeNull();
    expect(selectOpening(null)).toBeNull();
  });

  it('the two assistants added to an ops room say DIFFERENT things', () => {
    // The whole point, asserted on the copy the demo actually seeds.
    const ops = openingOf(OPS_WELCOME, 'ops')!.template!;
    const primary = openingOf(ADVISOR_WELCOME, 'ops')!.template!;
    expect(ops).not.toBe(primary);
    // And the primary does not re-tell the event, which would be the duplicate in a longer form.
    expect(renderWelcomeTemplate(primary, { eventSummary: 'THE EVENT LINE' }).content)
      .not.toContain('THE EVENT LINE');
  });

  it('renders the event line the room carries', () => {
    const t = openingOf(OPS_WELCOME, 'ops')!.template!;
    const out = renderWelcomeTemplate(t, {
      eventSummary: 'p95 latency on the checkout API crossed its SLA for 10 consecutive minutes.',
    });
    expect(out.content).toContain('p95 latency on the checkout API');
    expect(out.contributed).toContain('eventSummary');
    expect(out.content).toMatch(/operations issue/i);
  });

  it('DROPS a line whose field the room does not carry, rather than printing a hole', () => {
    const t = openingOf(OPS_WELCOME, 'ops')!.template!;
    const out = renderWelcomeTemplate(t, {});
    expect(out.content).not.toMatch(/\{eventSummary\}/);
    expect(out.content).not.toMatch(/undefined/);
    expect(out.missing).toContain('eventSummary');
    // The lines naming nothing still render, so a room with no summary is still welcomed.
    expect(out.content).toMatch(/operations issue/i);
  });

  it('lets a template name its own role without the resolver branching on it', () => {
    const out = renderWelcomeTemplate('I am the {role} assistant here.', {}, { role: 'ops' });
    expect(out.content).toBe('I am the ops assistant here.');
    // And with no role the line is dropped rather than printed with a hole.
    expect(renderWelcomeTemplate('I am the {role} assistant here.', {}, {}).content).toBe('');
  });

  it('caps member text the same way the clause assembly does', () => {
    const out = renderWelcomeTemplate('{eventSummary}', { eventSummary: 'x'.repeat(10_000) });
    expect(out.content.length).toBeLessThan(1_000);
  });

  it('is not vacuous: the ops type really adds more than one assistant', () => {
    // Without two assistants in the room there is no duplicate to prevent.
    const roster = CONVERSATION_TYPES.ops.defaultAgents ?? [];
    expect(roster.length).toBeGreaterThan(1);
    // And the two the demo gives copy to are the two it adds.
    expect(roster).toContain('advisor');
    expect(roster).toContain('ops-premium');
  });

  it('leaves the conversation type free of assistant copy', () => {
    // The placement that was backed out. A type declaring welcome copy would put an assistant's words
    // on the room again and make adding one a deploy.
    for (const key of Object.keys(CONVERSATION_TYPES)) {
      expect((CONVERSATION_TYPES as Record<string, { welcome?: unknown }>)[key].welcome).toBeUndefined();
    }
  });

  it('the assembly is still what an un-templated room gets, and it still says something', () => {
    // An empty render falls back to this, so if this were ever empty the fallback would post nothing.
    expect(composeWelcome({ priorSubject: 'Latency SLA breach' }).content.trim().length).toBeGreaterThan(0);
  });
});

describe('a template can include the suggested prompts', () => {
  // A template replaces the built-in opening, which is where the suggested prompts were listed, so a template
  // dropped them with nothing to say so. `{examples}` puts them back, as a list, where the template says.
  it('renders {examples} as a list on its own lines', () => {
    const out = renderWelcomeTemplate('Hi, I am the {role} assistant.\nTry one of these:\n{examples}', {
      examples: ['Summarize the Q3 renewals', 'Draft the board update'],
    }, { role: 'primary' });
    expect(out.content).toBe('Hi, I am the primary assistant.\nTry one of these:\n- Summarize the Q3 renewals\n- Draft the board update');
  });

  it('leaves out the line that names {examples} when the assistant has none', () => {
    const out = renderWelcomeTemplate('Hi.\n{examples}', {});
    expect(out.content).toBe('Hi.');
  });
});
