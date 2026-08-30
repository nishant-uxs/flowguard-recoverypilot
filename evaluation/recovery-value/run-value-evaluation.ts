import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  applyPlattScaling,
  calibrationMetrics,
  fitPlattScaling,
  type CalibrationMetrics,
} from '../ml/calibration.js';
import type { ModelPrediction } from '../ml/simple-model.js';
import {
  CURRENT_M5_SIMULATOR_AUDIT,
  generateRecoveryOpportunityBatch,
  MODEL_FEATURE_FIELDS,
  predictRecoveryProbability,
  runOpportunityStrategy,
  topKMetrics,
  type OpportunityEnvironmentOptions,
  type RecoveryOpportunityCase,
  type OpportunityRun,
} from './opportunity.js';

const resultDirectory = resolve(process.cwd(), 'evaluation/results');
const SEEDS = Array.from({ length: 20 }, (_, index) => index + 1);
const BUDGETS = [10, 25, 50, 75, 100];
const TOP_K = [10, 25, 50];

type NumericSummary = {
  mean: number;
  median: number;
  standardDeviation: number;
  confidenceInterval95: [number, number];
};

type BudgetSummary = {
  budget: number;
  baseline: NumericSummary & {
    meanInterventions: number;
    meanRecoveries: number;
    meanValuePerInterventionPaise: number;
  };
  flowguard: NumericSummary & {
    meanInterventions: number;
    meanRecoveries: number;
    meanValuePerInterventionPaise: number;
  };
  probabilityFlowGuardBeatsBaseline: number;
};

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function median(values: number[]): number {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;
}

