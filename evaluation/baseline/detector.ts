import {
  type GeneratedDataset,
  segmentKey,
  TARGET_SEGMENT,
} from '../generator/temporal-dataset.js';
import type { PaymentEvent } from '../../packages/domain/src/index.js';

export const TARGET_SEGMENT_LABEL = 'UPI_INTENT';
const FAILURE_RATE_PRIOR = 0.04;
const FAILURE_RATE_PRIOR_WEIGHT = 4;
const ROLLING_WINDOW_SIZE = 3;

export type WindowObservation = {
  merchantId: string;
  windowIndex: number;
  timestamp: string;
  eventCount: number;
  attempts: number;
  failures: number;
  failureRate: number | null;
  latencyMs: number | null;
  amountMean: number | null;
};

export type MerchantBaseline = {
  merchantId: string;
  warmupEndWindowExclusive: number;
  failureRateMean: number;
  failureRateStd: number;
  latencyMeanMs: number;
  latencyStdMs: number;
};

export type BaselineConfig = {
  alpha: number;
  cusumReference: number;
  ewmaThreshold: number;
  cusumThreshold: number;
  minimumPersistence: number;
  cooldownWindows: number;
  resetThreshold: number;
  resetPersistence: number;
  failureWeight: number;
  latencyWeight: number;
  baselineWarmupWindows: number;
};

export type BaselineSignal = {
  merchantId: string;
  segment: typeof TARGET_SEGMENT_LABEL;
  windowIndex: number;
  timestamp: string;
  score: number;
  ewma: number;
  cusum: number;
  alert: boolean;
  severity: 'normal' | 'elevated' | 'severe';
  signals: string[];
};

export type DetectorRun = {
  signals: BaselineSignal[];
  alerts: BaselineSignal[];
  debouncedSignals: number;
  baselines: MerchantBaseline[];
};

export type EvaluationPeriod = {
  name: 'train' | 'validation' | 'test';
  startWindow: number;
  endWindowExclusive: number;
};

export const DEFAULT_BASELINE_CONFIG: BaselineConfig = {
  alpha: 0.35,
  cusumReference: 0.5,
  ewmaThreshold: 1.8,
  cusumThreshold: 3,
  minimumPersistence: 2,
  cooldownWindows: 6,
  resetThreshold: 0.45,
  resetPersistence: 3,
  failureWeight: 0.7,
  latencyWeight: 0.3,
  baselineWarmupWindows: 12,
};

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[], fallback: number): number {
  if (values.length < 2) return fallback;
  const average = mean(values);
  const variance = mean(values.map((value) => (value - average) ** 2));
  return Math.max(fallback, Math.sqrt(variance));
}

function rollingFeature(
  observations: WindowObservation[],
  endIndex: number,
): { failureRate: number | null; latencyMs: number | null; eventCount: number } {
  const window = observations.slice(Math.max(0, endIndex - ROLLING_WINDOW_SIZE + 1), endIndex + 1);
  const attempts = window.reduce((sum, observation) => sum + observation.attempts, 0);
  const failures = window.reduce((sum, observation) => sum + observation.failures, 0);
  const latencyWeight = window.reduce(
    (sum, observation) => sum + (observation.latencyMs === null ? 0 : observation.eventCount),
    0,
  );
  const weightedLatency = window.reduce(
    (sum, observation) =>
      sum + (observation.latencyMs === null ? 0 : observation.latencyMs * observation.eventCount),
    0,
  );

  return {
    failureRate:
      attempts === 0
        ? null
        : (failures + FAILURE_RATE_PRIOR * FAILURE_RATE_PRIOR_WEIGHT) /
          (attempts + FAILURE_RATE_PRIOR_WEIGHT),
    latencyMs: latencyWeight === 0 ? null : weightedLatency / latencyWeight,
    eventCount: window.reduce((sum, observation) => sum + observation.eventCount, 0),
  };
}

