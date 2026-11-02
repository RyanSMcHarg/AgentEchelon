/**
 * THE UNIT OF ANALYSIS, ON SCREEN (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §4.2).
 *
 * An experiment holds an enrolled conversation to one arm while it is active, so its turns are correlated and every test the
 * backend runs counts conversations; the means are still taken over exchanges. An operator reading a
 * result needs both numbers, because "400 exchanges" and "12 conversations" are very different amounts of
 * evidence, and the verdict beside them is computed from the second.
 */
import { useTranslation } from 'react-i18next';
import type { ExperimentUnitsRow } from '@ae/shared';

/** One variant's sample in both units. */
export interface VariantUnitCounts {
  conversation_count: number;
  exchange_count: number;
}

/** The units of one experiment's variants, keyed by variant id. */
export function unitsForExperiment(
  rows: ExperimentUnitsRow[] | undefined,
  experimentId: string,
): Map<string, VariantUnitCounts> {
  const out = new Map<string, VariantUnitCounts>();
  for (const r of rows ?? []) {
    if (r.experiment_id !== experimentId) continue;
    out.set(r.variant_id, {
      conversation_count: Number(r.conversation_count) || 0,
      exchange_count: Number(r.exchange_count) || 0,
    });
  }
  return out;
}

/** "N conversations · M exchanges" for an experiment's header. */
export function SampleMeta({ variants }: { variants: Array<VariantUnitCounts | undefined> }) {
  const { t } = useTranslation();
  const present = variants.filter((v): v is VariantUnitCounts => !!v);
  const conversations = present.reduce((s, v) => s + v.conversation_count, 0);
  const exchanges = present.reduce((s, v) => s + v.exchange_count, 0);
  return (
    <span data-testid="exp-sample-meta">
      {t('admin.experiments.sampleMeta', {
        conversations: conversations.toLocaleString(),
        exchanges: exchanges.toLocaleString(),
      })}
    </span>
  );
}

/**
 * The cells of the comparison row stating each side's conversations, beside the exchanges row. The row
 * itself is the comparison's own sample row (`ExperimentsTab`), so it styles and aligns with its siblings.
 */
export function SampleConversationsCells({ control, treatment }: { control?: VariantUnitCounts; treatment?: VariantUnitCounts }) {
  const { t } = useTranslation();
  const fmt = (v?: VariantUnitCounts) => (v ? v.conversation_count.toLocaleString() : '—');
  return (
    <>
      <span className="exp-metric-val">{fmt(control)}</span>
      <span className="exp-metric-label" title={t('admin.experiments.unitOfAnalysisHint')}>{t('admin.experiments.sampleConversations')}</span>
      <span className="exp-metric-val">{fmt(treatment)}</span>
    </>
  );
}

/** The recommendation's unit line: what every figure on the card was tested in. */
export function UnitOfAnalysisNote({
  variants,
}: {
  variants?: Array<{ variant_id: string; conversation_count?: number; exchange_count: number }>;
}) {
  const { t } = useTranslation();
  const list = variants ?? [];
  const control = list.find((v) => v.variant_id === 'control') ?? list[0];
  const treatment = list.find((v) => v.variant_id === 'treatment') ?? list.find((v) => v !== control);
  if (!control || !treatment || control.conversation_count == null || treatment.conversation_count == null) return null;
  return (
    <div className="exp-reco-unit" data-testid="exp-reco-unit" title={t('admin.experiments.unitOfAnalysisHint')}>
      {t('admin.experiments.unitOfAnalysis', {
        controlConversations: control.conversation_count.toLocaleString(),
        controlExchanges: control.exchange_count.toLocaleString(),
        treatmentConversations: treatment.conversation_count.toLocaleString(),
        treatmentExchanges: treatment.exchange_count.toLocaleString(),
      })}
    </div>
  );
}

/** The smallest variant's conversations, for the floor and the "need more" prescription. */
export function smallestConversationCount(
  variants: Array<{ conversation_count?: number; exchange_count: number } | undefined>,
): number | null {
  const counts = variants
    .map((v) => v?.conversation_count)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  return counts.length ? Math.min(...counts) : null;
}
