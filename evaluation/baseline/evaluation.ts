import { type GeneratedDataset } from '../generator/temporal-dataset.js';
import {
  type BaselineConfig,
  type DetectorRun,
  type EvaluationPeriod,
  type NaiveThresholdConfig,
  type WindowObservation,
  buildWindowObservations,
  periodFromDataset,
  runBaseline,
  runNaiveThreshold,
  truthPhaseAtWindow,
} from './detector.js';

export { periodFromDataset } from './detector.js';

export type DegradationEpisode = {
  merchantId: string;
  startWindow: number;
  endWindowExclusive: number;
};

export type EpisodeDetection = {
  episode: DegradationEpisode;
  alertWindow: number | null;
  leadTimeMinutes: number | null;
};

export type EvaluationMetrics = {
  period: string;
  merchants: number;
  episodes: number;
  episodesDetected: number;
  episodesMissed: number;
  falseEpisodes: number;
  alerts: number;
  precision: number;
  recall: number;
  f1: number;
  falseAlertRate: number;
  alertsPerMerchant: number;
  duplicateDebouncedSignals: number;
  prePeriodAlertsUsed: number;
  medianLeadTimeMinutes: number | null;
  meanLeadTimeMinutes: number | null;
  targetLeadTimeAttainment: number;
  stableWindows: number;
  episodeDetails: EpisodeDetection[];
};

export type TuningResult = {
  selectedConfiguration: BaselineConfig;
  validationMetrics: EvaluationMetrics;
  selectionObjective: number;
};

export type NaiveTuningResult = {
  selectedConfiguration: NaiveThresholdConfig;
  validationMetrics: EvaluationMetrics;
};

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function buildWindowObservationsForTarget(
  dataset: GeneratedDataset,
): Map<string, WindowObservation[]> {
  return buildWindowObservations(dataset);
}

export function buildDegradationEpisodes(dataset: GeneratedDataset): DegradationEpisode[] {
  const episodes: DegradationEpisode[] = [];

  const merchantIntervals = new Map<string, typeof dataset.truth.degradationIntervals>();
  dataset.truth.degradationIntervals
    .filter((interval) => interval.phase === 'degraded' || interval.phase === 'severe')
    .forEach((interval) => {
      const intervals = merchantIntervals.get(interval.merchantId) ?? [];
      intervals.push(interval);
      merchantIntervals.set(interval.merchantId, intervals);
    });

  for (const [merchantId, intervals] of merchantIntervals) {
    intervals.sort((first, second) => first.startWindow - second.startWindow);
    for (const interval of intervals) {
      const previous = episodes[episodes.length - 1];
      if (
        previous &&
        previous.merchantId === merchantId &&
        previous.endWindowExclusive >= interval.startWindow
      ) {
        previous.endWindowExclusive = Math.max(
          previous.endWindowExclusive,
          interval.endWindowExclusive,
        );
      } else {
        episodes.push({
          merchantId,
          startWindow: interval.startWindow,
          endWindowExclusive: interval.endWindowExclusive,
        });
      }
    }
  }

  return episodes;
}

function metricFor(
  dataset: GeneratedDataset,
  run: DetectorRun,
  period: EvaluationPeriod,
  merchantIds: Set<string>,
): EvaluationMetrics {
  const horizonWindows = Math.ceil(
    dataset.truth.targetSpec.predictionHorizonMinutes / dataset.metadata.windowMinutes,
  );
  const episodes = buildDegradationEpisodes(dataset).filter(
    (episode) =>
      merchantIds.has(episode.merchantId) &&
      episode.endWindowExclusive > period.startWindow &&
      episode.startWindow < period.endWindowExclusive,
  );
  const scopeStart = Math.max(0, period.startWindow - horizonWindows);
  const candidateAlerts = run.alerts.filter(
    (alert) => merchantIds.has(alert.merchantId) && alert.windowIndex < period.endWindowExclusive,
  );
  const scopedAlerts = candidateAlerts.filter((alert) => alert.windowIndex >= period.startWindow);
  const episodeDetails = episodes.map((episode) => {
    const matchingAlert = candidateAlerts
      .filter(
        (alert) =>
          alert.merchantId === episode.merchantId &&
          alert.windowIndex >= Math.max(0, episode.startWindow - horizonWindows) &&
          alert.windowIndex < episode.endWindowExclusive,
      )
      .sort((first, second) => first.windowIndex - second.windowIndex)[0];
    return {
      episode,
      alertWindow: matchingAlert?.windowIndex ?? null,
      leadTimeMinutes:
        matchingAlert === undefined
          ? null
          : (episode.startWindow - matchingAlert.windowIndex) * dataset.metadata.windowMinutes,
    };
  });
  const matchedAlertKeys = new Set(
    episodeDetails
      .filter((detail) => detail.alertWindow !== null)
      .map((detail) => `${detail.episode.merchantId}:${detail.alertWindow}`),
  );
  const falseAlerts = scopedAlerts.filter(
    (alert) => !matchedAlertKeys.has(`${alert.merchantId}:${alert.windowIndex}`),
  );
  let stableWindows = 0;
  for (const merchantId of merchantIds) {
    for (let windowIndex = scopeStart; windowIndex < period.endWindowExclusive; windowIndex += 1) {
      if (truthPhaseAtWindow(dataset, merchantId, windowIndex) === 'normal') stableWindows += 1;
    }
  }
  const leadTimes = episodeDetails
    .map((detail) => detail.leadTimeMinutes)
    .filter((leadTime): leadTime is number => leadTime !== null);
  const episodesDetected = leadTimes.length;
  const precision = ratio(episodesDetected, episodesDetected + falseAlerts.length);
  const recall = ratio(episodesDetected, episodes.length);

  return {
    period: period.name,
    merchants: merchantIds.size,
    episodes: episodes.length,
    episodesDetected,
    episodesMissed: episodes.length - episodesDetected,
    falseEpisodes: falseAlerts.length,
    alerts: scopedAlerts.length,
    precision,
    recall,
    f1: ratio(2 * precision * recall, precision + recall),
    falseAlertRate: ratio(falseAlerts.length, stableWindows),
    alertsPerMerchant: ratio(scopedAlerts.length, merchantIds.size),
    duplicateDebouncedSignals: run.debouncedSignals,
    prePeriodAlertsUsed: candidateAlerts.length - scopedAlerts.length,
    medianLeadTimeMinutes: median(leadTimes),
    meanLeadTimeMinutes: mean(leadTimes),
    targetLeadTimeAttainment: ratio(
      leadTimes.filter((leadTime) => leadTime >= dataset.truth.targetSpec.leadTimeTargetMinutes)
        .length,
      episodesDetected,
    ),
    stableWindows,
    episodeDetails,
  };
}

