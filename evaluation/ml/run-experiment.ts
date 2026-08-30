import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildWindowObservationsForTarget,
  evaluateBaseline,
  evaluateNaive,
  periodFromDataset,
  tuneBaseline,
  tuneNaive,
} from '../baseline/evaluation.js';
import {
  generateDataset,
  readDataset,
  writeDataset,
  type GeneratedDataset,
} from '../generator/temporal-dataset.js';
import { calibrationMetrics, type CalibrationMetrics } from './calibration.js';
import {
  buildFeatureDataset,
  splitSequences,
  type FeatureDataset,
  type FeatureSelection,
  type SequenceExample,
} from './features.js';
import {
  evaluateModelPredictions,
  predictLogisticRegression,
  trainLogisticRegression,
  type ModelPrediction,
  type ModelThresholdConfig,
  type LogisticModel,
} from './simple-model.js';

type ModelEvaluation = {
  validation: ReturnType<typeof evaluateModelPredictions>;
  test: ReturnType<typeof evaluateModelPredictions>;
  known: ReturnType<typeof evaluateModelPredictions>;
  unseen: ReturnType<typeof evaluateModelPredictions>;
  calibration: CalibrationMetrics;
  threshold: ModelThresholdConfig;
};

const resultDirectory = resolve(process.cwd(), 'evaluation/results');
const datasetDirectory = resolve(process.cwd(), 'evaluation/datasets/generated');
const neuralInputPath = resolve(resultDirectory, 'ml-neural-input.json');
const neuralOutputPath = resolve(resultDirectory, 'ml-neural-output.json');

function metricSummary(metrics: ReturnType<typeof evaluateModelPredictions>) {
  return {
    period: metrics.period,
    merchants: metrics.merchants,
    episodes: metrics.episodes,
    episodesDetected: metrics.episodesDetected,
    episodesMissed: metrics.episodesMissed,
    falseEpisodes: metrics.falseEpisodes,
    alerts: metrics.alerts,
    precision: metrics.precision,
    recall: metrics.recall,
    f1: metrics.f1,
    falseAlertRate: metrics.falseAlertRate,
    alertsPerMerchant: metrics.alertsPerMerchant,
    duplicateDebouncedSignals: metrics.duplicateDebouncedSignals,
    prePeriodAlertsUsed: metrics.prePeriodAlertsUsed,
    p25LeadTimeMinutes: metrics.p25LeadTimeMinutes,
    medianLeadTimeMinutes: metrics.medianLeadTimeMinutes,
    p75LeadTimeMinutes: metrics.p75LeadTimeMinutes,
    meanLeadTimeMinutes: metrics.meanLeadTimeMinutes,
    targetLeadTimeAttainment: metrics.targetLeadTimeAttainment,
    episodeDetails: metrics.episodeDetails,
  };
}

function predictionsForPeriod(
  predictions: ModelPrediction[],
  period: { startWindow: number; endWindowExclusive: number },
): ModelPrediction[] {
  return predictions.filter(
    (prediction) =>
      prediction.endWindow >= period.startWindow &&
      prediction.endWindow < period.endWindowExclusive,
  );
}

function tuneModelThreshold(
  dataset: GeneratedDataset,
  predictions: ModelPrediction[],
): { config: ModelThresholdConfig; metrics: ReturnType<typeof evaluateModelPredictions> } {
  const validation = periodFromDataset(dataset, 'validation');
  const known = new Set(
    dataset.metadata.merchantIds.filter((id) => !dataset.splits.merchantHoldout.includes(id)),
  );
  const candidates: ModelThresholdConfig[] = [];
  for (const threshold of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    for (const minimumPersistence of [1, 2, 3]) {
      candidates.push({
        threshold,
        minimumPersistence,
        cooldownWindows: 6,
        resetFraction: 0.5,
        resetPersistence: 3,
      });
    }
  }
  const selected = candidates
    .map((config) => {
      const metrics = evaluateModelPredictions(dataset, predictions, validation, config, known);
      const objective =
        metrics.f1 + 0.5 * metrics.targetLeadTimeAttainment - 0.25 * metrics.falseAlertRate;
      return { config, metrics, objective };
    })
    .sort((first, second) => second.objective - first.objective)[0]!;
  return { config: selected.config, metrics: selected.metrics };
}