function windowIndexFor(timestamp: string, dataset: GeneratedDataset): number {
  return Math.floor(
    (new Date(timestamp).getTime() - new Date(dataset.metadata.startAt).getTime()) /
      (dataset.metadata.windowMinutes * 60_000),
  );
}

function eventForTargetSegment(event: PaymentEvent): boolean {
  return segmentKey(event.paymentMethodSegment) === segmentKey(TARGET_SEGMENT);
}

export function buildWindowObservations(
  dataset: GeneratedDataset,
): Map<string, WindowObservation[]> {
  const byMerchantWindow = new Map<string, Map<number, PaymentEvent[]>>();

  dataset.events.filter(eventForTargetSegment).forEach((event) => {
    const windowIndex = windowIndexFor(event.timestamp, dataset);
    const windows = byMerchantWindow.get(event.merchantId) ?? new Map<number, PaymentEvent[]>();
    const events = windows.get(windowIndex) ?? [];
    events.push(event);
    windows.set(windowIndex, events);
    byMerchantWindow.set(event.merchantId, windows);
  });

  const observations = new Map<string, WindowObservation[]>();
  for (const merchantId of dataset.metadata.merchantIds) {
    const merchantWindows = byMerchantWindow.get(merchantId) ?? new Map<number, PaymentEvent[]>();
    const merchantObservations: WindowObservation[] = [];

    for (let windowIndex = 0; windowIndex < dataset.metadata.windows; windowIndex += 1) {
      const events = merchantWindows.get(windowIndex) ?? [];
      const attempts = events.length;
      const failures = events.filter((event) => event.status === 'failed').length;
      const latencies = events
        .map((event) => event.latencyMs)
        .filter((latency): latency is number => latency !== undefined);
      const amounts = events.map((event) => event.amount);

      merchantObservations.push({
        merchantId,
        windowIndex,
        timestamp: new Date(
          new Date(dataset.metadata.startAt).getTime() +
            windowIndex * dataset.metadata.windowMinutes * 60_000,
        ).toISOString(),
        eventCount: events.length,
        attempts,
        failures,
        failureRate:
          attempts === 0
            ? null
            : (failures + FAILURE_RATE_PRIOR * FAILURE_RATE_PRIOR_WEIGHT) /
              (attempts + FAILURE_RATE_PRIOR_WEIGHT),
        latencyMs: latencies.length === 0 ? null : mean(latencies),
        amountMean: amounts.length === 0 ? null : mean(amounts),
      });
    }

    observations.set(merchantId, merchantObservations);
  }

  return observations;
}

export function calibrateMerchantBaseline(
  observations: WindowObservation[],
  config: BaselineConfig = DEFAULT_BASELINE_CONFIG,
): MerchantBaseline {
  const merchantId = observations[0]?.merchantId ?? 'unknown';
  const warmup = observations
    .map((_, index) => rollingFeature(observations, index))
    .filter(
      (feature, index) =>
        observations[index]!.windowIndex < config.baselineWarmupWindows && feature.eventCount > 0,
    );
  const failureRates = warmup
    .map((feature) => feature.failureRate)
    .filter((rate): rate is number => rate !== null);
  const latencies = warmup
    .map((feature) => feature.latencyMs)
    .filter((latency): latency is number => latency !== null);

  return {
    merchantId,
    warmupEndWindowExclusive: config.baselineWarmupWindows,
    failureRateMean: mean(failureRates),
    failureRateStd: standardDeviation(failureRates, 0.018),
    latencyMeanMs: mean(latencies),
    latencyStdMs: standardDeviation(latencies, 120),
  };
}

export function calculateEwma(previous: number, current: number, alpha: number): number {
  if (alpha <= 0 || alpha > 1) throw new Error('alpha must be greater than 0 and at most 1');
  return alpha * current + (1 - alpha) * previous;
}

export function calculateCusum(previous: number, current: number, reference: number): number {
  if (reference < 0) throw new Error('CUSUM reference must be non-negative');
  return Math.max(0, previous + current - reference);
}