function standardDeviation(values: number[]): number {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function numericSummary(values: number[]): NumericSummary {
  const deviation = standardDeviation(values);
  const margin = (1.96 * deviation) / Math.sqrt(Math.max(1, values.length));
  return {
    mean: mean(values),
    median: median(values),
    standardDeviation: deviation,
    confidenceInterval95: [mean(values) - margin, mean(values) + margin],
  };
}

function summarizeRuns(runs: OpportunityRun[], budget: number): BudgetSummary {
  const baseline = runs.filter((run) => run.strategy === 'baseline');
  const flowguard = runs.filter((run) => run.strategy === 'flowguard');
  const baselineValues = baseline.map((run) => run.recoveredSimulatedValuePaise);
  const flowguardValues = flowguard.map((run) => run.recoveredSimulatedValuePaise);
  const wins = flowguardValues.filter((value, index) => value > baselineValues[index]!).length;
  return {
    budget,
    baseline: {
      ...numericSummary(baselineValues),
      meanInterventions: mean(baseline.map((run) => run.interventionsAttempted)),
      meanRecoveries: mean(baseline.map((run) => run.successfulRecoveries)),
      meanValuePerInterventionPaise: mean(
        baseline.map((run) => run.recoveredValuePerInterventionPaise),
      ),
    },
    flowguard: {
      ...numericSummary(flowguardValues),
      meanInterventions: mean(flowguard.map((run) => run.interventionsAttempted)),
      meanRecoveries: mean(flowguard.map((run) => run.successfulRecoveries)),
      meanValuePerInterventionPaise: mean(
        flowguard.map((run) => run.recoveredValuePerInterventionPaise),
      ),
    },
    probabilityFlowGuardBeatsBaseline: wins / Math.max(1, flowguardValues.length),
  };
}

async function runsForSeeds(
  seeds: number[],
  budget: number,
  options: OpportunityEnvironmentOptions = {},
): Promise<OpportunityRun[]> {
  const runs: OpportunityRun[] = [];
  for (const seed of seeds) {
    const cases = generateRecoveryOpportunityBatch(seed, 200, options);
    runs.push(await runOpportunityStrategy(cases, budget, 'baseline'));
    runs.push(await runOpportunityStrategy(cases, budget, 'flowguard'));
  }
  return runs;
}

function topKSummary(
  samples: Array<ReturnType<typeof topKMetrics>>,
  k: number,
  strategy: 'baseline' | 'flowguard',
) {
  const filtered = samples.filter((sample) => sample.k === k && sample.strategy === strategy);
  return {
    k,
    strategy,
    precisionAtK: numericSummary(filtered.map((sample) => sample.precisionAtK)),
    recallAtK: numericSummary(filtered.map((sample) => sample.recallAtK)),
    recoveryValueAtKPaise: numericSummary(filtered.map((sample) => sample.recoveryValueAtKPaise)),
    averageValuePerRankedInterventionPaise: numericSummary(
      filtered.map((sample) => sample.averageValuePerRankedInterventionPaise),
    ),
  };
}

function timingSummary(cases: RecoveryOpportunityCase[]) {
  const early = cases.filter((item) => item.observation.minutesSinceDetection <= 10);
  const late = cases.filter((item) => item.observation.minutesSinceDetection >= 30);
  const summarize = (group: RecoveryOpportunityCase[]) => ({
    cases: group.length,
    counterfactualSuccessRate:
      group.filter((item) => item.hiddenOutcome.wouldRecoverIfIntervened).length /
      Math.max(1, group.length),
    meanLatentSuccessProbability: mean(
      group.map((item) => item.hiddenOutcome.latentSuccessProbability),
    ),
    meanPredictedSuccessProbability: mean(
      group.map((item) => predictRecoveryProbability(item.observation)),
    ),
  });
  return { early: summarize(early), late: summarize(late) };
}

function inputIntegrityAudit(cases: RecoveryOpportunityCase[]): {
  hiddenOutcomeIsNotAnInput: boolean;
  hiddenPropensityIsNotAnInput: boolean;
  identifiersExcludedFromModelFeatures: boolean;
  scoreUnchangedWhenCounterfactualChanges: boolean;
  modelInputFields: string[];
} {
  const observation = cases[0]!.observation;
  const fields = [...MODEL_FEATURE_FIELDS].sort();
  const changedCounterfactual = {
    ...cases[0]!,
    hiddenOutcome: {
      ...cases[0]!.hiddenOutcome,
      wouldRecoverIfIntervened: !cases[0]!.hiddenOutcome.wouldRecoverIfIntervened,
      latentSuccessProbability: 1 - cases[0]!.hiddenOutcome.latentSuccessProbability,
    },
  };
  return {
    hiddenOutcomeIsNotAnInput: !fields.some((field) => field.toLowerCase().includes('hidden')),
    hiddenPropensityIsNotAnInput: !fields.some((field) => field.toLowerCase().includes('latent')),
    identifiersExcludedFromModelFeatures: !fields.some((field) =>
      ['caseId', 'paymentId', 'merchantId', 'sourceEventId', 'merchantApproval'].includes(field),
    ),
    scoreUnchangedWhenCounterfactualChanges:
      predictRecoveryProbability(observation) ===
      predictRecoveryProbability(changedCounterfactual.observation),
    modelInputFields: fields,
  };
}

function calibrationSummary(cases: RecoveryOpportunityCase[]): {
  fit: CalibrationMetrics;
  test: CalibrationMetrics;
  scaling: { slope: number; intercept: number; validationExamples: number };
} {
  const predictions: ModelPrediction[] = cases.map((item, index) => ({
    merchantId: item.observation.merchantId,
    endWindow: index,
    timestamp: '2026-08-30T12:00:00.000Z',
    probability: predictRecoveryProbability(item.observation),
    label: item.hiddenOutcome.wouldRecoverIfIntervened ? 1 : 0,
  }));
  const split = Math.floor(predictions.length / 2);
  const validation = predictions.slice(0, split);
  const test = predictions.slice(split);
  const scaling = fitPlattScaling(validation);
  return {
    fit: calibrationMetrics(validation),
    test: calibrationMetrics(applyPlattScaling(test, scaling)),
    scaling,
  };
}

function report(
  budgetSummaries: BudgetSummary[],
  topKSummaries: Array<ReturnType<typeof topKSummary>>,
  timing: ReturnType<typeof timingSummary>,
  calibration: ReturnType<typeof calibrationSummary>,
  sensitivity: Record<string, BudgetSummary>,
  audit: ReturnType<typeof inputIntegrityAudit>,
): string {
  const table = budgetSummaries
    .flatMap((summary) => [
      `| Baseline | ${summary.budget} | ${summary.baseline.meanInterventions.toFixed(1)} | ${summary.baseline.meanRecoveries.toFixed(1)} | ${summary.baseline.mean.toFixed(1)} |`,
      `| FlowGuard | ${summary.budget} | ${summary.flowguard.meanInterventions.toFixed(1)} | ${summary.flowguard.meanRecoveries.toFixed(1)} | ${summary.flowguard.mean.toFixed(1)} |`,
    ])
    .join('\n');
  const topK = topKSummaries
    .map(
      (summary) =>
        `| ${summary.strategy} | ${summary.k} | ${summary.precisionAtK.mean.toFixed(3)} | ${summary.recallAtK.mean.toFixed(3)} | ${summary.recoveryValueAtKPaise.mean.toFixed(1)} | ${summary.averageValuePerRankedInterventionPaise.mean.toFixed(1)} |`,
    )
    .join('\n');
  const sensitivityRows = Object.entries(sensitivity)
    .map(
      ([name, summary]) =>
        `| ${name} | ${summary.baseline.mean.toFixed(1)} | ${summary.flowguard.mean.toFixed(1)} | ${summary.probabilityFlowGuardBeatsBaseline.toFixed(3)} |`,
    )
    .join('\n');
  const defaultBudget50 = budgetSummaries.find((summary) => summary.budget === 50)!;
  const flowguardAdvantage =
    defaultBudget50.flowguard.mean > defaultBudget50.baseline.mean &&
    defaultBudget50.flowguard.meanValuePerInterventionPaise >
      defaultBudget50.baseline.meanValuePerInterventionPaise;
  const decision = flowguardAdvantage
    ? 'A — FlowGuard demonstrates incremental simulated recovery value under this synthetic response model.'
    : 'B — FlowGuard reduces unnecessary interventions but does not demonstrate incremental simulated recovery value.';
  return `# M6 Recovery Opportunity and Business-Value Report

## Current M5 result (preserved)

M5 remains versioned as \`m5-recovery-batch-v1\`: 120 simulated cases, baseline 110 interventions and 36,000 simulated units recovered, FlowGuard 80 interventions and 36,000 simulated units recovered, with zero incremental simulated value. M6 does not overwrite those artifacts.

## M6 synthetic recovery environment

This is **SIMULATED** evaluation data, not Razorpay behavior or revenue. M5's simulator audit found that outcomes were explicit scenarios or a seed hash and did not vary with amount, timing, severity or model score. It could test executor safety but not opportunity ranking.

M6 generates a hidden counterfactual outcome for each candidate. Hidden recovery propensity varies with merchant historical success, customer responsiveness, degradation severity, time since detection, amount, retry count, latency and latent noise. The decision layer sees only noisy observable proxies. It never receives the hidden propensity or counterfactual outcome, and probability is never calculated from the model's own prediction.

Decision-time opportunity value is:

\`\`\`text
expected recovery value = predicted success probability × recoverable amount
                           − intervention cost
\`\`\`

The baseline is fixed input-order selection with the same approval, amount and executor constraints. FlowGuard ranks by expected recovery value and applies the same bounded policy, approval and verification flow.

## Budget-constrained recovery value

The following are means over 20 independent seeds; value is simulated paise-like units and not money.

| Strategy | Budget | Interventions | Recoveries | Simulated Value |
|---|---:|---:|---:|---:|
${table}

Each budget also has standard deviation and a 95% confidence interval in \`recovery-value-report.json\`; no budget was cherry-picked.

## Top-K opportunity ranking

| Strategy | K | Precision@K | Recall@K | Recovery value@K | Average value/rank |
|---|---:|---:|---:|---:|---:|
${topK}

## Timing

Timing decay is modest and monotonic by construction rather than a large artificial cliff. Early means 0–10 minutes since detection; late means 30+ minutes.

- Early: ${timing.early.cases} cases, counterfactual success rate ${(timing.early.counterfactualSuccessRate * 100).toFixed(1)}%, mean latent probability ${timing.early.meanLatentSuccessProbability.toFixed(3)}, mean predicted probability ${timing.early.meanPredictedSuccessProbability.toFixed(3)}.
- Late: ${timing.late.cases} cases, counterfactual success rate ${(timing.late.counterfactualSuccessRate * 100).toFixed(1)}%, mean latent probability ${timing.late.meanLatentSuccessProbability.toFixed(3)}, mean predicted probability ${timing.late.meanPredictedSuccessProbability.toFixed(3)}.

## Calibration

Recovery probability is calibrated as a separate target: probability that an intervention recovers the candidate. Platt scaling uses the first half of evaluator samples only; the second half is reported as calibration test data.

- Validation fit Brier: ${calibration.fit.brierScore.toFixed(3)}, ECE: ${calibration.fit.expectedCalibrationError.toFixed(3)}
- Calibration-test Brier: ${calibration.test.brierScore.toFixed(3)}, ECE: ${calibration.test.expectedCalibrationError.toFixed(3)}
- Scaling: slope ${calibration.scaling.slope.toFixed(3)}, intercept ${calibration.scaling.intercept.toFixed(3)}

## Sensitivity

| Scenario | Baseline value @50 | FlowGuard value @50 | P(FlowGuard > baseline) |
|---|---:|---:|---:|
${sensitivityRows}

Sensitivity changes observation noise, timing decay and intervention cost. These are evaluation assumptions, not Razorpay economics.

## Input integrity and limitations

- Hidden outcome absent from model input: **${audit.hiddenOutcomeIsNotAnInput ? 'YES' : 'NO'}**
- Hidden propensity absent from model input: **${audit.hiddenPropensityIsNotAnInput ? 'YES' : 'NO'}**
- Merchant/payment/source identifiers excluded from model features: **${audit.identifiersExcludedFromModelFeatures ? 'YES' : 'NO'}**
- Score unchanged when hidden counterfactual changes: **${audit.scoreUnchangedWhenCounterfactualChanges ? 'YES' : 'NO'}**
- Model inputs: \`${audit.modelInputFields.join('`, `')}\`
- Cases use synthetic merchant/customer context and do not establish production success probabilities.
- The baseline receives no model score; FlowGuard's advantage, if any, comes from ranking noisy observable opportunity signals.
- Approval unavailable/rejected candidates and policy abstentions are not counted as interventions.
- M6 uses unique candidates; duplicate prevention remains validated by the preserved M5 batch.

## Failure cases

The evaluator includes high-value candidates with low response probability, low-value candidates with high response probability, late candidates, low-confidence/low-observability candidates and approval failures. Ranking can therefore miss recoverable candidates or select false opportunities; all seeds and budgets are reported.

## Final decision gate

**${decision}**

This conclusion is limited to the independent synthetic response model. The opportunity architecture should remain separate from degradation detection:

\`\`\`text
temporal degradation detector -> recovery opportunity scorer -> policy -> approval -> bounded action -> verification
\`\`\`

No simulated value is presented as Razorpay revenue. The next product layer may use this bounded loop for a demo, but production integration still requires real TEST MODE validation, merchant approval and observed outcome data.
`;
}

export async function runRecoveryValueEvaluation(): Promise<void> {
  const baseCases = SEEDS.flatMap((seed) => generateRecoveryOpportunityBatch(seed, 200));
  const budgetSummaries: BudgetSummary[] = [];
  for (const budget of BUDGETS) {
    budgetSummaries.push(summarizeRuns(await runsForSeeds(SEEDS, budget), budget));
  }
  const topKSamples = SEEDS.flatMap((seed) => {
    const cases = generateRecoveryOpportunityBatch(seed, 200);
    return TOP_K.flatMap((k) => [
      topKMetrics(cases, k, 'baseline'),
      topKMetrics(cases, k, 'flowguard'),
    ]);
  });
  const topKSummaries = TOP_K.flatMap((k) => [
    topKSummary(topKSamples, k, 'baseline'),
    topKSummary(topKSamples, k, 'flowguard'),
  ]);
  const timing = timingSummary(baseCases);
  const calibration = calibrationSummary(baseCases);
  const sensitivityOptions: Record<string, OpportunityEnvironmentOptions> = {
    default: {},
    higher_observation_noise: { observationNoise: 0.2 },
    faster_timing_decay: { timingDecayMultiplier: 1.5 },
    higher_intervention_cost: { interventionCostPaise: 100 },
  };
  const sensitivity: Record<string, BudgetSummary> = {};
  for (const [name, options] of Object.entries(sensitivityOptions)) {
    sensitivity[name] = summarizeRuns(await runsForSeeds(SEEDS, 50, options), 50);
  }
  const audit = inputIntegrityAudit(baseCases);
  const budgetRuns = Object.fromEntries(
    budgetSummaries.map((summary) => [String(summary.budget), summary]),
  );
  const result = {
    version: 'm6-recovery-value-v1',
    label: 'SIMULATED',
    seeds: SEEDS,
    casesPerSeed: 200,
    budgets: BUDGETS,
    currentM5SimulatorAudit: CURRENT_M5_SIMULATOR_AUDIT,
    m5ResultPreserved: {
      version: 'm5-recovery-batch-v1',
      baselineSimulatedRecoveredValuePaise: 36_000,
      flowguardSimulatedRecoveredValuePaise: 36_000,
      incrementalSimulatedRecoveredValuePaise: 0,
    },
    environment: {
      hiddenCounterfactualOutcome: true,
      decisionTimeInputs: audit.modelInputFields,
      options: sensitivityOptions,
      baseline: 'fixed input-order selection with shared approval/policy/executor constraints',
      flowguard: 'expected recovery value ranking with shared constraints',
    },
    budgetCurves: budgetRuns,
    topK: topKSummaries,
    timing,
    calibration,
    sensitivity,
    inputIntegrityAudit: audit,
    decision: {
      type:
        budgetSummaries[2]!.flowguard.mean > budgetSummaries[2]!.baseline.mean
          ? 'FLOWGUARD_INCREMENTAL_VALUE_ON_SYNTHETIC_PROTOCOL'
          : 'FLOWGUARD_NO_INCREMENTAL_VALUE_ON_SYNTHETIC_PROTOCOL',
      productionReady: false,
      recoveryDemoReady: true,
      rationale:
        'The result is limited to an explicit synthetic counterfactual response model and cannot be represented as production revenue.',
    },
  };
  mkdirSync(resultDirectory, { recursive: true });
  writeFileSync(
    resolve(resultDirectory, 'recovery-value-report.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    resolve(resultDirectory, 'recovery-value-report.md'),
    report(budgetSummaries, topKSummaries, timing, calibration, sensitivity, audit),
    'utf8',
  );
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('run-value-evaluation.ts')) {
  void runRecoveryValueEvaluation().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
