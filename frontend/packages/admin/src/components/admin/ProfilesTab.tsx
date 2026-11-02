import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import AssistantsList, { assistantRows } from './AssistantsList';
import AssistantOwnerControl from './AssistantOwnerControl';
import CreateAssistantFlow from './CreateAssistantFlow';
import { InfoTooltip } from './AdminHelp';
import { useCan, useConsoleAccess, useReissueSession } from '../../capabilities';
import {
  listProfilesAndTools,
  listOwnedProfiles,
  createProfileVersion,
  editProfileDraft,
  validateProfileDraft,
  activateProfileDraft,
  discardProfileDraft,
  rollbackProfile,
  exportProfile,
  type ProfileListing,
  type ProfileDefinitionBody,
  type ProfileManifestTyped,
  type ToolDescriptor,
  type RuntimeAssistant,
  type RosterTarget,
  type ProfileVersionSummary,
  type GoldenFailure,
  activatePastGoldenGate,
  type PastGateConfirmation,
  type IdentityRenameOutcome,
} from '../../services/profileService';
import { listTeamRoster } from '../../services/rosterService';
import { listOwnership } from '../../services/ownershipService';
import { VersionProvenance, CandidateNotActivatable, canActivateVersion } from './ProfileVersionProvenance';
import type { PastGateOutcome } from './GoldenRunPanel';

/** The server's refusals of an activation past the gate, which the golden panel words; anything else is an error. */
const PAST_GATE_REFUSALS = new Set(['GATE_CHANGED', 'GATE_NOT_REFUSING', 'REASON_REQUIRED', 'CONFIRMATION_REQUIRED', 'ADMIN_REQUIRED', 'NO_DRAFT']);
import AssistantInfrastructure from './AssistantInfrastructure';
import ImportVersion from './ImportVersion';
import { LimitsGroup } from './AssistantConfigFields';
import { type AreaContext, type DraftValidation } from './DraftControls';
import AssistantPage from './AssistantPage';
import { unsavedAreas, type Unsaved } from './unsavedAreas';
import type { DraftArea } from './draftAreas';
import type { AssistantLink } from './assistantLinks';
import type { ClassificationCatalog, FieldDecision, ProfileDraftPatch } from '../../services/profileService';

/**
 * THE ASSISTANTS TAB: one list of every assistant, a creation wizard, and each assistant's page
 * (SPEC-ADMIN-CONSOLE "Assistants", SPEC-PORTABLE-PROFILES).
 *
 * Creating runs as one wizard: `CreateAssistantFlow` makes the assistant, and once a load shows its draft the wizard
 * continues on that draft in the assistant's page itself (`AssistantPage` with `wizard`), its sections as steps. After
 * that, the page shows the active version or the draft, chosen by one toggle in its header, one section at a time; the
 * draft is edited in place in the same sections, and Discard, Validate and Activate sit on the draft's banner.
 *
 * This tab owns the reads and writes: the listing and catalogs, the active and draft bodies, each area's unsaved edit,
 * saving an area, Validate, Activate, Discard, export and import. Leaving the assistant with an unsaved edit asks first.
 * Every control renders only for a session holding its capability, and every route enforces the same rule server-side (A14).
 */
interface ProfilesTabProps {
  registerBack?: (close: (() => void) | null) => void;
  /** Open Effectiveness or Conversations narrowed to this assistant (and a version or an intent), from its page's links. */
  onOpenLink?: (link: AssistantLink) => void;
  /**
   * The assistant to open on mount: the one whose analytics were just viewed, so Back from them lands on that
   * assistant rather than the list. The tab is unmounted while another tab shows, which is why it is handed back.
   */
  initialAssistant?: string | null;
}

