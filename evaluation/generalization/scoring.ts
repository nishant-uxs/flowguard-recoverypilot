import type { GeneratedDataset } from '../generator/temporal-dataset.js';
import {
  type BaselineSignal,
  type DetectorRun,
  type EvaluationPeriod,
} from '../baseline/detector.js';

export type HardeningPolicy = {
  predictionHorizonMinutes: number;
  usefulInterventionMinutes: number;
  targetLeadTimeMinutes: number;
  cooldownWindows: number;
};

export const DEFAULT_HARDENING_POLICY: HardeningPolicy = {
  predictionHorizonMinutes: 30,
  usefulInterventionMinutes: 30,
  targetLeadTimeMinutes: 10,
  cooldownWindows: 6,
};

export type GeneralizationEpisode = {
  merchantId: string;
  startWindow: number;
  endWindowExclusive: number;
};

export type MatchedEpisode = {
  episode: GeneralizationEpisode;
  alertWindow: number | null;
  leadTimeMinutes: number | null;
  timing: 'early' | 'late_useful' | 'missed';
  early5: boolean;
  early10: boolean;
  early20: boolean;
};

export type HardeningMetrics = {
  period: string;
  merchants: number;
  episodes: number;
  episodesDetected: number;
  episodesMissed: number;
  falseEpisodes: number;
  alerts: number;
  falseAlerts: number;
  duplicateDebouncedSignals: number;
  precision: number;
  recall: number;
  f1: number;
  falseAlertRate: number;
  alertsPerMerchant: number;
  stableWindows: number;
  lateDetections: number;
  p25LeadTimeMinutes: number | null;
  medianLeadTimeMinutes: number | null;
  p75LeadTimeMinutes: number | null;
  meanLeadTimeMinutes: number | null;
  percentDetectedAtLeast5MinutesEarly: number;
  percentDetectedAtLeast10MinutesEarly: number;
  percentDetectedAtLeast20MinutesEarly: number;
  leadTimeWeightedUtility: number;
  episodeDetails: MatchedEpisode[];
};

export type UtilityAssumptions = {
  falseAlertCost: number;
  missedEpisodeCost: number;
  earlyMinuteValue: number;
  maximumEarlyMinutesRewarded: number;
};

export const DEFAULT_UTILITY_ASSUMPTIONS: UtilityAssumptions = {
  falseAlertCost: 1,
  missedEpisodeCost: 5,
  earlyMinuteValue: 0.1,
  maximumEarlyMinutesRewarded: 30,
};

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((first, second) => first - second);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function episodesFor(
  dataset: GeneratedDataset,
  period: EvaluationPeriod,
  merchantIds: Set<string>,
): GeneralizationEpisode[] {
  const byMerchant = new Map<string, GeneralizationEpisode[]>();
  dataset.truth.degradationIntervals
    .filter(
      (interval) =>
        merchantIds.has(interval.merchantId) &&
        (interval.phase === 'degraded' || interval.phase === 'severe'),
    )
    .forEach((interval) => {
      const merchantEpisodes = byMerchant.get(interval.merchantId) ?? [];
      merchantEpisodes.push({
        merchantId: interval.merchantId,
        startWindow: interval.startWindow,
        endWindowExclusive: interval.endWindowExclusive,
      });
      byMerchant.set(interval.merchantId, merchantEpisodes);
    });

  const episodes: GeneralizationEpisode[] = [];
  for (const merchantEpisodes of byMerchant.values()) {
    merchantEpisodes.sort((first, second) => first.startWindow - second.startWindow);
    for (const episode of merchantEpisodes) {
      const previous = episodes[episodes.length - 1];
      if (
        previous &&
        previous.merchantId === episode.merchantId &&
        previous.endWindowExclusive >= episode.startWindow
      ) {
        previous.endWindowExclusive = Math.max(
          previous.endWindowExclusive,
          episode.endWindowExclusive,
        );
      } else {
        episodes.push(episode);
      }
    }
  }
  return episodes
    .filter(
      (episode) =>
        episode.startWindow >= period.startWindow &&
        episode.startWindow < period.endWindowExclusive,
    )
    .sort(
      (first, second) =>
        first.startWindow - second.startWindow || first.merchantId.localeCompare(second.merchantId),
    );
}

