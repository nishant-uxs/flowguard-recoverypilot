import { describe, expect, it } from 'vitest';

import { TARGET_SEGMENT } from '../generator/temporal-dataset.js';
import type { DetectorRun } from '../baseline/detector.js';
import { DEFAULT_HARDENING_POLICY, evaluateHardeningRun, utilityForMetrics } from './scoring.js';
import type { GeneratedDataset } from '../generator/temporal-dataset.js';

function dataset(
  intervals: Array<{ merchantId: string; start: number; end: number }>,
): GeneratedDataset {
  return {
    metadata: {
      schemaVersion: 'm4.5',
      seed: 1,
      startAt: '2026-08-02T00:00:00.000Z',
      windowMinutes: 5,
      windows: 48,
      merchantIds: ['m1', 'm2'],
      segmentKeys: ['upi.intent'],
    },
    events: [],
    truth: {
      targetSpec: {
        targetSegment: TARGET_SEGMENT,
        windowMinutes: 5,
        observationWindowMinutes: 20,
        predictionHorizonMinutes: 30,
        sustainedDegradationMinutes: 15,
        leadTimeTargetMinutes: 10,
        degradationDefinition: 'test',
      },
      degradationIntervals: intervals.map((item) => ({
        merchantId: item.merchantId,
        paymentMethodSegment: TARGET_SEGMENT,
        phase: 'degraded' as const,
        startWindow: item.start,
        endWindowExclusive: item.end,
        startTimestamp: '',
        endTimestamp: '',
      })),
      scenarios: [],
    },
    splits: {
      temporalWindows: {
        train: { startWindow: 0, endWindowExclusive: 16 },
        validation: { startWindow: 16, endWindowExclusive: 32 },
        test: { startWindow: 32, endWindowExclusive: 48 },
      },
      merchantHoldout: ['m2'],
    },
  };
}

function run(alerts: Array<{ merchantId: string; windowIndex: number }>): DetectorRun {
  const signals = alerts.map((alert) => ({
    merchantId: alert.merchantId,
    segment: 'UPI_INTENT' as const,
    windowIndex: alert.windowIndex,
    timestamp: '',
    score: 1,
    ewma: 1,
    cusum: 1,
    alert: true,
    severity: 'elevated' as const,
    signals: [],
  }));
  return { signals, alerts: signals, debouncedSignals: 0, baselines: [] };
}

describe('M4.5 rigorous episode scoring', () => {
  it('separates useful early, late-useful, and false alerts', () => {
    const result = evaluateHardeningRun(
      dataset([
        { merchantId: 'm1', start: 10, end: 13 },
        { merchantId: 'm1', start: 30, end: 33 },
      ]),
      run([
        { merchantId: 'm1', windowIndex: 8 },
        { merchantId: 'm1', windowIndex: 29 },
        { merchantId: 'm1', windowIndex: 20 },
      ]),
      { name: 'test', startWindow: 0, endWindowExclusive: 40 },
    );

    expect(result.episodesDetected).toBe(2);
    expect(result.episodesMissed).toBe(0);
    expect(result.falseAlerts).toBe(1);
    expect(result.falseEpisodes).toBe(1);
    expect(result.percentDetectedAtLeast5MinutesEarly).toBe(1);
    expect(result.percentDetectedAtLeast10MinutesEarly).toBe(0.5);
    expect(result.percentDetectedAtLeast20MinutesEarly).toBe(0);
    expect(result.medianLeadTimeMinutes).toBe(7.5);
  });

  it('allows a pre-period alert to match only when it is inside the declared horizon', () => {
    const result = evaluateHardeningRun(
      dataset([{ merchantId: 'm1', start: 22, end: 25 }]),
      run([{ merchantId: 'm1', windowIndex: 16 }]),
      { name: 'test', startWindow: 20, endWindowExclusive: 40 },
    );

    expect(result.episodesDetected).toBe(1);
    expect(result.alerts).toBe(0);
    expect(result.falseAlerts).toBe(0);
    expect(result.episodeDetails[0]!.leadTimeMinutes).toBe(30);
  });

  it('computes parameterized utility without presenting normalized units as revenue', () => {
    const metrics = evaluateHardeningRun(
      dataset([{ merchantId: 'm1', start: 10, end: 13 }]),
      run([
        { merchantId: 'm1', windowIndex: 8 },
        { merchantId: 'm2', windowIndex: 20 },
      ]),
      { name: 'test', startWindow: 0, endWindowExclusive: 40 },
      undefined,
      DEFAULT_HARDENING_POLICY,
    );
    expect(metrics.leadTimeWeightedUtility).toBe(0);
    expect(
      utilityForMetrics(metrics, {
        falseAlertCost: 10,
        missedEpisodeCost: 5,
        earlyMinuteValue: 0.1,
        maximumEarlyMinutesRewarded: 30,
      }),
    ).toBe(-9);
  });
});
