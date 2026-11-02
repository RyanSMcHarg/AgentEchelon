/**
 * WHAT THE PROFILES TAB SAYS WHEN A VERSION CARRIES NO PERSONA, and it used to say something false.
 *
 * It read "inherits the deployment persona". There is no deployment-wide persona to inherit. Only a
 * classification deployed with `systemPromptParam` gets an `assistant-system-prompt` parameter - standard
 * alone in the shipped topology - and for every other assistant the fall-through lands on
 * `defaultPersonaFor`, the prompt compiled into the async processor, which describes the platform and the
 * tier rather than the deployment.
 *
 * THE OPS ASSISTANT IS WHERE THAT COST SOMETHING. `ops-premium` runs on premium's processor, premium is
 * `systemPromptParam: false`, and it had no persona of its own - so the console reported an inheritance
 * that did not exist while the assistant answered in the built-in premium-tier voice.
 *
 * WHY A TEST RATHER THAN A CAREFUL EDIT. The copy describes a three-step resolution chain that lives in
 * two other files, and the reason the old line survived is that nothing connected the sentence to the
 * code. These assert both halves: the chain is still the chain, and the sentence still names it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { requireTopology } from '../lib/config/profiles';

const CONSOLE_TAB = path.join(__dirname, '../../frontend/packages/admin/src/components/admin/ProfilesTab.tsx');
const PROCESSOR = path.join(__dirname, '../lambda/src/assistant-async-processor.ts');
const PROFILE_STACK = path.join(__dirname, '../lib/stacks/assistant-profile-stack.ts');


const read = (p: string) => fs.readFileSync(p, 'utf8');

/**
 * The console's copy lives in the shared locale file, not in the component. A test that greps the
 * component for a sentence now finds its import block - so copy assertions read HERE, and only the
 * assertions about CODE keep reading the source.
 */
const consoleCopy = (): string => {
  const raw = fs.readFileSync(
    path.join(__dirname, '../../frontend/packages/shared/src/locales/en.json'),
    'utf8',
  );
  return JSON.stringify(JSON.parse(raw).admin);
};


describe('the resolution chain the copy describes', () => {
  it('prefers the version persona, then the deployment seam, then the built-in prompt', () => {
    const src = read(PROCESSOR);
    // Step 1 -> 2: the version's persona, falling back to the seam.
    // The seam is the PRIMARY's: a second assistant with no version persona gets the built-in default
    // rather than inheriting the primary's (ADR-054), so step 2 is gated on the assistant.
    expect(src).toMatch(/const baseSystemPrompt = versionedPersona\?\.trim\(\)\s*\|\| \(isPrimaryAssistant \? await resolveBaseSystemPrompt\(\) : defaultPersonaFor\(CLASSIFICATION\)\)/);
    // Step 2 -> 3: the seam is the SSM parameter, then the inline env, then the compiled default.
    expect(src).toMatch(/ASSISTANT_SYSTEM_PROMPT_PARAM/);
    expect(src).toMatch(/process\.env\.ASSISTANT_SYSTEM_PROMPT\?\.trim\(\) \|\| defaultPersonaFor\(CLASSIFICATION\)/);
  });

  it('gives the seam to `systemPromptParam` classifications only, which is why step 2 is conditional', () => {
    // The whole reason "inherits the deployment persona" was false: the parameter and the env that reads
    // it are both created inside `if (topo.systemPromptParam)`, and premium does not set it.
    expect(read(PROFILE_STACK)).toMatch(/if \(topo\.systemPromptParam\) \{[\s\S]{0,400}?ASSISTANT_SYSTEM_PROMPT_PARAM/);
    // Each classification's topology is registry data, read by the stack that builds it.
    expect(requireTopology('standard').systemPromptParam).toBe(true);
    expect(requireTopology('premium').systemPromptParam).toBe(false);
  });
});

describe('the console copy for an absent persona', () => {
  const src = read(CONSOLE_TAB);

  it('no longer claims a deployment persona is inherited', () => {
    expect(src).not.toContain('inherits the deployment persona');
    expect(src).not.toContain("this deployment's persona");
  });

  it('names the conditional parameter and the built-in prompt it lands on otherwise', () => {
    // Both halves, because a message naming only the parameter is the old claim with extra words, and one
    // naming only the built-in prompt is wrong for standard.
    expect(consoleCopy()).toContain('assistant-system-prompt');
    expect(consoleCopy()).toMatch(/prompt built into its processor/);
  });
});
