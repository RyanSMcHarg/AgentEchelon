import React, { createContext, useContext, useState, type ReactNode } from 'react';
import type { Conversation, Message, UserTier } from '../types';
import {
  MOCK_CONVERSATIONS,
  MOCK_MESSAGES,
  simulateAIResponse,
  generateMessageId,
  generateConversationId,
} from '../utils/mockData';
import { useAuth } from './AuthProvider';

// Helper function to generate model-specific greeting messages
function getModelGreeting(tier: UserTier, _modelName: string): string {
  if (tier === 'basic') {
    return `Welcome to Agent Echelon. Try asking things like:\n\n• "Summarize the key differences between REST and GraphQL"\n• "Write a Python function to validate email addresses"\n• "What are the GDPR requirements for data retention?"\n• "Explain how Kubernetes pods communicate"\n\nThis conversation is suited for quick Q&A, lookups, and simple tasks.`;
  } else if (tier === 'standard') {
    return `Welcome to Agent Echelon. Try asking things like:\n\n• "Review this SQL query for performance issues and suggest improvements"\n• "Walk me through setting up a CI/CD pipeline for a Node.js app"\n• "Compare three approaches to caching in a microservices architecture"\n• "Generate a TypeScript API client from this OpenAPI spec"\n• "Help me troubleshoot why our Lambda cold starts exceed 3 seconds"\n\nThis conversation supports multi-step workflows, code generation, and detailed analysis.`;
  } else {
    return `Welcome to Agent Echelon. Try asking things like:\n\n• "Design a data pipeline architecture for processing 10M events/day with exactly-once delivery"\n• "Audit this IAM policy for privilege escalation risks and suggest least-privilege alternatives"\n• "Generate a comprehensive cost-benefit report comparing Aurora vs DynamoDB for our workload"\n• "Review our system design and identify single points of failure"\n• "Help me plan a zero-downtime migration from monolith to microservices"\n\nThis is a premium conversation with the most capable model. It supports report generation with downloadable documents, advanced multi-step workflows, and deep analysis.`;
  }
}

interface ConversationContextType {
  conversations: Conversation[];
  activeConversation: Conversation | null;
  messages: Message[];
  isLoadingMessages: boolean;
  createConversation: (title: string, modelId: string, modelName: string) => Promise<void>;
  selectConversation: (conversationId: string) => void;
  sendMessage: (content: string, attachment?: any) => Promise<void>;
  deleteConversation: (conversationId: string) => void;
  renameConversation: (conversationId: string, newTitle: string) => void;
}

const ConversationContext = createContext<ConversationContextType | undefined>(undefined);

interface ConversationProviderProps {
  children: ReactNode;
}

