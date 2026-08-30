import {
  type GeneratedDataset,
  phaseForEvent,
  segmentKey,
  TARGET_SEGMENT,
} from './temporal-dataset.js';

type NumericSummary = {
  count: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
};

export type SingleFeatureProbe = {
  feature: string;
  precision: number;
  recall: number;
  f1: number;
  flaggedNearPerfect: boolean;
};

export type SanityReport = {
  merchants: number;
  events: number;
  eventsPerMerchant: NumericSummary;
  eventsPerSegment: Record<string, number>;
  scenarioCounts: Record<string, number>;
  targetEventClassBalance: {
    normal: number;
    earlySignal: number;
    degraded: number;
    severe: number;
    recovery: number;
  };
  statusCounts: Record<string, number>;
  failureRatesBySegment: Record<string, number>;
  latencyMs: NumericSummary;
  amountInr: NumericSummary;
  degradationDurationsMinutes: NumericSummary;
  missingValues: Record<string, number>;
  duplicateEventIds: number;
  chronologicalViolations: number;
  uniquePaymentMethods: string[];
  singleFeatureProbe: SingleFeatureProbe;
  trivialProbeFlag: boolean;
};

type LabeledEvent = {
  label: boolean;
  failed: boolean;
  latencyMs: number;
};

function summarize(values: number[]): NumericSummary {
  if (values.length === 0) {
    return { count: 0, min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  }

  const sorted = [...values].sort((first, second) => first - second);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]!;

  return {
    count: values.length,
    min: sorted[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted[sorted.length - 1]!,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function evaluateProbe(
  events: LabeledEvent[],
  isPositive: (event: LabeledEvent) => boolean,
): SingleFeatureProbe {
  const counts = events.reduce(
    (result, event) => {
      const predicted = isPositive(event);
      if (predicted && event.label) result.truePositive += 1;
      if (predicted && !event.label) result.falsePositive += 1;
      if (!predicted && event.label) result.falseNegative += 1;
      return result;
    },
    { truePositive: 0, falsePositive: 0, falseNegative: 0 },
  );
  const precision = ratio(counts.truePositive, counts.truePositive + counts.falsePositive);
  const recall = ratio(counts.truePositive, counts.truePositive + counts.falseNegative);
  const f1 = ratio(2 * precision * recall, precision + recall);

  return {
    feature: '',
    precision,
    recall,
    f1,
    flaggedNearPerfect: f1 >= 0.98,
  };
}

function bestProbe(events: LabeledEvent[]): SingleFeatureProbe {
  const latencySummary = summarize(events.map((item) => item.latencyMs));
  const candidateProbes = [
    ['status=failed', (event: LabeledEvent) => event.failed],
    ['latency>=p50', (event: LabeledEvent) => event.latencyMs >= latencySummary.p50],
    ['latency>=p95', (event: LabeledEvent) => event.latencyMs >= latencySummary.p95],
  ];

  return candidateProbes
    .map(([feature, predicate]) => ({
      ...evaluateProbe(events, predicate as (event: LabeledEvent) => boolean),
      feature: feature as string,
    }))
    .sort((first, second) => second.f1 - first.f1)[0]!;
}

function phaseBucket(phase: string): keyof SanityReport['targetEventClassBalance'] {
  switch (phase) {
    case 'early_signal':
      return 'earlySignal';
    case 'degraded':
      return 'degraded';
    case 'severe':
      return 'severe';
    case 'recovery':
      return 'recovery';
    default:
      return 'normal';
  }
}

export function buildSanityReport(dataset: GeneratedDataset): SanityReport {
  const merchantIds = new Set(dataset.events.map((event) => event.merchantId));
  const eventCountByMerchant = new Map<string, number>();
  const eventsPerSegment: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};
  const segmentTotals: Record<string, number> = {};
  const segmentFailures: Record<string, number> = {};
  const amounts: number[] = [];
  const latencies: number[] = [];
  const labeledTargetEvents: LabeledEvent[] = [];
  const targetEventClassBalance = {
    normal: 0,
    earlySignal: 0,
    degraded: 0,
    severe: 0,
    recovery: 0,
  };

  for (const event of dataset.events) {
    eventCountByMerchant.set(
      event.merchantId,
      (eventCountByMerchant.get(event.merchantId) ?? 0) + 1,
    );
    const key = segmentKey(event.paymentMethodSegment);
    eventsPerSegment[key] = (eventsPerSegment[key] ?? 0) + 1;
    statusCounts[event.status] = (statusCounts[event.status] ?? 0) + 1;
    segmentTotals[key] = (segmentTotals[key] ?? 0) + 1;
    if (event.status === 'failed') segmentFailures[key] = (segmentFailures[key] ?? 0) + 1;
    amounts.push(event.amount);
    if (event.latencyMs !== undefined) latencies.push(event.latencyMs);

    if (key === segmentKey(TARGET_SEGMENT)) {
      const phase = phaseForEvent(
        event,
        dataset.truth,
        dataset.metadata.startAt,
        dataset.metadata.windowMinutes,
      );
      targetEventClassBalance[phaseBucket(phase)] += 1;
      labeledTargetEvents.push({
        label: phase === 'degraded' || phase === 'severe',
        failed: event.status === 'failed',
        latencyMs: event.latencyMs ?? 0,
      });
    }
  }

  const eventIds = dataset.events.map((event) => event.eventId);
  const uniqueEventIds = new Set(eventIds);
  const streamTimes = new Map<string, string[]>();
  for (const event of dataset.events) {
    const stream = `${event.merchantId}:${segmentKey(event.paymentMethodSegment)}`;
    const times = streamTimes.get(stream) ?? [];
    times.push(event.timestamp);
    streamTimes.set(stream, times);
  }
  const chronologicalViolations = [...streamTimes.values()].reduce(
    (count, timestamps) =>
      count +
      timestamps.slice(1).filter((timestamp, index) => timestamp < timestamps[index]!).length,
    0,
  );
  const durations = dataset.truth.degradationIntervals
    .filter((interval) => interval.phase === 'degraded' || interval.phase === 'severe')
    .map(
      (interval) =>
        (interval.endWindowExclusive - interval.startWindow) * dataset.metadata.windowMinutes,
    );
  const scenarioCounts = dataset.truth.scenarios.reduce<Record<string, number>>(
    (counts, scenario) => {
      counts[scenario.behaviorClass] = (counts[scenario.behaviorClass] ?? 0) + 1;
      return counts;
    },
    {},
  );
  const latencySummary = summarize(latencies);
  const probe = bestProbe(labeledTargetEvents);

  return {
    merchants: merchantIds.size,
    events: dataset.events.length,
    eventsPerMerchant: summarize([...eventCountByMerchant.values()]),
    eventsPerSegment,
    scenarioCounts,
    targetEventClassBalance,
    statusCounts,
    failureRatesBySegment: Object.fromEntries(
      Object.entries(segmentTotals).map(([key, count]) => [
        key,
        ratio(segmentFailures[key] ?? 0, count),
      ]),
    ),
    latencyMs: latencySummary,
    amountInr: summarize(amounts),
    degradationDurationsMinutes: summarize(durations),
    missingValues: {
      latencyMs: dataset.events.filter((event) => event.latencyMs === undefined).length,
      failureCategory: dataset.events.filter((event) => event.failureCategory === undefined).length,
    },
    duplicateEventIds: eventIds.length - uniqueEventIds.size,
    chronologicalViolations,
    uniquePaymentMethods: [
      ...new Set(dataset.events.map((event) => event.paymentMethodSegment.paymentMethod)),
    ].sort(),
    singleFeatureProbe: probe,
    trivialProbeFlag: probe.flaggedNearPerfect,
  };
}

export function validateDataset(dataset: GeneratedDataset): string[] {
  const issues: string[] = [];
  const report = buildSanityReport(dataset);
  const forbiddenKeys = new Set([
    'isDegraded',
    'degradationState',
    'recoverySuccess',
    'recoveredValue',
    'futureFailureCount',
    'scenarioType',
    'groundTruth',
  ]);

  for (const event of dataset.events) {
    for (const key of Object.keys(event)) {
      if (forbiddenKeys.has(key)) issues.push(`future-label field present in raw event: ${key}`);
    }
  }

  if (report.merchants < 5) issues.push('dataset must contain multiple merchants');
  if (report.events === 0) issues.push('dataset must contain events');
  if (Object.keys(report.eventsPerSegment).length < 4)
    issues.push('dataset must contain multiple payment segments');
  if (report.duplicateEventIds > 0) issues.push('duplicate event IDs detected');
  if (report.chronologicalViolations > 0) issues.push('chronological violations detected');
  if (
    !dataset.truth.degradationIntervals.some(
      (interval) => interval.phase === 'degraded' || interval.phase === 'severe',
    )
  ) {
    issues.push('target degradation does not occur');
  }
  if (report.targetEventClassBalance.normal === 0)
    issues.push('target segment has no normal control events');
  if (
    report.degradationDurationsMinutes.min < dataset.truth.targetSpec.sustainedDegradationMinutes
  ) {
    issues.push('degradation interval is shorter than the sustained target duration');
  }
  if (report.singleFeatureProbe.flaggedNearPerfect) {
    issues.push('single-feature probe is near-perfect; generator may be leaking or too easy');
  }

  const { temporalWindows } = dataset.splits;
  const orderedWindows = [temporalWindows.train, temporalWindows.validation, temporalWindows.test];
  orderedWindows.forEach((window, index) => {
    if (window.startWindow < 0 || window.endWindowExclusive > dataset.metadata.windows) {
      issues.push(`split ${index} is outside dataset window bounds`);
    }
    if (window.endWindowExclusive <= window.startWindow) issues.push(`split ${index} is empty`);
    if (index > 0 && window.startWindow < orderedWindows[index - 1]!.endWindowExclusive) {
      issues.push('temporal splits overlap');
    }
  });

  return [...new Set(issues)];
}

export function formatTimeline(
  dataset: GeneratedDataset,
  merchantId: string,
  targetSegmentKey = segmentKey(TARGET_SEGMENT),
): string {
  const lines = [`Timeline ${merchantId} · ${targetSegmentKey}`];
  const start = new Date(dataset.metadata.startAt).getTime();
  const windowMs = dataset.metadata.windowMinutes * 60_000;

  for (let windowIndex = 0; windowIndex < dataset.metadata.windows; windowIndex += 1) {
    const windowStart = start + windowIndex * windowMs;
    const windowEnd = windowStart + windowMs;
    const events = dataset.events.filter((event) => {
      const timestamp = new Date(event.timestamp).getTime();
      return (
        event.merchantId === merchantId &&
        segmentKey(event.paymentMethodSegment) === targetSegmentKey &&
        timestamp >= windowStart &&
        timestamp < windowEnd
      );
    });
    const failures = events.filter((event) => event.status === 'failed').length;
    const phase = events[0]
      ? phaseForEvent(
          events[0],
          dataset.truth,
          dataset.metadata.startAt,
          dataset.metadata.windowMinutes,
        )
      : (dataset.truth.degradationIntervals.find(
          (interval) =>
            interval.merchantId === merchantId &&
            interval.startWindow <= windowIndex &&
            interval.endWindowExclusive > windowIndex,
        )?.phase ?? 'normal');
    const time = new Date(windowStart).toISOString().slice(11, 16);
    lines.push(
      `${time}  ${phase.padEnd(12)} events=${String(events.length).padStart(2)} failures=${String(failures).padStart(2)}`,
    );
  }

  return lines.join('\n');
}
