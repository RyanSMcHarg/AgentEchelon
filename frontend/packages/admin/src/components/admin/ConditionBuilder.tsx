/**
 * A CONDITION, BUILT FROM DECLARED VARIABLES (ADR-060 decision 6), for every place a version gates: a workflow step and
 * its edges, a message's choice of template, and a routing rule.
 *
 * A condition is `{ <variable>: <value> }` or `{ <variable>: { op, value } }`, keys joined by AND, and a list of such
 * clauses is joined by OR. There is no expression language. A variable is added through the picker in its `decide`
 * mode, which does not offer member text, nor a fact about a person where the room reads what the condition selects.
 * The operators offered are the ones its type takes. Every reason the server refuses the condition is shown under it,
 * from the server's own `whenErrors` over the classification's served table, so what is accepted here is accepted there.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  whenErrors,
  type PickableSource,
  type PublishedVariables,
  type Scalar,
  type VariableType,
  type VersionVariable,
  type When,
  type WhenOperator,
  type WhenTest,
} from '../../../../../../backend/lambda/src/lib/variables.ts';
import VariablePicker, { consoleLookup } from './VariablePicker';

type T = (key: string, opts?: Record<string, unknown>) => string;

/** One test of a clause, as the builder edits it. */
export interface ConditionRow { key: string; op: WhenOperator; value?: Scalar | Scalar[] }

/** The operators a variable's type takes (decision 6): `has` on a set, `gt`/`lt` on a number, and never `gt`/`lt` on an enum. */
export function operatorsFor(type: VariableType | undefined): WhenOperator[] {
  if (type === 'set' || type === 'person-list') return ['has', 'exists'];
  if (type === 'number') return ['eq', 'ne', 'in', 'gt', 'lt', 'exists'];
  return ['eq', 'ne', 'in', 'exists'];
}

const isTest = (raw: unknown): raw is WhenTest => !!raw && typeof raw === 'object' && !Array.isArray(raw) && 'op' in (raw as object);

/** A condition as alternatives of rows: a clause is one alternative, a list is several. */
export function rowsOf(when: When | undefined): ConditionRow[][] {
  if (when === undefined) return [];
  const clauses = Array.isArray(when) ? when : [when];
  return clauses.map((c) => Object.entries(c ?? {}).map(([key, raw]) => (isTest(raw)
    ? { key, op: raw.op, ...(raw.value !== undefined ? { value: raw.value as Scalar | Scalar[] } : {}) }
    : { key, op: 'eq' as const, value: raw as Scalar })));
}

/** The condition the rows make: a bare value for `eq`, one clause for one alternative, nothing when no row is left. */
export function whenOf(alternatives: ConditionRow[][]): When | undefined {
  const clauses = alternatives.filter((rows) => rows.length).map((rows) => Object.fromEntries(rows.map((r) => [r.key,
    r.op === 'eq' && r.value !== undefined && !Array.isArray(r.value) ? r.value
      : { op: r.op, ...(r.op === 'exists' || r.value === undefined ? {} : { value: r.value }) }])));
  if (!clauses.length) return undefined;
  return clauses.length === 1 ? clauses[0] : clauses;
}

/** A typed value from what was entered, by the variable's type. */
export function typedValue(type: VariableType | undefined, raw: string): Scalar {
  if (type === 'number') return Number(raw);
  if (type === 'boolean') return raw === 'true';
  return raw;
}

/** A fresh row for a variable: the first operator its type takes, and the first declared value where it has some. */
function freshRow(name: string, src: PickableSource): ConditionRow {
  const op = operatorsFor(src.type)[0];
  if (src.type === 'boolean') return { key: name, op, value: true };
  if (src.values?.length) return { key: name, op, value: src.values[0] };
  if (src.type === 'number') return { key: name, op, value: 0 };
  return { key: name, op, value: '' };
}

