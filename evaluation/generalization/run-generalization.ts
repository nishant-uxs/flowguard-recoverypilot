import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DEFAULT_BASELINE_CONFIG,
  DEFAULT_NAIVE_CONFIG,
  buildWindowObservations,
  periodFromDataset,
  runBaseline,
  runNaiveThreshold,
  type BaselineConfig,
  type DetectorRun,
  type NaiveThresholdConfig,
} from '../baseline/detector.js';
import { buildFeatureDataset, type FeatureDataset, type FeatureSelection } from '../ml/features.js';
import {
  applyPlattScaling,
  calibrationMetrics,
  fitPlattScaling,
  type CalibrationMetrics,
} from '../ml/calibration.js';
import {
  predictLogisticRegression,
  predictionsToDetectorRun,
  trainLogisticRegression,
  type ModelPrediction,
  type ModelThresholdConfig,
} from '../ml/simple-model.js';
import {
  generateGeneralizationDataset,
  writeGeneralizationDataset,
  type GeneralizationDataset,
} from './generator-v2.js';
import { auditGeneralizationDataset, type LeakageAudit } from './audit.js';
import {
  DEFAULT_HARDENING_POLICY,
  DEFAULT_UTILITY_ASSUMPTIONS,
  evaluateHardeningRun,
  utilitySensitivity,
  type HardeningMetrics,
  type UtilityAssumptions,
} from './scoring.js';
import { splitDisjointSequences } from './splits.js';

const resultDirectory = resolve(process.cwd(), 'evaluation/results');
const datasetDirectory = resolve(process.cwd(), 'evaluation/datasets/generalization-v2');
const neuralInputPath = resolve(resultDirectory, 'generalization-neural-input.json');
const neuralOutputPath = resolve(resultDirectory, 'generalization-neural-output.json');
const knownMerchantSet = (dataset: GeneralizationDataset) =>
  new Set(
    dataset.metadata.merchantIds.filter(
      (merchantId) => !dataset.splits.merchantHoldout.includes(merchantId),
    ),
  );

type CandidateEvaluation = {
  name: string;
  featureNames: string[];
  model: string;
  validation: HardeningMetrics;
  test: HardeningMetrics;
  known: HardeningMetrics;
  unseen: HardeningMetrics;
  threshold?: ModelThresholdConfig;
  calibration?: {
    method: string;
    validation: CalibrationMetrics;
    test: CalibrationMetrics;
    scaling?: { slope: number; intercept: number; validationExamples: number };
  };
  metadata?: Record<string, unknown>;
};

function summary(metrics: HardeningMetrics) {
  return {
    period: metrics.period,
    merchants: metrics.merchants,
    episodes: metrics.episodes,
    episodesDetected: metrics.episodesDetected,
    episodesMissed: metrics.episodesMissed,
    falseEpisodes: metrics.falseEpisodes,
    alerts: metrics.alerts,
    falseAlerts: metrics.falseAlerts,
    precision: metrics.precision,
    recall: metrics.recall,
    f1: metrics.f1,
    falseAlertRate: metrics.falseAlertRate,
    medianLeadTimeMinutes: metrics.medianLeadTimeMinutes,
    meanLeadTimeMinutes: metrics.meanLeadTimeMinutes,
    p25LeadTimeMinutes: metrics.p25LeadTimeMinutes,
    p75LeadTimeMinutes: metrics.p75LeadTimeMinutes,
    percentDetectedAtLeast5MinutesEarly: metrics.percentDetectedAtLeast5MinutesEarly,
    percentDetectedAtLeast10MinutesEarly: metrics.percentDetectedAtLeast10MinutesEarly,
    percentDetectedAtLeast20MinutesEarly: metrics.percentDetectedAtLeast20MinutesEarly,
    lateDetections: metrics.lateDetections,
    leadTimeWeightedUtility: metrics.leadTimeWeightedUtility,
    alertsPerMerchant: metrics.alertsPerMerchant,
    duplicateDebouncedSignals: metrics.duplicateDebouncedSignals,
  };
}

