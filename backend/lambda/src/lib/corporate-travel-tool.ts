/**
 * Mock "corporate travel API" tool — a worked example of an EXECUTED Converse tool
 * (the same pattern as `load_company_context`: the in-Lambda loop calls it and feeds
 * the result back to the model, unlike the propose-and-confirm work-item tools).
 *
 * Purpose: ground the GENERIC `action_item` task lifecycle (gather → present options →
 * awaiting_completion → completed) with a concrete, demoable capability. The assistant
 * gathers trip details, CALLS this tool, gets back policy-checked options + a booking
 * deep-link, and presents them; the user completes the booking on the (mock) corporate
 * travel portal off-platform, exactly like the action_item flow describes.
 *
 * This is a MOCK: it returns deterministic, plausible options and a portal deep-link. It
 * makes NO network call — swap `searchCorporateTravel` for a real Concur / TravelPerk /
 * Navan client to make it live. The platform stays domain-neutral: the tool is OFF unless
 * a deployment sets `ENABLE_TRAVEL_TOOL=true` (see `isTravelToolEnabled`), and its intent
 * (`book_travel`) is supplied by a deployment's intent pack, not baked into the platform.
 */

/** Base URL of the (mock) corporate travel booking portal the deep-links point at. */
const TRAVEL_PORTAL_BASE =
  process.env.CORPORATE_TRAVEL_PORTAL_URL || 'https://travel.corp.example';

/** Read at call time (like CONTEXT_BUCKET) so the env is always current and testable. */
export function isTravelToolEnabled(): boolean {
  return process.env.ENABLE_TRAVEL_TOOL === 'true';
}

/** Converse toolSpec — same shape as the entries in the other TOOL_CONFIG blocks. */
export const CORPORATE_TRAVEL_TOOL_SPEC = {
  toolSpec: {
    name: 'search_corporate_travel',
    description:
      'Search the corporate travel booking system for policy-compliant flight and hotel ' +
      'options for a business trip. Call this once you have the origin, destination, and ' +
      'travel dates. Returns bookable options with an in-policy flag, price, and a deep-link ' +
      'to complete the booking in the corporate travel portal. Does NOT book anything itself ' +
      '— the traveler confirms and pays in the portal.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          origin: { type: 'string', description: 'Departure city or airport (e.g. "SEA" or "Seattle").' },
          destination: { type: 'string', description: 'Arrival city or airport (e.g. "JFK" or "New York").' },
          departDate: { type: 'string', description: 'Outbound date, YYYY-MM-DD.' },
          returnDate: { type: 'string', description: 'Return date, YYYY-MM-DD. Omit for one-way.' },
          cabin: { type: 'string', enum: ['economy', 'premium_economy', 'business'], description: 'Requested cabin; policy may cap it.' },
          travelers: { type: 'number', description: 'Number of travelers (default 1).' },
        },
        required: ['origin', 'destination', 'departDate'],
      },
    },
  },
} as const;

export interface TravelSearchArgs {
  origin: string;
  destination: string;
  departDate: string;
  returnDate?: string;
  cabin?: 'economy' | 'premium_economy' | 'business';
  travelers?: number;
}

export interface TravelOption {
  id: string;
  type: 'flight' | 'hotel';
  summary: string;
  priceUsd: number;
  inPolicy: boolean;
  bookingUrl: string;
}

export interface TravelSearchResult {
  query: TravelSearchArgs & { travelers: number };
  options: TravelOption[];
  policyNote: string;
  portalUrl: string;
}

/** Company travel policy cap (mock): coach domestic; business allowed only if pre-approved. */
const POLICY_CABIN_CAP_USD = 1200;

/**
 * Deterministic pseudo-variation from a string so different routes yield different-but-stable
 * prices (no Date.now/Math.random — stable across runs and unit-testable).
 */
function seedFrom(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function money(base: number, seed: number, spread: number): number {
  return base + (seed % spread);
}

function encode(v: string | number): string {
  return encodeURIComponent(String(v));
}

/**
 * Mock corporate-travel search. Returns a small, policy-checked option set + a portal
 * deep-link. Deterministic in its inputs.
 */
export function searchCorporateTravel(rawArgs: TravelSearchArgs): TravelSearchResult {
  const args = {
    ...rawArgs,
    travelers: rawArgs.travelers && rawArgs.travelers > 0 ? Math.floor(rawArgs.travelers) : 1,
  };
  const route = `${args.origin}->${args.destination}`.toUpperCase();
  const seed = seedFrom(route + (args.departDate || ''));
  const roundTrip = Boolean(args.returnDate);
  const cabin = args.cabin || 'economy';

  const link = (kind: string, id: string) => {
    const q = [
      `type=${encode(kind)}`,
      `option=${encode(id)}`,
      `from=${encode(args.origin)}`,
      `to=${encode(args.destination)}`,
      `depart=${encode(args.departDate)}`,
      ...(args.returnDate ? [`return=${encode(args.returnDate)}`] : []),
      `pax=${encode(args.travelers)}`,
    ].join('&');
    return `${TRAVEL_PORTAL_BASE}/book?${q}`;
  };

  const flightBase = (roundTrip ? 420 : 240) + (cabin === 'business' ? 900 : cabin === 'premium_economy' ? 260 : 0);
  const nonstopPrice = money(flightBase, seed, 180) * args.travelers;
  const oneStopPrice = money(Math.round(flightBase * 0.8), seed >> 3, 140) * args.travelers;
  const hotelPrice = money(180, seed >> 5, 120);

  const options: TravelOption[] = [
    {
      id: 'FL-NONSTOP',
      type: 'flight',
      summary: `Nonstop ${route} (${cabin.replace('_', ' ')}${roundTrip ? ', round-trip' : ', one-way'})`,
      priceUsd: nonstopPrice,
      inPolicy: nonstopPrice <= POLICY_CABIN_CAP_USD * args.travelers,
      bookingUrl: link('flight', 'FL-NONSTOP'),
    },
    {
      id: 'FL-1STOP',
      type: 'flight',
      summary: `1-stop ${route} (${cabin.replace('_', ' ')}${roundTrip ? ', round-trip' : ', one-way'}) — lower fare`,
      priceUsd: oneStopPrice,
      inPolicy: oneStopPrice <= POLICY_CABIN_CAP_USD * args.travelers,
      bookingUrl: link('flight', 'FL-1STOP'),
    },
    {
      id: 'HT-PREFERRED',
      type: 'hotel',
      summary: `Preferred-rate hotel near ${args.destination} (per night)`,
      priceUsd: hotelPrice,
      inPolicy: true,
      bookingUrl: link('hotel', 'HT-PREFERRED'),
    },
  ];

  const anyOverCap = options.some((o) => o.type === 'flight' && !o.inPolicy);
  const policyNote = anyOverCap
    ? `Company policy caps flights at $${POLICY_CABIN_CAP_USD}/traveler; over-cap options are flagged and need manager pre-approval in the portal.`
    : 'All options are within company travel policy.';

  return { query: args, options, policyNote, portalUrl: `${TRAVEL_PORTAL_BASE}/trips` };
}
