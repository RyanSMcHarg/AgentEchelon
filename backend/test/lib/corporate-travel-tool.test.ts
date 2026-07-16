/**
 * Mock corporate-travel API tool (executed Converse tool, worked example for the
 * generic action_item flow). Pure-function tests: deterministic options, policy
 * flagging, booking deep-links, and the env gate.
 */

import {
  searchCorporateTravel,
  isTravelToolEnabled,
  CORPORATE_TRAVEL_TOOL_SPEC,
  type TravelSearchArgs,
} from '../../lambda/src/lib/corporate-travel-tool';

const BASE: TravelSearchArgs = {
  origin: 'SEA',
  destination: 'JFK',
  departDate: '2026-08-10',
  returnDate: '2026-08-13',
  cabin: 'economy',
};

describe('searchCorporateTravel (mock)', () => {
  it('is deterministic for identical inputs', () => {
    expect(searchCorporateTravel(BASE)).toEqual(searchCorporateTravel(BASE));
  });

  it('returns flight + hotel options with booking deep-links into the portal', () => {
    const res = searchCorporateTravel(BASE);
    expect(res.options.length).toBeGreaterThanOrEqual(2);
    expect(res.options.some((o) => o.type === 'flight')).toBe(true);
    expect(res.options.some((o) => o.type === 'hotel')).toBe(true);
    for (const o of res.options) {
      expect(o.bookingUrl).toContain('/book?');
      expect(o.bookingUrl).toContain('from=SEA');
      expect(o.bookingUrl).toContain('to=JFK');
      expect(o.priceUsd).toBeGreaterThan(0);
    }
    expect(res.portalUrl).toContain('/trips');
  });

  it('defaults travelers to 1 and floors fractional counts', () => {
    expect(searchCorporateTravel({ ...BASE, travelers: undefined }).query.travelers).toBe(1);
    expect(searchCorporateTravel({ ...BASE, travelers: 2.9 }).query.travelers).toBe(2);
  });

  it('flags over-cap business fares as out of policy and notes pre-approval', () => {
    const res = searchCorporateTravel({ ...BASE, cabin: 'business' });
    const flights = res.options.filter((o) => o.type === 'flight');
    expect(flights.some((o) => !o.inPolicy)).toBe(true);
    expect(res.policyNote).toMatch(/pre-approval/i);
  });

  it('keeps in-policy economy fares marked in policy', () => {
    const res = searchCorporateTravel(BASE);
    const flights = res.options.filter((o) => o.type === 'flight');
    expect(flights.some((o) => o.inPolicy)).toBe(true);
    expect(res.policyNote).toMatch(/within company travel policy|pre-approval/i);
  });

  it('scales price with traveler count', () => {
    const one = searchCorporateTravel({ ...BASE, travelers: 1 });
    const two = searchCorporateTravel({ ...BASE, travelers: 2 });
    const oneFlight = one.options.find((o) => o.id === 'FL-NONSTOP')!;
    const twoFlight = two.options.find((o) => o.id === 'FL-NONSTOP')!;
    expect(twoFlight.priceUsd).toBe(oneFlight.priceUsd * 2);
  });

  it('exposes a well-formed Converse toolSpec', () => {
    expect(CORPORATE_TRAVEL_TOOL_SPEC.toolSpec.name).toBe('search_corporate_travel');
    expect(CORPORATE_TRAVEL_TOOL_SPEC.toolSpec.inputSchema.json.required).toEqual(
      expect.arrayContaining(['origin', 'destination', 'departDate']),
    );
  });
});

describe('isTravelToolEnabled', () => {
  const prev = process.env.ENABLE_TRAVEL_TOOL;
  afterEach(() => {
    if (prev === undefined) delete process.env.ENABLE_TRAVEL_TOOL;
    else process.env.ENABLE_TRAVEL_TOOL = prev;
  });

  it('is off unless explicitly enabled', () => {
    delete process.env.ENABLE_TRAVEL_TOOL;
    expect(isTravelToolEnabled()).toBe(false);
    process.env.ENABLE_TRAVEL_TOOL = 'false';
    expect(isTravelToolEnabled()).toBe(false);
    process.env.ENABLE_TRAVEL_TOOL = 'true';
    expect(isTravelToolEnabled()).toBe(true);
  });
});
