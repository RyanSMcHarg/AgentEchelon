// Imported from the '/types' subpath (not the '@ae/shared' barrel): the barrel's
// `User` re-export is AuthProvider's runtime auth-context User (shadows
// types/index.ts's User to avoid an ambiguous-export collision — see
// packages/shared/src/index.ts). This mock data needs the plain types/index.ts
// shape (all fields required), so it bypasses the barrel and imports it directly.
import type { User, Conversation, Message, Model, UserTier } from '@ae/shared/types';

// Mock AI models available
export const MOCK_MODELS: Model[] = [
  {
    id: 'anthropic.claude-opus-4-20250514',
    name: 'Claude Opus',
    tier: 'premium',
    description: 'Most capable model for complex reasoning and analysis',
    costPerMillion: { input: 15, output: 75 },
    icon: '🧠',
    color: '#8B5CF6',
  },
  {
    id: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    name: 'Claude Sonnet 3.5',
    tier: 'standard',
    description: 'Balanced performance and cost for general use',
    costPerMillion: { input: 3, output: 15 },
    icon: '⚡',
    color: '#3B82F6',
  },
  {
    id: 'anthropic.claude-3-haiku-20240307-v1:0',
    name: 'Claude Haiku',
    tier: 'basic',
    description: 'Fast and economical for simple tasks',
    costPerMillion: { input: 0.25, output: 1.25 },
    icon: '🚀',
    color: '#10B981',
  },
  {
    id: 'amazon.titan-text-premier-v1:0',
    name: 'Amazon Titan Text',
    tier: 'standard',
    description: 'AWS-native model for text generation',
    costPerMillion: { input: 0.5, output: 1.5 },
    icon: '📝',
    color: '#F59E0B',
  },
];

// Mock users with different tiers
export const MOCK_USERS: Record<UserTier, User> = {
  premium: {
    id: 'user-premium-001',
    name: 'Alice Executive',
    email: 'alice@company.com',
    tier: 'premium',
    userArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/abc/user/alice',
  },
  standard: {
    id: 'user-standard-001',
    name: 'Bob Engineer',
    email: 'bob@company.com',
    tier: 'standard',
    userArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/abc/user/bob',
  },
  basic: {
    id: 'user-basic-001',
    name: 'Charlie Support',
    email: 'charlie@company.com',
    tier: 'basic',
    userArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/abc/user/charlie',
  },
};

// Mock conversations
export const MOCK_CONVERSATIONS: Conversation[] = [
  {
    id: 'conv-001',
    conversationArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/abc/channel/001',
    title: 'Project Strategy Analysis',
    modelId: 'anthropic.claude-opus-4-20250514',
    modelName: 'Claude Opus',
    modelTier: 'premium',
    createdAt: new Date('2025-01-15T10:00:00Z'),
    updatedAt: new Date('2025-01-15T14:30:00Z'),
    lastMessage: 'Based on the analysis, I recommend...',
  },
  {
    id: 'conv-002',
    conversationArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/abc/channel/002',
    title: 'Code Review Assistant',
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    modelName: 'Claude Sonnet 3.5',
    modelTier: 'standard',
    createdAt: new Date('2025-01-14T09:00:00Z'),
    updatedAt: new Date('2025-01-15T11:20:00Z'),
    lastMessage: 'The function looks good, but consider...',
  },
  {
    id: 'conv-003',
    conversationArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/abc/channel/003',
    title: 'Quick Questions',
    modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
    modelName: 'Claude Haiku',
    modelTier: 'basic',
    createdAt: new Date('2025-01-13T15:00:00Z'),
    updatedAt: new Date('2025-01-13T15:05:00Z'),
    lastMessage: 'Yes, that is correct!',
  },
];

