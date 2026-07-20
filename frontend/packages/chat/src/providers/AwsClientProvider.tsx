import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { useAuth } from '@ae/shared';
import { chimeService } from '../services/chimeService';

interface AwsClientContextType {
  isInitialized: boolean;
  userArn: string | null;
  error: string | null;
}

const AwsClientContext = createContext<AwsClientContextType | undefined>(undefined);

export function AwsClientProvider({ children }: { children: ReactNode }) {
  const { user, idToken } = useAuth();
  const [isInitialized, setIsInitialized] = useState(false);
  const [userArn, setUserArn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function initializeClients() {
      if (!user || !idToken) {
        setIsInitialized(false);
        setUserArn(null);
        setError(null);
        return;
      }

      try {
        setError(null);
        await chimeService.initialize(idToken, user.id);
        setUserArn(chimeService.getUserArn());
        setIsInitialized(true);
      } catch (err) {
        console.error('Failed to initialize AWS clients:', err);
        setError(err instanceof Error ? err.message : 'Failed to initialize AWS clients');
        setIsInitialized(false);
      }
    }

    initializeClients();
  }, [user, idToken]);

  return (
    <AwsClientContext.Provider value={{ isInitialized, userArn, error }}>
      {children}
    </AwsClientContext.Provider>
  );
}

export function useAwsClient(): AwsClientContextType {
  const context = useContext(AwsClientContext);
  if (context === undefined) {
    throw new Error('useAwsClient must be used within an AwsClientProvider');
  }
  return context;
}
