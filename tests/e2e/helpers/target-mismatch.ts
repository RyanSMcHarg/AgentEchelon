/**
 * THE TARGET-MISMATCH LISTENER (`helpers/fixtures.ts`): every page of every context a test uses is listened to for the
 * client's `[target-mismatch]` console line, once. A context reaches the fixtures twice (built through the patched
 * `browser.newContext`, then handed to the `context` fixture), so each context and each page is attached at most once
 * and every report is recorded exactly once. Proven in `backend/test/e2e-target-mismatch-watch.test.ts`.
 */
/**
 * THE PARTS OF A PAGE AND A CONTEXT THIS LISTENER USES, which Playwright's `Page` and `BrowserContext` satisfy. Named here
 * rather than imported, so the backend test that proves the listener typechecks without the e2e package installed.
 */
interface ConsoleLine { text(): string }
interface Page { on(event: 'console', listener: (msg: ConsoleLine) => unknown): unknown }
interface BrowserContext { pages(): Page[]; on(event: 'page', listener: (page: Page) => unknown): unknown }

/** The marker the client logs every target mismatch under (`TARGET_MISMATCH_LOG` in the chat app's `targetIntegrity.ts`). */
export const TARGET_MISMATCH_LOG = '[target-mismatch]';

/** The running test's target-mismatch reports, and whether it declared them. One test runs at a time in a worker. */
export const targetWatch = { seen: [] as string[], expected: false };

const watchedContexts = new WeakSet<object>();
const watchedPages = new WeakSet<object>();

/** One page's console, listened to once. */
export function watchPageForTargetMismatch(page: Page): void {
  if (watchedPages.has(page)) return;
  watchedPages.add(page);
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes(TARGET_MISMATCH_LOG)) targetWatch.seen.push(text.slice(0, 400));
  });
}

/** Every page a context has or opens is listened to, once however often the context is handed in. */
export function watchContextForTargetMismatch(context: BrowserContext): void {
  if (watchedContexts.has(context)) return;
  watchedContexts.add(context);
  for (const page of context.pages()) watchPageForTargetMismatch(page);
  context.on('page', watchPageForTargetMismatch);
}