function signalsInPeriod(
  run: DetectorRun,
  period: EvaluationPeriod,
  merchantIds: Set<string>,
): BaselineSignal[] {
  return run.alerts
    .filter(
      (alert) =>
        merchantIds.has(alert.merchantId) &&
        alert.windowIndex >= period.startWindow &&
        alert.windowIndex < period.endWindowExclusive,
    )
    .sort(
      (first, second) =>
        first.windowIndex - second.windowIndex || first.merchantId.localeCompare(second.merchantId),
    );
}

function normalWindow(dataset: GeneratedDataset, merchantId: string, windowIndex: number): boolean {
  return !dataset.truth.degradationIntervals.some(
    (interval) =>
      interval.merchantId === merchantId &&
      (interval.phase === 'degraded' || interval.phase === 'severe') &&
      interval.startWindow <= windowIndex &&
      interval.endWindowExclusive > windowIndex,
  );
}

export function utilityForMetrics(
  metrics: Pick<HardeningMetrics, 'falseAlerts' | 'episodesMissed' | 'episodeDetails'>,
  assumptions: UtilityAssumptions = DEFAULT_UTILITY_ASSUMPTIONS,
): number {
  const earlyValue = metrics.episodeDetails.reduce((sum, detail) => {
    const lead = Math.max(
      0,
      Math.min(detail.leadTimeMinutes ?? 0, assumptions.maximumEarlyMinutesRewarded),
    );
    return sum + lead * assumptions.earlyMinuteValue;
  }, 0);
  return (
    earlyValue -
    metrics.falseAlerts * assumptions.falseAlertCost -
    metrics.episodesMissed * assumptions.missedEpisodeCost
  );
}

