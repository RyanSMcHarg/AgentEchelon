/**
 * THE HOST-PAGE LOADER (`embed.js`), served from the widget's own origin beside the frame.
 *
 * A host page includes it with one script tag and calls `AEWidget.mount(options)`. It creates the frame
 * (an iframe with a title, in the person's language once the frame reports it), keeps it in the corner,
 * sizes it when the panel opens and closes, and, for a host that signs its people in, relays the host's
 * assertion into the frame. It bundles no framework and reads nothing of the host page.
 *
 *  - **Messages from the frame** are read only when `event.origin` is the widget's origin and
 *    `event.source` is this loader's own frame.
 *  - **An assertion is posted only to the widget's origin** (the `targetOrigin` of `postMessage`), so a
 *    frame navigated elsewhere never receives it. The frame checks the other direction: the assertion's
 *    origin is a declared host and its source is the frame's own parent (`session/hostAssertion.ts`).
 *
 * The widget's origin is the origin this script was loaded from, unless `options.src` names the frame.
 */

const FRAME_READY = 'ae:widget-ready';
const FRAME_OPEN = 'ae:widget-open';
const ASSERTION_MESSAGE = 'ae:host-assertion';
const ASSERTION_REQUEST = 'ae:host-assertion-request';

export interface MountOptions {
  /** The frame document. Default: `index.html` beside this script. */
  src?: string;
  /** `guest` (the default): an anonymous visitor. `host`: the host posts an assertion for its signed-in person. */
  mode?: 'guest' | 'host';
  /** The person's language, as a BCP 47 tag. */
  lang?: string;
  /**
   * Where a visitor goes when the assistant is paused or unavailable: an https:, mailto: or tel: URL. The
   * frame shows it in those refusals, and drops any other scheme.
   */
  contact?: string;
  /** `light` or `dark`. Absent: the person's `prefers-color-scheme`. */
  theme?: 'light' | 'dark';
  /** `--accent-500`, a hex color. */
  accent?: string;
  /** The radius scale, in px (0 to 24). */
  radius?: number;
  /** The font family. Fonts load only from the widget's own origin or `data:`. */
  font?: string;
  /** The frame's accessible name until the frame reports its own, localized one. */
  title?: string;
  /** Where the frame goes. Default: fixed to the page's bottom-right corner. */
  container?: HTMLElement;
  /** Host mode: called when the frame needs a fresh assertion; answer with `postAssertion`. */
  onAssertionRequest?: () => void;
}

export interface WidgetHandle {
  /** Host mode: post the host's signed assertion, naming the conversation the person opened. */
  postAssertion(assertion: string, conversationArn?: string): void;
  unmount(): void;
}

const CLOSED = { width: '68px', height: '68px' };
const OPEN = { width: 'min(420px, calc(100vw - 16px))', height: 'min(640px, calc(100vh - 16px))' };

const scriptSrc: string | undefined = typeof document !== 'undefined'
  ? (document.currentScript as HTMLScriptElement | null)?.src
  : undefined;

export function mount(options: MountOptions = {}): WidgetHandle {
  const src = new URL(options.src ?? 'index.html', scriptSrc ?? window.location.href);
  const widgetOrigin = src.origin;
  const params = src.searchParams;
  params.set('mode', options.mode === 'host' ? 'host' : 'guest');
  if (options.lang) params.set('lang', options.lang);
  if (options.contact) params.set('contact', options.contact);
  if (options.theme) params.set('theme', options.theme);
  if (options.accent) params.set('accent', options.accent);
  if (options.radius !== undefined) params.set('radius', String(options.radius));
  if (options.font) params.set('font', options.font);

  const frame = document.createElement('iframe');
  frame.src = src.toString();
  frame.title = options.title ?? '';
  frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
  Object.assign(frame.style, {
    border: '0',
    background: 'transparent',
    colorScheme: 'normal',
    ...CLOSED,
    ...(options.container ? {} : { position: 'fixed', right: '8px', bottom: '8px', zIndex: '2147483000' }),
  });

  let ready = false;
  const queued: Array<[string, string | undefined]> = [];
  const send = (assertion: string, conversationArn?: string) => {
    frame.contentWindow?.postMessage({ type: ASSERTION_MESSAGE, assertion, ...(conversationArn ? { conversationArn } : {}) }, widgetOrigin);
  };

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== widgetOrigin || event.source !== frame.contentWindow) return;
    const data = event.data as { type?: unknown; open?: unknown; title?: unknown } | null;
    if (!data) return;
    if (data.type === FRAME_READY) {
      ready = true;
      if (typeof data.title === 'string' && data.title) frame.title = data.title;
      for (const [a, c] of queued.splice(0)) send(a, c);
    } else if (data.type === FRAME_OPEN) {
      const open = data.open === true;
      frame.dataset.open = String(open);
      Object.assign(frame.style, open ? OPEN : CLOSED);
    } else if (data.type === ASSERTION_REQUEST) {
      options.onAssertionRequest?.();
    }
  };
  window.addEventListener('message', onMessage);
  (options.container ?? document.body).appendChild(frame);

  return {
    postAssertion(assertion, conversationArn) {
      if (ready) send(assertion, conversationArn);
      else queued.push([assertion, conversationArn]);
    },
    unmount() {
      window.removeEventListener('message', onMessage);
      frame.remove();
    },
  };
}

if (typeof window !== 'undefined') {
  (window as unknown as { AEWidget?: { mount: typeof mount } }).AEWidget = { mount };
}
