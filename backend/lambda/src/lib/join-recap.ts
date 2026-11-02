/**
 * THE RECAP A PERSON GETS WHEN THEY ARE ADDED TO A CONVERSATION IS A TURN BY THE ROOM'S ASSISTANT.
 *
 * Sharing a conversation adds a person who cannot tell what came before. They are caught up privately,
 * and the catching up is the room's primary assistant speaking: its model, its persona, its language and
 * its attribution. The share Lambda used to write this itself with a utility model and a fixed prompt,
 * then post it under the assistant's name inside a fixed English wrapper, so the room's assistant was
 * credited with words it did not choose, in a voice and language a deployment had not configured.
 *
 * So the share only ASKS. It dispatches an ordinary turn through the router of the conversation's
 * classification, the same entry triage and the stop question use, naming the new member as the person
 * the turn is for. The router decides everything else (`router-agent-handler.ts`, `isJoinRecap`):
 *   - the speaker is the room's primary, resolved by the router; a payload cannot name another;
 *   - the reply is targeted at the new member and nobody else;
 *   - the new member must be a person who is in the conversation, read live;
 *   - the request the turn answers is this assistant's own `join-recap` prompt template, and the turn is
 *     a `conversation_summary`, the platform capability every assistant answers from the conversation.
 *
 * The share Lambda therefore carries no English and no model, and holds no Bedrock grant.
 */
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import type { TurnRequest } from '../router-agent-handler.js';
import type { ParsedTemplate } from './document-template.js';
import { renderPromptTemplate } from './message-template.js';
import { selectMessageTemplate } from './message-template-selection.js';
import { shippedMessageTemplate } from './shipped-message-templates.js';
import type { TemplateStoreDeps } from './template-store.js';
import { resolveRouterArn } from './router-arn.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
// The caller's own role, never an assistant session: asking for a turn is the service's act, and the
// turn speaks on the session the router routes for it.
const lambdaClient = new LambdaClient({ region: AWS_REGION });

/** The prompt template a recap is asked from (ADR-062 decision 1). */
export const JOIN_RECAP_TEMPLATE = 'join-recap';

/**
 * The request the recap turn answers in the shipped `join-recap` prompt template. It is what the MODEL reads,
 * not what the room reads: the assistant answers it in its own voice and in the language of the conversation.
 */
export const DEFAULT_JOIN_RECAP_REQUEST = shippedMessageTemplate(JOIN_RECAP_TEMPLATE).messageSections!.prompt;

/** The prompt a selected template asks, or the shipped request when one cannot be rendered. */
function recapPrompt(template: ParsedTemplate): string {
  const rendered = renderPromptTemplate(template);
  return rendered.ok && rendered.prompt.trim() ? rendered.prompt.trim() : DEFAULT_JOIN_RECAP_REQUEST;
}

/**
 * The request this assistant's recap answers, by the selection order (ADR-062 decision 3): the assistant's
 * own `join-recap` prompt template (or the one its version's `messages` names), the classification's, then the
 * shipped one.
 */
export async function joinRecapRequestFor(
  at: { classification: string; assistant?: string; messages?: import('./message-template.js').VersionMessages },
  deps?: TemplateStoreDeps,
): Promise<string> {
  const selected = await selectMessageTemplate({
    classification: at.classification,
    ...(at.assistant ? { assistant: at.assistant } : {}),
    name: JOIN_RECAP_TEMPLATE,
    messages: at.messages,
  }, deps);
  return recapPrompt(selected.template);
}

/**
 * Ask the router of `classification` for the recap turn, addressed privately to `memberArn`.
 *
 * Carries no text, no speaker and no correlation id: the router resolves the room's primary, composes
 * the request from that assistant's `join-recap` template, and derives the correlation from it, so a retried invoke
 * collapses into one recap. Asynchronous, so the share answers its caller without waiting on a
 * model.
 *
 * RETURNS FALSE RATHER THAN THROWING. The person has already been added; a recap that could not be
 * asked for is logged and the share stands.
 */
export async function dispatchJoinRecapTurn(args: {
  channelArn: string;
  classification: string;
  /** The person who just joined. The turn is theirs, and only they see its reply. */
  memberArn: string;
}): Promise<boolean> {
  const { channelArn, classification, memberArn } = args;
  const routerArn = await resolveRouterArn(classification);
  if (!routerArn) {
    console.error('[join-recap] no router for this classification; the new member gets no recap', { classification });
    return false;
  }
  const aeTurn: TurnRequest = {
    channelArn,
    senderArn: memberArn,
    // PRIVATE TO THE NEW MEMBER. The router forces this as well; declaring it keeps the payload honest.
    targeted: true,
    // Nobody is waiting on it: the person was added, they did not ask. Kept out of the response-time
    // measures for that reason (`interaction-kinds.ts`).
    trigger: 'join_recap',
    triggerAtMs: Date.now(),
  };
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: routerArn,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify({ aeTurn })),
    }));
    return true;
  } catch (err) {
    console.error('[join-recap] the recap turn could not be dispatched; the share stands', {
      classification, err: (err as Error)?.message,
    });
    return false;
  }
}
