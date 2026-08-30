import {
  type GeneratedDataset,
  segmentKey,
  TARGET_SEGMENT,
} from '../generator/temporal-dataset.js';
import type { PaymentEvent } from '../../packages/domain/src/index.js';

export type FeatureGroup = 'static' | 'rolling' | 'temporal' | 'merchant_relative';

export type FeatureDefinition = {
  name: string;
  group: FeatureGroup;
};

export const FEATURE_DEFINITIONS: FeatureDefinition[] = [
  { name: 'log_transaction_count', group: 'static' },
  { name: 'failure_rate', group: 'static' },
  { name: 'success_rate', group: 'static' },
  { name: 'latency_p50_ms', group: 'static' },
  { name: 'latency_p95_ms', group: 'static' },
  { name: 'latency_std_ms', group: 'static' },
  { name: 'log_amount_mean', group: 'static' },
  { name: 'log_amount_std', group: 'static' },
  { name: 'retry_rate', group: 'static' },
  { name: 'rolling_failure_mean', group: 'rolling' },
  { name: 'rolling_failure_std', group: 'rolling' },
  { name: 'rolling_latency_mean_ms', group: 'rolling' },
  { name: 'rolling_latency_std_ms', group: 'rolling' },
  { name: 'failure_delta', group: 'temporal' },
  { name: 'latency_delta_ms', group: 'temporal' },
  { name: 'failure_slope', group: 'temporal' },
  { name: 'latency_slope_ms', group: 'temporal' },
  { name: 'failure_baseline_z', group: 'merchant_relative' },
  { name: 'latency_baseline_z', group: 'merchant_relative' },
  { name: 'traffic_baseline_z', group: 'merchant_relative' },
];

export type FeatureName = (typeof FEATURE_DEFINITIONS)[number]['name'];
export type WindowFeatures = Record<FeatureName, number>;

export type WindowFeatureRecord = {
  merchantId: string;
  windowIndex: number;
  timestamp: string;
  features: WindowFeatures;
};

export type SequenceExample = {
  merchantId: string;
  endWindow: number;
  timestamp: string;
  values: number[][];
  featureNames: FeatureName[];
  label: 0 | 1;
};

export type FeatureDataset = {
  windowsByMerchant: Map<string, WindowFeatureRecord[]>;
  sequences: SequenceExample[];
  featureNames: FeatureName[];
  sequenceLength: number;
  horizonWindows: number;
};

export type FeatureSelection = {
  groups?: FeatureGroup[];
  includeNames?: FeatureName[];
};

