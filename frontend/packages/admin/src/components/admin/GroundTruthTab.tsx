import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import { InfoTooltip, GuideLinks, guide } from './AdminHelp';
import type { AnalyticsResult } from '@ae/shared';
import JudgeCalibrationPanel from './JudgeCalibrationPanel';
import GoldenSetPanel, { nominateToGoldenSet } from './GoldenSetPanel';

/** A label's compliance and groundedness halves (SPEC-EVALUATION Appendix C4). Absent means "not judged". */
export interface LabelHalves {
  isCompliant?: boolean;
  complianceCategories?: string[];
  isGrounded?: boolean;
}

interface GroundTruthTabProps {
  data: AnalyticsResult | null;
  isLoading: boolean;
  onSubmitScore?: (exchangeId: string, score: number, classification: string, reasoning: string, halves?: LabelHalves) => void;
  /** Open a conversation's detail (Conversations tab) from a scored exchange. */
  onOpenConversation?: (channelArn: string) => void;
}

const triState = (v: string): boolean | undefined => (v === 'true' ? true : v === 'false' ? false : undefined);

function deltaColor(delta: number): string {
  const abs = Math.abs(delta);
  if (abs <= 5) return 'var(--status-good)';   // close agreement
  if (abs <= 15) return 'var(--status-warn)';  // moderate disagreement
  return 'var(--status-bad)';                  // significant disagreement
}

