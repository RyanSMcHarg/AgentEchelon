# Agent Architecture Pattern

## Message Flow

```
User sends message
  ↓
Chime SDK Channel
  ↓
Lex Bot (configured with InvokedBy: StandardMessages = AUTO)
  ↓
Lambda (Lex fulfillment)
  ↓
Bedrock (generate response)
  ↓
Lambda returns Lex response format
  ↓
Lex receives response
  ↓
Lex sends message back to Chime Channel
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

1. **Bot Configuration (create-bot.ts)**
   - Create AppInstanceBot with Lex configuration
   - Set `InvokedBy.StandardMessages = 'AUTO'` so bot responds to all messages

2. **Lex Bot Setup (create-lex-bot.ts)**
   - Create Lex bot with intents
   - Configure Lambda fulfillment
   - Build and deploy bot

3. **Lambda Handler**
   - Receive Lex event
   - Decode `inputTranscript` (URL-encoded)
   - Call Bedrock for AI response
   - Return Lex response format with messages
   - Let Lex handle sending to Chime

> **Note:** the simplified handler below shows the Lex → Lambda → Chime transport only. In practice the tier handler runs a **self-hosted Converse tool loop** (`lambda/src/lib/async-processor-core.ts`) — it calls Bedrock's Converse API and optionally invokes tools across multiple turns. There is no Bedrock Agent.

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

  // Get model ID from channel metadata (passed via Lex session)
  const modelId = event.sessionState.sessionAttributes?.modelId
    || 'anthropic.claude-3-haiku-20240307-v1:0';

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
