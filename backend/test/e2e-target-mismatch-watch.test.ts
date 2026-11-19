/**
 * THE E2E TARGET-MISMATCH LISTENER RECORDS EACH REPORT ONCE (`tests/e2e/helpers/target-mismatch.ts`).
 *
 * A context reaches the suite's fixtures twice: built through the patched `browser.newContext`, then handed to the
 * `context` fixture. Each hand-in attaching its own listener recorded every `[target-mismatch]` line twice, so a spec
 * counting reports (`>= 2`) passed on one. This proves a context and its pages are listened to once however often they
 * are handed in.
 */
import { EventEmitter } from 'events';
import {
  TARGET_MISMATCH_LOG, targetWatch, watchContextForTargetMismatch, watchPageForTargetMismatch,
} from '../../tests/e2e/helpers/target-mismatch';

// The Playwright types as the helper takes them: the backend installs no `@playwright/test` of its own.
type BrowserContext = Parameters<typeof watchContextForTargetMismatch>[0];
type Page = Parameters<typeof watchPageForTargetMismatch>[0];

const fakePage = () => new EventEmitter() as unknown as Page & EventEmitter;
const fakeContext = (pages: Array<Page & EventEmitter>) => {
  const ctx = new EventEmitter() as unknown as BrowserContext & EventEmitter;
  (ctx as unknown as { pages: () => Page[] }).pages = () => pages;
  return ctx;
};
const log = (text: string) => ({ text: () => text });

beforeEach(() => { targetWatch.seen = []; targetWatch.expected = false; });

describe('the target-mismatch listener', () => {
  it('records one report once when the same context is handed in twice', () => {
    const page = fakePage();
    const ctx = fakeContext([page]);
    watchContextForTargetMismatch(ctx);
    watchContextForTargetMismatch(ctx);
    page.emit('console', log(`${TARGET_MISMATCH_LOG} one`));
    expect(targetWatch.seen).toEqual([`${TARGET_MISMATCH_LOG} one`]);
  });

  it('listens to a page the context opens later once, and ignores other console lines', () => {
    const ctx = fakeContext([]);
    watchContextForTargetMismatch(ctx);
    watchContextForTargetMismatch(ctx);
    const later = fakePage();
    ctx.emit('page', later);
    watchPageForTargetMismatch(later);
    later.emit('console', log('an ordinary line'));
    later.emit('console', log(`${TARGET_MISMATCH_LOG} two`));
    expect(targetWatch.seen).toEqual([`${TARGET_MISMATCH_LOG} two`]);
  });
});