function tuneThreshold(
  dataset: GeneralizationDataset,
  predictions: ModelPrediction[],
  policy = DEFAULT_HARDENING_POLICY,
): { threshold: ModelThresholdConfig; metrics: HardeningMetrics; objective: number } {
  const validation = periodFromDataset(dataset, 'validation');
  const known = knownMerchantSet(dataset);
  const candidates: ModelThresholdConfig[] = [];
  for (const threshold of [0.25, 0.35, 0.45, 0.55, 0.65, 0.75]) {
    for (const minimumPersistence of [1, 2, 3]) {
      candidates.push({
        threshold,
        minimumPersistence,
        cooldownWindows: policy.cooldownWindows,
        resetFraction: 0.5,
        resetPersistence: 3,
      });
    }
  }
  const scored = candidates.map((threshold) => {
    const metrics = evaluateHardeningRun(
      dataset,
      predictionsToDetectorRun(predictions, threshold),
      validation,
      known,
      policy,
    );
    const objective =
      metrics.leadTimeWeightedUtility +
      2 * metrics.percentDetectedAtLeast10MinutesEarly +
      metrics.recall -
      2 * metrics.falseAlertRate;
    return { threshold, metrics, objective };
  });
  const selected = scored.sort((first, second) => second.objective - first.objective)[0]!;
  return {
    threshold: selected.threshold,
    metrics: selected.metrics,
    objective: selected.objective,
  };
}

function evaluateModel(
  dataset: GeneralizationDataset,
  name: string,
  predictions: ModelPrediction[],
  featureNames: string[],
  metadata: Record<string, unknown> = {},
): CandidateEvaluation {
  const policy = DEFAULT_HARDENING_POLICY;
  const known = knownMerchantSet(dataset);
  const holdout = new Set(dataset.splits.merchantHoldout);
  const calibrationValidation = predictions.filter(
    (prediction) =>
      prediction.endWindow >= dataset.splits.temporalWindows.validation.startWindow &&
      prediction.endWindow < dataset.splits.temporalWindows.validation.endWindowExclusive &&
      known.has(prediction.merchantId),
  );
  const calibration = fitPlattScaling(calibrationValidation);
  const calibratedPredictions = applyPlattScaling(predictions, calibration);
  const threshold = tuneThreshold(dataset, calibratedPredictions, policy);
  const test = periodFromDataset(dataset, 'test');
  const validation = threshold.metrics;
  const testPredictions = calibratedPredictions.filter(
    (prediction) =>
      prediction.endWindow >= test.startWindow && prediction.endWindow < test.endWindowExclusive,
  );
  const evaluation: CandidateEvaluation = {
    name,
    featureNames,
    model: 'logistic_regression',
    validation,
    test: evaluateHardeningRun(
      dataset,
      predictionsToDetectorRun(calibratedPredictions, threshold.threshold),
      test,
      new Set(dataset.metadata.merchantIds),
      policy,
    ),
    known: evaluateHardeningRun(
      dataset,
      predictionsToDetectorRun(calibratedPredictions, threshold.threshold),
      test,
      known,
      policy,
    ),
    unseen: evaluateHardeningRun(
      dataset,
      predictionsToDetectorRun(calibratedPredictions, threshold.threshold),
      test,
      holdout,
      policy,
    ),
    threshold: threshold.threshold,
    calibration: {
      method: 'Platt scaling fit on known validation predictions only',
      validation: calibrationMetrics(calibrationValidation),
      test: calibrationMetrics(testPredictions),
      scaling: calibration,
    },
    metadata: { ...metadata, thresholdObjective: threshold.objective },
  };
  return evaluation;
}

