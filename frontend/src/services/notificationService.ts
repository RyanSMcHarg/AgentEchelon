/**
 * Browser Notification Service
 *
 * Thin wrapper around the Web Notifications API for new-message alerts.
 * Request permission on first interaction, show only when the tab is hidden
 * or unfocused, dedupe by tag, click focuses the tab and (optionally) routes
 * to the channel.
 *
 * Usage:
 *   notificationService.requestPermission()   // call on app mount
 *   notificationService.notifyNewMessage({
 *     channelArn,
 *     title: 'Q3 Planning',
 *     body: 'Alice: Here's the update...',
 *     onClick: () => selectConversation(channelArn),
 *   })
 */

const activeNotifications = new Map<string, Notification>();

function isSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function isGranted(): boolean {
  return isSupported() && Notification.permission === 'granted';
}

function isDenied(): boolean {
  return isSupported() && Notification.permission === 'denied';
}

/**
 * Request notification permission if still `default`. No-op if already
 * granted or denied. Returns the resulting permission state.
 */
async function requestPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!isSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;

  try {
    const result = await Notification.requestPermission();
    return result;
  } catch (err) {
    console.warn('[notificationService] requestPermission failed:', err);
    return Notification.permission;
  }
}

export interface NotifyNewMessageOptions {
  channelArn: string;
  title: string;
  body: string;
  /** Called when the user clicks the notification. Should focus the
   *  tab and route to the channel. */
  onClick?: () => void;
  /** Override the dedupe tag. Defaults to the channel ARN so repeated
   *  messages in the same channel replace prior notifications. */
  tag?: string;
}

/**
 * Show a browser notification for a new message. Silently no-ops when:
 *  - Notifications aren't supported
 *  - Permission hasn't been granted
 *  - The page is currently focused and visible (no point nagging — the
 *    user is already looking at the app)
 *
 * The page-focused check is intentionally not performed here — the
 * caller decides whether to invoke this. Keeps the service dumb.
 */
function notifyNewMessage(options: NotifyNewMessageOptions): void {
  if (!isGranted()) return;

  const tag = options.tag || options.channelArn;

  try {
    // Close any prior notification for this tag to keep the stack tidy
    const existing = activeNotifications.get(tag);
    if (existing) {
      try {
        existing.close();
      } catch {
        /* ignore */
      }
    }

    const notification = new Notification(options.title, {
      body: options.body,
      icon: '/favicon.ico',
      tag,
      // Don't auto-close — let the OS handle it. Click handler focuses
      // the tab and calls the optional router callback.
      requireInteraction: false,
      silent: false,
    });

    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      try {
        options.onClick?.();
      } catch (err) {
        console.warn('[notificationService] onClick handler threw:', err);
      }
      notification.close();
    };

    notification.onclose = () => {
      activeNotifications.delete(tag);
    };

    activeNotifications.set(tag, notification);
  } catch (err) {
    console.warn('[notificationService] Failed to create notification:', err);
  }
}

/** Close all active notifications — useful on logout / session end. */
function closeAll(): void {
  for (const [, n] of activeNotifications) {
    try {
      n.close();
    } catch {
      /* ignore */
    }
  }
  activeNotifications.clear();
}

export const notificationService = {
  isSupported,
  isGranted,
  isDenied,
  requestPermission,
  notifyNewMessage,
  closeAll,
};
