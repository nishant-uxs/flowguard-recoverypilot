import { describe, expect, it } from 'vitest';

import { paymentEventSchema } from '../../packages/domain/src/index.js';
import { buildFeatureDataset, splitSequences } from '../ml/features.js';
import { generateGeneralizationDataset, type GeneralizationMechanism } from './generator-v2.js';

function fixture() {
  return generateGeneralizationDataset({ seed: 2026, merchants: 40, windows: 120 });
}

describe('M4.5 independent generalization dataset', () => {
  it('is reproducible and schema-valid', () => {
    const first = fixture();
    const second = fixture();

    expect(first).toEqual(second);
    expect(first.events.every((event) => paymentEventSchema.safeParse(event).success)).toBe(true);
    expect(
      first.events.every(
        (event, index) => index === 0 || first.events[index - 1]!.timestamp <= event.timestamp,
      ),
    ).toBe(true);
  }, 20_000);

  it('keeps mechanism families disjoint between known and holdout merchants', () => {
    const dataset = fixture();
    const holdout = new Set(dataset.splits.merchantHoldout);
    const knownMechanisms = new Set<GeneralizationMechanism>();
    const holdoutMechanisms = new Set<GeneralizationMechanism>();
    dataset.truth.scenarios.forEach((scenario) => {
      (holdout.has(scenario.merchantId) ? holdoutMechanisms : knownMechanisms).add(
        scenario.mechanism,
      );
    });

    expect([...knownMechanisms].sort()).toEqual(['A', 'B', 'C']);
    expect([...holdoutMechanisms].sort()).toEqual(['D', 'E', 'F', 'G', 'H', 'I', 'J']);
    expect([...knownMechanisms].some((mechanism) => holdoutMechanisms.has(mechanism))).toBe(false);
    expect(dataset.truth.scenarioFamilies).toEqual({
      TRAIN: ['A', 'B', 'C'],
      VALIDATION: ['A', 'B', 'C'],
      SHIFTED_TEST: ['D', 'E', 'F'],
      STRESS_TEST: ['G', 'H', 'I', 'J'],
    });
  });

  it('provides enough merchant-disjoint scenario coverage for an informative test', () => {
    const dataset = fixture();
    const holdout = new Set(dataset.splits.merchantHoldout);
    const holdoutScenarios = dataset.truth.scenarios.filter((scenario) =>
      holdout.has(scenario.merchantId),
    );
    const holdoutEpisodes = dataset.truth.degradationIntervals.filter(
      (interval) =>
        holdout.has(interval.merchantId) &&
        (interval.phase === 'degraded' || interval.phase === 'severe'),
    );

    expect(holdoutScenarios.length).toBe(8);
    expect(new Set(holdoutScenarios.map((scenario) => scenario.behaviorClass)).size).toBe(5);
    expect(new Set(holdoutScenarios.map((scenario) => scenario.mechanism)).size).toBe(7);
    expect(new Set(holdoutEpisodes.map((episode) => episode.merchantId)).size).toBeGreaterThan(5);
  });

  it('includes confounder and baseline-shift stress cases without labeling them as target degradation', () => {
    const dataset = fixture();
    const confounder = dataset.truth.scenarios.find((scenario) => scenario.mechanism === 'I')!;
    const shiftedBaseline = dataset.truth.scenarios.find((scenario) => scenario.mechanism === 'J')!;

    expect(confounder.targetDegraded).toBe(false);
    expect(shiftedBaseline.targetDegraded).toBe(false);
    expect(
      dataset.truth.degradationIntervals.some(
        (interval) => interval.merchantId === confounder.merchantId,
      ),
    ).toBe(false);
    expect(
      dataset.truth.degradationIntervals.some(
        (interval) => interval.merchantId === shiftedBaseline.merchantId,
      ),
    ).toBe(false);
  });

  it('rejects a dataset too short to contain the independent test episode', () => {
    expect(() => generateGeneralizationDataset({ windows: 72 })).toThrow();
  });

  it('keeps sequence splits chronological and excludes holdout merchants from training', () => {
    const dataset = fixture();
    const featureDataset = buildFeatureDataset(dataset);
    const splits = splitSequences(dataset, featureDataset, {
      excludeMerchantHoldoutFromTrain: true,
    });
    const holdout = new Set(dataset.splits.merchantHoldout);

    expect(
      splits.train.every(
        (example) => example.endWindow < dataset.splits.temporalWindows.validation.startWindow,
      ),
    ).toBe(true);
    expect(
      splits.validation.every(
        (example) =>
          example.endWindow >= dataset.splits.temporalWindows.validation.startWindow &&
          example.endWindow < dataset.splits.temporalWindows.test.startWindow,
      ),
    ).toBe(true);
    expect(
      splits.test.every(
        (example) => example.endWindow >= dataset.splits.temporalWindows.test.startWindow,
      ),
    ).toBe(true);
    expect(splits.train.every((example) => !holdout.has(example.merchantId))).toBe(true);
    expect(
      new Set(splits.train.map((example) => `${example.merchantId}:${example.endWindow}`)).size,
    ).toBe(splits.train.length);
  }, 20_000);
});
