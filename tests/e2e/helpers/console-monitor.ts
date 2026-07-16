/**
 * Console Monitor for E2E Tests
 *
 * Captures browser console errors, warnings, and diagnostic messages
 * during test execution. Attach before navigation to capture everything.
 *
 * Console/WebSocket monitoring helper for Playwright e2e.
 */
import { Page } from '@playwright/test';

export type ConsoleSeverity = 'error' | 'warning' | 'pageerror' | 'info';

export interface ConsoleEntry {
  severity: ConsoleSeverity;
  text: string;
  timestamp: number;
  /** URL where the message originated (if available) */
  url?: string;
}

export class ConsoleMonitor {
  private entries: ConsoleEntry[] = [];

  /** Substrings to ignore -- noisy browser/SDK warnings that are not actionable */
  private ignorePatterns: string[] = [
    'Download the React DevTools',
    'Third-party cookie',
    '[HMR]',
    'DevTools failed to load',
    'Manifest:',
    'favicon.ico',
    'Warning: ReactDOM.render is no longer supported',
    'cannot be a descendant of',
    'cannot contain a nested',
    'hydration error',
  ];

  /** Key phrases from info/log messages that indicate problems worth capturing */
  private diagnosticPatterns: string[] = [
    'AuthProvider:',
    'CAPTCHA',
    'Credential is missing',
    'rate limit',
    'RATE_LIMIT',
    '429',
    '400',
    '403',
    'ensureChannel',
    'channelReady',
    'MessagingProvider:',
    'AwsClientProvider:',
    'Error',
    'failed',
    'DENIED',
  ];

  /**
   * Attach listeners to the page. Call BEFORE navigation.
   */
  attach(page: Page): void {
    page.on('console', (msg) => {
      const type = msg.type(); // 'error', 'warning', 'log', 'info', etc.
      const text = msg.text();
      if (this.ignorePatterns.some(p => text.includes(p))) return;

      // Always capture errors and warnings
      if (type === 'error' || type === 'warning') {
        const severity: ConsoleSeverity = type === 'error' ? 'error' : 'warning';
        this.entries.push({ severity, text, timestamp: Date.now(), url: msg.location()?.url });
        const prefix = severity === 'error' ? '[CONSOLE ERROR]' : '[CONSOLE WARN]';
        console.log(`${prefix} ${text.substring(0, 200)}`);
        return;
      }

      // Also capture info/log messages matching diagnostic patterns
      if (this.diagnosticPatterns.some(p => text.includes(p))) {
        this.entries.push({ severity: 'info' as ConsoleSeverity, text, timestamp: Date.now(), url: msg.location()?.url });
        console.log(`[CONSOLE] ${text.substring(0, 200)}`);
      }
    });

    page.on('pageerror', (error) => {
      this.entries.push({
        severity: 'pageerror',
        text: error.message,
        timestamp: Date.now(),
      });
      console.log(`[PAGE CRASH] ${error.message.substring(0, 200)}`);
    });
  }

  /** All captured entries */
  get all(): ConsoleEntry[] {
    return [...this.entries];
  }

  /** Only errors and page crashes. Format includes the originating URL when
   *  the browser provided one — critical for "Failed to load resource: 403"
   *  style entries where the text alone doesn't say WHICH URL failed. */
  getErrors(): string[] {
    return this.entries
      .filter(e => e.severity === 'error' || e.severity === 'pageerror')
      .map(e => (e.url ? `${e.text} [${e.url}]` : e.text));
  }

  /** Only warnings */
  getWarnings(): string[] {
    return this.entries
      .filter(e => e.severity === 'warning')
      .map(e => e.text);
  }

  /** Whether any errors were captured */
  hasErrors(): boolean {
    return this.entries.some(e => e.severity === 'error' || e.severity === 'pageerror');
  }

  /**
   * Throw an error if any console errors were captured.
   * Call at the end of a test to fail on unexpected errors.
   */
  assertNoErrors(): void {
    const errors = this.getErrors();
    if (errors.length > 0) {
      throw new Error(
        `${errors.length} console error(s) detected:\n` +
        errors.map((e, i) => `  ${i + 1}. ${e.substring(0, 300)}`).join('\n')
      );
    }
  }

  /** Clear all captured entries (e.g., between test steps) */
  clear(): void {
    this.entries = [];
  }

  /** Add a pattern to ignore (substring match) */
  ignore(pattern: string): void {
    this.ignorePatterns.push(pattern);
  }

  /**
   * Dump all captured entries to stdout.
   * Useful at the end of a test for debugging failures.
   */
  dump(label?: string): void {
    if (this.entries.length === 0) {
      console.log(`[ConsoleMonitor]${label ? ` ${label}:` : ''} No console errors or warnings captured`);
      return;
    }
    console.log(`[ConsoleMonitor]${label ? ` ${label}:` : ''} ${this.entries.length} entries captured:`);
    for (const entry of this.entries) {
      const icon = entry.severity === 'pageerror' ? '[CRASH]' : entry.severity === 'error' ? '[ERROR]' : '[WARN]';
      const loc = entry.url ? ` (${entry.url})` : '';
      console.log(`  ${icon} [${entry.severity}] ${entry.text.substring(0, 300)}${loc}`);
    }
  }
}
