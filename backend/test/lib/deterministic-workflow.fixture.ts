/**
 * A FULLY DETERMINISTIC WORKFLOW, as a manager would declare it (SPEC-TASK-STATE-TRANSITIONS FR28, FR29;
 * SPEC-DOCUMENT-TEMPLATES FR9). A test fixture, not shipped in the demo pack.
 *
 * The model's one job is the requirements step: put the trip to the person and record each need with its
 * source. From there the platform runs everything the workflow declares, with no model call: entering
 * `searching` runs the travel search with the recorded needs as its arguments, its outcome takes
 * `onSuccess` or `onFailure`, entering `quoting` declares the platform-filled quote (whose fields read
 * the search's recorded result) as the document, and its outcome closes the task.
 */
import type { TaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import { parseTemplate, type TurnTemplates } from '../../lambda/src/lib/document-template';

export const TRAVEL_QUOTE: TaskStateMachine = {
  initial: 'collecting',
  states: {
    collecting: {
      transitions: ['searching'],
      awaits: { party: 'requester' },
      requires: ['origin', 'destination', 'departure date'],
      // The requirements step reads nothing and writes nothing: only the task tools.
      tools: [],
      prompt: 'Ask for the origin, the destination and the departure date, then record them.',
    },
    searching: {
      transitions: ['quoting', 'failed'],
      action: {
        tool: 'search_corporate_travel',
        args: {
          origin: 'requirement:origin',
          destination: 'requirement:destination',
          departDate: 'requirement:departure date',
          cabin: 'literal:economy',
        },
      },
      onSuccess: 'quoting',
      onFailure: 'failed',
    },
    quoting: {
      transitions: ['completed', 'failed'],
      produces: 'document' as const,
      template: 'travel-quote',
      action: { tool: 'deliver_document' },
      onSuccess: 'completed',
      onFailure: 'failed',
    },
    completed: { transitions: [], terminal: 'success' },
    failed: { transitions: [], terminal: 'failure' },
  },
};

export const TRAVEL_QUOTE_TEMPLATE_SOURCE = `---
${JSON.stringify({
  name: 'travel-quote',
  description: 'A policy-checked travel quote, filled from the search the workflow ran.',
  fill: 'platform',
  fields: {
    origin: 'requirement:origin',
    destination: 'requirement:destination',
    date: 'requirement:departure date',
    flight: 'tool:searching.options.0.summary',
    price: 'tool:searching.options.0.priceUsd',
    policy: 'tool:searching.policyNote',
    portal: 'tool:searching.portalUrl',
  },
})}
---
# Travel quote

## Trip

| From | To | Departing |
|---|---|---|
| {{origin}} | {{destination}} | {{date}} |

## Best option

{{flight}}, {{price}} USD.

## Policy

{{policy}}

Book in the travel portal: {{portal}}
`;

export const TRAVEL_QUOTE_TEMPLATES: TurnTemplates = {
  'travel-quote': { name: 'travel-quote', contentHash: 'a'.repeat(64), template: parseTemplate(TRAVEL_QUOTE_TEMPLATE_SOURCE) },
};

/** The requirements as the model records them on leaving `collecting`. */
export const TRAVEL_QUOTE_COLLECTED = [
  { need: 'origin', value: 'SEA', source: 'message', evidence: 'from Seattle' },
  { need: 'destination', value: 'JFK', source: 'message', evidence: 'to New York' },
  { need: 'departure date', value: '2026-11-03', source: 'message', evidence: 'on November 3rd' },
];
