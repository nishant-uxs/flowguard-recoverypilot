import type { GeneratedDataset } from '../generator/temporal-dataset.js';
import { segmentKey, TARGET_SEGMENT } from '../generator/temporal-dataset.js';
import type { GeneralizationDataset } from './generator-v2.js';

export type LeakageAudit = {
  duplicateEventIds: number;
  duplicatePaymentIds: number;
  merchantIdContainsMechanism: boolean;
  eventIdContainsMechanism: boolean;
  scenarioFamiliesInTrain: string[];
  scenarioFamiliesInHoldout: string[];
  merchantOverlapBetweenTrainAndHoldout: string[];
  bestSingleFeatureProbeAccuracy: number;
  labelPrevalence: number;
  suspiciousSingleFeatureProbe: boolean;
  criticalLeakageDetected: boolean;
  notes: string[];
};

function duplicateCount(values: string[]): number {
  return values.length - new Set(values).size;
}

function futureLabel(
  dataset: GeneratedDataset,
  merchantId: string,
  endWindow: number,
  horizonWindows: number,
): 0 | 1 {
  return dataset.truth.degradationIntervals.some(
    (interval) =>
      interval.merchantId === merchantId &&
      (interval.phase === 'degraded' || interval.phase === 'severe') &&
      interval.startWindow > endWindow &&
      interval.startWindow <= endWindow + horizonWindows,
  )
    ? 1
    : 0;
}

function bestThresholdAccuracy(values: Array<{ value: number; label: 0 | 1 }>): number {
  if (values.length === 0) return 0;
  const thresholds = [...new Set(values.map((item) => item.value))];
  return Math.max(
    ...thresholds.flatMap((threshold) =>
      [1, -1].map((direction) => {
        const correct = values.filter(
          (item) => (direction * (item.value - threshold) >= 0 ? 1 : 0) === item.label,
        ).length;
        return correct / values.length;
      }),
    ),
  );
}

export function auditGeneralizationDataset(dataset: GeneralizationDataset): LeakageAudit {
  const holdout = new Set(dataset.splits.merchantHoldout);
  const knownScenarios = dataset.truth.scenarios.filter(
    (scenario) => !holdout.has(scenario.merchantId),
  );
  const holdoutScenarios = dataset.truth.scenarios.filter((scenario) =>
    holdout.has(scenario.merchantId),
  );
  const trainFamilies = [...new Set(knownScenarios.map((scenario) => scenario.mechanism))].sort();
  const holdoutFamilies = [
    ...new Set(holdoutScenarios.map((scenario) => scenario.mechanism)),
  ].sort();
  const overlap = knownScenarios
    .map((scenario) => scenario.merchantId)
    .filter((merchantId) => holdout.has(merchantId));
  const horizonWindows = Math.ceil(
    dataset.truth.targetSpec.predictionHorizonMinutes / dataset.metadata.windowMinutes,
  );
  const metricsByMerchantWindow = new Map<string, { count: number; failures: number }>();
  dataset.events
    .filter((event) => segmentKey(event.paymentMethodSegment) === segmentKey(TARGET_SEGMENT))
    .forEach((event) => {
      const windowIndex = Math.floor(
        (new Date(event.timestamp).getTime() - new Date(dataset.metadata.startAt).getTime()) /
          (dataset.metadata.windowMinutes * 60_000),
      );
      const key = `${event.merchantId}:${windowIndex}`;
      const current = metricsByMerchantWindow.get(key) ?? { count: 0, failures: 0 };
      current.count += 1;
      current.failures += event.status === 'failed' ? 1 : 0;
      metricsByMerchantWindow.set(key, current);
    });
  const countProbes: Array<{ value: number; label: 0 | 1 }> = [];
  const failureRateProbes: Array<{ value: number; label: 0 | 1 }> = [];
  for (const merchantId of dataset.metadata.merchantIds) {
    for (let endWindow = 0; endWindow < dataset.metadata.windows - horizonWindows; endWindow += 1) {
      const metrics = metricsByMerchantWindow.get(`${merchantId}:${endWindow}`) ?? {
        count: 0,
        failures: 0,
      };
      countProbes.push({
        value: metrics.count,
        label: futureLabel(dataset, merchantId, endWindow, horizonWindows),
      });
      failureRateProbes.push({
        value: metrics.count === 0 ? 0 : metrics.failures / metrics.count,
        label: futureLabel(dataset, merchantId, endWindow, horizonWindows),
      });
    }
  }
  const probes = [...countProbes, ...failureRateProbes];
  const labelPrevalence =
    probes.filter((probe) => probe.label === 1).length / Math.max(1, probes.length);
  const bestSingleFeatureProbeAccuracy = Math.max(
    bestThresholdAccuracy(countProbes),
    bestThresholdAccuracy(failureRateProbes),
  );
  const merchantIdContainsMechanism = dataset.truth.scenarios.some((scenario) =>
    new RegExp(`(?:scenario|mechanism)[-_]${scenario.mechanism}`, 'i').test(scenario.merchantId),
  );
  const eventIdContainsMechanism = dataset.events.some((event) =>
    dataset.truth.scenarios.some(
      (scenario) =>
        new RegExp(`(?:scenario|mechanism)[-_]${scenario.mechanism}`, 'i').test(event.eventId) &&
        event.merchantId === scenario.merchantId,
    ),
  );
  const suspiciousSingleFeatureProbe =
    bestSingleFeatureProbeAccuracy >= 0.95 &&
    bestSingleFeatureProbeAccuracy > Math.max(labelPrevalence, 1 - labelPrevalence) + 0.1;
  const notes = [
    'Event IDs and merchant IDs are opaque identifiers and are never provided to models as features.',
    'Scenario mechanism metadata is truth-only and is not present in payment events.',
    'The single-feature probe is a screening test, not proof that a model cannot exploit feature combinations.',
  ];
  return {
    duplicateEventIds: duplicateCount(dataset.events.map((event) => event.eventId)),
    duplicatePaymentIds: duplicateCount(dataset.events.map((event) => event.paymentId)),
    merchantIdContainsMechanism,
    eventIdContainsMechanism,
    scenarioFamiliesInTrain: trainFamilies,
    scenarioFamiliesInHoldout: holdoutFamilies,
    merchantOverlapBetweenTrainAndHoldout: overlap,
    bestSingleFeatureProbeAccuracy,
    labelPrevalence,
    suspiciousSingleFeatureProbe,
    criticalLeakageDetected:
      duplicateCount(dataset.events.map((event) => event.eventId)) > 0 ||
      duplicateCount(dataset.events.map((event) => event.paymentId)) > 0 ||
      merchantIdContainsMechanism ||
      eventIdContainsMechanism ||
      overlap.length > 0 ||
      suspiciousSingleFeatureProbe,
    notes,
  };
}
