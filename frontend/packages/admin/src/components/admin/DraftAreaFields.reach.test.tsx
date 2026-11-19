/**
 * WHAT A DRAFT OFFERS IS WHAT THE TURN USES.
 *
 * What it proves: a tool the registry offers only to other roles is disabled and explained, and kept where a version
 * already selects it; deliver_document is shown included while advance_task_state is selected; a company-context source
 * the role cannot read is disabled and explained, and kept where selected; a stored guardrail key shows the guardrail it
 * names; the name placeholder names the provisioned name; the persona placeholder says what a non-primary falls back
 * to; and the company documents row says whether the turn includes them.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AbilitiesFields, AreaFields, IdentityFields, type AreaProps } from './DraftAreaFields';
import { ContextGroup } from './AssistantConfigFields';
import type * as svc from '../../services/profileService';

vi.mock('../../services/profileService', async (orig) => ({
  ...(await orig<typeof import('../../services/profileService')>()),
  listMessageTemplates: vi.fn().mockResolvedValue({ assistant: 'ops-premium', classification: 'premium', templates: [], family: {} }),
}));

const TOOLS: svc.ToolDescriptor[] = [
  { name: 'load_company_context', category: 'context', changesState: false, description: 'Reads documents.', requires: 'a bucket' },
  { name: 'read_deployment_health', category: 'context', changesState: false, description: 'Reads telemetry.', requires: 'the ops role', roles: ['ops'] },
  { name: 'advance_task_state', category: 'task', changesState: true, description: 'Moves a task.', requires: 'a task' },
  { name: 'deliver_document', category: 'task', changesState: false, description: 'Declares a document.', requires: 'a task' },
];

const CATALOG: svc.ClassificationCatalog = {
  classification: 'premium',
  models: { text: ['sonnet'], image: [] },
  retrievalReach: ['context/basic/', 'context/standard/', 'context/premium/'],
  roles: { primary: { contextPrefixes: ['context/basic/', 'context/standard/', 'context/premium/'] }, ops: { contextPrefixes: ['context/basic/', 'context/standard/'] } },
  guardrails: [{ key: 'default', guardrailId: 'gr-default' }, { key: 'strict', guardrailId: 'gr-strict' }],
  contextSources: [
    { key: 'company-docs', type: 's3-prefix', prefix: 'context/premium/' },
    { key: 'runbooks', type: 's3-prefix', prefix: 'context/standard/' },
    { key: 'user-profile', type: 'dynamodb-item' },
  ],
  primaryAssistant: 'advisor',
};

const props = (over: Partial<AreaProps> = {}): AreaProps => ({
  draft: { modelKey: 'sonnet' }, onPatch: vi.fn(), profileName: 'ops-premium', role: 'ops', catalog: CATALOG,
  tools: TOOLS, decisions: {}, canActivate: true, canEdit: true, ...over,
});

const box = (testId: string) => screen.getByTestId(testId).querySelector('input') as HTMLInputElement;

describe('the tools a draft offers', () => {
  it('disables and explains a tool offered only to another role', () => {
    render(<AbilitiesFields {...props({ role: 'primary', draft: { modelKey: 'sonnet', tools: ['load_company_context'] } })} />);
    expect(box('draft-tool-read_deployment_health').disabled).toBe(true);
    expect(screen.getByTestId('draft-tool-role-read_deployment_health')).toHaveTextContent('Offered only to an assistant in the ops role');
    expect(box('draft-tool-load_company_context').disabled).toBe(false);
  });

  it('keeps a role-gated tool a version already selects, so it can still be removed', () => {
    const onPatch = vi.fn();
    render(<AbilitiesFields {...props({ role: 'primary', onPatch, draft: { modelKey: 'sonnet', tools: ['read_deployment_health'] } })} />);
    const health = box('draft-tool-read_deployment_health');
    expect(health.checked).toBe(true);
    expect(health.disabled).toBe(false);
    fireEvent.click(health);
    expect(onPatch).toHaveBeenLastCalledWith({ tools: [] });
  });

  it('offers it to the role the registry names', () => {
    render(<AbilitiesFields {...props({ draft: { modelKey: 'sonnet', tools: [] } })} />);
    expect(box('draft-tool-read_deployment_health').disabled).toBe(false);
    expect(screen.queryByTestId('draft-tool-role-read_deployment_health')).toBeNull();
  });

  it('shows deliver_document included, and not removable alone, while advance_task_state is selected', () => {
    render(<AbilitiesFields {...props({ draft: { modelKey: 'sonnet', tools: ['advance_task_state'] } })} />);
    const deliver = box('draft-tool-deliver_document');
    expect(deliver.checked).toBe(true);
    expect(deliver.disabled).toBe(true);
    expect(screen.getByTestId('draft-tool-riding-deliver_document')).toHaveTextContent('Included whenever advance_task_state is');
    fireEvent.click(box('draft-tool-advance_task_state'));
    expect(box('draft-tool-deliver_document').checked).toBe(false);
    expect(box('draft-tool-deliver_document').disabled).toBe(false);
  });
});

describe('the context sources a draft offers', () => {
  it('disables and explains a company-context source the role does not read', () => {
    render(<AbilitiesFields {...props()} />);
    expect(box('draft-context-source-company-docs').disabled).toBe(true);
    expect(screen.getByTestId('draft-context-source-unreadable-company-docs')).toHaveTextContent('ops role can\'t read context/premium/');
    expect(box('draft-context-source-runbooks').disabled).toBe(false);
    expect(box('draft-context-source-user-profile').disabled).toBe(false);
  });

  it('keeps one a version already selects, explained, so it can be removed', () => {
    render(<AbilitiesFields {...props({ draft: { modelKey: 'sonnet', contextSources: ['company-docs'] } })} />);
    expect(box('draft-context-source-company-docs').checked).toBe(true);
    expect(box('draft-context-source-company-docs').disabled).toBe(false);
    expect(screen.getByTestId('draft-context-source-unreadable-company-docs')).toBeTruthy();
  });

  it('offers every source to a role that reads them all', () => {
    render(<AbilitiesFields {...props({ role: 'primary', profileName: 'advisor' })} />);
    expect(box('draft-context-source-company-docs').disabled).toBe(false);
    expect(screen.queryByTestId('draft-context-source-unreadable-company-docs')).toBeNull();
  });
});

describe('the variables a draft lists', () => {
  it('names the fields a welcome can use, each with what it holds', () => {
    render(<AreaFields area="variables" {...props({ draft: { modelKey: 'sonnet' } })} />);
    const group = screen.getByTestId('variables-group-welcome');
    expect(group).toHaveTextContent('assistantName');
    expect(group).toHaveTextContent('What happened, when an event such as an alert opened the conversation.');
  });
});

describe('the values a draft can read', () => {
  const row = (source: string, description?: string) => ({ source, type: 'string', trust: 'operator', describesPerson: false, availability: 'always', insertAs: 'text', origin: '', mayDecide: true, ...(description ? { description } : {}) });
  it('defines each value under what it describes', () => {
    const catalog = {
      ...CATALOG,
      contextSources: [{ key: 'company-docs', title: 'Company knowledge' }],
      variables: { sources: [row('ctx:company-docs.digest', 'The document menu'), row('conversation:eventSummary')] },
    } as unknown as AreaProps['catalog'];
    render(<AreaFields area="variables" {...props({ catalog })} />);
    const source = screen.getByTestId('variables-source-company-docs');
    expect(source).toHaveTextContent('Company knowledge');
    expect(source).toHaveTextContent('The document menu');
    expect(screen.getByTestId('variables-group-origin')).toHaveTextContent('What happened, when an event opened the conversation.');
  });
});

describe('the guardrail a draft shows', () => {
  it('shows a stored catalog key as the guardrail it names', () => {
    render(<AreaFields area="settings" {...props({ draft: { modelKey: 'sonnet', guardrailId: 'strict' } })} />);
    expect((screen.getByTestId('draft-guardrail') as HTMLSelectElement).value).toBe('gr-strict');
  });
});

describe('who it is', () => {
  it('names the provisioned name in the inherit placeholder', () => {
    render(<IdentityFields {...props({ provisionedName: 'Ops Desk' })} />);
    expect(screen.getByTestId('draft-name').getAttribute('placeholder')).toBe('(inherit) Ops Desk');
  });

  it('says a non-primary falls back to the built-in persona, and the primary to the classification parameter', () => {
    const { unmount } = render(<IdentityFields {...props()} />);
    expect(screen.getByTestId('draft-persona').getAttribute('placeholder')).toBe('Blank uses the built-in persona for this classification');
    unmount();
    render(<IdentityFields {...props({ profileName: 'advisor', role: 'primary' })} />);
    expect(screen.getByTestId('draft-persona').getAttribute('placeholder')).toBe('Blank: the classification parameter, else the built-in prompt');
  });
});

describe('the company documents row', () => {
  it('says they are included where the tool is allowed and the role reads company context', () => {
    render(<ContextGroup config={{ modelKey: 'sonnet' }} catalog={CATALOG} role="ops" />);
    expect(screen.getByTestId('field-companyDocuments')).toHaveTextContent('Included on every turn');
  });

  it('says they are not included where the version\'s tools leave out load_company_context', () => {
    render(<ContextGroup config={{ modelKey: 'sonnet', tools: ['advance_task_state'] }} catalog={CATALOG} role="ops" />);
    expect(screen.getByTestId('field-companyDocuments')).toHaveTextContent('tools do not include load_company_context');
  });

  it('says they are not included where the role reads no company context', () => {
    const catalog = { ...CATALOG, roles: { ...CATALOG.roles, intake: { contextPrefixes: [] } } };
    render(<ContextGroup config={{ modelKey: 'sonnet' }} catalog={catalog} role="intake" />);
    expect(screen.getByTestId('field-companyDocuments')).toHaveTextContent('role reads no company context');
  });
});
