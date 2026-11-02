/**
 * EVERY INFRASTRUCTURE LINK NAMES ONE RESOURCE, and a shared one says it is shared.
 *
 * An unresolved resource used to fall back to a search of the Lambda console for "AgentHandler" or
 * "ChannelFlow", which named a different resource on every deployment with more than one.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import AssistantInfrastructure, { infrastructureRows } from './AssistantInfrastructure';
import type { ResolvedInfra } from '../../services/profileService';

const resolved: ResolvedInfra = {
  region: 'us-east-1',
  classification: 'premium',
  role: 'primary',
  botArn: 'arn:aws:chime:us-east-1:1:app-instance/a/bot/b',
  lexBotId: 'LEX1',
  lexBotAliasId: 'TSTALIASID',
  definitionParam: '/agent-echelon/assistant/advisor/definition',
  assignmentParam: '/agent-echelon/assistant-assignments/premium/primary/live',
  profileBodies: { bucket: 'bodies', prefix: 'profiles/advisor/' },
  processorFunctionName: 'proc-1',
  routerFunctionName: 'router-1',
  actingRoleName: 'acting-1',
  boundaryPolicyArn: 'arn:aws:iam::1:policy/AgentEchelonAssistantActingBoundary-premium',
  boundaryPolicyName: 'AgentEchelonAssistantActingBoundary-premium',
  guardrailId: 'g1',
  guardrailName: 'agent-echelon-premium-guardrail',
  templates: { bucket: 'bodies', prefix: 'templates/premium/' },
  lexLogGroup: 'lex-logs',
  channelFlowArn: 'arn:aws:chime:us-east-1:1:app-instance/a/channel-flow/f',
  channelFlowProcessorFunctionName: 'flow-proc-1',
};

describe('AssistantInfrastructure', () => {
  it('links every resolved resource to its own page, never a list or a search', () => {
    const { container } = render(<AssistantInfrastructure resolved={resolved} />);
    const hrefs = [...container.querySelectorAll('a.doc-link')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.length).toBeGreaterThanOrEqual(12);
    for (const h of hrefs) {
      expect(h).not.toMatch(/#\/functions\?|#\/functions$|#\/roles$|#\/guardrails$|\?fo=and/);
    }
    expect(hrefs).toContain('https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions/flow-proc-1');
  });

  it('labels the shared resources with the classification that shares them', () => {
    render(<AssistantInfrastructure resolved={resolved} />);
    expect(screen.getByText('Shared by premium assistants')).toBeTruthy();
    expect(screen.getByText('Shared by the deployment')).toBeTruthy();
  });

  it('an unresolved resource says so and links nowhere', () => {
    const rows = infrastructureRows({ region: 'us-east-1' });
    for (const scope of Object.values(rows)) for (const r of scope) expect(r.href).toBeUndefined();
    const { container } = render(<AssistantInfrastructure resolved={{ region: 'us-east-1' }} />);
    expect(container.querySelectorAll('a.doc-link')).toHaveLength(0);
    expect(screen.getAllByText('Not resolved').length).toBeGreaterThan(0);
  });
});
