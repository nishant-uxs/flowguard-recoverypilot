import type { GeneratedDataset } from '../generator/temporal-dataset.js';
import { evaluateDetectorRun, type EvaluationMetrics } from '../baseline/evaluation.js';
import type { BaselineSignal, DetectorRun, EvaluationPeriod } from '../baseline/detector.js';
import type { SequenceExample } from './features.js';
import { flattenSequence } from './features.js';

export type StandardScaler = {
  means: number[];
  standardDeviations: number[];
};

export type LogisticRegressionConfig = {
  learningRate: number;
  epochs: number;
  l2: number;
  positiveClassWeight?: number;
};

export const DEFAULT_LOGISTIC_CONFIG: LogisticRegressionConfig = {
  learningRate: 0.08,
  epochs: 300,
  l2: 0.001,
};

export type LogisticModel = {
  weights: number[];
  bias: number;
  scaler: StandardScaler;
  config: LogisticRegressionConfig;
  parameterCount: number;
  trainingLoss: number;
};

export type ModelPrediction = {
  merchantId: string;
  endWindow: number;
  timestamp: string;
  probability: number;
  label: 0 | 1;
};

export type ModelThresholdConfig = {
  threshold: number;
  minimumPersistence: number;
  cooldownWindows: number;
  resetFraction: number;
  resetPersistence: number;
};

export const DEFAULT_MODEL_THRESHOLD_CONFIG: ModelThresholdConfig = {
  threshold: 0.5,
  minimumPersistence: 2,
  cooldownWindows: 6,
  resetFraction: 0.5,
  resetPersistence: 3,
};

function sigmoid(value: number): number {
  if (value >= 0) {
    const exponent = Math.exp(-value);
    return 1 / (1 + exponent);
  }
  const exponent = Math.exp(value);
  return exponent / (1 + exponent);
}

function assertDimensions(examples: SequenceExample[], vectors: number[][]): void {
  const dimension = vectors[0]?.length ?? 0;
  if (dimension === 0) throw new Error('at least one feature is required');
  if (vectors.some((vector) => vector.length !== dimension)) {
    throw new Error('all sequence examples must have the same feature dimensions');
  }
  if (examples.some((example) => !example.values.flat().every(Number.isFinite))) {
    throw new Error('feature values must be finite');
  }
}

export function fitStandardScaler(examples: SequenceExample[]): StandardScaler {
  const vectors = examples.map(flattenSequence);
  assertDimensions(examples, vectors);
  const dimension = vectors[0]!.length;
  const means = Array.from(
    { length: dimension },
    (_, index) => vectors.reduce((sum, vector) => sum + vector[index]!, 0) / vectors.length,
  );
  const standardDeviations = Array.from({ length: dimension }, (_, index) => {
    const variance =
      vectors.reduce((sum, vector) => sum + (vector[index]! - means[index]!) ** 2, 0) /
      vectors.length;
    return Math.max(0.000_001, Math.sqrt(variance));
  });
  return { means, standardDeviations };
}

export function transformExample(example: SequenceExample, scaler: StandardScaler): number[] {
  const vector = flattenSequence(example);
  if (vector.length !== scaler.means.length)
    throw new Error('feature dimension does not match scaler');
  return vector.map(
    (value, index) => (value - scaler.means[index]!) / scaler.standardDeviations[index]!,
  );
}

function weightedPositiveClass(examples: SequenceExample[], configured?: number): number {
  if (configured !== undefined) return configured;
  const positives = examples.filter((example) => example.label === 1).length;
  const negatives = examples.length - positives;
  return positives === 0 ? 1 : Math.min(10, Math.max(1, negatives / positives));
}

