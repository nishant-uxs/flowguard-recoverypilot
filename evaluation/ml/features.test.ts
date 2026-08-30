import { describe, expect, it } from 'vitest';

import { generateDataset, segmentKey, TARGET_SEGMENT } from '../generator/temporal-dataset.js';
import { buildFeatureDataset, FEATURE_DEFINITIONS, splitSequences } from './features.js';

function fixture() {
  return generateDataset({ seed: 42, merchants: 20, windows: 48 });
}

function windowIndex(timestamp: string, startAt: string, windowMinutes: number): number {
  return Math.floor(
    (new Date(timestamp).getTime() - new Date(startAt).getTime()) / (windowMinutes * 60_000),
  );
}

describe('temporal ML feature pipeline', () => {
  it('constructs four chronological input windows', () => {
    const dataset = buildFeatureDataset(fixture());
    const example = dataset.sequences[0]!;

    expect(dataset.sequenceLength).toBe(4);
    expect(example.values).toHaveLength(4);
    expect(example.values.every((window) => window.length === dataset.featureNames.length)).toBe(
      true,
    );
    expect(example.endWindow).toBe(3);
  });

  it('creates labels from future degradation intervals only', () => {
    const raw = fixture();
    const features = buildFeatureDataset(raw);
    const example = features.sequences.find((candidate) => candidate.label === 1)!;
    const matchingInterval = raw.truth.degradationIntervals.find(
      (interval) =>
        interval.merchantId === example.merchantId &&
        (interval.phase === 'degraded' || interval.phase === 'severe') &&
        interval.startWindow > example.endWindow &&
        interval.startWindow <= example.endWindow + features.horizonWindows,
    );

    expect(matchingInterval).toBeDefined();
  });

  it('does not change past features when future events are changed', () => {
    const raw = fixture();
    const original = buildFeatureDataset(raw);
    const sample = original.sequences[0]!;
    const altered = {
      ...raw,
      events: raw.events.map((event) =>
        event.merchantId === sample.merchantId &&
        windowIndex(event.timestamp, raw.metadata.startAt, raw.metadata.windowMinutes) >
          sample.endWindow &&
        segmentKey(event.paymentMethodSegment) === segmentKey(TARGET_SEGMENT)
          ? {
              ...event,
              status: 'failed' as const,
              failureCategory: 'technical_error' as const,
            }
          : event,
      ),
    };
    const changed = buildFeatureDataset(altered);
    const originalPast = original.windowsByMerchant
      .get(sample.merchantId)!
      .slice(0, sample.endWindow + 1);
    const changedPast = changed.windowsByMerchant
      .get(sample.merchantId)!
      .slice(0, sample.endWindow + 1);

    expect(changedPast).toEqual(originalPast);
  });

  it('uses chronological train, validation and test sequence splits', () => {
    const raw = fixture();
    const splits = splitSequences(raw, buildFeatureDataset(raw), {
      excludeMerchantHoldoutFromTrain: true,
    });

    expect(Math.max(...splits.train.map((example) => example.endWindow))).toBeLessThan(29);
    expect(Math.min(...splits.validation.map((example) => example.endWindow))).toBe(28);
    expect(Math.min(...splits.test.map((example) => example.endWindow))).toBe(38);
    expect(
      splits.train.every((example) => !raw.splits.merchantHoldout.includes(example.merchantId)),
    ).toBe(true);
  });

  it('keeps merchant holdout examples separate from training', () => {
    const raw = fixture();
    const splits = splitSequences(raw, buildFeatureDataset(raw), {
      excludeMerchantHoldoutFromTrain: true,
    });
    const holdout = new Set(raw.splits.merchantHoldout);

    expect(splits.merchantHoldout.length).toBeGreaterThan(0);
    expect(splits.merchantHoldout.every((example) => holdout.has(example.merchantId))).toBe(true);
    expect(splits.train.some((example) => holdout.has(example.merchantId))).toBe(false);
  });

  it('is deterministic and does not expose merchant or scenario identifiers as features', () => {
    const raw = fixture();
    const first = buildFeatureDataset(raw);
    const second = buildFeatureDataset(raw);
    const featureNames = FEATURE_DEFINITIONS.map((definition) => definition.name);

    expect(first.sequences).toEqual(second.sequences);
    expect(
      featureNames.some((name) => name.includes('merchant') || name.includes('scenario')),
    ).toBe(false);
  });

  it('supports static, temporal and merchant-relative ablations', () => {
    const raw = fixture();
    const staticOnly = buildFeatureDataset(raw, { selection: { groups: ['static'] } });
    const temporalOnly = buildFeatureDataset(raw, { selection: { groups: ['temporal'] } });
    const relativeOnly = buildFeatureDataset(raw, { selection: { groups: ['merchant_relative'] } });

    expect(staticOnly.featureNames.length).toBeGreaterThan(0);
    expect(temporalOnly.featureNames.length).toBeGreaterThan(0);
    expect(relativeOnly.featureNames.length).toBeGreaterThan(0);
    expect(new Set(staticOnly.featureNames).size).toBe(staticOnly.featureNames.length);
  });
});
