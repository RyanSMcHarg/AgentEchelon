import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';

/** The composer's device cache (`services/composerCache.ts`) starts empty in every test, as on a fresh device. */
function clearComposerCacheKeys(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('ae.composer.')) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* no storage in this environment */
  }
}

beforeEach(clearComposerCacheKeys);
afterEach(clearComposerCacheKeys);