function trainLogisticCandidate(
  dataset: GeneralizationDataset,
  featureDataset: FeatureDataset,
  name: string,
  selection: FeatureSelection,
): CandidateEvaluation {
  const selectedFeatures = buildFeatureDataset(dataset, {
    sequenceLength: featureDataset.sequenceLength,
    horizonMinutes: dataset.truth.targetSpec.predictionHorizonMinutes,
    selection,
  });
  const splits = splitDisjointSequences(dataset, selectedFeatures, {
    excludeMerchantHoldoutFromTrain: true,
  });
  const model = trainLogisticRegression(splits.train);
  const predictions = predictLogisticRegression(model, selectedFeatures.sequences);
  return evaluateModel(dataset, name, predictions, selectedFeatures.featureNames, {
    parameterCount: model.parameterCount,
    trainingLoss: model.trainingLoss,
  });
}

function neuralInput(dataset: GeneralizationDataset, featureDataset: FeatureDataset) {
  const splits = splitDisjointSequences(dataset, featureDataset, {
    excludeMerchantHoldoutFromTrain: true,
  });
  return {
    seed: 45,
    modelVersion: 'm4.5-gru-v2',
    hiddenSize: 16,
    learningRate: 0.003,
    epochs: 40,
    batchSize: 128,
    train: splits.train,
    all: featureDataset.sequences,
  };
}

function trainNeuralCandidate(
  dataset: GeneralizationDataset,
  featureDataset: FeatureDataset,
): CandidateEvaluation | null {
  mkdirSync(resultDirectory, { recursive: true });
  writeFileSync(
    neuralInputPath,
    `${JSON.stringify(neuralInput(dataset, featureDataset))}\n`,
    'utf8',
  );
  try {
    execFileSync(
      'python',
      [resolve(process.cwd(), 'evaluation/ml/train_gru.py'), neuralInputPath, neuralOutputPath],
      { stdio: 'inherit' },
    );
  } catch (error) {
    writeFileSync(
      neuralOutputPath,
      `${JSON.stringify({ status: 'unavailable', reason: String(error) }, null, 2)}\n`,
    );
  }
  const output = JSON.parse(readFileSync(neuralOutputPath, 'utf8')) as {
    status: string;
    predictions?: ModelPrediction[];
    [key: string]: unknown;
  };
  if (output.status !== 'trained' || output.predictions === undefined) return null;
  const metadata = { ...output };
  delete metadata.predictions;
  const result = evaluateModel(
    dataset,
    'gru_sequence_model',
    output.predictions,
    featureDataset.featureNames,
    metadata,
  );
  result.model = 'temporal_gru';
  return result;
}

function detectorCandidate(
  dataset: GeneralizationDataset,
  name: string,
  run: DetectorRun,
  config: BaselineConfig | NaiveThresholdConfig,
): CandidateEvaluation {
  const test = periodFromDataset(dataset, 'test');
  const validation = periodFromDataset(dataset, 'validation');
  const known = knownMerchantSet(dataset);
  const holdout = new Set(dataset.splits.merchantHoldout);
  const policy = DEFAULT_HARDENING_POLICY;
  const evaluate = (period: typeof test, merchants: Set<string>) =>
    evaluateHardeningRun(dataset, run, period, merchants, policy);
  return {
    name,
    model: name === 'naive_threshold' ? 'global_rolling_threshold' : 'ewma_cusum',
    featureNames: ['rolling failure rate', 'merchant-relative failure and latency deviations'],
    validation: evaluate(validation, known),
    test: evaluate(test, new Set(dataset.metadata.merchantIds)),
    known: evaluate(test, known),
    unseen: evaluate(test, holdout),
    metadata: { configuration: config },
  };
}