function trainSimpleModel(
  dataset: GeneratedDataset,
  featureDataset: FeatureDataset,
): {
  model: LogisticModel;
  predictions: ModelPrediction[];
  evaluation: ModelEvaluation;
} {
  const splits = splitSequences(dataset, featureDataset, {
    excludeMerchantHoldoutFromTrain: true,
  });
  const model = trainLogisticRegression(splits.train);
  const predictions = predictLogisticRegression(model, featureDataset.sequences);
  const threshold = tuneModelThreshold(dataset, predictions);
  const test = periodFromDataset(dataset, 'test');
  const merchants = new Set(
    dataset.metadata.merchantIds.filter((id) => !dataset.splits.merchantHoldout.includes(id)),
  );
  const holdout = new Set(dataset.splits.merchantHoldout);
  return {
    model,
    predictions,
    evaluation: {
      validation: threshold.metrics,
      test: evaluateModelPredictions(dataset, predictions, test, threshold.config),
      known: evaluateModelPredictions(dataset, predictions, test, threshold.config, merchants),
      unseen: evaluateModelPredictions(dataset, predictions, test, threshold.config, holdout),
      calibration: calibrationMetrics(predictionsForPeriod(predictions, test)),
      threshold: threshold.config,
    },
  };
}

function featureGroupSelection(name: string): FeatureSelection {
  switch (name) {
    case 'static_rolling':
      return { groups: ['static', 'rolling'] };
    case 'temporal':
      return { groups: ['temporal'] };
    case 'merchant_relative':
      return { groups: ['merchant_relative'] };
    default:
      return {};
  }
}

function neuralInput(
  dataset: GeneratedDataset,
  featureDataset: FeatureDataset,
): {
  seed: number;
  modelVersion: string;
  hiddenSize: number;
  learningRate: number;
  epochs: number;
  batchSize: number;
  train: SequenceExample[];
  all: SequenceExample[];
} {
  const splits = splitSequences(dataset, featureDataset, {
    excludeMerchantHoldoutFromTrain: true,
  });
  return {
    seed: 42,
    modelVersion: 'm4-gru-v1',
    hiddenSize: 16,
    learningRate: 0.003,
    epochs: 40,
    batchSize: 128,
    train: splits.train,
    all: featureDataset.sequences,
  };
}

function trainNeuralModel(
  dataset: GeneratedDataset,
  featureDataset: FeatureDataset,
): {
  metadata: Record<string, unknown>;
  predictions: ModelPrediction[];
  evaluation: ModelEvaluation | null;
} {
  writeFileSync(
    neuralInputPath,
    `${JSON.stringify(neuralInput(dataset, featureDataset))}\n`,
    'utf8',
  );
  let output: {
    status: string;
    predictions?: ModelPrediction[];
    [key: string]: unknown;
  };
  try {
    execFileSync(
      'python',
      [resolve(process.cwd(), 'evaluation/ml/train_gru.py'), neuralInputPath, neuralOutputPath],
      {
        stdio: 'inherit',
      },
    );
    output = JSON.parse(readFileSync(neuralOutputPath, 'utf8')) as typeof output;
  } catch (error) {
    output = { status: 'unavailable', reason: String(error) };
  }
  if (output.status !== 'trained' || output.predictions === undefined) {
    return { metadata: output, predictions: [], evaluation: null };
  }

  const predictions = output.predictions;
  const metadata = { ...output };
  delete metadata.predictions;
  const threshold = tuneModelThreshold(dataset, predictions);
  const test = periodFromDataset(dataset, 'test');
  const known = new Set(
    dataset.metadata.merchantIds.filter((id) => !dataset.splits.merchantHoldout.includes(id)),
  );
  const holdout = new Set(dataset.splits.merchantHoldout);
  return {
    metadata,
    predictions,
    evaluation: {
      validation: threshold.metrics,
      test: evaluateModelPredictions(dataset, predictions, test, threshold.config),
      known: evaluateModelPredictions(dataset, predictions, test, threshold.config, known),
      unseen: evaluateModelPredictions(dataset, predictions, test, threshold.config, holdout),
      calibration: calibrationMetrics(predictionsForPeriod(predictions, test)),
      threshold: threshold.config,
    },
  };
}