function zScore(value: number | null, baselineMean: number, baselineStd: number): number | null {
  return value === null ? null : (value - baselineMean) / baselineStd;
}

function severityFor(
  score: number,
  ewma: number,
  cusum: number,
  config: BaselineConfig,
): BaselineSignal['severity'] {
  if (ewma >= config.ewmaThreshold * 1.65 || cusum >= config.cusumThreshold * 1.5 || score >= 4) {
    return 'severe';
  }
  if (score > 0.7) return 'elevated';
  return 'normal';
}

function streamSignals(
  observations: WindowObservation[],
  baseline: MerchantBaseline,
  config: BaselineConfig,
): { signals: BaselineSignal[]; debouncedSignals: number } {
  let ewma = 0;
  let cusum = 0;
  let evidenceStreak = 0;
  let recoveryStreak = 0;
  let inEpisode = false;
  let lastAlertWindow = Number.NEGATIVE_INFINITY;
  let debouncedSignals = 0;
  const signals: BaselineSignal[] = [];

  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index]!;
    const feature = rollingFeature(observations, index);
    const failureZ = zScore(feature.failureRate, baseline.failureRateMean, baseline.failureRateStd);
    const latencyZ = zScore(feature.latencyMs, baseline.latencyMeanMs, baseline.latencyStdMs);
    const positiveFailureZ = Math.max(0, failureZ ?? 0);
    const positiveLatencyZ = Math.max(0, latencyZ ?? 0);
    const signedDeviation =
      config.failureWeight * (failureZ ?? 0) + config.latencyWeight * (latencyZ ?? 0);
    const score =
      failureZ === null && latencyZ === null
        ? 0
        : config.failureWeight * positiveFailureZ + config.latencyWeight * positiveLatencyZ;

    ewma = calculateEwma(ewma, score, config.alpha);
    cusum = calculateCusum(cusum, signedDeviation, config.cusumReference);

    const evidence =
      feature.eventCount > 0 && (ewma >= config.ewmaThreshold || cusum >= config.cusumThreshold);
    evidenceStreak = evidence ? evidenceStreak + 1 : 0;
    const shouldReset =
      score < config.resetThreshold &&
      ewma < config.resetThreshold &&
      cusum < config.cusumReference;
    recoveryStreak = shouldReset ? recoveryStreak + 1 : 0;

    if (recoveryStreak >= config.resetPersistence) {
      inEpisode = false;
      recoveryStreak = 0;
    }

    const canStartEpisode =
      !inEpisode &&
      evidenceStreak >= config.minimumPersistence &&
      observation.windowIndex - lastAlertWindow > config.cooldownWindows;
    const alert = canStartEpisode;

    if (alert) {
      inEpisode = true;
      lastAlertWindow = observation.windowIndex;
      evidenceStreak = 0;
    } else if (evidence && inEpisode) {
      debouncedSignals += 1;
    }

    const signalNames: string[] = [];
    if (positiveFailureZ >= 1) signalNames.push('failure_rate_above_merchant_baseline');
    if (positiveLatencyZ >= 1) signalNames.push('latency_above_merchant_baseline');
    if (feature.eventCount === 0) signalNames.push('no_observation');

    signals.push({
      merchantId: observation.merchantId,
      segment: TARGET_SEGMENT_LABEL,
      windowIndex: observation.windowIndex,
      timestamp: observation.timestamp,
      score,
      ewma,
      cusum,
      alert,
      severity: severityFor(score, ewma, cusum, config),
      signals: signalNames,
    });
  }

  return { signals, debouncedSignals };
}

