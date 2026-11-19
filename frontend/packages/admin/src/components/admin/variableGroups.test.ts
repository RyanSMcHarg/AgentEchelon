import { describe, expect, it } from 'vitest';
import { buildSourceTable, publishedVariables, type PublishedVariables } from '../../../../../../backend/lambda/src/lib/variables.ts';
import en from '../../../../shared/src/locales/en.json';
import { contextSourceGroups, definitionKey, platformGroups } from './variableGroups';

const copyAt = (key: string): unknown => key.split('.').reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], en);

const published = (): PublishedVariables => publishedVariables(buildSourceTable({ catalog: [], facts: ['company'] }));

describe('the variables page groups', () => {
  it('defines every value the platform publishes', () => {
    const undefinedSources = platformGroups(published()).flatMap((g) => g.rows).filter((r) => typeof copyAt(definitionKey(r.source).key) !== 'string');
    expect(undefinedSources.map((r) => r.source)).toEqual([]);
  });

  it('lists what started a conversation apart from the conversation', () => {
    const groups = Object.fromEntries(platformGroups(published()).map((g) => [g.id, g.rows.map((r) => r.source)]));
    expect(groups.origin).toContain('conversation:eventSummary');
    expect(groups.conversation).toContain('conversation:topic');
    expect(groups.conversation).not.toContain('conversation:eventSummary');
  });

  it('lists an onboarding answer with the person who gave it', () => {
    const person = platformGroups(published()).find((g) => g.id === 'person');
    expect(person?.rows.map((r) => r.source)).toContain('fact:company');
  });

  it('groups a context source field under its source, in the catalog order', () => {
    const row = (source: string) => ({ source, type: 'string', trust: 'operator', describesPerson: false, availability: 'always', insertAs: 'text', origin: '', mayDecide: true }) as PublishedVariables['sources'][number];
    const groups = contextSourceGroups(
      { sources: [row('ctx:company-docs.digest'), row('ctx:user-profile.company')] },
      [{ key: 'user-profile', title: 'About this person' }, { key: 'company-docs', title: 'Company knowledge', description: 'The document menu' }],
    );
    expect(groups.map((g) => [g.key, g.title, g.rows.length])).toEqual([['user-profile', 'About this person', 1], ['company-docs', 'Company knowledge', 1]]);
    expect(groups[1].description).toBe('The document menu');
  });
});