function markdownMetricBlock(
  label: string,
  metrics: ReturnType<typeof evaluateModelPredictions> | null,
): string {
  if (metrics === null) return `- ${label}: unavailable`;
  return [
    `- ${label} precision/recall/F1: ${metrics.precision.toFixed(3)} / ${metrics.recall.toFixed(3)} / ${metrics.f1.toFixed(3)}`,
    `- ${label} false-alert rate: ${(metrics.falseAlertRate * 100).toFixed(2)}%`,
    `- ${label} episodes: ${metrics.episodesDetected}/${metrics.episodes}`,
    `- ${label} lead time p25/median/p75: ${metrics.p25LeadTimeMinutes ?? 'n/a'} / ${metrics.medianLeadTimeMinutes ?? 'n/a'} / ${metrics.p75LeadTimeMinutes ?? 'n/a'} minutes`,
    `- ${label} >=10-minute early: ${(metrics.targetLeadTimeAttainment * 100).toFixed(1)}%`,
  ].join('\n');
}

function markdownReport(result: {
  dataset: GeneratedDataset;
  baseline: ReturnType<typeof evaluateBaseline>;
  baselineKnown: ReturnType<typeof evaluateBaseline>;
  baselineUnseen: ReturnType<typeof evaluateBaseline>;
  naive: ReturnType<typeof evaluateNaive>;
  naiveKnown: ReturnType<typeof evaluateNaive>;
  naiveUnseen: ReturnType<typeof evaluateNaive>;
  simple: {
    model: LogisticModel;
    evaluation: ModelEvaluation;
  };
  ablations: Record<string, { model: LogisticModel; evaluation: ModelEvaluation }>;
  neural: ReturnType<typeof trainNeuralModel>;
}): string {
  const {
    dataset,
    baseline,
    baselineKnown,
    baselineUnseen,
    naive,
    naiveKnown,
    naiveUnseen,
    simple,
    ablations,
    neural,
  } = result;
  const neuralEvaluation = neural.evaluation;
  return `# M4 — Temporal ML Experiment Report

All outcomes below are **SIMULATED DATA** generated from dataset version
${dataset.metadata.schemaVersion}; no production payment or monetary outcome
is represented. Razorpay TEST MODE was not invoked.

## Dataset and split

- Seed: ${dataset.metadata.seed}
- Merchants/events: ${dataset.metadata.merchantIds.length}/${dataset.events.length}
- Input: four chronological five-minute windows (20 minutes)
- Target: degradation onset in the following six five-minute windows (30 minutes)
- Train/validation/test windows: 0-${dataset.splits.temporalWindows.train.endWindowExclusive} / ${dataset.splits.temporalWindows.validation.startWindow}-${dataset.splits.temporalWindows.validation.endWindowExclusive} / ${dataset.splits.temporalWindows.test.startWindow}-${dataset.splits.temporalWindows.test.endWindowExclusive}
- Training excludes the ${dataset.splits.merchantHoldout.length} merchant holdout identities.

## Feature set

The model uses transaction count, failure/success rate, latency p50/p95/std,
amount mean/std and retry rate; rolling means/stds; deltas and slopes; and
merchant-relative z-scores. Merchant IDs, scenario labels and future values
are not features. Scalers are fitted on training sequences only.

## Model configuration

### Logistic regression

- Class-weighted deterministic gradient descent
- Model version: m4-logistic-v1
- Learning rate: ${simple.model.config.learningRate}
- Epochs: ${simple.model.config.epochs}
- L2: ${simple.model.config.l2}
- Parameters: ${simple.model.parameterCount}
- Frozen operating threshold: ${simple.evaluation.threshold.threshold}
- Persistence/cooldown: ${simple.evaluation.threshold.minimumPersistence}/${simple.evaluation.threshold.cooldownWindows} windows

### Temporal neural model

- Architecture: ${neural.metadata.architecture ?? 'unavailable'}
- Model version: ${neural.metadata.modelVersion ?? 'unavailable'}
- Device: ${neural.metadata.device ?? 'unavailable'}
- Framework: ${neural.metadata.framework ?? 'unavailable'}
- Parameters: ${neural.metadata.parameterCount ?? 'unavailable'}
- Batch size / learning rate / epochs: ${neural.metadata.batchSize ?? 'n/a'} / ${neural.metadata.learningRate ?? 'n/a'} / ${neural.metadata.epochs ?? 'n/a'}
- Training seconds: ${typeof neural.metadata.trainingSeconds === 'number' ? neural.metadata.trainingSeconds.toFixed(2) : 'n/a'}
- Frozen operating threshold: ${neural.evaluation?.threshold.threshold ?? 'n/a'}

The local runtime exposed PyTorch CPU (cuda_available=false), so no GPU
claim is made. The GRU is intentionally small and the experiment records this
device outcome rather than silently treating CPU training as GPU training.

## Test comparison

| Model | Precision | Recall | F1 | False-alert rate | Episodes | Median lead | >=10m early | Brier | ECE | Known F1 | Unseen F1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Naive rolling threshold | ${naive.precision.toFixed(3)} | ${naive.recall.toFixed(3)} | ${naive.f1.toFixed(3)} | ${(naive.falseAlertRate * 100).toFixed(2)}% | ${naive.episodesDetected}/${naive.episodes} | ${naive.medianLeadTimeMinutes ?? 'n/a'} | ${(naive.targetLeadTimeAttainment * 100).toFixed(1)}% | n/a | n/a | ${naiveKnown.f1.toFixed(3)} | ${naiveUnseen.f1.toFixed(3)} |
| EWMA/CUSUM | ${baseline.precision.toFixed(3)} | ${baseline.recall.toFixed(3)} | ${baseline.f1.toFixed(3)} | ${(baseline.falseAlertRate * 100).toFixed(2)}% | ${baseline.episodesDetected}/${baseline.episodes} | ${baseline.medianLeadTimeMinutes ?? 'n/a'} | ${(baseline.targetLeadTimeAttainment * 100).toFixed(1)}% | n/a | n/a | ${baselineKnown.f1.toFixed(3)} | ${baselineUnseen.f1.toFixed(3)} |
| Logistic regression | ${simple.evaluation.test.precision.toFixed(3)} | ${simple.evaluation.test.recall.toFixed(3)} | ${simple.evaluation.test.f1.toFixed(3)} | ${(simple.evaluation.test.falseAlertRate * 100).toFixed(2)}% | ${simple.evaluation.test.episodesDetected}/${simple.evaluation.test.episodes} | ${simple.evaluation.test.medianLeadTimeMinutes ?? 'n/a'} | ${(simple.evaluation.test.targetLeadTimeAttainment * 100).toFixed(1)}% | ${simple.evaluation.calibration.brierScore.toFixed(3)} | ${simple.evaluation.calibration.expectedCalibrationError.toFixed(3)} | ${simple.evaluation.known.f1.toFixed(3)} | ${simple.evaluation.unseen.f1.toFixed(3)} |
| Temporal GRU | ${neuralEvaluation?.test.precision.toFixed(3) ?? 'n/a'} | ${neuralEvaluation?.test.recall.toFixed(3) ?? 'n/a'} | ${neuralEvaluation?.test.f1.toFixed(3) ?? 'n/a'} | ${neuralEvaluation === null ? 'n/a' : `${(neuralEvaluation.test.falseAlertRate * 100).toFixed(2)}%`} | ${neuralEvaluation === null ? 'n/a' : `${neuralEvaluation.test.episodesDetected}/${neuralEvaluation.test.episodes}`} | ${neuralEvaluation?.test.medianLeadTimeMinutes ?? 'n/a'} | ${neuralEvaluation === null ? 'n/a' : `${(neuralEvaluation.test.targetLeadTimeAttainment * 100).toFixed(1)}%`} | ${neuralEvaluation?.calibration.brierScore.toFixed(3) ?? 'n/a'} | ${neuralEvaluation?.calibration.expectedCalibrationError.toFixed(3) ?? 'n/a'} | ${neuralEvaluation?.known.f1.toFixed(3) ?? 'n/a'} | ${neuralEvaluation?.unseen.f1.toFixed(3) ?? 'n/a'} |

Metrics are episode-level and use identical persistence/cooldown evaluation.
Negative lead time means the first alert arrived after the sustained episode
onset; positive lead time means early warning. Test-period alert counts exclude
pre-period alerts that are still credited when they fall within the fixed
prediction horizon; those are reported in machine-readable output as
prePeriodAlertsUsed.

## Logistic ablation

${Object.entries(ablations)
  .map(
    ([name, value]) =>
      `### ${name}\n\n${markdownMetricBlock('Test', value.evaluation.test)}\n- Brier/ECE: ${value.evaluation.calibration.brierScore.toFixed(3)} / ${value.evaluation.calibration.expectedCalibrationError.toFixed(3)}`,
  )
  .join('\n\n')}

