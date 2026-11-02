/**
 * ONE PICKER FOR EVERY VARIABLE A VERSION MAY READ (ADR-060 slice 1e), shared by the message template editor, the
 * welcome editor, the event workflow editor, the template each message uses (Message templates) and the routing rules.
 *
 * It lists what the assistant's classification publishes, served with the profile listing on the classification's
 * catalog (`publishedVariables`, the table validation builds), beside the variables the version names. Each row says
 * its source, its type and its trust, and whether it may decide. Whether a row may be picked is ADR-060's own rule,
 * said in place: member text is inserted and never decides (decision 2), and a fact about a person never selects or
 * enters a message the room reads, except a display name through a mention (decision 7). The server refuses the same
 * things; the picker only stops offering them.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buildSourceTable,
  tableFromPublished,
  versionLookup,
  type PickableSource,
  type PublishedVariables,
  type SourceLookup,
  type VersionVariable,
} from '../../../../../../backend/lambda/src/lib/variables.ts';

type T = (key: string, opts?: Record<string, unknown>) => string;

/** What the pick is for: a value a condition decides on, or a value inserted into text. */
export type PickPurpose = 'decide' | 'insert';

/** Why a source may not be picked for this use, as a locale key, or undefined when it may. */
export function pickRefusal(src: Pick<PickableSource, 'mayDecide' | 'describesPerson' | 'mentionable'>, purpose: PickPurpose, audience?: 'room' | 'addressed'): string | undefined {
  if (purpose === 'decide' && !src.mayDecide) return 'admin.variables.refused.member';
  if (audience === 'room' && src.describesPerson) {
    if (purpose === 'insert' && src.mentionable) return 'admin.variables.refused.mentionOnly';
    return 'admin.variables.refused.person';
  }
  return undefined;
}

/**
 * The lookup the console's inline validation reads: the classification's published table with the version's variables,
 * the same lookup the server builds (`versionLookup`). Without a served table, the sources every classification publishes.
 */
export function consoleLookup(published: PublishedVariables | undefined, variables: Readonly<Record<string, VersionVariable>> | undefined): SourceLookup {
  const table = published ? tableFromPublished(published) : buildSourceTable({ catalog: [] });
  return versionLookup(table, variables);
}

/** One row the picker offers: a version's variable by its name, or a source by its own. */
export interface PickerRow {
  /** What a condition or a template names. */
  name: string;
  /** The version's variable it is, when it is one. */
  variable?: string;
  src: PickableSource;
}

/** The rows, the version's variables first, then every source the classification publishes. */
export function pickerRows(published: PublishedVariables | undefined, variables: Readonly<Record<string, VersionVariable>> | undefined): PickerRow[] {
  const sources = published?.sources ?? [];
  const bySource = new Map(sources.map((s) => [s.source, s]));
  const named: PickerRow[] = Object.entries(variables ?? {}).flatMap(([name, v]) => {
    const src = bySource.get(v.source);
    return src ? [{ name, variable: name, src }] : [];
  });
  return [...named, ...sources.map((src) => ({ name: src.source, src }))];
}

const VariablePicker: React.FC<{
  published?: PublishedVariables;
  variables?: Readonly<Record<string, VersionVariable>>;
  purpose: PickPurpose;
  /** Who reads the message the pick decides or enters; absent when the message's reader is decided where it is said. */
  audience?: 'room' | 'addressed';
  /** Leaves out sources this call site never reads, said in `hiddenNote`. */
  only?: (src: PickableSource) => boolean;
  hiddenNote?: string;
  /** Picking only the version's own variables (a welcome inserts them by name). */
  variablesOnly?: boolean;
  onPick: (name: string, src: PickableSource) => void;
  testId: string;
}> = ({ published, variables, purpose, audience, only, hiddenNote, variablesOnly, onPick, testId }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const [filter, setFilter] = useState('');
  const rows = pickerRows(published, variables)
    .filter((r) => (!only || only(r.src)))
    .filter((r) => !filter || r.name.toLowerCase().includes(filter.toLowerCase()) || r.src.source.toLowerCase().includes(filter.toLowerCase()));
  return (
    <details className="admin-variable-picker" data-testid={testId}>
      <summary>{t(purpose === 'decide' ? 'admin.variables.pickDecide' : 'admin.variables.pickInsert')}</summary>
      <p className="admin-field-hint">{t('admin.variables.help')}</p>
      {!published && <p className="admin-field-hint" role="status" data-testid={`${testId}-unread`}>{t('admin.variables.unreadable')}</p>}
      {hiddenNote && <p className="admin-field-hint">{hiddenNote}</p>}
      <label><span className="admin-field-label">{t('admin.variables.filter')}</span>
        <input type="text" className="input" value={filter} onChange={(e) => setFilter(e.target.value)} data-testid={`${testId}-filter`} />
      </label>
      <table className="admin-mini-table">
        <thead><tr>
          <th>{t('admin.variables.col.name')}</th><th>{t('admin.variables.col.type')}</th>
          <th>{t('admin.variables.col.trust')}</th><th>{t('admin.variables.col.decides')}</th><th />
        </tr></thead>
        <tbody>
          {rows.map((r) => {
            const refusal = pickRefusal(r.src, purpose, audience) ?? (variablesOnly && !r.variable ? 'admin.variables.refused.nameFirst' : undefined);
            const id = `${testId}-row-${r.name}`;
            return (
              <tr key={id} data-testid={id} data-refused={refusal ? 'true' : 'false'}>
                <td>
                  <code>{r.name}</code>
                  {r.variable && <span className="admin-field-hint"> = <code>{r.src.source}</code></span>}
                  <div className="admin-field-hint">{r.src.origin}</div>
                </td>
                <td><code>{r.src.type}</code>{r.src.values?.length ? <span className="admin-field-hint"> ({r.src.values.join(', ')})</span> : null}</td>
                <td>{t(`admin.variables.trust.${r.src.trust}`)}{r.src.describesPerson && <div className="admin-field-hint">{t('admin.variables.describesPerson')}</div>}</td>
                <td>{t(r.src.mayDecide ? 'admin.variables.decidesYes' : 'admin.variables.decidesNo')}</td>
                <td>
                  <button type="button" className="btn-secondary" disabled={!!refusal} data-testid={`${id}-pick`}
                    aria-label={t('admin.variables.pick', { name: r.name })} onClick={() => onPick(r.name, r.src)}>
                    {t('admin.variables.pickButton')}
                  </button>
                  {refusal && <div className="admin-field-hint" data-testid={`${id}-why`}>{t(refusal)}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
};

export default VariablePicker;
