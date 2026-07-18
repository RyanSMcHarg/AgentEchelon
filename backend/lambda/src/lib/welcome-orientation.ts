/**
 * Welcome orientation - the copy the assistant opens a new conversation with.
 *
 * CONFIG-DRIVEN by design: the PLATFORM ships a generic, classification-neutral welcome, and a DEPLOYMENT
 * (e.g. the Stratum demo) supplies company-specific orientation via SSM (`ASSISTANT_WELCOME_PARAM`)
 * with NO code change - which is itself a worked customization example. Absent config ⇒ the generic
 * welcome (byte-for-byte the historical greeting, so un-configured deployments are unaffected).
 *
 * The orientation lets a deployment tell a first-time user WHO they are and WHAT they can do:
 * the company, the signed-in user's access level, a few grounded example prompts, and (optionally)
 * a pointer to learn about / customize the platform itself.
 */

export interface WelcomeOrientation {
  /** Company/organization name, e.g. "Stratum Technologies". */
  companyName?: string;
  /** One clause about the company, e.g. "an enterprise SaaS company (workflow automation, ~280 people, Austin)". */
  companyBlurb?: string;
  /** One line about the signed-in user's access, e.g. "You have standard access - internal company info (directory, processes, roadmap)." */
  accessBlurb?: string;
  /** 2–4 grounded example prompts to try (rendered as bullets). */
  examples?: string[];
  /** Optional closing note, e.g. a pointer to learn about / customize the platform. */
  platformNote?: string;
}

const MAX_EXAMPLES = 4;

/** Parse the orientation JSON from the SSM param. Tolerant: returns null on empty/invalid so the
 *  caller falls back to the generic welcome. Only string fields and a string[] `examples` are kept. */
export function parseWelcomeOrientation(raw: string | null | undefined): WelcomeOrientation | null {
  if (!raw || !raw.trim()) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
  const examples = Array.isArray(r.examples)
    ? r.examples.filter((e): e is string => typeof e === 'string' && e.trim().length > 0).map((e) => e.trim()).slice(0, MAX_EXAMPLES)
    : undefined;
  const out: WelcomeOrientation = {
    ...(str(r.companyName) ? { companyName: str(r.companyName) } : {}),
    ...(str(r.companyBlurb) ? { companyBlurb: str(r.companyBlurb) } : {}),
    ...(str(r.accessBlurb) ? { accessBlurb: str(r.accessBlurb) } : {}),
    ...(examples && examples.length ? { examples } : {}),
    ...(str(r.platformNote) ? { platformNote: str(r.platformNote) } : {}),
  };
  // Only meaningful if it carries at least one orientation signal.
  return out.companyName || out.companyBlurb || out.accessBlurb || out.examples || out.platformNote ? out : null;
}

/** True when an orientation carries enough to render the richer welcome. */
function hasOrientation(o?: WelcomeOrientation | null): o is WelcomeOrientation {
  return Boolean(o && (o.companyName || o.companyBlurb || (o.examples && o.examples.length)));
}

/**
 * Compose the WelcomeIntent reply. Handles the drift-redirect / topic short-circuits (unchanged), then
 * either the deployment-configured orientation (company + access + examples + platform note) or the
 * generic platform welcome. Static-shaped (no model call) so the welcome stays instant and predictable.
 */
export function composeWelcomeMessage(args: {
  orientation?: WelcomeOrientation | null;
  triggerContext?: string;
  topic?: string;
}): string {
  const { orientation, triggerContext, topic } = args;
  // The welcome is intentionally NOT name-personalized. The Chime WelcomeIntent fires on the bot's
  // membership at channel creation, before the user's membership/metadata are reliably readable, so a
  // name here races and is often wrong or missing. The assistant greets the user by name on their
  // FIRST real turn instead (see the async processor's first-turn greeting).
  const greeting = 'Hi';

  // Drift-redirect / explicit trigger: name what brought us here so the user doesn't retype it.
  if (triggerContext && triggerContext.trim().length > 0) {
    const cleaned = triggerContext.trim().slice(0, 240);
    return `${greeting} - continuing from your earlier message: "${cleaned}". I'll pick up the thread; what would you like to dig into first?`;
  }
  // Caller-provided topic (create-conversation path): ground the welcome in it.
  if (topic && topic.trim().length > 0) {
    const cleaned = topic.trim().slice(0, 200);
    return `${greeting} - I can help with ${cleaned}. Where would you like to start?`;
  }

  // No deployment orientation ⇒ the generic platform welcome (unchanged from the historical greeting).
  if (!hasOrientation(orientation)) {
    return `${greeting} - I'm your assistant for this conversation. I can answer questions, draft documents, analyse data, help with code, or work through a plan with you. What would you like to start with?`;
  }

  const company = orientation.companyName || 'your organization';
  const blurb = orientation.companyBlurb ? `, ${orientation.companyBlurb}` : '';
  const lines: string[] = [`${greeting} - I'm your assistant at ${company}${blurb}.`];
  if (orientation.accessBlurb) {
    lines.push('', orientation.accessBlurb);
  }
  if (orientation.examples && orientation.examples.length) {
    lines.push('', 'A few things you can try:');
    for (const e of orientation.examples) lines.push(`- ${e}`);
  }
  if (orientation.platformNote) {
    lines.push('', orientation.platformNote);
  }
  return lines.join('\n');
}