export function evaluateBaseline(
  dataset: GeneratedDataset,
  observations: Map<string, WindowObservation[]>,
  config: BaselineConfig,
  period: EvaluationPeriod,
  merchantIds = new Set(dataset.metadata.merchantIds),
): EvaluationMetrics {
  return metricFor(dataset, runBaseline(observations, config), period, merchantIds);
}

export function evaluateNaive(
  dataset: GeneratedDataset,
  observations: Map<string, WindowObservation[]>,
  config: NaiveThresholdConfig,
  period: EvaluationPeriod,
  merchantIds = new Set(dataset.metadata.merchantIds),
): EvaluationMetrics {
  return metricFor(dataset, runNaiveThreshold(observations, config), period, merchantIds);
}

export function tuneBaseline(
  dataset: GeneratedDataset,
  observations: Map<string, WindowObservation[]>,
): TuningResult {
  const validation = periodFromDataset(dataset, 'validation');
  const candidates: BaselineConfig[] = [];
  for (const alpha of [0.2, 0.35, 0.5]) {
    for (const ewmaThreshold of [1.4, 1.8, 2.2]) {
      for (const cusumThreshold of [2.4, 3, 3.6]) {
        for (const cusumReference of [0.35, 0.5, 0.75, 1]) {
          for (const minimumPersistence of [2, 3]) {
            candidates.push({
              ...{
                alpha,
                ewmaThreshold,
                cusumThreshold,
                minimumPersistence,
              },
              cusumReference,
              cooldownWindows: 6,
              resetThreshold: 0.45,
              resetPersistence: 3,
              failureWeight: 0.7,
              latencyWeight: 0.3,
              baselineWarmupWindows: 12,
            });
          }
        }
      }
    }
  }

  const scored = candidates.map((candidate) => {
    const metrics = evaluateBaseline(dataset, observations, candidate, validation);
    const objective =
      metrics.f1 - 0.25 * metrics.falseAlertRate + 0.1 * metrics.targetLeadTimeAttainment;
    return { candidate, metrics, objective };
  });
  const selected = scored.sort((first, second) => second.objective - first.objective)[0]!;

  return {
    selectedConfiguration: selected.candidate,
    validationMetrics: selected.metrics,
    selectionObjective: selected.objective,
  };
}

export function tuneNaive(
  dataset: GeneratedDataset,
  observations: Map<string, WindowObservation[]>,
): NaiveTuningResult {
  const validation = periodFromDataset(dataset, 'validation');
  const candidates: NaiveThresholdConfig[] = [0.06, 0.08, 0.1, 0.12, 0.15, 0.18].flatMap(
    (threshold) =>
      [2, 3].map((minimumPersistence) => ({
        threshold,
        minimumPersistence,
        cooldownWindows: 6,
        resetPersistence: 3,
      })),
  );
  const selected = candidates
    .map((candidate) => ({
      candidate,
      metrics: evaluateNaive(dataset, observations, candidate, validation),
    }))
    .sort(
      (first, second) =>
        second.metrics.f1 -
        0.25 * second.metrics.falseAlertRate -
        (first.metrics.f1 - 0.25 * first.metrics.falseAlertRate),
    )[0]!;
  return {
    selectedConfiguration: selected.candidate,
    validationMetrics: selected.metrics,
  };
}

export function knownAndUnseenMerchantSets(dataset: GeneratedDataset): {
  known: Set<string>;
  unseen: Set<string>;
} {
  const unseen = new Set(dataset.splits.merchantHoldout);
  return {
    known: new Set(dataset.metadata.merchantIds.filter((merchantId) => !unseen.has(merchantId))),
    unseen,
  };
}

export function evaluateKnownAndUnseen(
  dataset: GeneratedDataset,
  observations: Map<string, WindowObservation[]>,
  config: BaselineConfig,
): { known: EvaluationMetrics; unseen: EvaluationMetrics } {
  const period = periodFromDataset(dataset, 'test');
  const merchants = knownAndUnseenMerchantSets(dataset);
  return {
    known: evaluateBaseline(dataset, observations, config, period, merchants.known),
    unseen: evaluateBaseline(dataset, observations, config, period, merchants.unseen),
  };
}
