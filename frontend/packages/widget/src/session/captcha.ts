/**
 * THE GUEST-START CAPTCHA: Cloudflare Turnstile, verified server-side by guest start (L16).
 *
 * The widget renders the challenge into a container it owns and resolves with the response token. The
 * challenge is invisible unless Turnstile needs an interaction, and then it is its own accessible widget
 * (WCAG 2.2 SC 3.3.8). The script loads from `challenges.cloudflare.com` only, which the frame's
 * Content-Security-Policy names.
 */

/** Renders a challenge into `container` and resolves with its response token. */
export type CaptchaSolver = (container: HTMLElement, siteKey: string, lang: string) => Promise<string>;

interface Turnstile {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  remove(widgetId: string): void;
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<Turnstile> | null = null;

function loadTurnstile(): Promise<Turnstile> {
  const existing = (window as unknown as { turnstile?: Turnstile }).turnstile;
  if (existing) return Promise.resolve(existing);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => {
      const t = (window as unknown as { turnstile?: Turnstile }).turnstile;
      if (t) resolve(t);
      else reject(new Error('turnstile did not load'));
    };
    s.onerror = () => {
      loading = null;
      reject(new Error('turnstile did not load'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export const turnstileSolver: CaptchaSolver = async (container, siteKey, lang) => {
  const turnstile = await loadTurnstile();
  return new Promise((resolve, reject) => {
    const id = turnstile.render(container, {
      sitekey: siteKey,
      language: lang,
      appearance: 'interaction-only',
      callback: (token: string) => {
        resolve(token);
        setTimeout(() => turnstile.remove(id), 0);
      },
      'error-callback': () => reject(new Error('captcha error')),
      'expired-callback': () => reject(new Error('captcha expired')),
    });
  });
};
