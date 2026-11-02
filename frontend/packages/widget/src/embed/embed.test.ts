/**
 * The host-page loader: a titled frame, sized by the frame's own messages only, and a host assertion
 * posted only to the widget's origin.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount } from './embed';

const WIDGET = 'https://widget.example.com';

afterEach(() => {
  document.body.innerHTML = '';
});

function frameOf(): HTMLIFrameElement {
  return document.querySelector('iframe')!;
}

function fromFrame(data: unknown, origin = WIDGET, source: unknown = frameOf().contentWindow) {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: source as MessageEventSource }));
}

describe('the loader', () => {
  it('frames the widget with its options, a title, and a sandbox', () => {
    mount({ src: `${WIDGET}/index.html`, mode: 'host', lang: 'pt-BR', theme: 'dark', accent: '#0f766e', title: 'Assistant' });
    const frame = frameOf();
    const url = new URL(frame.src);
    expect(url.origin).toBe(WIDGET);
    expect(Object.fromEntries(url.searchParams)).toEqual({ mode: 'host', lang: 'pt-BR', theme: 'dark', accent: '#0f766e' });
    expect(frame.title).toBe('Assistant');
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
  });

  it('takes the frame\'s localized title and sizes the frame from the frame\'s own messages', () => {
    mount({ src: `${WIDGET}/index.html` });
    fromFrame({ type: 'ae:widget-ready', title: 'Assistente' });
    expect(frameOf().title).toBe('Assistente');
    fromFrame({ type: 'ae:widget-open', open: true });
    expect(frameOf().dataset.open).toBe('true');
    fromFrame({ type: 'ae:widget-open', open: false });
    expect(frameOf().dataset.open).toBe('false');
    expect(frameOf().style.width).toBe('68px');
  });

  it('ignores a message from another origin, or from another window on the widget origin', () => {
    mount({ src: `${WIDGET}/index.html` });
    fromFrame({ type: 'ae:widget-open', open: true }, 'https://evil.example.com');
    expect(frameOf().dataset.open).toBeUndefined();
    fromFrame({ type: 'ae:widget-open', open: true }, WIDGET, window);
    expect(frameOf().dataset.open).toBeUndefined();
  });

  it('posts an assertion only to the widget origin, after the frame is ready', () => {
    const handle = mount({ src: `${WIDGET}/index.html`, mode: 'host' });
    const post = vi.spyOn(frameOf().contentWindow!, 'postMessage');
    handle.postAssertion('a.b.c', 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/c1');
    expect(post).not.toHaveBeenCalled();
    fromFrame({ type: 'ae:widget-ready', title: 'Assistant' });
    expect(post).toHaveBeenCalledWith(
      { type: 'ae:host-assertion', assertion: 'a.b.c', conversationArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/c1' },
      WIDGET,
    );
  });

  it('passes the frame\'s request for a fresh assertion to the host', () => {
    const onAssertionRequest = vi.fn();
    mount({ src: `${WIDGET}/index.html`, mode: 'host', onAssertionRequest });
    fromFrame({ type: 'ae:host-assertion-request' }, 'https://evil.example.com');
    expect(onAssertionRequest).not.toHaveBeenCalled();
    fromFrame({ type: 'ae:host-assertion-request' });
    expect(onAssertionRequest).toHaveBeenCalledTimes(1);
  });
});
