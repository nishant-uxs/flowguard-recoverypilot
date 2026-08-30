import { describe, expect, it } from 'vitest';

import { paymentEventSchema } from '../../packages/domain/src/index.js';
import { buildSanityReport } from '../generator/sanity.js';
import { generateDataset, segmentKey, TARGET_SEGMENT } from '../generator/temporal-dataset.js';
import {
  buildWindowObservationsForTarget,
  evaluateKnownAndUnseen,
  periodFromDataset,
  tuneBaseline,
} from './evaluation.js';
import { calculateCusum, calculateEwma, DEFAULT_BASELINE_CONFIG, runBaseline } from './detector.js';

function fixture() {
  return generateDataset({ seed: 42, merchants: 20, windows: 48 });
}

describe('interpretable temporal baseline', () => {
  it('processes chronological observations and fills zero-event windows', () => {
    const dataset = fixture();
    const observations = buildWindowObservationsForTarget(dataset);
    const firstMerchant = observations.get(dataset.metadata.merchantIds[0]!)!;

    expect(firstMerchant).toHaveLength(dataset.metadata.windows);
    expect(firstMerchant.map((item) => item.windowIndex)).toEqual(
      Array.from({ length: dataset.metadata.windows }, (_, index) => index),
    );
    expect(
      [...observations.values()].some((stream) => stream.some((item) => item.eventCount === 0)),
    ).toBe(true);
  });

  it('calculates EWMA exactly', () => {
    expect(calculateEwma(2, 6, 0.25)).toBe(3);
    expect(calculateEwma(0, 4, 1)).toBe(4);
  });

  it('calculates one-sided CUSUM and resets at zero', () => {
    expect(calculateCusum(0, 1, 0.25)).toBe(0.75);
    expect(calculateCusum(0.2, 0.1, 0.5)).toBe(0);
  });

  it('rejects malformed detector configuration values', () => {
    expect(() => calculateEwma(0, 1, 0)).toThrow();
    expect(() => calculateEwma(0, 1, 1.1)).toThrow();
    expect(() => calculateCusum(0, 1, -1)).toThrow();
  });

  it('does not use future events to change earlier signals', () => {
    const dataset = fixture();
    const observations = buildWindowObservationsForTarget(dataset);
    const original = runBaseline(observations);
    const futureTimestamp = new Date(
      new Date(dataset.metadata.startAt).getTime() + 40 * dataset.metadata.windowMinutes * 60_000,
    ).toISOString();
    const alteredDataset = {
      ...dataset,
      events: dataset.events.map((event) =>
        event.timestamp >= futureTimestamp &&
        segmentKey(event.paymentMethodSegment) === segmentKey(TARGET_SEGMENT)
          ? {
              ...event,
              status: 'failed' as const,
              failureCategory: 'technical_error' as const,
            }
          : event,
      ),
    };
    const altered = runBaseline(buildWindowObservationsForTarget(alteredDataset));
    const originalEarly = original.signals.filter((signal) => signal.windowIndex < 40);
    const alteredEarly = altered.signals.filter((signal) => signal.windowIndex < 40);

    expect(alteredEarly).toEqual(originalEarly);
  });

  it('produces a baseline alert for degradation without alerting every stable window', () => {
    const dataset = fixture();
    const observations = buildWindowObservationsForTarget(dataset);
    const run = runBaseline(observations, DEFAULT_BASELINE_CONFIG);
    const report = buildSanityReport(dataset);
    const stableAlerts = run.alerts.filter((alert) => alert.windowIndex < 14);

    expect(run.alerts.length).toBeGreaterThan(0);
    expect(stableAlerts.length).toBeLessThan(dataset.metadata.merchantIds.length);
    expect(
      report.targetEventClassBalance.degraded + report.targetEventClassBalance.severe,
    ).toBeGreaterThan(0);
  });

  it('debounces repeated signals into episodes', () => {
    const dataset = fixture();
    const run = runBaseline(buildWindowObservationsForTarget(dataset));
    const alertsByMerchant = new Map<string, number>();

    run.alerts.forEach((alert) => {
      alertsByMerchant.set(alert.merchantId, (alertsByMerchant.get(alert.merchantId) ?? 0) + 1);
    });

    expect(run.debouncedSignals).toBeGreaterThan(0);
    expect(Math.max(...alertsByMerchant.values())).toBeLessThan(4);
  });

  it('is deterministic for the same dataset and configuration', () => {
    const observations = buildWindowObservationsForTarget(fixture());
    expect(runBaseline(observations)).toEqual(runBaseline(observations));
  });

  it('calibrates baselines per merchant rather than globally', () => {
    const dataset = fixture();
    const run = runBaseline(buildWindowObservationsForTarget(dataset));
    const failureMeans = run.baselines.map((baseline) => baseline.failureRateMean);

    expect(new Set(failureMeans).size).toBeGreaterThan(1);
  });

  it('tunes on validation without reading test labels', { timeout: 15_000 }, () => {
    const dataset = fixture();
    const observations = buildWindowObservationsForTarget(dataset);
    const original = tuneBaseline(dataset, observations);
    const alteredTestTruth = {
      ...dataset,
      truth: {
        ...dataset.truth,
        degradationIntervals: [
          ...dataset.truth.degradationIntervals,
          {
            merchantId: dataset.metadata.merchantIds[0]!,
            paymentMethodSegment: TARGET_SEGMENT,
            phase: 'degraded' as const,
            startWindow: 60,
            endWindowExclusive: 72,
            startTimestamp: '2026-08-01T05:00:00.000Z',
            endTimestamp: '2026-08-01T06:00:00.000Z',
          },
        ],
      },
    };

    expect(tuneBaseline(alteredTestTruth, observations).selectedConfiguration).toEqual(
      original.selectedConfiguration,
    );
  });

  it('evaluates known and merchant-holdout sets separately', () => {
    const dataset = fixture();
    const observations = buildWindowObservationsForTarget(dataset);
    const tuning = tuneBaseline(dataset, observations);
    const results = evaluateKnownAndUnseen(dataset, observations, tuning.selectedConfiguration);

    expect(results.known.merchants).toBe(17);
    expect(results.unseen.merchants).toBe(3);
  });

  it('keeps the raw event contract valid while producing baseline inputs', () => {
    const dataset = fixture();
    const observations = buildWindowObservationsForTarget(dataset);

    expect(dataset.events.every((event) => paymentEventSchema.safeParse(event).success)).toBe(true);
    expect(observations.size).toBe(dataset.metadata.merchantIds.length);
    expect(periodFromDataset(dataset, 'test').name).toBe('test');
  });
});
