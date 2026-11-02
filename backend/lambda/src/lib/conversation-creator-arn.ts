/**
 * A CLASSIFICATION'S CONVERSATION CREATOR, FOUND BY NAME AT CALL TIME.
 *
 * Each classification's creator is built and published by its own `Assistants-<classification>` stack
 * (`ConversationCreator`, `lib/constructs/conversation-creator.ts`) under
 * `${CONVERSATION_CREATOR_PARAM_ROOT}/<classification>/conversation-creator-arn`. A caller reads that one key
 * when it opens a conversation at the classification, so no caller's environment names a classification and
 * declaring one changes nothing in the stacks that call it (the classification-independence plan, step 4).
 * The shape is `resolveRouterArn`'s (`router-arn.ts`): an explicit map in the environment wins where one is set
 * (`CONVERSATION_CREATORS`), then the parameter, cached per container.
 *
 * The caller decides which classifications it may ask for (the create-conversation API a member
 * classification's alone); IAM bounds the invoke by the creator's own tags.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';

let ssm: Pick<SSMClient, 'send'> | undefined;
const byClassification = new Map<string, string>();

/**
 * READ THE CREATOR'S KEY THROUGH THE HANDLER'S OWN SSM CLIENT. A cold function pays each client's first-call setup
 * once, so a handler that holds one hands it here (`create-conversation.ts`). Optional: without it the module
 * builds its own on the first read.
 */
export function useConversationCreatorArnSsmClient(client: Pick<SSMClient, 'send'>): void {
  ssm = client;
}

/** An explicit `{ classification: functionArn }` map, where the environment carries one. */
function fromEnvironment(): Record<string, string> {
  const raw = (process.env.CONVERSATION_CREATORS || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    console.error('[conversation-creator-arn] CONVERSATION_CREATORS is not valid JSON; it names no creator');
    return {};
  }
}

/** The creator function ARN for `classification`, or undefined when none is published or it is not declared. */
export async function resolveConversationCreatorArn(classification: string): Promise<string | undefined> {
  // Only a declared conversational value forms a parameter name.
  if (!profiles.isKnownClassification(classification) || !profiles.isConversational(classification)) return undefined;
  const explicit = fromEnvironment()[classification];
  if (explicit) return explicit;
  const cached = byClassification.get(classification);
  if (cached) return cached;
  const root = (process.env.CONVERSATION_CREATOR_PARAM_ROOT || '').trim();
  if (!root) {
    console.error('[conversation-creator-arn] CONVERSATION_CREATOR_PARAM_ROOT is not set; no creator can be found', { classification });
    return undefined;
  }
  const name = `${root}/${classification}/conversation-creator-arn`;
  try {
    ssm ??= new SSMClient({});
    const arn = ((await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value || '').trim();
    if (arn) {
      byClassification.set(classification, arn);
      return arn;
    }
    console.error('[conversation-creator-arn] the creator parameter is empty', { name });
  } catch (err) {
    console.error('[conversation-creator-arn] the creator parameter could not be read', { name, err: (err as Error)?.name });
  }
  return undefined;
}

/** For tests: forget what was found. */
export function resetConversationCreatorArnCache(): void {
  byClassification.clear();
  ssm = undefined;
}
