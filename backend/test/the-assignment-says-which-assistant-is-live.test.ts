/**
 * The assignment record (DESIGN-SEPARATE-ASSISTANTS section 3.0).
 *
 * `(classification, role, occupancy)` names the assistant occupying a slot and the bot it answers
 * as. It is the authority for "which assistant is live", and the thing a reader resolves through
 * instead of building an SSM key out of a classification.
 *
 * ITS READER IS ON THE TURN PATH. `primaryAssistantOf` (`lib/conversation-primary.ts`) resolves a room's
 * primary through these records (`liveAssistantsByHandle` in `lib/default-agents.ts`) rather than building a
 * key out of the classification, so every ordinary turn depends on their shape. The record was published a deploy
 * ahead of that reader, so the authority existed and was inspectable before anything trusted it.
 */
import { INSTANCE_SSM, ASSISTANT_ROLES } from '../lib/stacks/agent-classification-common';
import { defaultProfileRegistry } from '../lib/profile-registry';
import * as fs from 'fs';
import * as path from 'path';

describe('the assignment says which assistant is live', () => {
  it('keys on classification, role and occupancy, under its own prefix', () => {
    const key = INSTANCE_SSM.assistantAssignment('premium', 'primary', 'live');

    expect(key).toMatch(/\/assistant-assignments\/premium\/primary\/live$/);
    // A DISTINCT PREFIX FROM `/assistant/{name}/...`, which is the per-assistant namespace. The
    // assignment is about which assistant occupies a slot; the other is about one assistant's own
    // facts, and conflating them is how the classification came to stand in for the assistant.
    expect(key).not.toContain('/assistant/');
  });

  it('gives every (role, occupancy) pair its own key, so two stacks never write one parameter', () => {
    // The classification stack owns the live entry and the battle stack owns the alt. A single
    // roster JSON would make them race to own it.
    const keys = new Set<string>();
    // The challenger in a role (`alt`) is written by the battle stack, the role's own assistant by
    // the classification stack.
    const kinds = ['live', 'alt'];
    for (const role of ASSISTANT_ROLES) {
      for (const kind of kinds) keys.add(INSTANCE_SSM.assistantAssignment('premium', role, kind));
    }
    expect(keys.size).toBe(ASSISTANT_ROLES.length * kinds.length);
  });

  it('is read under the SAME prefix the CDK helper writes, by the assignment reader every room primary goes through', () => {
    // The Lambda side cannot import `INSTANCE_SSM` (it lives in the CDK layer), so the prefix is written
    // twice; the two drifting apart would publish the records at one path and read them at another.
    const source = fs.readFileSync(path.join(__dirname, '..', 'lambda', 'src', 'lib', 'default-agents.ts'), 'utf8');
    expect(source).toContain('Path: `${SSM_ROOT}/assistant-assignments/${classification}`');
    expect(INSTANCE_SSM.assistantAssignment('premium', 'primary', 'alt'))
      .toEqual('/agent-echelon/assistant-assignments/premium/primary/alt');
    // And the room primary falls back to the PRIMARY role's live occupant.
    const resolver = fs.readFileSync(path.join(__dirname, '..', 'lambda', 'src', 'lib', 'conversation-primary.ts'), 'utf8');
    expect(resolver).toContain("export const PRIMARY_ROLE = 'primary';");
    expect(source).toContain("if (parsed.occupancy !== 'live') continue;");
  });

  it('names the ASSISTANT, and the name is the one the write path already keys on', () => {
    // `AssistantProfile.name` is defined as the `/assistant/{name}` segment, so the record and the
    // profile store agree by construction rather than by both happening to use the classification.
    //
    // NO CLASSIFICATION IS ALSO A PROFILE NAME, which is the rule `validateProfilesConfig` enforces
    // and the reason this assertion is worth making here too: the record's `assistant` field is only
    // meaningful while the two namespaces are distinguishable. An earlier version of this test
    // asserted that `premium` served a profile called `premium` - it passed, and it was pinning the
    // coincidence that let a classification stand in for an assistant everywhere.
    const classifications = defaultProfileRegistry.classificationValues();
    for (const c of classifications) {
      expect(classifications).not.toContain(defaultProfileRegistry.requireProfileFor(c).name);
    }
  });
});
