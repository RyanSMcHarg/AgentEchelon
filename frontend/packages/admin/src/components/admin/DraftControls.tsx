/**
 * THE DRAFT'S CONTROLS, SHARED BY AN ASSISTANT'S PAGE AND THE CREATION WIZARD.
 *
 * One area of the draft edited inline (`DraftStep`), what the draft changes against the active version (`DraftDiff`),
 * the server's answer to Validate or an activation (`DraftValidationResult`), and Discard draft behind a confirm that
 * names what is lost (`DiscardDraft`). The page's sections and the wizard's steps render these, so an area is edited one
 * way wherever it appears. A tested instruction a promoted experiment left on the draft is moved into the persona with
 * `MoveIntoPersona`.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HelpToggle } from './AdminHelp';
import { AreaFields, MAX_PERSONA_LENGTH, type AreaProps, type InlineArea } from './DraftAreaFields';
import { areaSummary, draftDiff } from './draftAreas';
import { draftWith } from './unsavedAreas';
import type { ProfileDefinitionBody, ProfileDraftPatch, RouteError } from '../../services/profileService';
import { movedIntoPersona } from '../../../../../../backend/lambda/src/lib/persona-sections.ts';

type T = (key: string, opts?: Record<string, unknown>) => string;

/** What the server said of the draft: Validate's answer, or an activation's refusal. */
/** The server's answer to Validate; `errorDetails` are the refusals the page anchors to an intent card or a step (ADR-064). */
export interface DraftValidation { valid: boolean; errors: string[]; warnings?: string[]; errorDetails?: RouteError[] }

/** Everything an area's controls are handed, apart from the draft and the patch. */
export type AreaContext = Omit<AreaProps, 'draft' | 'onPatch'>;

/**
 * ONE AREA, INLINE: its controls, the help behind a ? control, the sentence the area will say once saved (the live
 * preview), and the actions the caller gives it. THE UNSAVED EDIT IS THE CALLER'S (`unsavedAreas.ts`): the controls
 * start from the saved draft with that edit laid over it and report each change back, so the edit outlives them.
 */
export const DraftStep: React.FC<{
  area: InlineArea;
  draft: ProfileDefinitionBody;
  ctx: AreaContext;
  /** This area's unsaved edit, held by the caller; absent while there is none. */
  unsaved?: ProfileDraftPatch;
  /** A change to this area's fields, merged into its unsaved edit by the caller. */
  onUnsavedPatch: (patch: ProfileDraftPatch) => void;
  actions: (edited: boolean) => React.ReactNode;
  /** Focus the step's heading when it opens: true where the step is opened alone, false where it sits inline in a section. */
  autoFocus?: boolean;
}> = ({ area, draft, ctx, unsaved, onUnsavedPatch, actions, autoFocus = true }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { if (autoFocus) heading.current?.focus(); }, [area, autoFocus]);
  const title = t(`admin.draftCards.area.${area}`);
  const seeded = draftWith(area, draft, unsaved);
  const edited = !!unsaved && Object.keys(unsaved).length > 0;
  return (
    <section className="admin-edit-step" aria-labelledby={`draft-step-${area}`} data-testid={`draft-step-${area}`}>
      <div className="admin-edit-card-head">
        <h5 id={`draft-step-${area}`} ref={heading} tabIndex={-1}>{title}</h5>
        <HelpToggle label={t('admin.draftCards.helpFor', { area: title })} testId={`draft-step-${area}-help`}>
          <p>{t(`admin.draftCards.help.${area}`)}</p>
        </HelpToggle>
        {edited && <span className="admin-badge" data-testid={`draft-step-${area}-unsaved`}>{t('admin.assistantPage.unsaved.mark')}</span>}
      </div>
      {/* The canvas layout rides in the patch beside the workflows, so an unsaved move is kept the same way. */}
      <AreaFields area={area} draft={seeded} {...ctx} layout={unsaved?.layout ?? ctx.layout ?? undefined} onPatch={onUnsavedPatch} />
      <p className="admin-edit-preview" aria-live="polite" data-testid="draft-step-preview">
        <strong>{t('admin.draftCards.preview')}</strong> {areaSummary(area, seeded, t, ctx.profileName)}
      </p>
      <div className="admin-config-actions">{actions(edited)}</div>
    </section>
  );
};

