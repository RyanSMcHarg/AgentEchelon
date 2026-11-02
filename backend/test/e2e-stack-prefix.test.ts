/**
 * Naming this deployment's stacks and selecting resources out of them: the shared selection in
 * scripts/lib/stack-resources.cjs, and the e2e helper over it (tests/e2e/helpers/stack-prefix.ts).
 * The live calls need a deployment; the decisions made on what comes back are pure, and each one is
 * a way a spec or a script reads "not deployed" for a resource that is.
 */
import {
  STACK_PREFIX,
  INSTANCE,
  SSM_ROOT,
  stackName,
  classificationStacksAmong,
  physicalIdsMatching,
  AGENT_HANDLER,
  type StackResource,
} from '../../tests/e2e/helpers/stack-prefix';

const { resolveStackPrefix, resolveInstanceName } = require('../scripts/lib/stack-lookup.cjs');
const shared = require('../scripts/lib/stack-resources.cjs');

describe('e2e stack-prefix helper', () => {
  it('takes its prefix from the operator scripts\' resolver', () => {
    expect(STACK_PREFIX).toBe(resolveStackPrefix(process.env));
    expect(INSTANCE).toBe(resolveInstanceName(process.env));
    expect(SSM_ROOT).toBe(`/${resolveInstanceName(process.env)}`);
    expect(stackName('Identity', 'AgentEchelon')).toBe('AgentEchelonIdentity');
    expect(stackName('Assistants-standard', 'Acme')).toBe('AcmeAssistants-standard');
  });

  it('selects this instance\'s classification stacks and no look-alike instance\'s', () => {
    const names = [
      'AgentEchelonAssistants-basic',
      'AgentEchelonAssistants-premium',
      'AgentEchelonConversations',
      'AgentEchelonTwoAssistants-basic',
      'AcmeAssistants-basic',
      'AgentEchelonImageGuardrail-standard',
    ];
    expect(classificationStacksAmong(names, 'AgentEchelon'))
      .toEqual(['AgentEchelonAssistants-basic', 'AgentEchelonAssistants-premium']);
    expect(classificationStacksAmong(names, 'Acme')).toEqual(['AcmeAssistants-basic']);
    expect(classificationStacksAmong(names, 'AgentEchelonTwo')).toEqual(['AgentEchelonTwoAssistants-basic']);
    // Every stack of the instance, still without the look-alike's.
    expect(shared.instanceStacksAmong(names, 'AgentEchelon')).toEqual([
      'AgentEchelonAssistants-basic', 'AgentEchelonAssistants-premium', 'AgentEchelonConversations',
      'AgentEchelonImageGuardrail-standard',
    ]);
  });

  it('selects resources by type and construct id, whatever CloudFormation cut the physical name to', () => {
    const resources: StackResource[] = [
      { LogicalResourceId: 'AgentHandlerRole1A2B3C4D', PhysicalResourceId: 'AgentEchelonAssistants-AgentHandlerRole-X', ResourceType: 'AWS::IAM::Role' },
      { LogicalResourceId: 'AgentHandler5E6F7A8B', PhysicalResourceId: 'AgentEchelonAssistants-AgentHandler5E6F7A8B-Y', ResourceType: 'AWS::Lambda::Function' },
      { LogicalResourceId: 'AgentHandlerLexInvoke9C0D1E2F', PhysicalResourceId: 'perm', ResourceType: 'AWS::Lambda::Permission' },
      { LogicalResourceId: 'TypedConversationFromEventRole3A4B5C6D', PhysicalResourceId: 'AgentEchelonAssistants-p-TypedConversationFromEve-Z', ResourceType: 'AWS::IAM::Role' },
      { LogicalResourceId: 'TypedConversationFromEvent7E8F9A0B', PhysicalResourceId: 'AgentEchelonAssistants-p-TypedConversationFromEve-W', ResourceType: 'AWS::Lambda::Function' },
    ];
    expect(physicalIdsMatching(resources, AGENT_HANDLER)).toEqual(['AgentEchelonAssistants-AgentHandler5E6F7A8B-Y']);
    expect(physicalIdsMatching(resources, { type: 'AWS::IAM::Role', logicalId: /^TypedConversationFromEventRole/ }))
      .toEqual(['AgentEchelonAssistants-p-TypedConversationFromEve-Z']);
    expect(physicalIdsMatching(resources, { type: 'AWS::Lambda::Function', logicalId: /^TypedConversationFromEvent/ }))
      .toEqual(['AgentEchelonAssistants-p-TypedConversationFromEve-W']);
    expect(physicalIdsMatching(resources, { type: 'AWS::DynamoDB::Table', logicalId: /^AgentHandler/ })).toEqual([]);
    // No pattern: every resource of the type.
    expect(physicalIdsMatching(resources, { type: 'AWS::IAM::Role' })).toHaveLength(2);
  });

  it('is one selection, shared by the scripts and the e2e helper', () => {
    const rows = [{ LogicalResourceId: 'AgentHandler5E6F7A8B', PhysicalResourceId: 'fn', ResourceType: 'AWS::Lambda::Function' }];
    expect(physicalIdsMatching(rows, AGENT_HANDLER)).toEqual(shared.physicalIdsMatching(rows, AGENT_HANDLER));
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../tests/e2e/helpers/stack-prefix.ts'), 'utf8');
    expect(src).toContain("require('../../../backend/scripts/lib/stack-resources.cjs')");
  });
});