// Mock messages for conversations
export const MOCK_MESSAGES: Record<string, Message[]> = {
  'conv-001': [
    {
      id: 'msg-001-1',
      content: 'Can you analyze our Q1 product strategy and provide recommendations?',
      sender: {
        arn: 'arn:aws:chime:us-east-1:123456789012:app-instance/abc/user/alice',
        name: 'Alice Executive',
      },
      timestamp: new Date('2025-01-15T10:00:00Z'),
      isBot: false,
      status: 'sent',
    },
    {
      id: 'msg-001-2',
      content: 'I will analyze your Q1 product strategy. Based on current market trends and your competitive position, here are my key recommendations:\n\n1. **Focus on Core Features**: Prioritize deepening existing capabilities over breadth\n2. **Customer Retention**: Invest 60% of resources in retention vs 40% in acquisition\n3. **Strategic Partnerships**: Explore 2-3 key partnerships in adjacent markets\n\nWould you like me to dive deeper into any of these areas?',
      sender: {
        arn: 'arn:aws:chime:us-east-1:123456789012:app-instance/abc/bot/claude-opus-bot',
        name: 'Claude Opus',
      },
      timestamp: new Date('2025-01-15T10:00:30Z'),
      isBot: true,
      status: 'sent',
    },
    {
      id: 'msg-001-3',
      content: 'Yes, tell me more about the strategic partnerships recommendation.',
      sender: {
        arn: 'arn:aws:chime:us-east-1:123456789012:app-instance/abc/user/alice',
        name: 'Alice Executive',
      },
      timestamp: new Date('2025-01-15T14:28:00Z'),
      isBot: false,
      status: 'sent',
    },
    {
      id: 'msg-001-4',
      content: 'Based on the analysis, I recommend focusing on partnerships that complement your core offering rather than compete. Here are three specific opportunities:\n\n**1. Data Analytics Platform** - Partner with a leading analytics provider to enhance your reporting capabilities\n\n**2. Integration Platform** - Connect with workflow automation tools to expand your ecosystem\n\n**3. Industry-Specific Solutions** - Form vertical partnerships in healthcare or finance\n\nEach partnership should be evaluated on: strategic alignment, revenue potential, and implementation complexity.',
      sender: {
        arn: 'arn:aws:chime:us-east-1:123456789012:app-instance/abc/bot/claude-opus-bot',
        name: 'Claude Opus',
      },
      timestamp: new Date('2025-01-15T14:30:00Z'),
      isBot: true,
      status: 'sent',
    },
  ],
  'conv-002': [
    {
      id: 'msg-002-1',
      content: 'Can you review this React component for performance issues?',
      sender: {
        arn: 'arn:aws:chime:us-east-1:123456789012:app-instance/abc/user/bob',
        name: 'Bob Engineer',
      },
      timestamp: new Date('2025-01-15T11:15:00Z'),
      isBot: false,
      attachment: {
        fileKey: 'attachments/bob/conv-002/component.tsx',
        name: 'UserProfile.tsx',
        size: 2048,
        type: 'text/plain',
      },
      status: 'sent',
    },
    {
      id: 'msg-002-2',
      content: 'I have reviewed the UserProfile component. Here are the key performance improvements:\n\n**Issues Found:**\n1. Missing React.memo() - component re-renders unnecessarily\n2. Inline function definitions causing new references\n3. useEffect missing dependency array\n\n**Recommendations:**\n```typescript\nexport const UserProfile = React.memo(({ userId }: Props) => {\n  const handleClick = useCallback(() => {...}, []);\n  \n  useEffect(() => {\n    fetchUser(userId);\n  }, [userId]);\n});\n```\n\nThese changes should reduce re-renders by ~70%.',
      sender: {
        arn: 'arn:aws:chime:us-east-1:123456789012:app-instance/abc/bot/claude-sonnet-bot',
        name: 'Claude Sonnet 3.5',
      },
      timestamp: new Date('2025-01-15T11:20:00Z'),
      isBot: true,
      status: 'sent',
    },
  ],
  'conv-003': [
    {
      id: 'msg-003-1',
      content: 'What is the difference between let and const in JavaScript?',
      sender: {
        arn: 'arn:aws:chime:us-east-1:123456789012:app-instance/abc/user/charlie',
        name: 'Charlie Support',
      },
      timestamp: new Date('2025-01-13T15:00:00Z'),
      isBot: false,
      status: 'sent',
    },
    {
      id: 'msg-003-2',
      content: 'The key differences:\n\n**const** - Cannot be reassigned after declaration\n```js\nconst x = 5;\nx = 10; // Error!\n```\n\n**let** - Can be reassigned\n```js\nlet y = 5;\ny = 10; // OK!\n```\n\nUse `const` by default, only use `let` when you need to reassign.',
      sender: {
        arn: 'arn:aws:chime:us-east-1:123456789012:app-instance/abc/bot/claude-haiku-bot',
        name: 'Claude Haiku',
      },
      timestamp: new Date('2025-01-13T15:00:05Z'),
      isBot: true,
      status: 'sent',
    },
  ],
};

// Helper function to get models available for a user tier
export function getAvailableModels(userTier: UserTier): Model[] {
  if (userTier === 'premium') return MOCK_MODELS;
  if (userTier === 'standard') return MOCK_MODELS.filter((m) => m.tier !== 'premium');
  return MOCK_MODELS.filter((m) => m.tier === 'basic');
}

// Generate unique IDs
export function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export function generateConversationId(): string {
  return `conv-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// Simulate AI response with delay
export function simulateAIResponse(prompt: string, modelId: string): Promise<string> {
  return new Promise((resolve) => {
    const delay = 1000 + Math.random() * 2000; // 1-3 second delay
    setTimeout(() => {
      const responses = [
        `I understand your question about "${prompt.substring(0, 50)}...". Here is my analysis:\n\n${generateMockResponse(modelId)}`,
        `That is a great question. Let me help you with that:\n\n${generateMockResponse(modelId)}`,
        `Based on your query: "${prompt.substring(0, 50)}..."\n\n${generateMockResponse(modelId)}`,
      ];
      resolve(responses[Math.floor(Math.random() * responses.length)]);
    }, delay);
  });
}

function generateMockResponse(modelId: string): string {
  if (modelId.includes('opus')) {
    return 'As the most advanced model, I can provide deep insights and comprehensive analysis. This is a detailed, thoughtful response that demonstrates complex reasoning capabilities. I have considered multiple perspectives and edge cases in formulating this answer.';
  } else if (modelId.includes('sonnet')) {
    return 'Here is a balanced analysis of your question. I have provided practical recommendations while considering both technical and business factors. This should give you a solid foundation to move forward.';
  } else {
    return 'Quick answer: Here is what you need to know. This is concise and to the point, perfect for fast responses.';
  }
}