const GroundTruthTab: React.FC<GroundTruthTabProps> = ({ data, isLoading, onSubmitScore, onOpenConversation }) => {
  const { t } = useTranslation();
  const [showScoring, setShowScoring] = useState(false);
  // The answer being labeled, when the form was opened from it (FR14), so the person sees what they judge.
  const [labeling, setLabeling] = useState<{ request: string; answer: string } | null>(null);
  // Bumped after a label or a nomination, so the queue and the set reload.
  const [refreshKey, setRefreshKey] = useState(0);
  const [nominateNotice, setNominateNotice] = useState<string | null>(null);
  const nominate = async (exchangeId: string, purpose: 'regression' | 'capability') => {
    setNominateNotice(null);
    try {
      await nominateToGoldenSet(exchangeId, purpose);
      setNominateNotice(t('admin.goldenSet.nominated'));
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setNominateNotice(err instanceof Error ? err.message : String(err));
    }
  };
  const [scoreForm, setScoreForm] = useState({
    exchangeId: '',
    score: 50,
    classification: 'acceptable',
    reasoning: '',
    compliance: '',
    ruleIds: '',
    grounded: '',
  });

  if (isLoading) {
    return <div className="admin-tab-loading">{t('admin.groundTruth.loadingGroundTruthData')}</div>;
  }

  const rows = data?.data ?? [];

  return (
    <div className="admin-tab">
      <div className="admin-tab-header">
        {/* The how-to and the reading of the two numbers are a hint. The position on whether the
            judge can be calibrated at all, and what a labeling program would cost, is SPEC-EVALUATION,
            "Where this sits against the industry bar" - too long for a page and too important to
            paraphrase here. */}
        <h3>
          {t('admin.groundTruth.groundTruthCalibration')}
          <InfoTooltip
            label={t('admin.groundTruth.howCalibrationIsMeasuredHere')}
            content={t('admin.groundTruth.howItWorks')}
          />
        </h3>
        {onSubmitScore && (
          <button
            className="btn-primary"
            onClick={() => setShowScoring(!showScoring)}
          >
            {showScoring ? 'Hide Scoring Form' : t('admin.groundTruth.scoreAnExchange')}
          </button>
        )}
      </div>

      <p className="admin-tab-description">
        How closely the automated evaluator's scores track human judgment.
      </p>
      <GuideLinks guides={[
        guide(t('admin.guides.groundTruth.spec'), 'evaluationSpec'),
        guide(t('admin.guides.evaluations.design'), 'evaluationDesign'),
      ]} />

      {/* Per rubric and per assistant, with its population and the people-to-people agreement beside it.
          The pooled error and agreement this replaced named no assistant and no population. */}
      <JudgeCalibrationPanel />
      <GoldenSetPanel
        canWrite={!!onSubmitScore}
        refreshKey={refreshKey}
        onLabel={(row) => {
          setScoreForm({ ...scoreForm, exchangeId: String(row.exchange_id ?? '') });
          setLabeling({ request: String(row.user_message ?? ''), answer: String(row.agent_response ?? '') });
          setShowScoring(true);
        }}
      />
      {nominateNotice && <p className="admin-help-text" role="status">{nominateNotice}</p>}

      {showScoring && onSubmitScore && (
        <div className="admin-scoring-form">
          <h4>{t('admin.groundTruth.submitHumanScore')}</h4>
          {labeling && (
            <div className="admin-help-text">
              <p><strong>{t('admin.goldenSet.column.request')}:</strong> {labeling.request}</p>
              <p><strong>{t('admin.goldenSet.column.answer')}:</strong> {labeling.answer}</p>
            </div>
          )}
          <div className="admin-form-grid">
            <label>
              {t('admin.groundTruth.exchangeId')}
              <input
                type="text"
                className="input"
                value={scoreForm.exchangeId}
                onChange={(e) => setScoreForm({ ...scoreForm, exchangeId: e.target.value })}
                // The old placeholder said "from evaluations tab", which cannot be followed: the
                // Evaluations tab is ATHENA-ONLY and Ground Truth is AURORA-ONLY, so anybody reading
                // this is in a mode where that tab is not in the nav at all. The reachable source is
                // the Effectiveness drill, which renders under Performance as "Evaluation".
                // (Asking for an id at all is the deeper problem - this form should open from the
                // exchange being scored rather than making somebody carry an id across tabs.)
                placeholder={t('admin.groundTruth.exchangeIdFromPerformanceEvaluation')}
              />
            </label>
            <label>
              Score (0-100):
              <input
                type="number"
                className="input"
                min={0}
                max={100}
                value={scoreForm.score}
                onChange={(e) => setScoreForm({ ...scoreForm, score: Number(e.target.value) })}
              />
            </label>
            <label>
              Classification:
              <select
                className="select input"
                value={scoreForm.classification}
                onChange={(e) => setScoreForm({ ...scoreForm, classification: e.target.value })}
              >
                <option value="excellent">{t('admin.groundTruth.excellent')}</option>
                <option value="good">{t('admin.groundTruth.good')}</option>
                <option value="acceptable">{t('admin.groundTruth.acceptable')}</option>
                <option value="poor">{t('admin.groundTruth.poor')}</option>
                <option value="appropriate_refusal">{t('admin.groundTruth.appropriateRefusal')}</option>
                <option value="error_response">{t('admin.groundTruth.errorResponse')}</option>
              </select>
            </label>
            <label>
              {t('admin.groundTruth.compliance')}
              <select
                className="select input"
                value={scoreForm.compliance}
                onChange={(e) => setScoreForm({ ...scoreForm, compliance: e.target.value })}
              >
                <option value="">{t('admin.groundTruth.complianceUnset')}</option>
                <option value="true">{t('admin.groundTruth.compliant')}</option>
                <option value="false">{t('admin.groundTruth.breached')}</option>
              </select>
            </label>
            {scoreForm.compliance === 'false' && (
              <label>
                {t('admin.groundTruth.ruleIds')}
                <input
                  type="text"
                  className="input"
                  value={scoreForm.ruleIds}
                  onChange={(e) => setScoreForm({ ...scoreForm, ruleIds: e.target.value })}
                />
              </label>
            )}
            <label>
              {t('admin.groundTruth.grounded')}
              <select
                className="select input"
                value={scoreForm.grounded}
                onChange={(e) => setScoreForm({ ...scoreForm, grounded: e.target.value })}
              >
                <option value="">{t('admin.groundTruth.groundedUnset')}</option>
                <option value="true">{t('admin.groundTruth.groundedYes')}</option>
                <option value="false">{t('admin.groundTruth.groundedNo')}</option>
              </select>
            </label>
            <label>
              Reasoning:
              <textarea
                className="textarea input"
                value={scoreForm.reasoning}
                onChange={(e) => setScoreForm({ ...scoreForm, reasoning: e.target.value })}
                placeholder={t('admin.groundTruth.whyDidYouAssignThis')}
                rows={3}
              />
            </label>
          </div>
          <button
            className="btn-primary"
            onClick={() => {
              const isCompliant = triState(scoreForm.compliance);
              onSubmitScore(scoreForm.exchangeId, scoreForm.score, scoreForm.classification, scoreForm.reasoning, {
                ...(isCompliant !== undefined ? { isCompliant } : {}),
                ...(isCompliant === false ? { complianceCategories: scoreForm.ruleIds.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
                ...(triState(scoreForm.grounded) !== undefined ? { isGrounded: triState(scoreForm.grounded) } : {}),
              });
              setScoreForm({ exchangeId: '', score: 50, classification: 'acceptable', reasoning: '', compliance: '', ruleIds: '', grounded: '' });
              setShowScoring(false);
              setLabeling(null);
              setRefreshKey((k) => k + 1);
            }}
            disabled={!scoreForm.exchangeId || !scoreForm.reasoning}
          >
            Submit Score
          </button>
        </div>
      )}

      <DataTable
        columns={[
          { key: 'scored_at', label: 'Date', render: (v) => new Date(String(v)).toLocaleDateString() },
          { key: 'exchange_id', label: 'Exchange', render: (v) => String(v).substring(0, 8) + '...' },
          { key: 'classification', label: 'Classification' },
          {
            key: 'human_score',
            label: 'Human Score',
            render: (v) => <span style={{ fontWeight: 700 }}>{Number(v).toFixed(0)}</span>,
          },
          {
            key: 'automated_score',
            label: 'Automated',
            // Null when the exchange has no automated evaluation yet (LEFT JOIN) — show a dash,
            // not NaN.
            render: (v) =>
              v == null || Number.isNaN(Number(v))
                ? <span style={{ opacity: 0.5 }}>—</span>
                : <span style={{ fontWeight: 600 }}>{Number(v).toFixed(0)}</span>,
          },
          {
            key: 'score_delta',
            label: 'Delta',
            // Delta is null when there is no automated score to compare against (human - null).
            // Show a dash rather than NaN.
            render: (v) => {
              if (v == null || Number.isNaN(Number(v))) {
                return <span style={{ opacity: 0.5 }}>—</span>;
              }
              const delta = Number(v);
              return (
                <span style={{ color: deltaColor(delta), fontWeight: 600 }}>
                  {delta > 0 ? '+' : ''}{delta.toFixed(0)}
                </span>
              );
            },
          },
          { key: 'scorer_id', label: 'Scorer' },
          {
            key: 'nominate',
            label: t('admin.goldenSet.keep'),
            sortable: false,
            render: (_v, row) => (onSubmitScore ? (
              <span>
                {Number(row.human_score) >= 50 && (
                  <button className="btn-secondary" onClick={() => nominate(String(row.exchange_id), 'regression')}>
                    {t('admin.goldenSet.keepRegression')}
                  </button>
                )}{' '}
                <button className="btn-secondary" onClick={() => nominate(String(row.exchange_id), 'capability')}>
                  {t('admin.goldenSet.keepCapability')}
                </button>
              </span>
            ) : null),
          },
          {
            key: 'channel_arn',
            label: 'Conversation',
            sortable: false,
            // Deep-link to the conversation this exchange belongs to. channel_arn is
            // returned by the ground_truth query; absent on older rows → no link.
            render: (v) =>
              v && onOpenConversation ? (
                <button className="btn-secondary" onClick={() => onOpenConversation(String(v))}>
                  Open
                </button>
              ) : (
                <span style={{ opacity: 0.5 }}>—</span>
              ),
          },
        ]}
        data={rows}
        emptyMessage={t('admin.groundTruth.noGroundTruthScoresSubmitted')}
      />

      {/* The classification shadow gate (DESIGN §5). It lives here because it is the same act as the
          scoring above - a human deciding what the correct answer was - applied to intent LABELS
          rather than to answer quality, and both feed evaluation rather than routing. */}
      {/* THE CLASSIFIER ACCURACY GATE MOVED TO EXPERIMENTS.
          It is not a labelling surface: it is the evidence somebody reads to DECIDE whether to
          change a classifier, which is an experiment decision. It sat here because it shares the
          adjudication machinery with ground-truth labelling, which is a reason about
          implementation rather than about what an operator came to this tab to do. */}
    </div>
  );
};

export default GroundTruthTab;
