/**
 * WHICH TEMPLATE ONE MESSAGE IS SAID FROM IN THIS VERSION, AND WHEN (ADR-062 decision 3, ADR-060 decision 6).
 *
 * Part of the Message templates section (`MessageTemplatesEditor`), shown for the message selected there. A version's
 * `messages` maps a message to one of the assistant's own templates, to a family (`@classification`, `@shipped`), or to
 * an ordered list of `{ template, when }` whose last alternative alone carries no condition: the first whose condition
 * holds is said, else the last. With no entry, the selection order answers: this assistant's own template of the
 * message's name, else the classification's, else the shipped one.
 *
 * A condition is built from declared variables and held to who reads the message (`messageAudience`, the rule validation
 * reads), so a fact about a person chooses only a message addressed to that person. The draft's validation checks each
 * named template is active in the assistant's family and fits its message.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { MessageChoice, MessageEntry } from '../../../../../../backend/lambda/src/lib/message-template.ts';
import { messageAudience } from '../../../../../../backend/lambda/src/lib/shipped-message-templates.ts';
import type { PublishedVariables, VersionVariable } from '../../../../../../backend/lambda/src/lib/variables.ts';
import ConditionBuilder from './ConditionBuilder';

type T = (key: string, opts?: Record<string, unknown>) => string;

/** An entry as alternatives: a name is one alternative with no condition. */
export function choicesOf(entry: MessageEntry): MessageChoice[] {
  return typeof entry === 'string' ? [{ template: entry }] : [...entry];
}

/** The entry the alternatives make: a name when one unconditioned alternative is left. */
export function entryOf(choices: MessageChoice[]): MessageEntry | undefined {
  if (!choices.length) return undefined;
  return choices.length === 1 && choices[0].when === undefined ? choices[0].template : choices;
}

/** One template a message may be said from: a value an entry may hold, and what the console calls it. */
export interface TemplateOption { value: string; label: string }

/** The value of the "no entry" choice: the selection order decides. */
export const ORDER_CHOICE = '';

/**
 * The templates one message may be said from, in the order a person reads them: the shipped one, the classification's
 * (said to fall back to the shipped one when it has none), then each of the assistant's own that fits the message.
 */
export function templateOptionsFor(t: T, args: { hasClassification: boolean; own: readonly string[] }): TemplateOption[] {
  return [
    { value: '@shipped', label: t('admin.messageChoices.shippedOption') },
    { value: '@classification', label: t(args.hasClassification ? 'admin.messageChoices.classificationOption' : 'admin.messageChoices.classificationNoneOption') },
    ...args.own.map((name) => ({ value: name, label: t('admin.messageChoices.ownOption', { name }) })),
  ];
}

const MessageChoicesEditor: React.FC<{
  /** The shipped message this is the choice for. */
  message: string;
  /** The version's entry for it, or nothing when the selection order decides. */
  entry: MessageEntry | undefined;
  /** The new entry, or undefined to let the selection order decide. Absent, the choice is shown read-only. */
  onChange?: (next: MessageEntry | undefined) => void;
  options: TemplateOption[];
  published?: PublishedVariables;
  variables?: Readonly<Record<string, VersionVariable>>;
}> = ({ message, entry, onChange, options, published, variables }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const choices = entry === undefined ? [] : choicesOf(entry);
  const selects = messageAudience(message);
  const readOnly = !onChange;
  const set = (next: MessageChoice[]) => onChange?.(entryOf(next));
  const templateSelect = (current: string, onPick: (v: string) => void, testId: string, withOrder = false) => {
    // A name the version holds that is not offered (a template since rolled back) is still shown, so it is not lost.
    const known = current === ORDER_CHOICE ? withOrder : options.some((o) => o.value === current);
    return (
      <select className="select" data-testid={testId} aria-label={t('admin.messageChoices.template')} value={current} disabled={readOnly}
        onChange={(e) => onPick(e.target.value)}>
        {withOrder && <option value={ORDER_CHOICE}>{t('admin.messageChoices.orderOption')}</option>}
        {!known && <option value={current}>{current}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  };

  return (
    <div className="profiles-persona-field" data-testid="message-choice">
      <h6>{t('admin.messageChoices.title')}</h6>
      <span className="admin-field-hint">{t('admin.messageChoices.help')}</span>
      {choices.length <= 1 && choices.every((c) => c.when === undefined) ? (
        <label><span className="admin-field-label">{t('admin.messageChoices.usedIn')}</span>
          {templateSelect(choices[0]?.template ?? ORDER_CHOICE, (v) => set(v === ORDER_CHOICE ? [] : [{ template: v }]), 'message-choice-pick', true)}
        </label>
      ) : (
        <ol>
          {choices.map((c, i) => {
            const last = i === choices.length - 1;
            const put = (next: MessageChoice | undefined) => set(next ? choices.map((x, j) => (j === i ? next : x)) : choices.filter((_, j) => j !== i));
            return (
              <li key={i} data-testid={`message-choice-alt-${i}`}>
                <span className="admin-field-label">{t(last ? 'admin.messageChoices.otherwise' : 'admin.messageChoices.when')}</span>
                {templateSelect(c.template, (template) => put({ ...c, template }), `message-choice-alt-${i}-template`)}
                {!last && (
                  <>
                    <ConditionBuilder value={c.when} selects={selects} published={published} variables={variables} testId={`message-choice-alt-${i}-when`}
                      onChange={(when) => put(when === undefined ? { template: c.template } : { template: c.template, when })} />
                    {!readOnly && (
                      <button type="button" className="btn-secondary" data-testid={`message-choice-alt-${i}-remove`} onClick={() => put(undefined)}>
                        {t('admin.messageChoices.removeAlternative')}
                      </button>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <span className="admin-field-hint">{t(selects === 'room' ? 'admin.messageChoices.readByRoom' : 'admin.messageChoices.readByOne')}</span>
      {!readOnly && (
        <div className="admin-review-buttons">
          <button type="button" className="btn-secondary" data-testid="message-choice-add-alternative"
            onClick={() => {
              const base = choices.length ? choices : [{ template: '@shipped' }];
              set([...base.slice(0, -1), { template: options[options.length - 1]?.value ?? '@shipped' }, base[base.length - 1]]);
            }}>
            {t('admin.messageChoices.addAlternative')}
          </button>
          {choices.length > 0 && (
            <button type="button" className="btn-secondary" data-testid="message-choice-reset" onClick={() => set([])}>
              {t('admin.messageChoices.reset')}
            </button>
          )}
        </div>
      )}
      {readOnly && <span className="admin-field-hint" data-testid="message-choice-read-only">{t('admin.messageChoices.readOnly')}</span>}
    </div>
  );
};

export default MessageChoicesEditor;