function sensitivity(evaluations: CandidateEvaluation[]): Record<string, Record<string, number>> {
  const assumptions: Record<string, UtilityAssumptions> = {
    balanced: DEFAULT_UTILITY_ASSUMPTIONS,
    falseAlertsExpensive: {
      ...DEFAULT_UTILITY_ASSUMPTIONS,
      falseAlertCost: 3,
    },
    missesExpensive: {
      ...DEFAULT_UTILITY_ASSUMPTIONS,
      missedEpisodeCost: 10,
    },
    earlyValueHigher: {
      ...DEFAULT_UTILITY_ASSUMPTIONS,
      earlyMinuteValue: 0.2,
    },
  };
  return Object.fromEntries(
    evaluations.map((evaluation) => [
      evaluation.name,
      utilitySensitivity(evaluation.test, assumptions),
    ]),
  );
}

function renderMetrics(metrics: HardeningMetrics): string {
  const value = (number: number | null) => (number === null ? 'n/a' : number.toFixed(3));
  return [
    `episodes ${metrics.episodesDetected}/${metrics.episodes}`,
    `precision ${value(metrics.precision)}`,
    `recall ${value(metrics.recall)}`,
    `F1 ${value(metrics.f1)}`,
    `false-alert rate ${value(metrics.falseAlertRate)}`,
    `median lead ${metrics.medianLeadTimeMinutes === null ? 'n/a' : `${metrics.medianLeadTimeMinutes}m`}`,
    `>=5m early ${value(metrics.percentDetectedAtLeast5MinutesEarly * 100)}%`,
    `>=10m early ${value(metrics.percentDetectedAtLeast10MinutesEarly * 100)}%`,
    `>=20m early ${value(metrics.percentDetectedAtLeast20MinutesEarly * 100)}%`,
    `utility ${value(metrics.leadTimeWeightedUtility)}`,
  ].join('; ');
}

