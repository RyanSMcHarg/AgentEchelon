/**
 * EVERY CLIENT EVENT THE FRONTEND SENDS IS ONE THE SERVER ACCEPTS.
 *
 * `client-events.ts` rejects a type not in `VALID_EVENT_TYPES` (`lambda/src/lib/client-event-types.ts`) as
 * `unknown_event_type`, and the record is never written. The frontend's `trackEvent` takes any string, so
 * TypeScript compares nothing: the admin console sent `admin_conversation_deleted` for a deletion, the server
 * refused it, and deletion telemetry was never recorded. So the lists are compared here: the frontend's
 * declared `EventName` union with the server's list, and every literal `trackEvent('...')` call in the
 * frontend with the server's list.
 */
import * as fs from 'fs';
import * as path from 'path';
import { VALID_EVENT_TYPES } from '../lambda/src/lib/client-event-types';

const FRONTEND = path.resolve(__dirname, '..', '..', 'frontend', 'packages');
const SERVICE = path.join(FRONTEND, 'shared', 'src', 'services', 'eventTrackingService.ts');
const accepted = new Set<string>(VALID_EVENT_TYPES);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('every client event is accepted', () => {
  it('declares in the frontend exactly the event types the server accepts', () => {
    const src = fs.readFileSync(SERVICE, 'utf8');
    const union = src.slice(src.indexOf('type EventName ='), src.indexOf(';', src.indexOf('type EventName =')));
    const declared = [...union.matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(10);
    expect([...declared].sort()).toEqual([...accepted].sort());
  });

  it('sends only accepted types from every literal trackEvent call', () => {
    const sent = new Map<string, string>();
    for (const file of sources(FRONTEND)) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/\btrackEvent\(\s*'([a-zA-Z0-9_]+)'/g)) {
        sent.set(m[1], path.relative(FRONTEND, file));
      }
    }
    expect(sent.size).toBeGreaterThan(3);
    const refused = [...sent].filter(([type]) => !accepted.has(type)).map(([type, file]) => `${type} (${file})`);
    expect(refused).toEqual([]);
  });
});