/** What the draft changes against the active version, area by area. */
export const DraftDiff: React.FC<{ draft: ProfileDefinitionBody; active: ProfileDefinitionBody | null }> = ({ draft, active }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const diff = draftDiff(active, draft);
  return (
    <section className="admin-edit-diff" aria-labelledby="draft-diff-title" data-testid="draft-diff">
      <h5 id="draft-diff-title">{t(active ? 'admin.draftCards.diffTitle' : 'admin.draftCards.diffTitleNew')}</h5>
      {diff.length === 0 ? <p className="admin-muted">{t('admin.draftCards.diffNone')}</p> : (
        <ul>
          {diff.map((d) => (
            <li key={d.area} data-testid={`draft-diff-${d.area}`}>
              <strong>{t(`admin.draftCards.area.${d.area}`)}</strong>{' '}
              {d.changes.map((c, i) => (
                <React.Fragment key={c.path}>
                  {i > 0 && ', '}
                  <code>{c.path}</code> <span className="admin-field-hint">{t(`admin.draftCards.change.${c.change}`)}</span>
                </React.Fragment>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/** The server's answer to Validate or an activation, where the person asked for it. */
export const DraftValidationResult: React.FC<{ validation: DraftValidation | null }> = ({ validation }) => {
  const { t } = useTranslation();
  if (!validation) return null;
  return (
    <>
      {validation.valid
        ? <div role="status" data-testid="draft-valid">{t('admin.profiles.draftValid')}</div>
        : (
          <div className="admin-error" role="alert" data-testid="draft-refused">
            <span>{t('admin.profiles.draftRefused')}</span>
            <ul>{validation.errors.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
        )}
      {validation.warnings?.length ? (
        <div role="status" data-testid="draft-warnings">
          <span>{t('admin.profiles.draftWarnings')}</span>
          <ul>{validation.warnings.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      ) : null}
    </>
  );
};

/**
 * DISCARD THE DRAFT, AFTER A CONFIRM THAT NAMES WHAT IS LOST: the areas it changes from the active version, or all of
 * it while nothing is active, and any area's edit not yet saved. Discarding changes nothing that serves; the server
 * refuses a draft saved since this one was loaded, and the caller shows why.
 */
export const DiscardDraft: React.FC<{
  draft: ProfileDefinitionBody;
  active: ProfileDefinitionBody | null;
  busy: boolean;
  canEdit: boolean;
  /** The names of the areas holding an edit not yet saved, which the discard loses too. */
  unsaved?: readonly string[];
  onDiscard: () => void;
}> = ({ draft, active, busy, canEdit, unsaved = [], onDiscard }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const [confirming, setConfirming] = useState(false);
  if (!canEdit) return null;
  if (!confirming) {
    return (
      <button type="button" className="btn-danger" disabled={busy} data-testid="draft-discard" onClick={() => setConfirming(true)}>
        {t('admin.draftCards.discard.button')}
      </button>
    );
  }
  const lost = draftDiff(active, draft).map((d) => t(`admin.draftCards.area.${d.area}`));
  return (
    <section className="admin-import-preview" role="alertdialog" aria-labelledby="draft-discard-title" data-testid="draft-discard-confirm">
      <h5 id="draft-discard-title">{t('admin.draftCards.discard.title')}</h5>
      <p data-testid="draft-discard-lost">
        {!active
          ? t('admin.draftCards.discard.lostAll')
          : lost.length
            ? t('admin.draftCards.discard.lostAreas', { areas: lost.join(', ') })
            : t('admin.draftCards.discard.lostNothing')}
      </p>
      {unsaved.length > 0 && <p data-testid="draft-discard-unsaved">{t('admin.assistantPage.unsaved.discard', { areas: unsaved.join(', ') })}</p>}
      <p className="admin-field-hint">{t('admin.draftCards.discard.servingUnchanged')}</p>
      <div className="admin-config-actions">
        <button type="button" className="btn-ghost" disabled={busy} data-testid="draft-discard-cancel" onClick={() => setConfirming(false)}>
          {t('admin.draftCards.cancel')}
        </button>
        <button type="button" className="btn-danger" disabled={busy} data-testid="draft-discard-confirm-button"
          onClick={() => { setConfirming(false); onDiscard(); }}>
          {t('admin.draftCards.discard.confirm')}
        </button>
      </div>
    </section>
  );
};

/**
 * MOVE THE TESTED INSTRUCTION INTO THE PERSONA: the draft's `systemPromptAddendum` becomes the last item of the persona's
 * How to answer section (`movedIntoPersona`, shared with any other path that makes the same move), and the addendum is
 * cleared, in one save through the draft's own save path. The draft changes and nothing serving does; the person
 * reviews it and activates as usual. Offered to a session that may edit, on a draft that carries an instruction.
 *
 * The move starts from the SAVED persona, so it waits while the persona holds an edit not yet saved: that edit, laid
 * over the draft the move produces, would otherwise put the old persona back on its next save.
 */
export const MoveIntoPersona: React.FC<{
  draft: ProfileDefinitionBody;
  busy: boolean;
  canEdit: boolean;
  /** The persona holds an edit not yet saved. */
  personaUnsaved: boolean;
  onSave: (patch: ProfileDraftPatch) => Promise<boolean>;
}> = ({ draft, busy, canEdit, personaUnsaved, onSave }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const [refusal, setRefusal] = useState<string | null>(null);
  if (!canEdit || !draft.systemPromptAddendum?.trim()) return null;
  const move = () => {
    const moved = movedIntoPersona(draft.persona, draft.systemPromptAddendum, MAX_PERSONA_LENGTH);
    if (!moved.ok) {
      setRefusal(moved.reason === 'too-long'
        ? t('admin.assistantPage.moveIntoPersona.tooLong', { length: moved.length.toLocaleString(), max: moved.max.toLocaleString() })
        : t('admin.assistantPage.moveIntoPersona.noPersona'));
      return;
    }
    setRefusal(null);
    void onSave({ persona: moved.persona, systemPromptAddendum: null });
  };
  return (
    <div className="admin-config-actions" data-testid="move-into-persona">
      <button type="button" className="btn-secondary" disabled={busy || personaUnsaved} data-testid="move-into-persona-button" onClick={move}>
        {t('admin.assistantPage.moveIntoPersona.button')}
      </button>
      <span className="admin-field-hint">
        {t(personaUnsaved ? 'admin.assistantPage.moveIntoPersona.unsavedPersona' : 'admin.assistantPage.moveIntoPersona.help')}
      </span>
      {refusal && <div className="admin-error" role="alert" data-testid="move-into-persona-refused">{refusal}</div>}
    </div>
  );
};