function markdownReport(
  dataset: GeneralizationDataset,
  audit: LeakageAudit,
  evaluations: CandidateEvaluation[],
  ablations: CandidateEvaluation[],
  neural: CandidateEvaluation | null,
  utilityResults: Record<string, Record<string, number>>,
): string {
  const allCandidates = [...evaluations, ...ablations];
  const best = [...allCandidates].sort(
    (first, second) =>
      second.test.leadTimeWeightedUtility - first.test.leadTimeWeightedUtility ||
      second.test.percentDetectedAtLeast10MinutesEarly -
        first.test.percentDetectedAtLeast10MinutesEarly,
  )[0];
  const evidence = dataset.truth.degradationIntervals.filter(
    (interval) => interval.phase === 'severe',
  ).length;
  const decision =
    neural === null
      ? 'DATASET/EVALUATION INSUFFICIENT FOR A TEMPORAL-NEURAL PRODUCT DECISION'
      : neural.unseen.episodes < 10 ||
          neural.unseen.episodesDetected + neural.unseen.episodesMissed < 10
        ? 'DATASET/EVALUATION INSUFFICIENT FOR A TEMPORAL-NEURAL PRODUCT DECISION'
        : neural.test.leadTimeWeightedUtility > (best?.test.leadTimeWeightedUtility ?? -Infinity)
          ? 'TEMPORAL NEURAL MODEL REQUIRES FURTHER EVIDENCE BEFORE PRODUCT INTEGRATION'
          : 'SIMPLER MODEL IS PREFERRED ON THIS PROTOCOL';
  const compact = (value: number | null) => (value === null ? 'n/a' : value.toFixed(3));
  const comparison = evaluations
    .map((evaluation) => {
      const brier = evaluation.calibration?.test.brierScore ?? null;
      const ece = evaluation.calibration?.test.expectedCalibrationError ?? null;
      return `| ${evaluation.name} | ${compact(evaluation.test.precision)} | ${compact(evaluation.test.recall)} | ${compact(evaluation.test.f1)} | ${compact(evaluation.test.falseAlertRate)} | ${evaluation.test.episodesDetected}/${evaluation.test.episodes} | ${evaluation.test.medianLeadTimeMinutes === null ? 'n/a' : `${evaluation.test.medianLeadTimeMinutes}m`} | ${compact(evaluation.test.percentDetectedAtLeast5MinutesEarly * 100)}% | ${compact(evaluation.test.percentDetectedAtLeast10MinutesEarly * 100)}% | ${compact(evaluation.test.percentDetectedAtLeast20MinutesEarly * 100)}% | ${compact(brier)} | ${compact(ece)} | ${compact(evaluation.known.f1)}/${compact(evaluation.known.percentDetectedAtLeast10MinutesEarly * 100)}% | ${compact(evaluation.unseen.f1)}/${compact(evaluation.unseen.percentDetectedAtLeast10MinutesEarly * 100)}% |`;
    })
    .join('\n');
  const ablation = ablations
    .map((evaluation) => `- ${evaluation.name}: ${renderMetrics(evaluation.test)}`)
    .join('\n');
  const calibration = evaluations
    .filter((evaluation) => evaluation.calibration !== undefined)
    .map(
      (evaluation) =>
        `- ${evaluation.name}: test Brier ${evaluation.calibration!.test.brierScore.toFixed(3)}, test ECE ${evaluation.calibration!.test.expectedCalibrationError.toFixed(3)}; ${evaluation.calibration!.method}`,
    )
    .join('\n');
  return `# M4.5 Independent Generalization Report

## Scope and scientific status

This report evaluates **synthetic payment events only**. It does not represent TEST MODE or production traffic, and normalized utility units are not revenue. The original v1 dataset and M4 outputs were not modified.

The first M4 GRU result (F1 1.000) was misleading: it detected episodes late (median lead -15 minutes), attained the 10-minute target only 5% of the time, and had poor calibration (Brier 0.269, ECE 0.447). M4.5 therefore scores useful early warning separately from eventual episode classification.

## Dataset v2

- Protocol: \`${dataset.truth.protocolVersion}\`; seed \`${dataset.metadata.seed}\`; ${dataset.metadata.merchantIds.length} merchants; ${dataset.events.length} events; ${dataset.metadata.windows} five-minute windows.
- Known merchants: ${dataset.metadata.merchantIds.length - dataset.splits.merchantHoldout.length}; merchant-disjoint holdout: ${dataset.splits.merchantHoldout.length}.
- Temporal split: train ${dataset.splits.temporalWindows.train.startWindow}-${dataset.splits.temporalWindows.train.endWindowExclusive}, validation ${dataset.splits.temporalWindows.validation.startWindow}-${dataset.splits.temporalWindows.validation.endWindowExclusive}, test ${dataset.splits.temporalWindows.test.startWindow}-${dataset.splits.temporalWindows.test.endWindowExclusive}.
- Sequence-boundary purge: ${4 - 1} input windows, so adjacent partitions do not reuse raw observation windows.
- Training mechanisms: A/B/C. Shifted and stress mechanisms reserved for holdout: D/E/F/G/H/I/J.
- Scenario families: ${Object.entries(dataset.truth.scenarioFamilies)
    .map(([family, mechanisms]) => `${family}=${mechanisms.join('/')}`)
    .join('; ')}.
- Mechanisms: ${Object.entries(dataset.truth.mechanismFamilies)
    .map(([key, description]) => `${key} ${description}`)
    .join('; ')}.
- Severe intervals in the generated truth: ${evidence}. Target episodes are only degraded/severe intervals; early signal and recovery are not target labels.

The model target is: “will sustained degradation begin in the next 30 minutes?” At scoring time, an alert is useful through 30 minutes after onset, is early only when issued before onset, and is matched to the earliest unused alert in the 30-minute prediction horizon. Alerts after the useful window are not credited.

## Leakage and split audit

- Duplicate event IDs: ${audit.duplicateEventIds}; duplicate payment IDs: ${audit.duplicatePaymentIds}.
- Scenario families in train: ${audit.scenarioFamiliesInTrain.join(', ')}; holdout: ${audit.scenarioFamiliesInHoldout.join(', ')}.
- Merchant overlap: ${audit.merchantOverlapBetweenTrainAndHoldout.length}.
- Best single-feature probe accuracy: ${audit.bestSingleFeatureProbeAccuracy.toFixed(3)} versus label prevalence ${audit.labelPrevalence.toFixed(3)}.
- Critical leakage detected: **${audit.criticalLeakageDetected ? 'YES' : 'NO'}**.

The audit checks identifiers, duplicates, merchant overlap, scenario disjointness, and simple count/failure-rate probes. It is not a proof against every multivariate artifact; adversarial probes remain a limitation.

## Model comparison

All candidates use the same test period, episode matcher, useful intervention window, cooldown policy, and lead-time definitions. Logistic and GRU thresholds are tuned on known validation merchants only. Calibration is Platt scaling fit on known validation predictions only.

| Model | Precision | Recall | F1 | False-alert rate | Episodes | Median lead | >=5m early | >=10m early | >=20m early | Brier | ECE | Known F1 / >=10m | Unseen F1 / >=10m |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${comparison}
${neural === null ? '| GRU sequence model | unavailable | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |' : ''}

Metrics include episode recall, false-alert rate, median/mean/p25/p75 lead, percentage detected at least 5/10/20 minutes early, and normalized lead-time utility. Percentages use detected episodes as their denominator; episode counts are always shown.

## Calibration

${calibration || '- No calibrated candidate was available.'}

## Ablation

${ablation}

The ablation is intended to show whether static/rolling, temporal trend, merchant-relative or full features drive the result. A GRU is a separate sequence-model comparison, not evidence that a larger network is automatically better.

## Cost-sensitive sensitivity

The utility assumptions are normalized evaluation assumptions: false alert cost 1, missed episode cost 5, early value 0.1 per early minute capped at 30 minutes. Sensitivity changes false-alert cost, missed-episode cost, and early value; these are not Razorpay economics.

\`\`\`json
${JSON.stringify(utilityResults, null, 2)}
\`\`\`

## Failure cases and limitations

- A false alert is any unmatched alert in the scoped test period, including alerts during stable windows and alerts after an episode's useful window.
- A late-useful detection is credited as episode detection but is not early warning.
- A missed episode is a true episode with no valid alert in the prediction horizon/useful window.
- The v2 holdout contains multiple mechanisms and merchant classes, but it remains synthetic and does not establish production generalization or statistical significance.
- The generator's fixed segment set and finite traffic model do not cover all payment-system failure modes.

## Decision gate

**${decision}**

Best scored candidate on the primary test utility/early-warning ordering: **${best?.name ?? 'none'}**.

This report does not authorize recovery actions. The data/evaluation is strong enough to proceed to the recovery-system layer only for a demo integration with explicit TEST MODE/simulation boundaries; it is **not** strong enough to claim production readiness, revenue recovery, or broad merchant generalization. A temporal neural model has not earned product integration unless it improves early warning, recall, false-alert control and shifted-merchant performance together.
`;
}