const ProfilesTab: React.FC<ProfilesTabProps> = ({ registerBack, onOpenLink, initialAssistant }) => {
  const { t: translate } = useTranslation();
  // Each control renders only for a role holding its capability (SPEC-ADMIN-CONSOLE FR0f, FR36).
  const can = useCan();
  const access = useConsoleAccess();
  const isTeam = access.status === 'ready' && access.role === 'team-members';
  const isAdmin = !isTeam;
  const ownedAssistants = access.status === 'ready' ? access.assistants : [];
  const ownTeams = access.status === 'ready' ? access.teams : [];
  const reissueSession = useReissueSession();
  // The new assistants a re-issue was already asked for, so a session that still does not name one (its owner
  // tag was not written) is asked once rather than on every load.
  const reissuedFor = useRef<Set<string>>(new Set());
  const [profiles, setProfiles] = useState<ProfileListing[]>([]);
  // THE TOOL REGISTRY, SERVED WITH THE LISTING, not mirrored in this package. See `ToolDescriptor`.
  const [tools, setTools] = useState<ToolDescriptor[]>([]);
  // The assistants created in the console, with their build state (ADR-048): every one for an admin,
  // the team's own for a team member, each read from the server already filtered.
  const [runtimeAssistants, setRuntimeAssistants] = useState<RuntimeAssistant[]>([]);
  const [rosterTargets, setRosterTargets] = useState<RosterTarget[]>([]);
  const [runtimeDirectoryUnreadable, setRuntimeDirectoryUnreadable] = useState(false);
  // An admin's view of ownership: every team, and which assistants' identities disagree about their owner.
  const [allTeams, setAllTeams] = useState<string[]>([]);
  const [mixedOwners, setMixedOwners] = useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = useState(false);
  // The assistant just created, for the notice that it is being built. The notice lasts while the build does: once a
  // load shows the assistant past provisioning, its row says what it is (draft ready, failed), so the notice goes.
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // THE TAB IS REPLACED BY ITS LOADING LINE ONLY UNTIL THE FIRST LOAD. A reload after a save, an activation or a
  // refresh keeps what is open (the assistant's section, the wizard's step) rather than unmounting it.
  const loadedOnce = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(initialAssistant ?? null);
  const [validation, setValidation] = useState<DraftValidation | null>(null);
  // The active version's resolved config VALUES (read from its manifest body), for the read-only view.
  const [config, setConfig] = useState<ProfileDefinitionBody | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  // THE DRAFT'S OWN VALUES, which the draft editor starts from. Seeding the editor from the active version showed
  // what is serving, not what the draft holds, and for an assistant never activated it showed its bare seed.
  const [draftConfig, setDraftConfig] = useState<ProfileDefinitionBody | null>(null);
  // The configId of the draft those values came from. The draft controls are keyed on it, so they re-seed when the
  // saved draft has LOADED, not when the listing first names its new id while the old values are still in hand.
  const [draftLoadedId, setDraftLoadedId] = useState<string | null>(null);
  /** Where the draft's workflow steps sit on the builder's canvas (ADR-061 decision 7), read with the draft. */
  const [draftLayout, setDraftLayout] = useState<ProfileManifestTyped['layout']>(undefined);
  const [downloading, setDownloading] = useState(false);
  // WHICH VERSION THE PAGE SHOWS: the active one, or the draft, edited in place. Switching to the active version keeps the draft.
  const [mode, setMode] = useState<'active' | 'draft'>('active');
  // THE CREATION WIZARD, CONTINUED ON THE DRAFT: the assistant just created, until its build shows its draft, and
  // then the assistant whose setup steps are showing.
  const [pendingSetup, setPendingSetup] = useState<string | null>(null);
  const [setupFor, setSetupFor] = useState<string | null>(null);
  // The outcome of the last activation's identity rename, surfaced because a rename that did not reach
  // the identity is otherwise invisible from here.
  const [identityRename, setIdentityRename] = useState<{ outcome: string; error?: string } | null>(null);
  // WHAT A DISCARD SAID, outside the draft for the same reason as the rename outcome: the reload that follows it
  // unmounts the draft (or re-keys it to the newer draft that was kept).
  const [discardOutcome, setDiscardOutcome] = useState<{ kind: 'discarded' | 'refused'; reason?: string } | null>(null);
  // Bumped after every mutation so the read-only panel re-reads the exported active version.
  const [configNonce, setConfigNonce] = useState(0);
  // WHAT EACH CLASSIFICATION OFFERS AND WHAT EACH FIELD IS, served with the listing.
  const [catalogs, setCatalogs] = useState<Record<string, ClassificationCatalog>>({});
  const [decisions, setDecisions] = useState<Record<string, FieldDecision>>({});
  // EACH AREA'S EDIT NOT YET SAVED, held here rather than in the controls, so it outlives a section switch, the
  // Active/Draft toggle, the wizard's steps and another area's save (`unsavedAreas.ts`).
  const [unsaved, setUnsaved] = useState<Unsaved>({});
  const patchUnsaved = (area: DraftArea, patch: ProfileDraftPatch) => setUnsaved((u) => ({ ...u, [area]: { ...(u[area] ?? {}), ...patch } }));
  const dropUnsaved = (areas: readonly DraftArea[]) => setUnsaved((u) => Object.fromEntries(Object.entries(u).filter(([a]) => !areas.includes(a as DraftArea))));
  const held = unsavedAreas(unsaved);

  const selected = profiles.find((p) => p.profileName === selectedName) ?? null;
  const ownedKey = ownedAssistants.join(',');
  const teamsKey = ownTeams.join(',');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (isTeam) {
        // A TEAM MEMBER'S LISTING IS READ ON THEIR OWN ROUTES: each owned assistant's, and each team's
        // roster, so the server answers for exactly what the session reaches.
        const [owned, rosters] = await Promise.all([
          ownedAssistants.length ? listOwnedProfiles(ownedAssistants) : Promise.resolve(null),
          can('manage-assistants') ? Promise.all(ownTeams.map((team) => listTeamRoster(team))) : Promise.resolve([]),
        ]);
        setProfiles(owned?.profiles ?? []);
        setTools(owned?.tools ?? []);
        setCatalogs(owned?.classifications ?? {});
        setDecisions(owned?.fieldDecisions ?? {});
        setRuntimeAssistants(rosters.flatMap((r) => r.runtimeAssistants));
        const targets = new Map<string, RosterTarget>();
        for (const r of rosters) for (const tg of r.rosterTargets) targets.set(tg.classification, tg);
        setRosterTargets([...targets.values()]);
        setRuntimeDirectoryUnreadable(false);
      } else {
        const r = await listProfilesAndTools();
        setProfiles(r.profiles);
        setTools(r.tools);
        setCatalogs(r.classifications ?? {});
        setDecisions(r.fieldDecisions ?? {});
        setRuntimeAssistants(r.runtimeAssistants);
        setRosterTargets(r.rosterTargets);
        setRuntimeDirectoryUnreadable(!!r.runtimeDirectoryUnreadable);
        if (can('manage-ownership')) {
          // Best effort: without it the owner field offers the teams the listing already names.
          listOwnership()
            .then((o) => {
              setAllTeams(o?.teams ?? []);
              setMixedOwners(new Set((o?.assistants ?? []).filter((a) => a.mixed).map((a) => a.assistant)));
            })
            .catch(() => undefined);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : translate('admin.profiles.failedToLoadProfiles'));
    } finally {
      loadedOnce.current = true;
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTeam, ownedKey, teamsKey]);

  useEffect(() => { load(); }, [load]);

  // A TEAM'S NEW ASSISTANT OPENS WITHOUT A SIGN-OUT. The session names the assistants the team owned when it
  // was issued, so when a load shows an active assistant on the team's own roster that the session does not
  // name, the console asks for a new session once; the session's change of assistants reloads this tab.
  // Driven by what a load returned, not by a timer.
  useEffect(() => {
    if (!isTeam) return;
    const missing = runtimeAssistants.filter((r) => r.status === 'active' && !ownedAssistants.includes(r.assistant)
      && !reissuedFor.current.has(r.assistant));
    if (!missing.length) return;
    for (const r of missing) reissuedFor.current.add(r.assistant);
    void reissueSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTeam, runtimeAssistants, ownedKey]);

  // THE WIZARD CONTINUES ONCE THE BUILD HAS MADE THE DRAFT: a load that lists the new assistant with its draft opens
  // it at the next step. Driven by what a load returned, not by a timer.
  useEffect(() => {
    if (!pendingSetup || !profiles.some((p) => p.profileName === pendingSetup && p.hasDraft)) return;
    setCreating(false);
    setJustCreated(null);
    setSelectedName(pendingSetup);
    setSetupFor(pendingSetup);
    setPendingSetup(null);
  }, [pendingSetup, profiles]);

  /** Leaving the assistant drops its unsaved edits, so it asks first, naming them; true when it may go. */
  const mayLeave = () => !held.length || window.confirm(translate('admin.assistantPage.unsaved.leave', {
    areas: held.map((a) => translate(`admin.draftCards.area.${a}`)).join(', '),
  }));

  // Let global/browser Back close the assistant first, asking before it drops an unsaved edit.
  useEffect(() => {
    registerBack?.(selectedName ? () => { if (mayLeave()) setSelectedName(null); } : null);
    return () => registerBack?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedName, registerBack, held.join(',')]);

  // A reload or a closed tab with an unsaved edit gets the browser's own leave prompt.
  useEffect(() => {
    if (!held.length) return;
    const ask = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [held.length]);

  // RESETTING THE OPEN AREA BELONGS TO SELECTION, NOT TO EVERY REFRESH. Another assistant starts with no unsaved edit.
  useEffect(() => {
    setMode('active'); setIdentityRename(null); setDiscardOutcome(null); setUnsaved({});
    setSetupFor((cur) => (cur === selectedName ? cur : null));
  }, [selectedName]);

  // UNTIL ITS FIRST ACTIVATION AN ASSISTANT'S PAGE SHOWS ITS DRAFT: nothing is serving, and the seed it would
  // otherwise show (no persona, no intents) reads as an incomplete assistant rather than as the draft it has.
  const showingDraft = !!selected && selected.activeVersion === null && selected.hasDraft;

  // Load the config VALUES for the read-only view whenever an assistant is opened: the active version's, or the
  // draft's while there is no active version.
  useEffect(() => {
    if (!selectedName) { setConfig(null); return; }
    let live = true;
    setConfigLoading(true);
    exportProfile(selectedName, showingDraft ? 'draft' : undefined)
      .then((m) => { if (live) setConfig((m as unknown as ProfileManifestTyped).body ?? null); })
      .catch(() => { if (live) setConfig(null); })
      .finally(() => { if (live) setConfigLoading(false); });
    return () => { live = false; };
  }, [selectedName, configNonce, showingDraft]);

  // The draft's values, for the editor, whenever the assistant has a draft.
  useEffect(() => {
    if (!selectedName || !selected?.hasDraft) { setDraftConfig(null); setDraftLoadedId(null); return; }
    let live = true;
    exportProfile(selectedName, 'draft')
      .then((m) => {
        if (!live) return;
        const typed = m as unknown as ProfileManifestTyped;
        setDraftConfig(typed.body ?? null);
        setDraftLayout(typed.layout);
        setDraftLoadedId(typed.provenance?.exportedConfigId ?? null);
      })
      .catch(() => { if (live) { setDraftConfig(null); setDraftLoadedId(null); } });
    return () => { live = false; };
  }, [selectedName, configNonce, selected?.hasDraft, selected?.draftConfigId]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      setConfigNonce((n) => n + 1);
    } catch (e) {
      setError(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /** Save one area's edit to the draft. A saved change is a new draft, so an earlier Validate no longer speaks for it. */
  async function saveDraft(name: string, patch: ProfileDraftPatch): Promise<boolean> {
    let saved = false;
    await run('edit-draft', async () => {
      await editProfileDraft(name, patch);
      saved = true;
      setValidation(null);
    });
    return saved;
  }

  /** Activate the draft; a refusal is shown beside the button that asked, each reason on its own line. */
  async function onActivate(name: string) {
    let activated = false;
    await run('activate', async () => {
      let r: Awaited<ReturnType<typeof activateProfileDraft>>;
      try {
        r = await activateProfileDraft(name);
      } catch (e) {
        const errs = (e as { body?: { errors?: unknown } }).body?.errors;
        if (Array.isArray(errs) && errs.some((x) => typeof x === 'string')) {
          setValidation({ valid: false, errors: errs.filter((x): x is string => typeof x === 'string') });
          return;
        }
        // THE GOLDEN SET'S REFUSAL (ADR-065): the reason, then each failed entry and attempt, beside the button.
        const golden = (e as { body?: { code?: string; params?: Record<string, string | number>; failures?: GoldenFailure[] } }).body;
        if (golden?.code?.startsWith('GOLDEN_')) {
          setValidation({
            valid: false,
            errors: [translate(`admin.assistantPage.golden.refusal.${golden.code}`, golden.params ?? {}), ...(golden.failures ?? []).map((f) => translate('admin.assistantPage.golden.failure', {
              entry: f.entryId.slice(0, 8), attempt: f.attempt,
              reason: translate(`admin.assistantPage.golden.reason.${f.reason}`, { rules: (f.rules ?? []).join(', ') }),
            }))],
          });
          return;
        }
        throw e;
      }
      activated = true;
      showActivated(r);
    });
    // The wizard ends at activation; the assistant's page shows what is now serving.
    if (activated) setSetupFor(null);
  }

  /** What the page shows once a draft is active, by either route. */
  function showActivated(r: { identityRename?: IdentityRenameOutcome; identityRenameError?: string }) {
    setValidation(null);
    // The page asked before activating over an unsaved edit; the draft it belonged to is gone.
    setUnsaved({});
    setMode('active');
    // Keep whether the rename reached the identity.
    setIdentityRename(r.identityRename ? { outcome: r.identityRename, error: r.identityRenameError } : null);
  }

  /**
   * Activate the draft past the golden gate's refusal (ADR-065 decision 5). The server's refusal of the confirmation (the
   * refusal changed, the gate no longer refuses, the reason or the caller) is handed back for the golden panel to word.
   */
  async function onActivatePastGate(name: string, confirm: PastGateConfirmation): Promise<PastGateOutcome> {
    let outcome: PastGateOutcome = { activated: false };
    await run('activate', async () => {
      let r: Awaited<ReturnType<typeof activatePastGoldenGate>>;
      try {
        r = await activatePastGoldenGate(name, confirm);
      } catch (e) {
        const code = (e as { body?: { code?: string } }).body?.code;
        if (code && PAST_GATE_REFUSALS.has(code)) {
          outcome = { activated: false, code };
          return;
        }
        throw e;
      }
      outcome = { activated: true };
      showActivated(r);
    });
    if (outcome.activated) setSetupFor(null);
    return outcome;
  }

  /**
   * DISCARD THE DRAFT THE CARDS ARE SHOWING, by the configId they were loaded from. A draft saved since (another tab, a
   * teammate, an import) is kept: the server's reason is shown and the page reloads to the newer draft.
   */
  async function onDiscard(name: string, configId: string | null | undefined) {
    setDiscardOutcome(null);
    await run('discard', async () => {
      try {
        await discardProfileDraft(name, configId ?? '');
      } catch (e) {
        const body = (e as { body?: { code?: string; error?: string } }).body;
        if (body?.code === 'DRAFT_CHANGED' || body?.code === 'NO_DRAFT') {
          setDiscardOutcome({ kind: 'refused', reason: translate(body.code === 'DRAFT_CHANGED' ? 'admin.draftCards.discard.changed' : 'admin.draftCards.discard.gone') });
          return;
        }
        throw e;
      }
      setDiscardOutcome({ kind: 'discarded' });
      setValidation(null);
      // The discard's confirm named the unsaved edits it drops with the draft.
      setUnsaved({});
      setMode('active');
      // The wizard was editing this draft; with it gone the assistant's page offers New version again.
      setSetupFor(null);
    });
  }

  async function onValidate(name: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await validateProfileDraft(name);
      setValidation({ valid: r.valid, errors: r.errors, ...(r.warnings?.length ? { warnings: r.warnings } : {}), ...(r.errorDetails?.length ? { errorDetails: r.errorDetails } : {}) });
    } catch (e) {
      setError(`validate: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function onExport(name: string) {
    setDownloading(true);
    setError(null);
    try {
      const manifest = await exportProfile(name);
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}-profile-manifest.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(`export: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDownloading(false);
    }
  }

  // AN IMPORT REPLACES THE DRAFT, so the editors seeded for the old one are cleared and re-seed from what
  // the reload returns, the same as opening the assistant again.
  async function onImported() {
    setValidation(null);
    await load();
    setConfigNonce((n) => n + 1);
  }

  // The teams an owner field offers: every team for an admin, the person's own for a team member.
  const ownerChoices = isTeam
    ? ownTeams
    : [...new Set([...allTeams, ...profiles.map((p) => p.ownerTeam).filter((x): x is string => !!x)])].sort();

  if (loading && !loadedOnce.current) return <div className="admin-tab-loading">{translate('admin.profiles.loadingProfiles')}</div>;

  // ---- One assistant: its page, the active version or its draft, one section at a time ----
  if (selected) {
    const name = config?.displayName || selected.displayName || selected.profileName;
    // WHAT THIS ASSISTANT'S CLASSIFICATION OFFERS: the draft's model selects offer only its models.
    const catalog = selected.classification ? catalogs[selected.classification] : undefined;
    const areaContext: AreaContext = {
      profileName: selected.profileName, role: selected.role, catalog, tools, decisions,
      canActivate: can('activate-profiles'), canEdit: can('edit-profiles'),
      layout: draftLayout, validationErrors: validation?.errors,
    };
    const back = () => { if (!mayLeave()) return; setSelectedName(null); setValidation(null); };
    const inSetup = setupFor === selected.profileName && !!selected.hasDraft && !!draftConfig;
    const exportButton = (
      <button className="btn-secondary" disabled={downloading} onClick={() => onExport(selected.profileName)}>
        {translate(downloading ? 'admin.profiles.downloading' : 'admin.profiles.exportManifest')}
      </button>
    );
    const notices = (
      <>
        {error && <div className="admin-error"><span>{error}</span>
          <button className="btn-secondary" onClick={() => setError(null)}>{translate('admin.assistants.dismiss')}</button></div>}
        {identityRename && (
          // OUTSIDE THE DRAFT, because activation consumes the draft: rendered inside it, the outcome unmounted in the
          // same refresh that delivered it and was never seen.
          <div role="status" data-testid="identity-rename">
            {identityRename.outcome === 'applied' && translate('admin.profiles.rename.applied')}
            {identityRename.outcome === 'unchanged' && translate('admin.profiles.rename.unchanged')}
            {identityRename.outcome === 'unsupported' && translate('admin.profiles.rename.unsupported')}
            {identityRename.outcome === 'failed' && translate('admin.profiles.theVersionIsActiveBut', { reason: identityRename.error || translate('admin.profiles.unknownReason') })}
          </div>
        )}
        {discardOutcome && (
          <div role={discardOutcome.kind === 'refused' ? 'alert' : 'status'} className={discardOutcome.kind === 'refused' ? 'admin-error' : undefined}
            data-testid={discardOutcome.kind === 'refused' ? 'draft-discard-refused' : 'draft-discarded'}>
            <span>{discardOutcome.kind === 'refused' ? discardOutcome.reason : translate('admin.draftCards.discard.done')}</span>
          </div>
        )}
      </>
    );

    const versionsBody = (
      <>
        <DataTable
          data={selected.versions as unknown as Array<Record<string, unknown>>}
          emptyMessage={translate('admin.profiles.noVersions')}
          columns={[
            { key: 'version', label: translate('admin.assistantPage.versions.version') },
            { key: 'configId', label: translate('admin.assistantPage.versions.configId'), render: (v) => <code>{String(v).slice(0, 12)}</code> },
            { key: 'active', label: translate('admin.assistantPage.versions.active'), render: (v) => (v ? <span className="admin-badge admin-badge-active">{translate('admin.assistantPage.versions.activeMark')}</span> : '-') },
            { key: 'lastModified', label: translate('admin.assistantPage.versions.modified'), render: (v) => (v ? new Date(String(v)).toLocaleString() : '-') },
            // WHERE THE VERSION CAME FROM (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5, §3.6).
            {
              key: 'provenance', label: translate('admin.profiles.provenance'), sortable: false,
              render: (_v, row) => <VersionProvenance row={row as unknown as ProfileVersionSummary} />,
            },
            {
              key: 'rollback', label: '', sortable: false,
              // A CANDIDATE IS NEVER ACTIVATED HERE: its experiment's Promote action is the one way it
              // reaches the live assistant.
              render: (_v, row) => (row.derivedFrom && can('activate-profiles')
                ? <CandidateNotActivatable experimentId={String((row.derivedFrom as { experimentId: string }).experimentId)} />
                : !canActivateVersion(row as unknown as ProfileVersionSummary) || !can('activate-profiles') ? '' : (
                  <button className="btn-secondary" disabled={busy}
                    onClick={() => run('rollback', () => rollbackProfile(selected.profileName, Number(row.version)))}>
                    {translate('admin.assistantPage.versions.rollBack', { version: row.version })}
                  </button>
                )),
            },
          ]}
        />
        {/* EXPORT AND IMPORT SIT TOGETHER, and an import lands on THIS assistant: the console always
            names it as the target, whatever assistant the chosen manifest was exported from. */}
        {can('edit-profiles') ? (
          <ImportVersion assistant={selected.profileName} assistantLabel={name} hasDraft={!!selected.hasDraft}
            disabled={busy} onImported={onImported}
            beside={exportButton} />
        ) : <div>{exportButton}</div>}
      </>
    );

    return (
      <AssistantPage
        selected={selected}
        config={config}
        configLoading={configLoading}
        draft={draftConfig}
        draftKey={draftLoadedId ?? ''}
        catalog={catalog}
        tools={tools}
        decisions={decisions}
        ctx={areaContext}
        busy={busy}
        validation={validation}
        // UNTIL ITS FIRST ACTIVATION THE PAGE SHOWS THE DRAFT: nothing is serving.
        mode={selected.activeVersion === null ? 'draft' : mode}
        onModeChange={setMode}
        onStartDraft={() => { void run('create-version', () => createProfileVersion(selected.profileName)).then(() => setMode('draft')); }}
        onSave={(patch) => saveDraft(selected.profileName, patch)}
        unsaved={unsaved}
        onUnsavedPatch={patchUnsaved}
        onUnsavedDrop={dropUnsaved}
        // THE WIZARD CONTINUES HERE once the build has made the draft: the same page, its sections as steps.
        wizard={inSetup ? { onFinishLater: () => setSetupFor(null) } : undefined}
        onValidate={() => onValidate(selected.profileName)}
        onActivate={() => onActivate(selected.profileName)}
        onActivatePastGate={(confirm) => onActivatePastGate(selected.profileName, confirm)}
        onDiscard={() => { void onDiscard(selected.profileName, draftLoadedId ?? selected.draftConfigId); }}
        onBack={back}
        onOpenLink={onOpenLink}
        canEdit={can('edit-profiles')}
        canValidate={can('view-profiles')}
        notices={notices}
        ownerControl={(
          <AssistantOwnerControl
            assistant={selected.profileName}
            ownerTeam={selected.ownerTeam ?? null}
            mixed={mixedOwners.has(selected.profileName)}
            teams={ownerChoices}
            isAdmin={isAdmin}
            labelHidden
            canManage={can('manage-ownership')}
            onSaved={() => { void load(); }}
          />
        )}
        limits={(
          <LimitsGroup selected={selected} catalog={catalog} canEditLimit={can('manage-assistants')}
            team={isTeam ? (selected.ownerTeam ?? undefined) : undefined} onSaved={() => { void load(); }} />
        )}
        infrastructure={<AssistantInfrastructure resolved={selected.resolved} classification={selected.classification} />}
        versions={versionsBody}
      />
    );
  }

  // ---- The list ----
  const rows = assistantRows(profiles, runtimeAssistants);
  const createTeams = isTeam ? ownTeams : ownerChoices;
  const stillBuilding = !!justCreated
    && (runtimeAssistants.find((r) => r.assistant === justCreated)?.status ?? 'provisioning') === 'provisioning';
  return (
    <div className="admin-tab">
      <div className="admin-tab-header">
        <h3>{translate('admin.assistants.title')} <InfoTooltip label={translate('admin.profiles.aboutProfiles')} content={translate('admin.profiles.eachAssistantProfileIsA')} /></h3>
        <div className="admin-assistants-toolbar-group">
          {can('manage-assistants') && !creating && (
            <button className="btn-primary" onClick={() => { setCreating(true); setJustCreated(null); }} data-testid="create-assistant-open">
              {translate('admin.create.open')}
            </button>
          )}
          <button className="btn-secondary" onClick={() => load()} disabled={busy}>{translate('admin.assistants.refresh')}</button>
        </div>
      </div>
      <p className="admin-tab-description">{translate('admin.assistants.description')}</p>

      {error && <div className="admin-error"><span>{error}</span>
        <button className="btn-secondary" onClick={() => setError(null)}>{translate('admin.assistants.dismiss')}</button></div>}
      {stillBuilding && <div className="admin-info-banner" role="status" data-testid="created-notice"><span>{translate('admin.create.created', { assistant: justCreated })}</span>
        <button className="btn-secondary" onClick={() => setJustCreated(null)}>{translate('admin.assistants.dismiss')}</button></div>}
      {runtimeDirectoryUnreadable && <div className="admin-error"><span>{translate('admin.assistants.directoryUnreadable')}</span></div>}

      {creating && (
        <CreateAssistantFlow
          targets={rosterTargets}
          ownerTeams={createTeams}
          isAdmin={isAdmin}
          catalogs={Object.keys(catalogs).length ? catalogs : undefined}
          copySources={profiles
            .filter((p) => p.activeVersion !== null && p.classification)
            .map((p) => ({ profileName: p.profileName, label: p.displayName || p.profileName, classification: p.classification as string, activeVersion: p.activeVersion as number }))}
          onCancel={() => {
            // Leaving while the build runs keeps the notice; the assistant's page then edits its draft in the same sections.
            setCreating(false);
            if (pendingSetup) { setJustCreated(pendingSetup); setPendingSetup(null); }
          }}
          onCheckBuild={() => { void load(); }}
          onCreated={(id) => {
            setPendingSetup(id);
            // A team member's session is re-issued at once, so it is current when the build finishes; the
            // load that shows the assistant active asks once more if it still is not named (above).
            if (isTeam) void reissueSession();
            void load();
          }}
        />
      )}

      <AssistantsList
        rows={rows}
        teams={isTeam ? ownTeams : ownerChoices}
        isAdmin={isAdmin}
        canRetire={isAdmin && can('manage-assistants')}
        onOpen={(n) => { setSelectedName(n); setValidation(null); }}
        onChanged={() => { void load(); }}
      />
    </div>
  );
};

export default ProfilesTab;
