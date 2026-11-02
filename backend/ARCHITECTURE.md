# Agent Architecture Pattern

## Message Flow

```
User sends message
  ↓
Chime SDK Channel
  ↓
The assistant's Lex Bot (AppInstanceBot InvokedBy: StandardMessages = NONE, TargetedMessages = ALL; the channel flow takes untargeted turns)
  ↓
Lambda (Lex fulfillment: the classification's router)
  ↓
Router dispatches to the async processor and returns an empty Lex response
  ↓
Async processor calls Bedrock and posts / updates the reply in the channel as the assistant
  ↓
User receives response
```

## Key Points

###  1. Lex Event Structure
```typescript
interface LexEvent {
  inputTranscript: string;  // URL-encoded user message
  sessionState: {
    intent: {
      name: string;
      state: string;
    };
    sessionAttributes?: Record<string, string>;
  };
  requestAttributes?: {
    'CHIME.channel.arn'?: string;  // Channel ARN from Chime
  };
}
```

### 2. Lambda Response Format (Standard)
```typescript
return {
  sessionState: {
    dialogAction: {
      type: 'Close' | 'ElicitIntent' | 'Delegate'
    },
    intent: {
      name: intentName,
      state: 'Fulfilled' | 'Failed'
    }
  },
  messages: [
    {
      contentType: 'PlainText',
      content: 'Response text here'
    }
  ]
};
```

### 3. Direct Chime Messaging (Recommended Approach)
**Always send responses directly to Chime from Lambda** instead of relying on Lex to forward them. This gives you:
- Full control over message formatting
- Ability to easily add SMS/email notifications for long-running tasks
- No JSON wrapping from Lex's response format

```typescript
// Send directly to Chime
await messagingClient.send(
  new SendChannelMessageCommand({
    ChannelArn: channelArn,
    Content: message,
    Type: 'STANDARD',
    Persistence: 'PERSISTENT',
    ChimeBearer: BOT_ARN,  // Bot's ARN (required!)
  })
);

// Return empty messages array to Lex
// Lex will post {"Messages":[]} but frontend can filter it out
return {
  sessionState: {
    dialogAction: { type: 'Close' },
    intent: { name: intentName, state: 'Fulfilled' }
  },
  messages: []  // Required! Omitting causes 400 error
};
```

**IMPORTANT**:
- You MUST include `messages: []` in the response even when empty
- Omitting the `messages` field causes Lex to return a 400 error to Chime
- Lex will post `{"Messages":[]}` as a STANDARD message to the channel
- Frontend should filter out messages with ContentType `application/amz-chime-lex-msgs` that contain only empty arrays

### 4. Understanding Dialog Action Types

The `dialogAction.type` controls Lex's conversation flow, NOT whether Lex posts to Chime:

**Dialog Action Types:**
- **`Close`** - Intent is fulfilled, conversation turn complete (use this for single-turn interactions)
- **`ElicitIntent`** - Ask user what they want to do next (multi-turn conversations)
- **`ElicitSlot`** - Ask user to fill a specific slot (when intent needs more info)
- **`ConfirmIntent`** - Ask user to confirm before fulfilling (e.g., "Submit this request?")
- **`Delegate`** - Let Lex manage conversation flow using configured prompts

**Key Insight:** When Lex is integrated with Chime SDK Messaging, it ALWAYS posts whatever is in the `messages` array back to the channel, regardless of dialog action type. The dialog action type only affects conversation flow management, not message posting behavior.

For our use case (single-turn Q&A):
```javascript
dialogAction: { type: 'Close' }  // Correct - each message is a complete interaction
intent: { state: 'Fulfilled' }   // Intent succeeded
messages: []                      // Empty - we already sent directly to Chime
```

This combination tells Lex:
1. The conversation turn is complete (Close)
2. The intent was successfully fulfilled (Fulfilled)
3. Don't send any messages (empty array - but Lex still posts `{"Messages":[]}` to Chime)

## Implementation Steps

1. **The assistant's identity and Lex bot (`lambda/src/lib/assistant-provisioner.ts`)**, built by the provisioner for every assistant, declared or created in the console (ADR-048, amended 2026-10-23)
   - Create the Lex bot with `WelcomeIntent` and `FallbackIntent`, both fulfilled by the classification's router
   - Create the AppInstanceBot with that Lex configuration, `InvokedBy.StandardMessages = 'NONE'`, tagged `provisioner = runtime`

2. **Lambda Handler (`lambda/src/router-agent-handler.ts`, the classification's router)**
   - Receive the Lex event
   - Decode `inputTranscript` (URL-encoded)
   - Classify the request and dispatch it to the classification's async processor, which posts and updates the reply in the channel as the assistant
   - Return a silent Lex response (`formatLexSilentResponse`: `Close`, `Fulfilled`, `messages: []`)

> **Note:** the example handler below shows the bare Lex → Lambda → Chime transport only, the pattern this design grew from. The shipped router does not return its reply through Lex: the async processor runs a **self-hosted Converse tool loop** (`lambda/src/lib/async-processor-core.ts`), calling Bedrock's Converse API and optionally invoking tools across multiple turns, and delivers the reply itself. There is no Bedrock Agent.

## Common Issues

### Issue: 403 Error from Bot
**Cause**: Lambda trying to send to Chime using user's ChimeBearer instead of bot's ARN

**Fix**: Use `BOT_ARN` as ChimeBearer when sending directly

### Issue: Messages Not Appearing
**Cause**: Returning messages in wrong format or bot not properly configured

**Fix**: Return proper Lex response structure with messages array

### Issue: Duplicate Messages
**Cause**: Sending to Chime directly AND returning messages to Lex

**Fix**: Choose one - either send directly (return empty messages) OR return messages to Lex (don't send directly)

## Example Handler

```javascript
exports.handler = async (event) => {
  const userMessage = decodeURIComponent(event.inputTranscript || '');
  const intentName = event.sessionState.intent.name;
  const channelArn = event.requestAttributes?.['CHIME.channel.arn'];

  // Get model ID from the Lex session (illustrative; the shipped router resolves the model from
  // the classification's strategy, and its utility model is UTILITY_MODEL_ID in lib/config/model-strategy.ts)
  const modelId = event.sessionState.sessionAttributes?.modelId
    || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

  // Call Bedrock
  const response = await invokeBedrock(modelId, userMessage);

  // Return to Lex (Lex will send to Chime)
  return {
    sessionState: {
      dialogAction: { type: 'Close' },
      intent: {
        name: intentName,
        state: 'Fulfilled'
      }
    },
    messages: [{
      contentType: 'PlainText',
      content: response
    }]
  };
};
```
