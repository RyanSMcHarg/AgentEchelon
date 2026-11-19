/**
 * A VERSION'S VARIABLE IS READ WHERE IT IS USED, AND CHECKED THROUGH THE LOOKUP THAT READS IT.
 *
 * The scope is the declaration and usage of variables across the profile page, including in all workflows and templates.
 * What it proves:
 *
 *  - a workflow condition on one of the version's variables is checked through the version's variables, the lookup the
 *    router evaluates it with, rather than refused as "not a source";
 *  - the router's own lines (intake questions, placeholders, handovers) carry a resolver, so a field bound to a variable
 *    and a message alternative's condition are read there as on the processor's turns;
 *  - a variable naming a `ctx:` field fits a template set as the least-permitting catalog entry, in the set the runtime
 *    loads and in the router's lookup, as validation already reads it;
 *  - naming an own template that binds a variable is checked with the version's lookup;
 *  - what each call site holds is one rule (`routerHoldsAt`, `processorTurnHolds`), the console's pickers read.
 */
import * as fs from 'fs';
import * as path from 'path';
import { versionEventWorkflowsErrors, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import { contextSourceOf, processorTurnHolds, routerHeldVariables, routerHoldsAt } from '../../lambda/src/lib/variables';

const src = (rel: string) => fs.readFileSync(path.join(__dirname, '../../lambda/src', rel), 'utf8');

const gated: Record<string, EventWorkflow> = {
  greet: {
    on: 'assistant-joined', initial: 'hello',
    states: {
      hello: { send: { to: 'room', template: 'workflow-opening' } as never, when: { kind: 'ops' }, onSuccess: 'done' },
      done: { disposition: 'success' },
    },
  } as never,
};
const VARIABLES = { kind: { source: 'conversation:type' } } as const;

describe('a workflow condition on a version variable', () => {
  it('is checked through the version\'s variables, the lookup the router evaluates it with', () => {
    expect(versionEventWorkflowsErrors(gated, { lookup: routerHeldVariables(VARIABLES).lookup })).toEqual([]);
  });

  it('is refused without them, which is why every caller passes them', () => {
    expect(versionEventWorkflowsErrors(gated).join(' ')).toMatch(/kind/);
    const lifecycle = src('lib/profile-lifecycle.ts');
    expect(lifecycle).toContain('versionEventWorkflowsErrors(body.eventWorkflows, { lookup: routerHeldVariables(body.variables).lookup');
    expect(lifecycle).toContain("lookup: routerHeldVariables(patchedVariables ?? undefined).lookup");
    expect(lifecycle).toContain('storedTemplateMisfit(loaded.template, shipped, { lookup })');
  });
});

describe('the router\'s own lines read the version\'s variables', () => {
  it('loads its set with the version\'s variables and hands it a resolver', () => {
    const router = src('router-agent-handler.ts');
    const words = router.slice(router.indexOf('async function wordsOf('), router.indexOf('async function dispatchWelcomePrompt('));
    expect(words).toContain('...(version?.variables ? { variables: version.variables } : {}),');
    expect(words).toContain('resolver: { ...routerVariables(version?.variables');
  });
});

describe('a variable naming a context-source field', () => {
  it('reads as the least-permitting catalog entry where the catalog is not read', () => {
    const vars = { desk: { source: 'ctx:crm.desk', fallback: 'the desk' } } as never;
    expect(routerHeldVariables(vars).lookup('desk')).toMatchObject({ source: 'ctx:crm.desk', describesPerson: true });
    expect(src('lib/message-template-selection.ts')).toContain('withUnreadCatalog(versionLookup(buildSourceTable({ catalog: [] }), at.variables), at.variables)');
  });
});

describe('what each call site holds', () => {
  it('a router holds the conversation, the event and the roles, and a person only where the event names one', () => {
    expect(routerHoldsAt('conversation:type', 'alarm-state-changed')).toBe(true);
    expect(routerHoldsAt('participantRole:lead', 'person-joined')).toBe(true);
    expect(routerHoldsAt('person:onboarded', 'person-joined')).toBe(true);
    expect(routerHoldsAt('person:onboarded', 'alarm-state-changed')).toBe(false);
    expect(routerHoldsAt('signal:userLanguage', 'assistant-joined')).toBe(false);
    expect(routerHoldsAt('ctx:crm.desk', 'assistant-joined')).toBe(false);
  });

  it('a processor turn holds the conversation, the person and the context sources, and no event or role', () => {
    expect(processorTurnHolds('signal:userLanguage')).toBe(true);
    expect(processorTurnHolds('pref:verbosity')).toBe(true);
    expect(processorTurnHolds('ctx:crm.desk')).toBe(true);
    expect(processorTurnHolds('participant:role')).toBe(false);
    expect(processorTurnHolds('event:alarmState')).toBe(false);
    expect(contextSourceOf('ctx:crm.desk')).toBe('crm');
    expect(contextSourceOf('conversation:type')).toBeUndefined();
  });
});

describe('a malformed variable is refused by name, never thrown on', () => {
  it('names no source for an entry that is not { source }, so a lookup built before the shape check does not throw', () => {
    const { versionVariableSources } = require('../../lambda/src/lib/variables');
    expect(versionVariableSources({ team: null, kind: { source: 'conversation:type' }, odd: 3 } as never)).toEqual({ kind: 'conversation:type' });
    expect(versionVariableSources([null] as never)).toEqual({});
    expect(() => routerHeldVariables({ team: null } as never).lookup('team')).not.toThrow();
  });
});

describe('a move\'s declaration after a link sits on a line of its own', () => {
  it('ends the link label before the marker in every client', () => {
    const { withTurnDeclarationLine } = require('../../lambda/src/lib/turn-declaration');
    const out: string = withTurnDeclarationLine('Moved. NAVIGATE_CHANNEL:arn:x|Open it', { kind: 'drift', moves: 'm3', answers: 'm4' });
    const [link, marker] = out.split('\n');
    expect(link).toBe('Moved. NAVIGATE_CHANNEL:arn:x|Open it');
    expect(marker).toMatch(/^<!--turn:/);
    // The label the previous client parser reads ends at the line, before the marker.
    expect(/NAVIGATE_CHANNEL:([^|\s]+)\|([^\n]+)/.exec(out)?.[2]).toBe('Open it');
  });
});

describe('the router\'s own lines read the room\'s type', () => {
  it('every caller names the channel, and the type is read from it', () => {
    const router = src('router-agent-handler.ts');
    expect(router).toContain("wordsOf(args.assistant, { channelArn: args.channelArn })");
    expect(router).toContain('wordsOf(profile.name, { channelArn: task.channelArn })');
    expect(router).toContain('wordsOf(turnProfile.name, { channelArn })');
    expect(router).toMatch(/const conversationType = at\.conversationType\n\s+\?\? \(at\.channelArn && version\?\.messages \? \(await getChannelContext\(at\.channelArn\)/);
  });
});
