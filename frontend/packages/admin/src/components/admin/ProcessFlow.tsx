/**
 * A PROCESS AS A FLOW (SPEC-PROCESSES P1): its phases top to bottom, numbered in the order they run, each phase a card with its stages down it, each stage
 * naming the party that answers it, and the hand-offs between phases in order beneath. Nothing scrolls sideways.
 *
 * Everything shown is read from the version's own workflow definitions (`processChain.ts`): a phase is one workflow, a party is
 * who a stage's step names (a person's role and team, an assistant's role, or the platform), and a hand-off is the `open`
 * step one phase uses to start the next. Phases that run in parallel (a fork, or a phase alongside the one that opened it)
 * share one group, named by its range of phase numbers, side by side where the width holds them, and a join says, on the phase that declares it, which parts it waits for.
 * Selecting a stage says what it is for, who answers it, its deadline and where it runs, with the way to the workflow that
 * declares it.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { VersionProcess } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { phaseOf, processLayout, type PhaseJoin, type PhaseStage } from './processChain';

type T = (key: string, opts?: Record<string, unknown>) => string;

/** One party that acts in the process: its row's key, and how it is said. */
interface Lane { key: string; words: string }

/** A stage's selection key: its workflow and step. */
const keyOf = (workflow: string, step: string) => `${workflow}\u0000${step}`;