export function runGeneralizationExperiment(): void {
  const dataset = generateGeneralizationDataset();
  writeGeneralizationDataset(dataset, datasetDirectory);
  const audit = auditGeneralizationDataset(dataset);
  const observations = buildWindowObservations(dataset);
  const baseline = detectorCandidate(
    dataset,
    'ewma_cusum',
    runBaseline(observations, DEFAULT_BASELINE_CONFIG),
    DEFAULT_BASELINE_CONFIG,
  );
  const naive = detectorCandidate(
    dataset,
    'naive_threshold',
    runNaiveThreshold(observations, DEFAULT_NAIVE_CONFIG),
    DEFAULT_NAIVE_CONFIG,
  );
  const featureDataset = buildFeatureDataset(dataset);
  const logistic = trainLogisticCandidate(dataset, featureDataset, 'logistic_full', {});
  const ablations = [
    trainLogisticCandidate(dataset, featureDataset, 'logistic_static_rolling', {
      groups: ['static', 'rolling'],
    }),
    trainLogisticCandidate(dataset, featureDataset, 'logistic_temporal', { groups: ['temporal'] }),
    trainLogisticCandidate(dataset, featureDataset, 'logistic_merchant_relative', {
      groups: ['merchant_relative'],
    }),
  ];
  const neural = trainNeuralCandidate(dataset, featureDataset);
  const evaluations = [naive, baseline, logistic];
  if (neural !== null) evaluations.push(neural);
  const utilityResults = sensitivity(evaluations);
  const report = markdownReport(dataset, audit, evaluations, ablations, neural, utilityResults);
  mkdirSync(resultDirectory, { recursive: true });
  const manifest = {
    protocolVersion: dataset.truth.protocolVersion,
    datasetVersion: 'generalization-v2',
    datasetSeed: dataset.metadata.seed,
    merchants: dataset.metadata.merchantIds.length,
    events: dataset.events.length,
    windows: dataset.metadata.windows,
    split: dataset.splits,
    purgedSequenceBoundaryWindows: featureDataset.sequenceLength - 1,
    trainMechanisms: ['A', 'B', 'C'],
    shiftedMechanisms: ['D', 'E', 'F', 'G', 'H', 'I', 'J'],
    scenarioFamilies: dataset.truth.scenarioFamilies,
    sequenceLength: featureDataset.sequenceLength,
    horizonWindows: featureDataset.horizonWindows,
    featureNames: featureDataset.featureNames,
    modelSeed: 45,
    models: {
      logistic: { learningRate: 0.08, epochs: 300, l2: 0.001 },
      gru: {
        version: 'm4.5-gru-v2',
        hiddenSize: 16,
        learningRate: 0.003,
        epochs: 40,
        batchSize: 128,
      },
    },
    policy: DEFAULT_HARDENING_POLICY,
    utilityAssumptions: DEFAULT_UTILITY_ASSUMPTIONS,
    calibration: 'Platt scaling on known validation predictions only',
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    leakageAudit: audit,
  };
  writeFileSync(
    resolve(resultDirectory, 'experiment-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  const result = {
    manifest,
    audit,
    models: Object.fromEntries(
      evaluations.map((evaluation) => [
        evaluation.name,
        {
          model: evaluation.model,
          featureNames: evaluation.featureNames,
          validation: summary(evaluation.validation),
          test: summary(evaluation.test),
          known: summary(evaluation.known),
          unseen: summary(evaluation.unseen),
          threshold: evaluation.threshold,
          calibration: evaluation.calibration,
          metadata: evaluation.metadata,
          utilitySensitivity: utilityResults[evaluation.name],
        },
      ]),
    ),
    ablations: Object.fromEntries(
      ablations.map((evaluation) => [
        evaluation.name,
        {
          test: summary(evaluation.test),
          known: summary(evaluation.known),
          unseen: summary(evaluation.unseen),
        },
      ]),
    ),
    decision: {
      reportVersion: 'm4.5-hardening-v1',
      syntheticOnly: true,
      recoveryLayerReadyForDemoOnly: true,
      productionReady: false,
      neuralModelAvailable: neural !== null,
      rationale:
        neural === null
          ? 'Temporal neural training was unavailable; no neural product decision is justified.'
          : 'M4.5 requires multi-dimensional improvement on early warning, recall, false alerts, shifted merchants and calibration; synthetic evidence alone cannot establish production readiness.',
    },
  };
  writeFileSync(
    resolve(resultDirectory, 'generalization-report.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(resolve(resultDirectory, 'generalization-report.md'), report, 'utf8');
  console.log(report);
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('run-generalization.ts')) {
  runGeneralizationExperiment();
}
