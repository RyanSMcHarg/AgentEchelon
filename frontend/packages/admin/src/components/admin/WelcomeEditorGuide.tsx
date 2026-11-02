/**
 * HOW AN ASSISTANT'S OPENING IS MADE, BESIDE THE BOX THAT WRITES IT.
 *
 * Three answers, in the order a person needs them:
 *
 *   - what the built-in opening is made of, which is what a blank Opening text gives;
 *   - the fields Opening text may name, each with what it holds, inserted with one click, and the rule that a line
 *     naming a field the conversation lacks is left out;
 *   - a preview against a sample conversation, so the rule is seen working rather than read about.
 *
 * THE PREVIEW IS THE ROUTER'S OWN SELECTION AND RENDERER (W1). `welcomeWorkflowOf` picks the welcome workflow a room of
 * this type runs, `welcomePlan` finds its opening step, `selectOpening` reads its text and orientation, and
 * `composeOpening` renders them, in the same pure modules the router posts a welcome from
 * (`backend/lambda/src/lib/event-workflow.ts`, `welcome-orientation.ts`). What the preview shows for a sample
 * conversation is what the router posts in one, built-in opening included.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  composeOpening,
  selectOpening,
  welcomeTemplateFields,
  WELCOME_TOKENS,
  type WelcomeOrientation,
} from '../../../../../../backend/lambda/src/lib/welcome-orientation.ts';
import { welcomePlan, welcomeWorkflowOf, type EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';

/**
 * The fields Opening text may name, in the order they are offered: the welcome's declared variables
 * (`WELCOME_FIELDS`, ADR-060), inserted as `{{field}}`, the syntax every template uses. A stored `{field}` still reads.
 */
export { WELCOME_TOKENS };
type Sample = 'topic' | 'event' | 'continued';

/** What the preview shows for one draft's welcome workflows, conversation type and sample conversation. */
export interface WelcomePreview {
  /** The opening the router posts. */
  content: string;
  /** Which opening produced it. */
  applies: 'type' | 'default' | 'builtIn' | 'emptyTemplate';
  /** True when the welcome's opening sets nothing of its own, so a primary uses the deployment parameter. */
  deploymentCopy: boolean;
}

/** The opening the router posts for these draft workflows, in this kind of conversation, with these conversation fields. */
export function previewWelcome(
  workflows: Record<string, EventWorkflow> | null | undefined,
  conversationType: string | undefined,
  conversation: WelcomeOrientation,
  role?: string,
): WelcomePreview {
  const welcome = welcomeWorkflowOf(workflows, conversationType || undefined);
  const own = selectOpening(welcomePlan(welcome.workflow).opening);
  const opening = composeOpening(own?.template, { ...(own?.orientation ?? {}), ...conversation }, { role });
  const typed = !!conversationType && (welcome.workflow.types ?? []).includes(conversationType);
  const applies = !own?.template ? 'builtIn'
    : !opening.usedTemplate ? 'emptyTemplate'
      : typed ? 'type' : 'default';
  return { content: opening.content, applies, deploymentCopy: !own };
}

const WelcomeEditorGuide: React.FC<{
  /** The draft's event workflows, the welcome among them. */
  workflows: Record<string, EventWorkflow> | null;
  /** The conversation type being edited; empty for every other room. */
  conversationType?: string;
  /** The classification, for naming the deployment's orientation parameter. */
  classification?: string;
  role?: string;
  onInsert: (token: string) => void;
}> = ({ workflows, conversationType, classification, role, onInsert }) => {
  const { t } = useTranslation();
  const [sample, setSample] = useState<Sample>('topic');
  const conversation: WelcomeOrientation = sample === 'topic' ? { topic: t('admin.welcome.sampleTopic') }
    : sample === 'event' ? { eventSummary: t('admin.welcome.sampleEvent') }
      : { priorSubject: t('admin.welcome.sampleTopic'), priorMessage: t('admin.welcome.samplePriorMessage') };
  const preview = previewWelcome(workflows, conversationType, conversation, role || t('admin.welcome.sampleRole'));
  const type = conversationType || '';

  return (
    <div className="admin-welcome-guide" data-testid="welcome-guide">
      <details>
        <summary>{t('admin.welcome.builtInTitle')}</summary>
        <p className="admin-field-hint" data-testid="welcome-built-in">{t('admin.welcome.builtIn')}</p>
      </details>

      <h6>{t('admin.welcome.tokensTitle')}</h6>
      <p className="admin-field-hint">{t('admin.welcome.tokensHelp')}</p>
      <dl className="admin-config-list" data-testid="welcome-tokens">
        {WELCOME_TOKENS.map((token) => (
          <React.Fragment key={token}>
            <dt>
              <button type="button" className="btn-secondary" onClick={() => onInsert(`{{${token}}}`)}
                aria-label={t('admin.welcome.insert', { token: `{{${token}}}` })}>
                <code>{`{{${token}}}`}</code>
              </button>
            </dt>
            <dd>{t(`admin.welcome.token.${token}`)}</dd>
          </React.Fragment>
        ))}
      </dl>
      <p className="admin-field-hint">{t('admin.welcome.exampleLead')}</p>
      <pre className="admin-welcome-example" data-testid="welcome-example">{welcomeTemplateFields(t('admin.welcome.exampleTemplate'))}</pre>
      <p className="admin-field-hint">{t('admin.welcome.typeExampleLead')}</p>
      <pre className="admin-welcome-example" data-testid="welcome-type-example">{welcomeTemplateFields(t('admin.welcome.typeExampleTemplate'))}</pre>

      <h6>{t('admin.welcome.previewTitle')}</h6>
      <label>
        <span className="admin-field-label">{t('admin.welcome.previewSample')}</span>
        <select className="select" value={sample} onChange={(e) => setSample(e.target.value as Sample)} data-testid="welcome-sample">
          <option value="topic">{t('admin.welcome.sample.topic')}</option>
          <option value="event">{t('admin.welcome.sample.event')}</option>
          <option value="continued">{t('admin.welcome.sample.continued')}</option>
        </select>
      </label>
      <p className="admin-field-hint" data-testid="welcome-applies">
        {t(`admin.welcome.applies.${preview.applies === 'default' && type ? 'defaultForType' : preview.applies}`, { type })}
        {preview.deploymentCopy && <> {t('admin.welcome.deploymentCopy', {
          param: `/agent-echelon/assistant/${classification || '<classification>'}/welcome-orientation`,
        })}</>}
      </p>
      <pre className="admin-welcome-preview" data-testid="welcome-preview">{preview.content}</pre>
    </div>
  );
};

export default WelcomeEditorGuide;
