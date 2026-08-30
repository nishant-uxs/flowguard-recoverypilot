import type { ModelPrediction } from './simple-model.js';

export type CalibrationMetrics = {
  brierScore: number;
  expectedCalibrationError: number;
  bins: Array<{
    lowerBound: number;
    upperBound: number;
    count: number;
    meanProbability: number;
    observedRate: number;
  }>;
};

export function calibrationMetrics(
  predictions: ModelPrediction[],
  binCount = 10,
): CalibrationMetrics {
  if (predictions.length === 0) {
    return { brierScore: 0, expectedCalibrationError: 0, bins: [] };
  }
  const bins = Array.from({ length: binCount }, (_, index) => ({
    lowerBound: index / binCount,
    upperBound: (index + 1) / binCount,
    count: 0,
    meanProbability: 0,
    observedRate: 0,
  }));
  let brierScore = 0;
  for (const prediction of predictions) {
    brierScore += (prediction.probability - prediction.label) ** 2;
    const index = Math.min(binCount - 1, Math.floor(prediction.probability * binCount));
    const bin = bins[index]!;
    bin.count += 1;
    bin.meanProbability += prediction.probability;
    bin.observedRate += prediction.label;
  }
  let expectedCalibrationError = 0;
  for (const bin of bins) {
    if (bin.count === 0) continue;
    bin.meanProbability /= bin.count;
    bin.observedRate /= bin.count;
    expectedCalibrationError +=
      (bin.count / predictions.length) * Math.abs(bin.meanProbability - bin.observedRate);
  }
  return {
    brierScore: brierScore / predictions.length,
    expectedCalibrationError,
    bins,
  };
}
