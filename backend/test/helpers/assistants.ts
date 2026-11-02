/**
 * ONE WAY A TEST BUILDS A CLASSIFICATION'S ASSISTANT STACK.
 *
 * `bin/backend.ts` creates one `AssistantsStack` per classification the profile registry declares with a
 * topology, passing the classification by name. A test that reads one classification's stack builds it the
 * same way, through this factory, so the topology always comes from the registry rather than from a copy.
 */
import type { Construct } from 'constructs';
import { AssistantsStack, type AssistantsStackProps } from '../../lib/stacks/assistant-profile-stack';

/** The construct the app builds for `classification`, as a factory taking the scope, id and the remaining props. */
export function assistantsOf(classification: string) {
  return (scope: Construct, id: string, props: Omit<AssistantsStackProps, 'classification'>): AssistantsStack =>
    new AssistantsStack(scope, id, { ...props, classification });
}

/** The id `bin/backend.ts` gives a classification's assistant stack under the default instance prefix. */
export function assistantsStackId(classification: string): string {
  return `AgentEchelonAssistants-${classification}`;
}