export const ProcessFlow: React.FC<{
  workflows: Record<string, unknown>;
  process: VersionProcess;
  /** Opens the version's Workflows section, where a stage's step is edited. */
  onOpenWorkflows?: () => void;
}> = ({ workflows, process, onOpenWorkflows }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const [selected, setSelected] = useState<string | null>(null);

  // THE PHASES IN RUN ORDER, parallel ones grouped side by side (`processLayout`).
  const layout = processLayout(workflows, process.workflows.filter((wf) => wf in workflows));
  const phases = layout.steps.flatMap((st) => st.phases).map((wf) => phaseOf(workflows, wf));
  const joinWords = (j: PhaseJoin) => t(j.when === 'any' ? 'admin.processes.wizard.joinAny' : 'admin.processes.wizard.joinAll', { stage: j.label ?? j.step, parts: j.parts.map((x) => x.words).join(', ') });
  // THE PARTIES, IN THE ORDER THEY FIRST ACT: a person by role and team, an assistant by its role, the platform last.
  const laneOf = (r: PhaseStage['responsible']): Lane => (r.kind === 'person'
    ? { key: `person:${r.role}:${r.team ?? ''}`, words: r.team ? t('admin.processes.who.person', { role: r.role, team: r.team }) : r.role }
    : r.kind === 'assistant'
      ? { key: `assistant:${r.role}`, words: t('admin.processes.wizard.assistantRole', { role: r.role }) }
      : { key: 'platform', words: t('admin.processes.who.platform') });
  const handoffs = phases.map((p) => layout.places[p.workflow]?.handoff);
  const handoffOf = (wf: string) => layout.places[wf]?.handoff;
  const numberOf = (wf: string) => phases.findIndex((p) => p.workflow === wf) + 1;
  const pick = phases.flatMap((p) => p.stages.map((s) => ({ phase: p, stage: s }))).find((x) => keyOf(x.phase.workflow, x.stage.step) === selected);

  if (!phases.length) return <p className="admin-muted">{t('admin.processes.flowView.none')}</p>;
  return (
    <div className="admin-process-flow" data-testid="process-flow-view">
      {/* TOP TO BOTTOM: one phase after another, each a card with its stages down it. Parallel phases stand side by
          side only where the width holds them, and wrap under each other where it does not, so nothing scrolls sideways. */}
      <ol className="admin-process-flow-steps" data-testid="process-flow-steps" aria-label={t('admin.processes.flowView.title', { label: process.label })}>
        {layout.steps.map((st, i) => (
          <li key={st.phases.join('|')} className="admin-process-flow-step" data-testid={`process-flow-group-${i + 1}`} data-phases={st.phases.length}>
            {st.phases.length > 1 && (
              <div className="admin-process-flow-step-head">
                <strong>{t('admin.processes.wizard.group', { count: st.phases.length, from: numberOf(st.phases[0]), to: numberOf(st.phases[st.phases.length - 1]) })}</strong>
              </div>
            )}
            <div className={st.phases.length > 1 ? PHASES_PARALLEL : PHASES}>
              {st.phases.map((wf) => phases.find((p) => p.workflow === wf)).filter((p): p is (typeof phases)[number] => !!p).map((p) => (
                <section key={p.workflow} className="admin-process-flow-phase" data-testid={`process-flow-phase-${p.workflow}`}>
                  <div className="admin-process-flow-phase-head">
                    <span className="admin-field-hint">{t('admin.processes.wizard.phaseN', { n: numberOf(p.workflow) })}</span>
                    <code>{p.workflow}</code>
                    <span className="admin-field-hint">{p.types.join(', ')}</span>
                    {handoffOf(p.workflow) && <span className="admin-process-flow-handin">{t('admin.processes.flowView.handedFrom', { from: handoffOf(p.workflow)!.from })}</span>}
                    {layout.places[p.workflow]?.alongsideOf && (
                      <span className="admin-process-flow-alongside" data-testid={`process-flow-alongside-${p.workflow}`}>
                        {t('admin.processes.wizard.runsAlongside', { workflow: layout.places[p.workflow].alongsideOf })}
                      </span>
                    )}
                    {layout.places[p.workflow]?.joins.map((j) => (
                      <span key={j.step} className="admin-process-flow-join" data-testid={`process-flow-join-${p.workflow}-${j.step}`}>{joinWords(j)}</span>
                    ))}
                  </div>
                  <ol className="admin-process-flow-stages">
                    {p.stages.map((s) => {
                      const k = keyOf(p.workflow, s.step);
                      const who = laneOf(s.responsible);
                      return (
                        <li key={s.step}>
                          <button type="button" className={k === selected ? STAGE_ON : STAGE_OFF} aria-pressed={k === selected}
                            data-testid={`process-flow-stage-${p.workflow}-${s.step}`} data-who={who.key} onClick={() => setSelected(k === selected ? null : k)}>
                            <span>{s.label}</span>
                            <span className="admin-field-hint">{who.words}</span>
                            {s.dueMinutes ? <span className="admin-field-hint">{t('admin.processes.wizard.due', { minutes: s.dueMinutes })}</span> : null}
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
            </div>
          </li>
        ))}
      </ol>

      {pick ? (
        <section className="admin-process-flow-detail" aria-live="polite" data-testid="process-flow-detail">
          <strong>{pick.stage.label}</strong>
          {pick.stage.description && <p>{pick.stage.description}</p>}
          <dl>
            <dt>{t('admin.processes.flowView.responsible')}</dt><dd>{laneOf(pick.stage.responsible).words}</dd>
            {pick.stage.dueMinutes ? <><dt>{t('admin.processes.flowView.deadline')}</dt><dd>{t('admin.processes.wizard.due', { minutes: pick.stage.dueMinutes })}</dd></> : null}
            <dt>{t('admin.processes.flowView.runsIn')}</dt><dd><code>{pick.phase.workflow}</code> {pick.phase.types.join(', ')}</dd>
            {layout.places[pick.phase.workflow]?.joins.filter((j) => j.step === pick.stage.step).map((j) => (
              <React.Fragment key={j.step}><dt>{t('admin.processes.flowView.joins')}</dt><dd>{joinWords(j)}</dd></React.Fragment>
            ))}
          </dl>
          {onOpenWorkflows && <button type="button" className="btn-link" data-testid="process-flow-edit" onClick={onOpenWorkflows}>{t('admin.processes.flowView.edit')}</button>}
        </section>
      ) : <p className="admin-field-hint">{t('admin.processes.flowView.pick')}</p>}

      {handoffs.some(Boolean) && (
        <section aria-labelledby="process-flow-handoffs" data-testid="process-flow-handoffs">
          <h5 id="process-flow-handoffs">{t('admin.processes.flowView.handoffs')}</h5>
          <ol className="admin-process-flow-handoffs">
            {handoffs.map((h) => h && (
              <li key={h.to}>
                <strong>{t('admin.processes.flowView.handoffLine', { from: h.from, to: h.to })}</strong>{' '}
                {t('admin.processes.wizard.whereValue', { type: h.type })}
                {h.ledBy && <>{'. '}{t('admin.processes.wizard.ledBy')}: {roleWords(h.ledBy, t)}</>}
                {'. '}{h.waits ? t('admin.processes.wizard.waits', { workflow: h.from }) : t('admin.processes.wizard.alongside')}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
};

/** A stage's button, selected and not. */
const STAGE_ON = ['admin-process-flow-stage', 'admin-process-flow-stage-on'].join(' ');
const STAGE_OFF = 'admin-process-flow-stage';
/** A group of phases, and a group whose phases run in parallel. */
const PHASES = 'admin-process-flow-step-phases';
const PHASES_PARALLEL = [PHASES, 'admin-process-flow-step-parallel'].join(' ');

/** A role as a conversation type declares it (`role:team`), in words. */
function roleWords(role: string, t: T): string {
  const [r, team] = role.split(':');
  const said = r.replace(/[-_]+/g, ' ');
  return team ? t('admin.processes.who.person', { role: said, team }) : said;
}

export default ProcessFlow;