export function evaluateHardeningRun(
  dataset: GeneratedDataset,
  run: DetectorRun,
  period: EvaluationPeriod,
  merchantIds = new Set(dataset.metadata.merchantIds),
  policy: HardeningPolicy = DEFAULT_HARDENING_POLICY,
  assumptions: UtilityAssumptions = DEFAULT_UTILITY_ASSUMPTIONS,
): HardeningMetrics {
  const horizonWindows = Math.ceil(
    policy.predictionHorizonMinutes / dataset.metadata.windowMinutes,
  );
  const usefulWindows = Math.ceil(
    policy.usefulInterventionMinutes / dataset.metadata.windowMinutes,
  );
  const episodes = episodesFor(dataset, period, merchantIds);
  const allAlerts = run.alerts
    .filter(
      (alert) => merchantIds.has(alert.merchantId) && alert.windowIndex < period.endWindowExclusive,
    )
    .sort(
      (first, second) =>
        first.windowIndex - second.windowIndex || first.merchantId.localeCompare(second.merchantId),
    );
  const usedAlertKeys = new Set<string>();
  const episodeDetails: MatchedEpisode[] = episodes.map((episode) => {
    const candidate = allAlerts.find(
      (alert) =>
        alert.merchantId === episode.merchantId &&
        !usedAlertKeys.has(`${alert.merchantId}:${alert.windowIndex}`) &&
        alert.windowIndex >= Math.max(0, episode.startWindow - horizonWindows) &&
        alert.windowIndex <= episode.startWindow + usefulWindows,
    );
    if (!candidate) {
      return {
        episode,
        alertWindow: null,
        leadTimeMinutes: null,
        timing: 'missed',
        early5: false,
        early10: false,
        early20: false,
      };
    }
    usedAlertKeys.add(`${candidate.merchantId}:${candidate.windowIndex}`);
    const leadTimeMinutes =
      (episode.startWindow - candidate.windowIndex) * dataset.metadata.windowMinutes;
    return {
      episode,
      alertWindow: candidate.windowIndex,
      leadTimeMinutes,
      timing: leadTimeMinutes >= 0 ? 'early' : 'late_useful',
      early5: leadTimeMinutes >= 5,
      early10: leadTimeMinutes >= policy.targetLeadTimeMinutes,
      early20: leadTimeMinutes >= 20,
    };
  });
  const scopedAlerts = signalsInPeriod(run, period, merchantIds);
  const falseAlertSignals = scopedAlerts.filter(
    (alert) => !usedAlertKeys.has(`${alert.merchantId}:${alert.windowIndex}`),
  );
  const falseAlerts = falseAlertSignals.length;
  const falseAlertsByMerchant = new Map<string, BaselineSignal[]>();
  falseAlertSignals.forEach((alert) => {
    const merchantAlerts = falseAlertsByMerchant.get(alert.merchantId) ?? [];
    merchantAlerts.push(alert);
    falseAlertsByMerchant.set(alert.merchantId, merchantAlerts);
  });
  const falseEpisodes = [...falseAlertsByMerchant.values()].reduce((count, merchantAlerts) => {
    merchantAlerts.sort((first, second) => first.windowIndex - second.windowIndex);
    return (
      count +
      merchantAlerts.reduce(
        (merchantCount, alert, index) =>
          merchantCount +
          (index === 0 ||
          alert.windowIndex - merchantAlerts[index - 1]!.windowIndex > policy.cooldownWindows
            ? 1
            : 0),
        0,
      )
    );
  }, 0);
  const scopeStart = Math.max(0, period.startWindow - horizonWindows);
  let stableWindows = 0;
  for (const merchantId of merchantIds) {
    for (let windowIndex = scopeStart; windowIndex < period.endWindowExclusive; windowIndex += 1) {
      if (normalWindow(dataset, merchantId, windowIndex)) stableWindows += 1;
    }
  }
  const leadTimes = episodeDetails
    .map((detail) => detail.leadTimeMinutes)
    .filter((leadTime): leadTime is number => leadTime !== null);
  const episodesDetected = leadTimes.length;
  const precision = ratio(episodesDetected, episodesDetected + falseAlerts);
  const recall = ratio(episodesDetected, episodes.length);
  const metricsWithoutUtility = {
    falseAlerts,
    episodesMissed: episodes.length - episodesDetected,
    episodeDetails,
  };
  const earlyDetails = episodeDetails.filter((detail) => detail.leadTimeMinutes !== null);
  const lateDetections = earlyDetails.filter((detail) => detail.timing === 'late_useful').length;
  const base: Omit<HardeningMetrics, 'leadTimeWeightedUtility'> = {
    period: period.name,
    merchants: merchantIds.size,
    episodes: episodes.length,
    episodesDetected,
    episodesMissed: episodes.length - episodesDetected,
    falseEpisodes,
    alerts: scopedAlerts.length,
    falseAlerts,
    duplicateDebouncedSignals: run.debouncedSignals,
    precision,
    recall,
    f1: ratio(2 * precision * recall, precision + recall),
    falseAlertRate: ratio(falseAlerts, stableWindows),
    alertsPerMerchant: ratio(scopedAlerts.length, merchantIds.size),
    stableWindows,
    lateDetections,
    p25LeadTimeMinutes: percentile(leadTimes, 0.25),
    medianLeadTimeMinutes: percentile(leadTimes, 0.5),
    p75LeadTimeMinutes: percentile(leadTimes, 0.75),
    meanLeadTimeMinutes:
      leadTimes.length === 0
        ? null
        : leadTimes.reduce((sum, value) => sum + value, 0) / leadTimes.length,
    percentDetectedAtLeast5MinutesEarly: ratio(
      earlyDetails.filter((detail) => detail.early5).length,
      episodesDetected,
    ),
    percentDetectedAtLeast10MinutesEarly: ratio(
      earlyDetails.filter((detail) => detail.early10).length,
      episodesDetected,
    ),
    percentDetectedAtLeast20MinutesEarly: ratio(
      earlyDetails.filter((detail) => detail.early20).length,
      episodesDetected,
    ),
    episodeDetails,
  };
  return {
    ...base,
    leadTimeWeightedUtility: utilityForMetrics(metricsWithoutUtility, assumptions),
  };
}

export function utilitySensitivity(
  metrics: HardeningMetrics,
  scenarios: Record<string, UtilityAssumptions>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(scenarios).map(([name, assumptions]) => [
      name,
      utilityForMetrics(metrics, assumptions),
    ]),
  );
}
