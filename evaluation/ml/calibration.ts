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

export type PlattScaling = {
  slope: number;
  intercept: number;
  validationExamples: number;
};

function logit(probability: number): number {
  const bounded = Math.min(1 - 1e-7, Math.max(1e-7, probability));
  return Math.log(bounded / (1 - bounded));
}

export function fitPlattScaling(
  predictions: ModelPrediction[],
  options: { learningRate?: number; epochs?: number; l2?: number } = {},
): PlattScaling {
  if (predictions.length === 0) throw new Error('cannot calibrate an empty prediction set');
  let slope = 1;
  let intercept = 0;
  const learningRate = options.learningRate ?? 0.05;
  const epochs = options.epochs ?? 500;
  const l2 = options.l2 ?? 0.001;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    let slopeGradient = 0;
    let interceptGradient = 0;
    for (const prediction of predictions) {
      const feature = logit(prediction.probability);
      const calibrated = 1 / (1 + Math.exp(-(slope * feature + intercept)));
      const error = calibrated - prediction.label;
      slopeGradient += error * feature;
      interceptGradient += error;
    }
    slope -= learningRate * (slopeGradient / predictions.length + l2 * slope);
    intercept -= learningRate * (interceptGradient / predictions.length);
  }
  return { slope, intercept, validationExamples: predictions.length };
}

export function applyPlattScaling(
  predictions: ModelPrediction[],
  scaling: PlattScaling,
): ModelPrediction[] {
  return predictions.map((prediction) => ({
    ...prediction,
    probability:
      1 / (1 + Math.exp(-(scaling.slope * logit(prediction.probability) + scaling.intercept))),
  }));
}

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