export function ConversationProvider({ children }: ConversationProviderProps) {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [allMessages, setAllMessages] = useState<Record<string, Message[]>>({});
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);

  // Initialize with mock data
  React.useEffect(() => {
    if (user) {
      // Filter conversations based on user tier
      const userConversations = MOCK_CONVERSATIONS.filter((conv) => {
        if (user.tier === 'premium') return true;
        if (user.tier === 'standard') return conv.modelTier !== 'premium';
        return conv.modelTier === 'basic';
      });
      setConversations(userConversations);
      setAllMessages(MOCK_MESSAGES);

      // Auto-select first conversation
      if (userConversations.length > 0) {
        setActiveConversation(userConversations[0]);
      }
    }
  }, [user]);

  const createConversation = async (
    title: string,
    modelId: string,
    modelName: string
  ): Promise<void> => {
    if (!user) return;

    // Determine model tier from modelId
    let modelTier: 'premium' | 'standard' | 'basic' = 'basic';
    if (modelId.includes('opus')) modelTier = 'premium';
    else if (modelId.includes('sonnet') || modelId.includes('titan')) modelTier = 'standard';

    const newConversation: Conversation = {
      id: generateConversationId(),
      conversationArn: `arn:aws:chime:us-east-1:123456789012:app-instance/abc/channel/${Date.now()}`,
      title,
      modelId,
      modelName,
      modelTier,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Create initial greeting message from the agent
    const greetingMessage: Message = {
      id: generateMessageId(),
      content: getModelGreeting(modelTier, modelName),
      sender: {
        arn: `arn:aws:chime:us-east-1:123456789012:app-instance/abc/bot/${modelName.toLowerCase().replace(/\s+/g, '-')}-bot`,
        name: modelName,
      },
      timestamp: new Date(),
      isBot: true,
      status: 'sent',
    };

    setConversations((prev) => [newConversation, ...prev]);
    setAllMessages((prev) => ({ ...prev, [newConversation.id]: [greetingMessage] }));
    setActiveConversation(newConversation);
  };

  const selectConversation = (conversationId: string) => {
    const conversation = conversations.find((c) => c.id === conversationId);
    if (conversation) {
      setActiveConversation(conversation);

      // Mark as read
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId ? { ...c, unreadCount: 0 } : c
        )
      );
    }
  };

  const sendMessage = async (content: string, attachment?: any): Promise<void> => {
    if (!activeConversation || !user) return;

    // Create user message
    const userMessage: Message = {
      id: generateMessageId(),
      content,
      sender: {
        arn: user.userArn || '',
        name: user.name || user.email,
      },
      timestamp: new Date(),
      isBot: false,
      attachment,
      status: 'sending',
    };

    // Add user message immediately
    setAllMessages((prev) => ({
      ...prev,
      [activeConversation.id]: [...(prev[activeConversation.id] || []), userMessage],
    }));

    // Update message status to sent
    setTimeout(() => {
      setAllMessages((prev) => ({
        ...prev,
        [activeConversation.id]: prev[activeConversation.id].map((m) =>
          m.id === userMessage.id ? { ...m, status: 'sent' as const } : m
        ),
      }));
    }, 200);

    // Simulate AI response
    setIsLoadingMessages(true);
    try {
      const aiResponse = await simulateAIResponse(content, activeConversation.modelId);

      const botMessage: Message = {
        id: generateMessageId(),
        content: aiResponse,
        sender: {
          arn: `arn:aws:chime:us-east-1:123456789012:app-instance/abc/bot/${activeConversation.modelName.toLowerCase().replace(/\s+/g, '-')}-bot`,
          name: activeConversation.modelName,
        },
        timestamp: new Date(),
        isBot: true,
        status: 'sent',
      };

      setAllMessages((prev) => ({
        ...prev,
        [activeConversation.id]: [...prev[activeConversation.id], botMessage],
      }));

      // Update conversation lastMessage and updatedAt
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeConversation.id
            ? {
                ...c,
                lastMessage: aiResponse.substring(0, 50) + '...',
                updatedAt: new Date(),
              }
            : c
        )
      );
    } catch (error) {
      console.error('Error getting AI response:', error);
      // Update user message status to failed
      setAllMessages((prev) => ({
        ...prev,
        [activeConversation.id]: prev[activeConversation.id].map((m) =>
          m.id === userMessage.id ? { ...m, status: 'failed' as const } : m
        ),
      }));
    } finally {
      setIsLoadingMessages(false);
    }
  };

  const deleteConversation = (conversationId: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== conversationId));
    setAllMessages((prev) => {
      const newMessages = { ...prev };
      delete newMessages[conversationId];
      return newMessages;
    });

    if (activeConversation?.id === conversationId) {
      setActiveConversation(conversations[0] || null);
    }
  };

  const renameConversation = (conversationId: string, newTitle: string) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === conversationId ? { ...c, title: newTitle } : c))
    );

    if (activeConversation?.id === conversationId) {
      setActiveConversation((prev) => (prev ? { ...prev, title: newTitle } : null));
    }
  };

  const value: ConversationContextType = {
    conversations,
    activeConversation,
    messages: activeConversation ? allMessages[activeConversation.id] || [] : [],
    isLoadingMessages,
    createConversation,
    selectConversation,
    sendMessage,
    deleteConversation,
    renameConversation,
  };

  return <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>;
}

export function useConversations(): ConversationContextType {
  const context = useContext(ConversationContext);
  if (context === undefined) {
    throw new Error('useConversations must be used within a ConversationProvider');
  }
  return context;
}
