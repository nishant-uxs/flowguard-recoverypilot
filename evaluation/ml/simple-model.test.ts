import { describe, expect, it } from 'vitest';

import { generateDataset } from '../generator/temporal-dataset.js';
import { periodFromDataset } from '../baseline/evaluation.js';
import { applyPlattScaling, calibrationMetrics, fitPlattScaling } from './calibration.js';
import { buildFeatureDataset, splitSequences } from './features.js';
import {
  evaluateModelPredictions,
  fitStandardScaler,
  predictLogisticRegression,
  predictionsToDetectorRun,
  trainLogisticRegression,
} from './simple-model.js';

function fixture() {
  const dataset = generateDataset({ seed: 42, merchants: 20, windows: 48 });
  const features = buildFeatureDataset(dataset);
  return { dataset, features, splits: splitSequences(dataset, features) };
}

describe('simple temporal ML baseline', () => {
  it('trains without merchant identifiers and emits finite probabilities', () => {
    const { splits } = fixture();
    const model = trainLogisticRegression(splits.train);
    const predictions = predictLogisticRegression(model, splits.validation);

    expect(model.parameterCount).toBeGreaterThan(1);
    expect(predictions.length).toBe(splits.validation.length);
    expect(
      predictions.every((prediction) => prediction.probability >= 0 && prediction.probability <= 1),
    ).toBe(true);
  });

  it('is deterministic for the same examples and configuration', () => {
    const { splits } = fixture();
    const first = trainLogisticRegression(splits.train);
    const second = trainLogisticRegression(splits.train);

    expect(second).toEqual(first);
    expect(predictLogisticRegression(second, splits.test)).toEqual(
      predictLogisticRegression(first, splits.test),
    );
  });

  it('fits preprocessing on training data and rejects malformed dimensions', () => {
    const { splits } = fixture();
    const scaler = fitStandardScaler(splits.train);
    expect(scaler.means.length).toBe(splits.train[0]!.values.flat().length);
    expect(() =>
      predictLogisticRegression(
        {
          ...trainLogisticRegression(splits.train),
          scaler: { means: [0], standardDeviations: [1] },
        },
        splits.test,
      ),
    ).toThrow();
  });

  it('applies a validation-frozen threshold with persistence and cooldown', () => {
    const { splits } = fixture();
    const model = trainLogisticRegression(splits.train);
    const predictions = predictLogisticRegression(model, splits.test);
    const run = predictionsToDetectorRun(predictions, {
      threshold: 0.4,
      minimumPersistence: 2,
      cooldownWindows: 6,
      resetFraction: 0.5,
      resetPersistence: 3,
    });

    expect(run.signals.every((signal) => signal.segment === 'UPI_INTENT')).toBe(true);
    expect(run.alerts.length).toBeLessThanOrEqual(predictions.length);
    expect(run.debouncedSignals).toBeGreaterThanOrEqual(0);
  });

  it('evaluates model scores with the same episode-level protocol', () => {
    const { dataset, splits } = fixture();
    const model = trainLogisticRegression(splits.train);
    const predictions = predictLogisticRegression(model, splits.test);
    const metrics = evaluateModelPredictions(
      dataset,
      predictions,
      periodFromDataset(dataset, 'test'),
      {
        threshold: 0.5,
        minimumPersistence: 2,
        cooldownWindows: 6,
        resetFraction: 0.5,
        resetPersistence: 3,
      },
    );

    expect(metrics.period).toBe('test');
  });

  it('computes Brier score and expected calibration error', () => {
    const metrics = calibrationMetrics([
      {
        merchantId: 'mrc_001',
        endWindow: 1,
        timestamp: '2026-08-01T00:00:00Z',
        probability: 0.9,
        label: 1,
      },
      {
        merchantId: 'mrc_001',
        endWindow: 2,
        timestamp: '2026-08-01T00:05:00Z',
        probability: 0.1,
        label: 0,
      },
    ]);

    expect(metrics.brierScore).toBeCloseTo(0.01);
    expect(metrics.expectedCalibrationError).toBeCloseTo(0.1);
  });

  it('fits and applies Platt scaling using validation predictions only', () => {
    const validation = [
      {
        merchantId: 'mrc_001',
        endWindow: 1,
        timestamp: '2026-08-01T00:00:00Z',
        probability: 0.6,
        label: 1 as const,
      },
      {
        merchantId: 'mrc_001',
        endWindow: 2,
        timestamp: '2026-08-01T00:05:00Z',
        probability: 0.4,
        label: 0 as const,
      },
      {
        merchantId: 'mrc_001',
        endWindow: 3,
        timestamp: '2026-08-01T00:10:00Z',
        probability: 0.55,
        label: 1 as const,
      },
      {
        merchantId: 'mrc_001',
        endWindow: 4,
        timestamp: '2026-08-01T00:15:00Z',
        probability: 0.45,
        label: 0 as const,
      },
    ];
    const scaling = fitPlattScaling(validation);
    const calibrated = applyPlattScaling(validation, scaling);

    expect(scaling.validationExamples).toBe(validation.length);
    expect(
      calibrated.every((prediction) => prediction.probability > 0 && prediction.probability < 1),
    ).toBe(true);
    expect(calibrationMetrics(calibrated).brierScore).toBeLessThanOrEqual(
      calibrationMetrics(validation).brierScore + 0.01,
    );
  });
});
