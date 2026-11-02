/**
 * THE EMPTY-STATE WELCOME IS THE CLASSIFICATION'S OWN COPY (`newConversation.class.<value>.greeting`), and a
 * classification whose copy declares none is welcomed by nothing rather than by another classification's words.
 */
import { describe, it, expect } from 'vitest';
import i18n from '@ae/shared/i18n';
import { getModelGreeting } from './greeting';

const t = i18n.t.bind(i18n) as unknown as Parameters<typeof getModelGreeting>[1];

describe('getModelGreeting', () => {
  it('is the sample classification\'s welcome from the locale', () => {
    expect(getModelGreeting('premium', t)).toMatch(/^Welcome to Agent Echelon\./);
  });

  it('is null for a classification whose copy declares no welcome, and for none', () => {
    expect(getModelGreeting('internal', t)).toBeNull();
    expect(getModelGreeting('', t)).toBeNull();
  });
});
