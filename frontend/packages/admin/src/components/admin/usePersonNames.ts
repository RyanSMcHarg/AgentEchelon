import { useEffect, useState } from 'react';
import { useCan } from '../../capabilities';
import { listPeople, namesByPersonId, userManagementUrl } from '../../services/peopleService';

/**
 * THE NAMES OF THE PEOPLE A SURFACE HOLDS ONLY BY ID. The names come from the console's list of people
 * (`GET /users`, user-management.ts), whose names are the directory's (`displayNameFor`) and are given
 * only to a caller who may be told who a person is. So they are asked for only by a role holding both
 * `view-users` and `see-user-identity`; anyone else, and any person the list does not name, sees the id.
 */
export function usePersonNames(logAs: string): Map<string, string> {
  const can = useCan();
  const mayName = can('view-users') && can('see-user-identity');
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!mayName || !userManagementUrl()) return;
    let live = true;
    listPeople()
      .then((list) => { if (live) setNames(namesByPersonId(list.users)); })
      .catch((err) => console.warn(`[${logAs}] the people could not be named; their ids are shown`, (err as Error)?.message));
    return () => { live = false; };
  }, [mayName, logAs]);
  return names;
}