const FAILURE_RATE_PRIOR = 0.04;
const FAILURE_RATE_PRIOR_WEIGHT = 4;
const BASELINE_WINDOW_COUNT = 12;

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[], fallback = 1): number {
  if (values.length < 2) return fallback;
  const mean = average(values);
  return Math.max(fallback, Math.sqrt(average(values.map((value) => (value - mean) ** 2))));
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  const index = (sorted.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

function slope(values: number[]): number {
  if (values.length < 2) return 0;
  const xMean = (values.length - 1) / 2;
  const yMean = average(values);
  const numerator = values.reduce(
    (sum, value, index) => sum + (index - xMean) * (value - yMean),
    0,
  );
  const denominator = values.reduce((sum, _, index) => sum + (index - xMean) ** 2, 0);
  return denominator === 0 ? 0 : numerator / denominator;
}

function windowIndexFor(timestamp: string, dataset: GeneratedDataset): number {
  return Math.floor(
    (new Date(timestamp).getTime() - new Date(dataset.metadata.startAt).getTime()) /
      (dataset.metadata.windowMinutes * 60_000),
  );
}

function targetEventsByMerchantWindow(
  dataset: GeneratedDataset,
): Map<string, Map<number, PaymentEvent[]>> {
  const result = new Map<string, Map<number, PaymentEvent[]>>();
  for (const event of dataset.events) {
    if (segmentKey(event.paymentMethodSegment) !== segmentKey(TARGET_SEGMENT)) continue;
    const merchantWindows = result.get(event.merchantId) ?? new Map<number, PaymentEvent[]>();
    const events = merchantWindows.get(windowIndexFor(event.timestamp, dataset)) ?? [];
    events.push(event);
    merchantWindows.set(windowIndexFor(event.timestamp, dataset), events);
    result.set(event.merchantId, merchantWindows);
  }
  return result;
}

function eventMetrics(events: PaymentEvent[]): {
  count: number;
  failureRate: number;
  successRate: number;
  latencyP50: number;
  latencyP95: number;
  latencyStd: number;
  amountMean: number;
  amountStd: number;
  retryRate: number;
} {
  const count = events.length;
  const failures = events.filter((event) => event.status === 'failed').length;
  const successes = events.filter((event) => event.status === 'succeeded').length;
  const latency = events
    .map((event) => event.latencyMs)
    .filter((value): value is number => value !== undefined);
  const amounts = events.map((event) => event.amount);
  return {
    count,
    failureRate:
      count === 0
        ? 0
        : (failures + FAILURE_RATE_PRIOR * FAILURE_RATE_PRIOR_WEIGHT) /
          (count + FAILURE_RATE_PRIOR_WEIGHT),
    successRate: count === 0 ? 0 : successes / count,
    latencyP50: percentile(latency, 0.5),
    latencyP95: percentile(latency, 0.95),
    latencyStd: standardDeviation(latency, 0),
    amountMean: average(amounts),
    amountStd: standardDeviation(amounts, 0),
    retryRate: count === 0 ? 0 : events.filter((event) => event.retryCount > 0).length / count,
  };
}

function selectedFeatureNames(selection: FeatureSelection = {}): FeatureName[] {
  if (selection.includeNames) return [...selection.includeNames];
  const groups = new Set(
    selection.groups ?? FEATURE_DEFINITIONS.map((definition) => definition.group),
  );
  return FEATURE_DEFINITIONS.filter((definition) => groups.has(definition.group)).map(
    (definition) => definition.name as FeatureName,
  );
}

function isFutureDegradation(
  dataset: GeneratedDataset,
  merchantId: string,
  endWindow: number,
  horizonWindows: number,
): boolean {
  return dataset.truth.degradationIntervals.some(
    (interval) =>
      interval.merchantId === merchantId &&
      (interval.phase === 'degraded' || interval.phase === 'severe') &&
      interval.startWindow > endWindow &&
      interval.startWindow <= endWindow + horizonWindows,
  );
}

export function buildFeatureDataset(
  dataset: GeneratedDataset,
  options: {
    sequenceLength?: number;
    horizonMinutes?: number;
    selection?: FeatureSelection;
  } = {},
): FeatureDataset {
  const sequenceLength = options.sequenceLength ?? 4;
  const horizonMinutes =
    options.horizonMinutes ?? dataset.truth.targetSpec.predictionHorizonMinutes;
  const horizonWindows = Math.ceil(horizonMinutes / dataset.metadata.windowMinutes);
  const featureNames = selectedFeatureNames(options.selection);
  const eventsByMerchantWindow = targetEventsByMerchantWindow(dataset);
  const windowsByMerchant = new Map<string, WindowFeatureRecord[]>();

  for (const merchantId of dataset.metadata.merchantIds) {
    const rawWindows = Array.from({ length: dataset.metadata.windows }, (_, windowIndex) =>
      eventMetrics(eventsByMerchantWindow.get(merchantId)?.get(windowIndex) ?? []),
    );
    const records: WindowFeatureRecord[] = [];

    for (let windowIndex = 0; windowIndex < rawWindows.length; windowIndex += 1) {
      const current = rawWindows[windowIndex]!;
      const previous = rawWindows[Math.max(0, windowIndex - 1)]!;
      const historical = rawWindows.slice(0, Math.min(windowIndex, BASELINE_WINDOW_COUNT));
      const baseline = historical.length > 0 ? historical : [current];
      const baselineFailure = standardDeviation(
        baseline.map((window) => window.failureRate),
        0.02,
      );
      const baselineLatency = standardDeviation(
        baseline.map((window) => window.latencyP50),
        100,
      );
      const baselineTraffic = standardDeviation(
        baseline.map((window) => Math.log1p(window.count)),
        0.5,
      );
      const baselineFailureMean = average(baseline.map((window) => window.failureRate));
      const baselineLatencyMean = average(baseline.map((window) => window.latencyP50));
      const baselineTrafficMean = average(baseline.map((window) => Math.log1p(window.count)));
      const rolling = rawWindows.slice(Math.max(0, windowIndex - 2), windowIndex + 1);
      const rollingFailure = rolling.map((window) => window.failureRate);
      const rollingLatency = rolling.map((window) => window.latencyP50);
      const values: WindowFeatures = {
        log_transaction_count: Math.log1p(current.count),
        failure_rate: current.failureRate,
        success_rate: current.successRate,
        latency_p50_ms: current.latencyP50,
        latency_p95_ms: current.latencyP95,
        latency_std_ms: current.latencyStd,
        log_amount_mean: Math.log1p(current.amountMean),
        log_amount_std: Math.log1p(current.amountStd),
        retry_rate: current.retryRate,
        rolling_failure_mean: average(rollingFailure),
        rolling_failure_std: standardDeviation(rollingFailure, 0),
        rolling_latency_mean_ms: average(rollingLatency),
        rolling_latency_std_ms: standardDeviation(rollingLatency, 0),
        failure_delta: current.failureRate - previous.failureRate,
        latency_delta_ms: current.latencyP50 - previous.latencyP50,
        failure_slope: slope(rollingFailure),
        latency_slope_ms: slope(rollingLatency),
        failure_baseline_z: (current.failureRate - baselineFailureMean) / baselineFailure,
        latency_baseline_z: (current.latencyP50 - baselineLatencyMean) / baselineLatency,
        traffic_baseline_z: (Math.log1p(current.count) - baselineTrafficMean) / baselineTraffic,
      };
      records.push({
        merchantId,
        windowIndex,
        timestamp: new Date(
          new Date(dataset.metadata.startAt).getTime() +
            windowIndex * dataset.metadata.windowMinutes * 60_000,
        ).toISOString(),
        features: values,
      });
    }
    windowsByMerchant.set(merchantId, records);
  }

  const sequences: SequenceExample[] = [];
  for (const [merchantId, windows] of windowsByMerchant) {
    for (
      let endWindow = sequenceLength - 1;
      endWindow + horizonWindows < windows.length;
      endWindow += 1
    ) {
      const sequence = windows.slice(endWindow - sequenceLength + 1, endWindow + 1);
      sequences.push({
        merchantId,
        endWindow,
        timestamp: windows[endWindow]!.timestamp,
        values: sequence.map((record) => featureNames.map((name) => record.features[name])),
        featureNames,
        label: isFutureDegradation(dataset, merchantId, endWindow, horizonWindows) ? 1 : 0,
      });
    }
  }

  return {
    windowsByMerchant,
    sequences,
    featureNames,
    sequenceLength,
    horizonWindows,
  };
}

export function splitSequences(
  dataset: GeneratedDataset,
  featureDataset: FeatureDataset,
  options: { excludeMerchantHoldoutFromTrain?: boolean } = {},
): {
  train: SequenceExample[];
  validation: SequenceExample[];
  test: SequenceExample[];
  merchantHoldout: SequenceExample[];
} {
  const { train, validation, test } = dataset.splits.temporalWindows;
  const holdout = new Set(dataset.splits.merchantHoldout);
  const result = { train: [], validation: [], test: [], merchantHoldout: [] } as {
    train: SequenceExample[];
    validation: SequenceExample[];
    test: SequenceExample[];
    merchantHoldout: SequenceExample[];
  };
  for (const example of featureDataset.sequences) {
    if (example.endWindow >= test.startWindow && example.endWindow < test.endWindowExclusive) {
      result.test.push(example);
    } else if (
      example.endWindow >= validation.startWindow &&
      example.endWindow < validation.endWindowExclusive
    ) {
      result.validation.push(example);
    } else if (
      example.endWindow >= train.startWindow &&
      example.endWindow < train.endWindowExclusive &&
      (!options.excludeMerchantHoldoutFromTrain || !holdout.has(example.merchantId))
    ) {
      result.train.push(example);
    }
    if (holdout.has(example.merchantId)) result.merchantHoldout.push(example);
  }
  return result;
}

export function flattenSequence(example: SequenceExample): number[] {
  return example.values.flat();
}