const ConditionBuilder: React.FC<{
  value: When | undefined;
  onChange: (next: When | undefined) => void;
  published?: PublishedVariables;
  variables?: Readonly<Record<string, VersionVariable>>;
  /** Who reads what the condition selects (decision 7). */
  selects: 'room' | 'addressed';
  /** The event a workflow condition runs at, which an `event:` field must exist at. */
  event?: string;
  only?: (src: PickableSource) => boolean;
  hiddenNote?: string;
  testId: string;
}> = ({ value, onChange, published, variables, selects, event, only, hiddenNote, testId }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const lookup = consoleLookup(published, variables);
  const alternatives = rowsOf(value);
  const set = (next: ConditionRow[][]) => onChange(whenOf(next));
  const errors = value === undefined ? [] : whenErrors(value, lookup, { selects, ...(event ? { event } : {}) });

  const valueControl = (row: ConditionRow, onValue: (v: Scalar | Scalar[] | undefined) => void, id: string) => {
    const src = lookup(row.key);
    if (row.op === 'exists') return null;
    if (row.op === 'in') {
      const list = Array.isArray(row.value) ? row.value : row.value !== undefined && row.value !== '' ? [row.value] : [];
      return (
        <input type="text" className="input" data-testid={`${id}-value`} aria-label={t('admin.conditions.valueList')} value={list.join(', ')}
          onChange={(e) => onValue(e.target.value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => typedValue(src?.type, s)))} />
      );
    }
    const scalar = Array.isArray(row.value) ? row.value[0] : row.value;
    if (src?.type === 'boolean') {
      return (
        <select className="select" data-testid={`${id}-value`} aria-label={t('admin.conditions.value')} value={String(scalar ?? true)}
          onChange={(e) => onValue(e.target.value === 'true')}>
          <option value="true">{t('admin.conditions.true')}</option>
          <option value="false">{t('admin.conditions.false')}</option>
        </select>
      );
    }
    if (src?.values?.length) {
      return (
        <select className="select" data-testid={`${id}-value`} aria-label={t('admin.conditions.value')} value={String(scalar ?? '')}
          onChange={(e) => onValue(e.target.value)}>
          {!src.values.includes(String(scalar)) && <option value={String(scalar ?? '')}>{String(scalar ?? '')}</option>}
          {src.values.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      );
    }
    return (
      <input type={src?.type === 'number' ? 'number' : 'text'} className="input" data-testid={`${id}-value`} aria-label={t('admin.conditions.value')}
        value={String(scalar ?? '')} onChange={(e) => onValue(typedValue(src?.type, e.target.value))} />
    );
  };

  return (
    <div className="admin-condition" data-testid={testId}>
      {alternatives.length === 0 && <span className="admin-field-hint" data-testid={`${testId}-always`}>{t('admin.conditions.always')}</span>}
      {alternatives.map((rows, a) => (
        <div key={a} className="admin-condition-alternative" data-testid={`${testId}-alt-${a}`}>
          {a > 0 && <span className="admin-field-label">{t('admin.conditions.or')}</span>}
          {rows.map((row, r) => {
            const id = `${testId}-alt-${a}-row-${r}`;
            const src = lookup(row.key);
            const update = (next: ConditionRow | undefined) => set(alternatives.map((rs, i) => (i !== a ? rs
              : next ? rs.map((x, j) => (j === r ? next : x)) : rs.filter((_, j) => j !== r))));
            return (
              <div key={id} className="admin-filter-group" data-testid={id}>
                {r > 0 && <span className="admin-field-hint">{t('admin.conditions.and')}</span>}
                <code>{row.key}</code>
                <select className="select" data-testid={`${id}-op`} aria-label={t('admin.conditions.operator')} value={row.op}
                  onChange={(e) => {
                    const op = e.target.value as WhenOperator;
                    update(op === 'exists' ? { key: row.key, op } : { ...row, op });
                  }}>
                  {operatorsFor(src?.type).map((op) => <option key={op} value={op}>{t(`admin.conditions.op.${op}`)}</option>)}
                </select>
                {valueControl(row, (v) => update({ ...row, ...(v === undefined ? {} : { value: v }) }), id)}
                <button type="button" className="btn-secondary" data-testid={`${id}-remove`} onClick={() => update(undefined)}>
                  {t('admin.conditions.remove')}
                </button>
              </div>
            );
          })}
          <VariablePicker published={published} variables={variables} purpose="decide" audience={selects} only={only} hiddenNote={hiddenNote}
            testId={`${testId}-alt-${a}-picker`}
            onPick={(name, src) => set(alternatives.map((rs, i) => (i === a ? [...rs.filter((x) => x.key !== name), freshRow(name, src)] : rs)))} />
        </div>
      ))}
      <div className="admin-filter-group">
        {alternatives.length === 0 ? (
          <VariablePicker published={published} variables={variables} purpose="decide" audience={selects} only={only} hiddenNote={hiddenNote}
            testId={`${testId}-picker`} onPick={(name, src) => set([[freshRow(name, src)]])} />
        ) : (
          <>
            <span className="admin-field-label">{t('admin.conditions.addAlternative')}</span>
            <VariablePicker published={published} variables={variables} purpose="decide" audience={selects} only={only} hiddenNote={hiddenNote}
              testId={`${testId}-or-picker`} onPick={(name, src) => set([...alternatives, [freshRow(name, src)]])} />
          </>
        )}
      </div>
      {errors.length > 0 && (
        <ul role="alert" data-testid={`${testId}-errors`}>
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
    </div>
  );
};

export default ConditionBuilder;
