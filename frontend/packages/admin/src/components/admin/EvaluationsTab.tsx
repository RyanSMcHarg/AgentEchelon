import React from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import MetricCard from './MetricCard';
import { InfoTooltip, GuideLinks, guide } from './AdminHelp';
import { METRIC_TARGETS, formatTarget } from './metricTargets';
import { modelDisplayName, type AnalyticsDateRange, type AnalyticsResult } from '@ae/shared';
import DeliveredDocumentsPanel from './DeliveredDocumentsPanel';

interface EvaluationsTabProps {
  data: AnalyticsResult | null;
  isLoading: boolean;
  /** The window the delivered-document scores are read over. Absent: the panel is not shown. */
  dateRange?: AnalyticsDateRange;
}

function scoreColor(score: number): string {
  if (score >= 75) return '#10b981';
  if (score >= 50) return '#f59e0b';
  return '#ef4444';
}

const EvaluationsTab: React.FC<EvaluationsTabProps> = ({ data, isLoading, dateRange }) => {
  const { t } = useTranslation();
  if (isLoading) {
    return <div className="admin-tab-loading">{t('admin.evaluations.loadingEvaluationData')}</div>;
  }

  const rows = data?.data ?? [];
  // Count-weighted average relevance across rows, for the target summary.
  const totalCount = rows.reduce((s, r) => s + Number(r.count || 0), 0);
  const avgRelevance = totalCount > 0
    ? rows.reduce((s, r) => s + Number(r.avg_relevance_score || 0) * Number(r.count || 0), 0) / totalCount
    : 0;

  // ── COMPLIANCE, AND THE COVERAGE THAT MAKES IT READABLE (DESIGN-EVALUATION, Pass C) ──
  //
  // A compliance rate over an unscored population is worse than no rate: it looks like a measurement.
  // So the denominator is the ASSESSED count, and it is rendered beside the number - the only way a
  // reader can tell "everything complied" from "nothing was looked at".
  //
  // Until Pass C has run over a window, `assessed` is 0 and the card says so instead of showing a
  // figure. This tab previously showed no compliance at all while the API computed one.
  const complianceAssessed = rows.reduce((s, r) => s + Number(r.compliance_assessed_count || 0), 0);
  const violations = rows.reduce((s, r) => s + Number(r.violation_count || 0), 0);
  // BLOCKING BREACHES ARE CALLED OUT SEPARATELY, because the rule set grades them and a single rate
  // throws that away. A week with two minor scope findings and a week with two disclosed card numbers
  // produce the same percentage; only this line tells them apart.
  const blocking = rows.reduce((s, r) => s + Number(r.blocking_violation_count || 0), 0);
  const complianceRate = complianceAssessed > 0
    ? ((complianceAssessed - violations) / complianceAssessed) * 100
    : null;

  // ── WHICH JUDGE PRODUCED THESE SCORES, AND WHETHER THERE IS ONE ANSWER TO THAT ──────────────────
  //
  // Tenet P3: the harness outlives the model, and a model is a replaceable function call, so swapping
  // the judge is an expected event rather than an edge case. Every score re-baselines when it happens,
  // and the tab showed nothing about it: a relevance average judged by one model and a relevance
  // average judged by its successor looked identical, so a fall in the number could be a regression in
  // the assistants or a different judge with no way to tell which. The rubric version already
  // segregates rows scored under different prompt wording; the model is the other axis, and the one
  // the evaluation runner records and every reader dropped.
  //
  // ABSENT IS NOT ONE JUDGE. Only the Aurora runner writes the evaluator model; the Athena runner
  // scores relevance alone and records none, so the fields do not arrive in that mode. Undefined
  // leaves both the name and the warning silent rather than asserting a single judge that is unknown.
  const judgeCount = Number(data?.evaluatorModelCount ?? 0);
  const judge = judgeCount === 1 && data?.evaluatorModel
    ? modelDisplayName(data.evaluatorModel) || data.evaluatorModel
    : null;

  return (
    <div className="admin-tab">
      {/* How the judge is prompted is a hint a reader needs once; the passes, the rubrics and the
          selection behind every figure belong to SPEC-EVALUATION and DESIGN-EVALUATION. */}
      <h3>
        {t('admin.evaluations.evaluationScores')}
        <InfoTooltip
          label={t('admin.evaluations.howTheseScoresAreProduced')}
          content={
            <>
              Each exchange - a user message plus the assistant's reply - is scored context-aware, with
              its preceding turns and, for a task turn, its task context, so a correct contextual reply
              is not penalized as if it were isolated. Rows group by day, assistant and intent, and the
              count is the number of exchanges in that group. Target:{' '}
              {t(METRIC_TARGETS.relevance_score.labelKey)} {formatTarget(METRIC_TARGETS.relevance_score)}{' '}
              (good).
            </>
          }
        />
      </h3>
      <p className="admin-tab-description">{t('admin.evaluations.description')}</p>
      <GuideLinks guides={[
        guide(t('admin.guides.evaluations.spec'), 'evaluationSpec'),
        guide(t('admin.guides.evaluations.design'), 'evaluationDesign'),
      ]} />
      {totalCount > 0 && (
        <div className="admin-metrics-row">
          <MetricCard
            title={t('admin.evaluations.avgRelevance')}
            value={avgRelevance.toFixed(1)}
            subtitle={`${totalCount.toLocaleString()} evaluations${judge ? ` · judged by ${judge}` : ''}`}
            target={METRIC_TARGETS.relevance_score}
            rawValue={avgRelevance}
          />
          {/* AN AVERAGE OVER TWO JUDGES IS NOT ONE NUMBER, and nothing else on this tab would say so.
              Shown only above one, for the reason the Effectiveness surface shows its rubric warning
              only above one: a notice that is always on is noise, and noise is why nobody reads the
              one time it matters. */}
          {judgeCount > 1 && (
            <MetricCard
              title={t('admin.evaluations.judgesInWindow')}
              value={judgeCount.toLocaleString()}
              subtitle={t('admin.evaluations.theAverageSpansMoreThan')}
            />
          )}
          {/* COMPLIANCE IS A SEPARATE QUESTION FROM RELEVANCE, and is shown as one. A reply can
              address a request perfectly and still breach a rule, so the two never share a card. */}
          <MetricCard
            title={t('admin.evaluations.compliance')}
            value={complianceRate === null ? t('admin.evaluations.notAssessed') : `${complianceRate.toFixed(1)}%`}
            subtitle={
              complianceAssessed === 0
                ? t('admin.evaluations.0OfExchangesAssessed', { totalCount: totalCount.toLocaleString() })
                : `${violations.toLocaleString()} breach${violations === 1 ? '' : 'es'}`
                  + (blocking > 0 ? t('admin.evaluations.blocking', { blocking: blocking.toLocaleString() }) : '')
                  + t('admin.evaluations.inOfAssessed', { complianceAssessed: complianceAssessed.toLocaleString(), totalCount: totalCount.toLocaleString() })
            }
          />
        </div>
      )}
      <DataTable
        columns={[
          { key: 'date', label: 'Date' },
          { key: 'assistant', label: 'Assistant Type' },
          { key: 'intent_type', label: 'Intent' },
          {
            key: 'avg_relevance_score',
            label: 'Avg Score',
            render: (v) => {
              const score = Number(v);
              // v is null for a day-group whose exchanges aren't evaluated yet
              // (evaluation runs on a schedule). Show a dash, not NaN/0.0.
              if (!Number.isFinite(score)) {
                return <span style={{ opacity: 0.5 }}>&mdash;</span>;
              }
              return (
                <span style={{ color: scoreColor(score), fontWeight: 600 }}>
                  {score.toFixed(1)}
                </span>
              );
            },
          },
          {
            // THE JUDGE BEHIND THIS GROUP'S AVERAGE. A dash covers three cases that are all "not
            // known": a group whose exchanges are not scored yet, a row scored before the runner wrote
            // the column, and Athena mode, which records no judge at all. Printing a model name in any
            // of them would attribute a score to a model that may never have seen it.
            key: 'evaluator_model',
            label: 'Judge',
            render: (v, row) => {
              // A group spanning a model change has no single judge to print, so it says how many
              // rather than picking one.
              const distinct = Number(row.evaluator_model_count ?? 0);
              if (distinct > 1) {
                return <span title={t('admin.evaluations.thisDayAssistantAndIntent')}>{distinct} judges</span>;
              }
              if (v == null || v === '') return <span style={{ opacity: 0.5 }}>&mdash;</span>;
              return <span title={t('admin.evaluations.theModelThatJudgedThese', { v: String(v) })}>{modelDisplayName(String(v)) || String(v)}</span>;
            },
          },
          { key: 'count', label: 'Count' },
        ]}
        data={data?.data ?? []}
        emptyMessage={t('admin.evaluations.noEvaluationDataAvailableFor')}
      />
      {/* The scores above are the replies'. A delivered file's own grade is its own table (FR22). */}
      {dateRange && <DeliveredDocumentsPanel dateRange={dateRange} />}
    </div>
  );
};

export default EvaluationsTab;