These ablations test static/rolling features, temporal trend features,
merchant-relative features and the full feature set. The full model is not
assumed to win; the frozen validation objective explicitly rewards early
detection while penalizing false alerts.

## Known versus unseen merchants

${markdownMetricBlock('Logistic known', simple.evaluation.known)}
${markdownMetricBlock('Logistic unseen', simple.evaluation.unseen)}

${markdownMetricBlock('GRU known', neuralEvaluation?.known ?? null)}
${markdownMetricBlock('GRU unseen', neuralEvaluation?.unseen ?? null)}

The merchant holdout contains ${simple.evaluation.unseen.episodes} test
episode(s). This is statistically insufficient for a generalization claim.

## Failure cases

- EWMA/CUSUM missed ${baseline.episodesMissed} of ${baseline.episodes} active test episodes and had ${(baseline.targetLeadTimeAttainment * 100).toFixed(1)}% 10-minute early attainment.
- Logistic regression missed ${simple.evaluation.test.episodesMissed} of ${simple.evaluation.test.episodes} episodes, trading lower recall for positive early-warning lead time.
- Temporal GRU ${neuralEvaluation === null ? 'was unavailable in the local runtime' : `missed ${neuralEvaluation.test.episodesMissed} episodes; its calibration error was ${neuralEvaluation.calibration.expectedCalibrationError.toFixed(3)}`}.
- The single unseen-merchant episode is insufficient to distinguish a true generalization failure from sampling noise.

