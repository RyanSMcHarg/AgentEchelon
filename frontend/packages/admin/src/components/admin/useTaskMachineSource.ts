import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClassificationCatalog, ProfileDefinitionBody, ProfileDraftPatch } from '../../services/profileService';
import { DEFAULT_TASK_STATE_MACHINES, isPlatformMachineKey, type TaskStateMachine } from '../../../../../../backend/lambda/src/lib/task-state-machines.ts';
import { packWithMachine } from './machineEdits';
import type { TaskMachineSource } from './WorkflowBuilder';

/**
 * THE MACHINES A DRAFT'S TASK STEPS OPEN, AS THE WORKFLOW BUILDER EDITS THEM (ADR-067 stage 4): the version's own machine,
 * else the classification's or the shipped one as the starting point it copies in on its first edit, never a platform
 * machine, which no version edits. Each edit patches the draft's pack with the machine (`packWithMachine`), keeping the
 * rest of the pack, as an edit from the Workflows list does.
 */
/** The participant roles the classification's catalog declares, which a step's update can address. */
export function declaredParticipantRoles(catalog: ClassificationCatalog | undefined): readonly string[] {
  return catalog?.variables?.sources.find((s) => s.source === 'participant:role')?.values ?? [];
}

export function useTaskMachineSource(
  config: ProfileDefinitionBody | null,
  catalog: ClassificationCatalog | undefined,
  onPatch: (patch: ProfileDraftPatch) => void,
): TaskMachineSource {
  const initial = ((config?.intentPack as { machines?: Record<string, TaskStateMachine> } | undefined)?.machines) ?? {};
  const [own, setOwn] = useState<Record<string, TaskStateMachine>>(initial);
  const ownRef = useRef(own);
  ownRef.current = own;
  // THE MACHINES FOLLOW THE DRAFT: a reload, a discard, a save or another assistant's draft brings its own pack, so an edit
  // never writes a machine the draft no longer has.
  useEffect(() => { setOwn(initial); }, [config?.intentPack]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo<TaskMachineSource>(() => ({
    of: (key) => {
      if (isPlatformMachineKey(key)) return undefined;
      return own[key] ?? catalog?.storedPack?.machines?.[key] ?? (DEFAULT_TASK_STATE_MACHINES as Record<string, TaskStateMachine>)[key];
    },
    onChange: (key, next) => {
      if (isPlatformMachineKey(key)) return;
      const machines = { ...ownRef.current, [key]: next };
      setOwn(machines);
      const pack = { ...((config?.intentPack ?? {}) as Record<string, unknown>), machines: ownRef.current } as Parameters<typeof packWithMachine>[0];
      onPatch({ intentPack: packWithMachine(pack, key, next, catalog?.storedPack) as ProfileDraftPatch['intentPack'] });
    },
    emailConfigured: catalog?.emailConfigured,
    participantRoles: declaredParticipantRoles(catalog),
  }), [own, catalog, config, onPatch]);
}