export function runBaseline(
  observationsByMerchant: Map<string, WindowObservation[]>,
  config: BaselineConfig = DEFAULT_BASELINE_CONFIG,
): DetectorRun {
  const signals: BaselineSignal[] = [];
  const baselines: MerchantBaseline[] = [];
  let debouncedSignals = 0;

  for (const observations of observationsByMerchant.values()) {
    const baseline = calibrateMerchantBaseline(observations, config);
    const result = streamSignals(observations, baseline, config);
    baselines.push(baseline);
    signals.push(...result.signals);
    debouncedSignals += result.debouncedSignals;
  }

  signals.sort((first, second) => {
    const timeOrder = first.timestamp.localeCompare(second.timestamp);
    return timeOrder !== 0 ? timeOrder : first.merchantId.localeCompare(second.merchantId);
  });

  return {
    signals,
    alerts: signals.filter((signal) => signal.alert),
    debouncedSignals,
    baselines,
  };
}

export type NaiveThresholdConfig = {
  threshold: number;
  minimumPersistence: number;
  cooldownWindows: number;
  resetPersistence: number;
};

export const DEFAULT_NAIVE_CONFIG: NaiveThresholdConfig = {
  threshold: 0.1,
  minimumPersistence: 2,
  cooldownWindows: 6,
  resetPersistence: 3,
};

export function runNaiveThreshold(
  observationsByMerchant: Map<string, WindowObservation[]>,
  config: NaiveThresholdConfig = DEFAULT_NAIVE_CONFIG,
): DetectorRun {
  const signals: BaselineSignal[] = [];
  const baselines: MerchantBaseline[] = [];
  let debouncedSignals = 0;

  for (const observations of observationsByMerchant.values()) {
    const baseline = calibrateMerchantBaseline(observations);
    baselines.push(baseline);
    let streak = 0;
    let recoveryStreak = 0;
    let inEpisode = false;
    let lastAlertWindow = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < observations.length; index += 1) {
      const observation = observations[index]!;
      const feature = rollingFeature(observations, index);
      const score = feature.failureRate ?? 0;
      const evidence = feature.failureRate !== null && feature.failureRate >= config.threshold;
      streak = evidence ? streak + 1 : 0;
      recoveryStreak = !evidence ? recoveryStreak + 1 : 0;
      if (recoveryStreak >= config.resetPersistence) {
        inEpisode = false;
        recoveryStreak = 0;
      }
      const alert =
        !inEpisode &&
        streak >= config.minimumPersistence &&
        observation.windowIndex - lastAlertWindow > config.cooldownWindows;
      if (alert) {
        inEpisode = true;
        lastAlertWindow = observation.windowIndex;
        streak = 0;
      } else if (evidence && inEpisode) {
        debouncedSignals += 1;
      }

      signals.push({
        merchantId: observation.merchantId,
        segment: TARGET_SEGMENT_LABEL,
        windowIndex: observation.windowIndex,
        timestamp: observation.timestamp,
        score,
        ewma: score,
        cusum: score,
        alert,
        severity:
          score >= config.threshold * 1.5
            ? 'severe'
            : score >= config.threshold
              ? 'elevated'
              : 'normal',
        signals: evidence ? ['failure_rate_above_global_threshold'] : [],
      });
    }
  }

  signals.sort((first, second) => {
    const timeOrder = first.timestamp.localeCompare(second.timestamp);
    return timeOrder !== 0 ? timeOrder : first.merchantId.localeCompare(second.merchantId);
  });

  return {
    signals,
    alerts: signals.filter((signal) => signal.alert),
    debouncedSignals,
    baselines,
  };
}

export function periodFromDataset(
  dataset: GeneratedDataset,
  name: EvaluationPeriod['name'],
): EvaluationPeriod {
  const period = dataset.splits.temporalWindows[name];
  return { name, ...period };
}

export function truthPhaseAtWindow(
  dataset: GeneratedDataset,
  merchantId: string,
  windowIndex: number,
): string {
  const interval = dataset.truth.degradationIntervals.find(
    (candidate) =>
      candidate.merchantId === merchantId &&
      candidate.startWindow <= windowIndex &&
      candidate.endWindowExclusive > windowIndex,
  );
  return interval?.phase ?? 'normal';
}