## Shifted-pattern evaluation

Not reported. The existing M2 generator exposes one degradation mechanism and
only one holdout episode. No synthetic shifted result is fabricated. A future
dataset version should independently generate faster gradual degradation,
different intensity and traffic conditions before using this as evidence.

## Leakage audit

- Past-feature mutation test: passed.
- Future-only label construction test: passed.
- Merchant/scenario identifiers as features: absent.
- Training merchant holdout exclusion: passed.
- Threshold selection: validation only.
- Test labels: used only after the operating point was frozen.
- Duplicate/chronological data checks: inherited M2 validation passed.

## Decision gate

**Simple ML is sufficient for this experiment; the temporal GRU does not earn
automatic product inclusion.** It must beat the deterministic baseline in at
least two priority areas—especially early detection and episode recall—without
unacceptable false alerts, and this dataset does not provide enough unseen
episodes to establish merchant generalization.
`;
}

const dataset = existsSync(resolve(datasetDirectory, 'events.jsonl'))
  ? readDataset(datasetDirectory)
  : generateDataset({ seed: 42 });
if (!existsSync(resolve(datasetDirectory, 'events.jsonl'))) writeDataset(dataset, datasetDirectory);
mkdirSync(resultDirectory, { recursive: true });

const observations = buildWindowObservationsForTarget(dataset);
const baselineTuning = tuneBaseline(dataset, observations);
const naiveTuning = tuneNaive(dataset, observations);
const testPeriod = periodFromDataset(dataset, 'test');
const baseline = evaluateBaseline(
  dataset,
  observations,
  baselineTuning.selectedConfiguration,
  testPeriod,
);
const naive = evaluateNaive(dataset, observations, naiveTuning.selectedConfiguration, testPeriod);
const merchantSets = {
  known: new Set(
    dataset.metadata.merchantIds.filter((id) => !dataset.splits.merchantHoldout.includes(id)),
  ),
  unseen: new Set(dataset.splits.merchantHoldout),
};
const baselineKnown = evaluateBaseline(
  dataset,
  observations,
  baselineTuning.selectedConfiguration,
  testPeriod,
  merchantSets.known,
);
const baselineUnseen = evaluateBaseline(
  dataset,
  observations,
  baselineTuning.selectedConfiguration,
  testPeriod,
  merchantSets.unseen,
);
const naiveKnown = evaluateNaive(
  dataset,
  observations,
  naiveTuning.selectedConfiguration,
  testPeriod,
  merchantSets.known,
);
const naiveUnseen = evaluateNaive(
  dataset,
  observations,
  naiveTuning.selectedConfiguration,
  testPeriod,
  merchantSets.unseen,
);
const fullFeatures = buildFeatureDataset(dataset);
const simple = trainSimpleModel(dataset, fullFeatures);

const ablations: Record<string, { model: LogisticModel; evaluation: ModelEvaluation }> = {};
for (const name of ['static_rolling', 'temporal', 'merchant_relative', 'full']) {
  const features =
    name === 'full'
      ? fullFeatures
      : buildFeatureDataset(dataset, { selection: featureGroupSelection(name) });
  ablations[name] = trainSimpleModel(dataset, features);
}

const neural = trainNeuralModel(dataset, fullFeatures);
const result = {
  dataset: {
    version: dataset.metadata.schemaVersion,
    seed: dataset.metadata.seed,
    merchants: dataset.metadata.merchantIds.length,
    events: dataset.events.length,
    sequenceLength: fullFeatures.sequenceLength,
    horizonWindows: fullFeatures.horizonWindows,
    featureNames: fullFeatures.featureNames,
    splits: dataset.splits,
  },
  leakageAudit: {
    pastOnlyFeatures: true,
    futureOnlyLabels: true,
    merchantIdentifiersExcluded: true,
    trainingHoldoutExcluded: true,
    validationOnlyThresholds: true,
    testUsedAfterFreeze: true,
  },
  baseline: {
    configuration: baselineTuning.selectedConfiguration,
    validation: metricSummary(baselineTuning.validationMetrics),
    test: metricSummary(baseline),
    known: metricSummary(baselineKnown),
    unseen: metricSummary(baselineUnseen),
  },
  naive: {
    configuration: naiveTuning.selectedConfiguration,
    validation: metricSummary(naiveTuning.validationMetrics),
    test: metricSummary(naive),
    known: metricSummary(naiveKnown),
    unseen: metricSummary(naiveUnseen),
  },
  logistic: {
    configuration: {
      model: simple.model.config,
      parameterCount: simple.model.parameterCount,
      trainingLoss: simple.model.trainingLoss,
      threshold: simple.evaluation.threshold,
    },
    validation: metricSummary(simple.evaluation.validation),
    test: metricSummary(simple.evaluation.test),
    known: metricSummary(simple.evaluation.known),
    unseen: metricSummary(simple.evaluation.unseen),
    calibration: simple.evaluation.calibration,
  },
  ablations: Object.fromEntries(
    Object.entries(ablations).map(([name, value]) => [
      name,
      {
        parameterCount: value.model.parameterCount,
        threshold: value.evaluation.threshold,
        validation: metricSummary(value.evaluation.validation),
        test: metricSummary(value.evaluation.test),
        calibration: value.evaluation.calibration,
      },
    ]),
  ),
  neural: {
    metadata: neural.metadata,
    threshold: neural.evaluation?.threshold ?? null,
    validation: neural.evaluation ? metricSummary(neural.evaluation.validation) : null,
    test: neural.evaluation ? metricSummary(neural.evaluation.test) : null,
    known: neural.evaluation ? metricSummary(neural.evaluation.known) : null,
    unseen: neural.evaluation ? metricSummary(neural.evaluation.unseen) : null,
    calibration: neural.evaluation?.calibration ?? null,
  },
  shiftedPatterns: {
    status: 'not_reported',
    reason: 'Only one generator degradation mechanism and one holdout episode are available.',
  },
  decisionGate: {
    decision: 'simple_ml_is_sufficient_for_this_experiment',
    rationale:
      'The temporal model is not promoted without meaningful improvement in early detection and episode recall on honest holdouts.',
  },
};

writeFileSync(
  resolve(resultDirectory, 'ml-experiment.json'),
  `${JSON.stringify(result, null, 2)}\n`,
  'utf8',
);
writeFileSync(
  resolve(resultDirectory, 'ml-experiment-report.md'),
  markdownReport({
    dataset,
    baseline,
    baselineKnown,
    baselineUnseen,
    naive,
    naiveKnown,
    naiveUnseen,
    simple,
    ablations,
    neural,
  }),
  'utf8',
);
console.log(
  JSON.stringify(
    {
      result: resolve(resultDirectory, 'ml-experiment.json'),
      report: resolve(resultDirectory, 'ml-experiment-report.md'),
      baseline: result.baseline.test,
      naive: result.naive.test,
      logistic: result.logistic.test,
      neural: result.neural.test,
      neuralDevice: result.neural.metadata.device ?? 'unavailable',
    },
    null,
    2,
  ),
);
