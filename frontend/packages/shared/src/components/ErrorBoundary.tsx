import { Component, type ReactNode, type ErrorInfo } from 'react';
import i18n from '../i18n';
import { trackEvent } from '../services/eventTrackingService';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
    try {
      trackEvent('error', {
        message: error.message || 'Unknown error',
        componentStack: (errorInfo.componentStack || '').slice(0, 500),
      });
    } catch {
      // Tracking must never interfere with error handling
    }
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          padding: '40px',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}>
          <h1 style={{ fontSize: '24px', fontWeight: 600, color: '#2d2d2d', marginBottom: '12px' }}>
            {i18n.t('error.boundaryTitle')}
          </h1>
          <p style={{ fontSize: '15px', color: '#6e6e6e', marginBottom: '24px', textAlign: 'center', maxWidth: '400px' }}>
            {i18n.t('error.boundaryBody')}
          </p>
          {this.state.error && (
            <pre style={{
              fontSize: '12px',
              color: '#8e8e8e',
              background: '#f5f5f5',
              padding: '12px 16px',
              borderRadius: '8px',
              marginBottom: '24px',
              maxWidth: '500px',
              overflow: 'auto',
            }}>
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={this.handleRetry}
            style={{
              padding: '10px 24px',
              background: '#2d2d2d',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {i18n.t('error.retry')}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