export function trainLogisticRegression(
  examples: SequenceExample[],
  config: LogisticRegressionConfig = DEFAULT_LOGISTIC_CONFIG,
): LogisticModel {
  if (examples.length === 0) throw new Error('cannot train on an empty sequence set');
  const scaler = fitStandardScaler(examples);
  const vectors = examples.map((example) => transformExample(example, scaler));
  const weights = Array.from({ length: vectors[0]!.length }, () => 0);
  let bias = 0;
  const positiveWeight = weightedPositiveClass(examples, config.positiveClassWeight);
  let trainingLoss = 0;

  for (let epoch = 0; epoch < config.epochs; epoch += 1) {
    const gradient = Array.from({ length: weights.length }, () => 0);
    let biasGradient = 0;
    trainingLoss = 0;
    for (let row = 0; row < vectors.length; row += 1) {
      const example = examples[row]!;
      const probability = sigmoid(
        vectors[row]!.reduce((sum, value, index) => sum + value * weights[index]!, bias),
      );
      const classWeight = example.label === 1 ? positiveWeight : 1;
      const error = (probability - example.label) * classWeight;
      for (let index = 0; index < weights.length; index += 1) {
        gradient[index] += error * vectors[row]![index]!;
      }
      biasGradient += error;
      const clippedProbability = Math.min(1 - 1e-12, Math.max(1e-12, probability));
      trainingLoss -=
        classWeight *
        (example.label * Math.log(clippedProbability) +
          (1 - example.label) * Math.log(1 - clippedProbability));
    }
    for (let index = 0; index < weights.length; index += 1) {
      weights[index] -=
        config.learningRate * (gradient[index]! / vectors.length + config.l2 * weights[index]!);
    }
    bias -= config.learningRate * (biasGradient / vectors.length);
  }

  return {
    weights,
    bias,
    scaler,
    config: { ...config, positiveClassWeight: positiveWeight },
    parameterCount: weights.length + 1,
    trainingLoss: trainingLoss / examples.length,
  };
}

export function predictLogisticRegression(
  model: LogisticModel,
  examples: SequenceExample[],
): ModelPrediction[] {
  return examples.map((example) => {
    const vector = transformExample(example, model.scaler);
    const logit = vector.reduce(
      (sum, value, index) => sum + value * model.weights[index]!,
      model.bias,
    );
    return {
      merchantId: example.merchantId,
      endWindow: example.endWindow,
      timestamp: example.timestamp,
      probability: sigmoid(logit),
      label: example.label,
    };
  });
}

function severity(probability: number): BaselineSignal['severity'] {
  return probability >= 0.8 ? 'severe' : probability >= 0.5 ? 'elevated' : 'normal';
}

export function predictionsToDetectorRun(
  predictions: ModelPrediction[],
  config: ModelThresholdConfig,
): DetectorRun {
  const signals: BaselineSignal[] = [];
  let debouncedSignals = 0;
  const byMerchant = new Map<string, ModelPrediction[]>();
  predictions.forEach((prediction) => {
    const merchantPredictions = byMerchant.get(prediction.merchantId) ?? [];
    merchantPredictions.push(prediction);
    byMerchant.set(prediction.merchantId, merchantPredictions);
  });

  for (const merchantPredictions of byMerchant.values()) {
    merchantPredictions.sort((first, second) => first.endWindow - second.endWindow);
    let evidenceStreak = 0;
    let recoveryStreak = 0;
    let inEpisode = false;
    let lastAlertWindow = Number.NEGATIVE_INFINITY;
    for (const prediction of merchantPredictions) {
      const evidence = prediction.probability >= config.threshold;
      evidenceStreak = evidence ? evidenceStreak + 1 : 0;
      recoveryStreak =
        prediction.probability < config.threshold * config.resetFraction ? recoveryStreak + 1 : 0;
      if (recoveryStreak >= config.resetPersistence) {
        inEpisode = false;
        recoveryStreak = 0;
      }
      const alert =
        !inEpisode &&
        evidenceStreak >= config.minimumPersistence &&
        prediction.endWindow - lastAlertWindow > config.cooldownWindows;
      if (alert) {
        inEpisode = true;
        lastAlertWindow = prediction.endWindow;
        evidenceStreak = 0;
      } else if (evidence && inEpisode) {
        debouncedSignals += 1;
      }
      signals.push({
        merchantId: prediction.merchantId,
        segment: 'UPI_INTENT',
        windowIndex: prediction.endWindow,
        timestamp: prediction.timestamp,
        score: prediction.probability,
        ewma: prediction.probability,
        cusum: prediction.probability,
        alert,
        severity: severity(prediction.probability),
        signals: evidence ? ['model_probability_above_threshold'] : [],
      });
    }
  }

  signals.sort((first, second) => first.timestamp.localeCompare(second.timestamp));
  return {
    signals,
    alerts: signals.filter((signal) => signal.alert),
    debouncedSignals,
    baselines: [],
  };
}

export function evaluateModelPredictions(
  dataset: GeneratedDataset,
  predictions: ModelPrediction[],
  period: EvaluationPeriod,
  threshold: ModelThresholdConfig,
  merchantIds = new Set(dataset.metadata.merchantIds),
): EvaluationMetrics {
  return evaluateDetectorRun(
    dataset,
    predictionsToDetectorRun(predictions, threshold),
    period,
    merchantIds,
  );
}
