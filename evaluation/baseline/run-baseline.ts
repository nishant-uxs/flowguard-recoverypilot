import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildSanityReport } from '../generator/sanity.js';
import { generateDataset, readDataset, writeDataset } from '../generator/temporal-dataset.js';
import {
  buildWindowObservationsForTarget,
  evaluateBaseline,
  evaluateKnownAndUnseen,
  evaluateNaive,
  periodFromDataset,
  tuneBaseline,
  tuneNaive,
} from './evaluation.js';

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function metricLine(label: string, value: number | null): string {
  return `- ${label}: ${value === null ? 'n/a' : value.toFixed(3)}`;
}

function verdictFor(metrics: ReturnType<typeof evaluateBaseline>): {
  verdict: 'WEAK BASELINE' | 'REASONABLE BASELINE' | 'STRONG BASELINE';
  room: string;
} {
  if (
    metrics.f1 >= 0.65 &&
    metrics.falseAlertRate <= 0.15 &&
    metrics.targetLeadTimeAttainment >= 0.5
  ) {
    return {
      verdict: 'STRONG BASELINE',
      room: 'Meaningful room remains only if ML improves lead time, false-alert cost or shifted-merchant performance without sacrificing episode recall.',
    };
  }
  if (metrics.f1 >= 0.35 && metrics.falseAlertRate <= 0.35) {
    return {
      verdict: 'REASONABLE BASELINE',
      room: 'There is credible room for ML to improve episode recall, early warning and merchant-shift robustness; it must beat this baseline on untouched holdouts.',
    };
  }
  return {
    verdict: 'WEAK BASELINE',
    room: 'There is substantial room for ML improvement, but the next step should first inspect data quality and baseline assumptions rather than add model complexity automatically.',
  };
}

function reportMarkdown(result: {
  dataset: ReturnType<typeof buildSanityReport> & { seed: number };
  configuration: ReturnType<typeof tuneBaseline>;
  naiveConfiguration: ReturnType<typeof tuneNaive>;
  test: ReturnType<typeof evaluateBaseline>;
  naiveTest: ReturnType<typeof evaluateNaive>;
  known: ReturnType<typeof evaluateBaseline>;
  unseen: ReturnType<typeof evaluateBaseline>;
  verdict: ReturnType<typeof verdictFor>;
}): string {
  const { configuration, naiveConfiguration, test, naiveTest, known, unseen } = result;
  return `# M3 — Temporal Degradation Baseline Report

This report is generated from synthetic data and does not represent production
Razorpay performance or real-money recovery.

## Dataset

- Seed: ${result.dataset.seed}
- Merchants: ${result.dataset.merchants}
- Events: ${result.dataset.events}
- Target segment: UPI Intent
- Test episodes active in the test period: ${test.episodes}
- Temporal windows: 5 minutes

## Detector

FlowGuard uses a merchant-specific warmup baseline, positive failure-rate and
latency deviations, EWMA smoothing, one-sided CUSUM accumulation, persistence
and episode debouncing. It uses no future event or label.

Configuration selected on validation only:

- EWMA alpha: ${configuration.selectedConfiguration.alpha}
- CUSUM reference: ${configuration.selectedConfiguration.cusumReference}
- EWMA threshold: ${configuration.selectedConfiguration.ewmaThreshold}
- CUSUM threshold: ${configuration.selectedConfiguration.cusumThreshold}
- Minimum persistence: ${configuration.selectedConfiguration.minimumPersistence} windows
- Cooldown: ${configuration.selectedConfiguration.cooldownWindows} windows
- Reset threshold/persistence: ${configuration.selectedConfiguration.resetThreshold} / ${configuration.selectedConfiguration.resetPersistence}
- Merchant warmup: ${configuration.selectedConfiguration.baselineWarmupWindows} windows
- Validation objective: ${configuration.selectionObjective.toFixed(3)}

## Final test results

${metricLine('Precision', test.precision)}
${metricLine('Recall', test.recall)}
${metricLine('F1', test.f1)}
${metricLine('False-alert rate during stable windows', test.falseAlertRate)}
- Alerts: ${test.alerts}
- Pre-period alerts used to detect active test episodes: ${test.prePeriodAlertsUsed}
- True episodes detected: ${test.episodesDetected}
- Missed episodes: ${test.episodesMissed}
- False episodes: ${test.falseEpisodes}
- Alerts per merchant: ${test.alertsPerMerchant.toFixed(3)}
- Debounced repeated signals across the full replay: ${test.duplicateDebouncedSignals}
${metricLine('Median detection lead time (minutes)', test.medianLeadTimeMinutes)}
${metricLine('Mean detection lead time (minutes)', test.meanLeadTimeMinutes)}
- Target lead-time attainment: ${percentage(test.targetLeadTimeAttainment)}

## Naive threshold comparison

The naive comparator is a global three-window rolling failure-rate threshold
with the same persistence and cooldown shape. Its threshold was selected on
validation only; it was not tuned on test.

- Selected threshold: ${naiveConfiguration.selectedConfiguration.threshold}
${metricLine('Precision', naiveTest.precision)}
${metricLine('Recall', naiveTest.recall)}
${metricLine('F1', naiveTest.f1)}
${metricLine('False-alert rate', naiveTest.falseAlertRate)}
- Alerts: ${naiveTest.alerts}
${metricLine('Median detection lead time (minutes)', naiveTest.medianLeadTimeMinutes)}
- Target lead-time attainment: ${percentage(naiveTest.targetLeadTimeAttainment)}

## Known versus unseen merchants

Known merchants:

${metricLine('Precision', known.precision)}
${metricLine('Recall', known.recall)}
${metricLine('F1', known.f1)}
${metricLine('False-alert rate', known.falseAlertRate)}
- Episodes detected/missed: ${known.episodesDetected}/${known.episodesMissed}

Merchant holdout:

${metricLine('Precision', unseen.precision)}
${metricLine('Recall', unseen.recall)}
${metricLine('F1', unseen.f1)}
${metricLine('False-alert rate', unseen.falseAlertRate)}
- Episodes detected/missed: ${unseen.episodesDetected}/${unseen.episodesMissed}

## Verdict

**${result.verdict.verdict}**

${result.verdict.room}

The baseline is intentionally interpretable and exists to establish whether
more complex ML provides measurable incremental value.
`;
}

const datasetDirectory = resolve(process.cwd(), 'evaluation/datasets/generated');
const resultDirectory = resolve(process.cwd(), 'evaluation/results');
mkdirSync(resultDirectory, { recursive: true });
const dataset = existsSync(resolve(datasetDirectory, 'events.jsonl'))
  ? readDataset(datasetDirectory)
  : generateDataset({ seed: 42 });

if (!existsSync(resolve(datasetDirectory, 'events.jsonl'))) {
  writeDataset(dataset, datasetDirectory);
}

const observations = buildWindowObservationsForTarget(dataset);
const configuration = tuneBaseline(dataset, observations);
const naiveConfiguration = tuneNaive(dataset, observations);
const testPeriod = periodFromDataset(dataset, 'test');
const test = evaluateBaseline(
  dataset,
  observations,
  configuration.selectedConfiguration,
  testPeriod,
);
const naiveTest = evaluateNaive(
  dataset,
  observations,
  naiveConfiguration.selectedConfiguration,
  testPeriod,
);
const { known, unseen } = evaluateKnownAndUnseen(
  dataset,
  observations,
  configuration.selectedConfiguration,
);
const verdict = verdictFor(test);
const result = {
  generatedData: {
    seed: dataset.metadata.seed,
    merchants: dataset.metadata.merchantIds.length,
    events: dataset.events.length,
    targetSegment: dataset.truth.targetSpec.targetSegment,
    observationWindowMinutes: dataset.truth.targetSpec.observationWindowMinutes,
    predictionHorizonMinutes: dataset.truth.targetSpec.predictionHorizonMinutes,
  },
  configuration,
  naiveConfiguration,
  test,
  naiveTest,
  known,
  unseen,
  verdict,
};

writeFileSync(
  resolve(resultDirectory, 'baseline.json'),
  `${JSON.stringify(result, null, 2)}\n`,
  'utf8',
);
writeFileSync(
  resolve(resultDirectory, 'baseline-report.md'),
  reportMarkdown({
    dataset: { ...buildSanityReport(dataset), seed: dataset.metadata.seed },
    configuration,
    naiveConfiguration,
    test,
    naiveTest,
    known,
    unseen,
    verdict,
  }),
  'utf8',
);

console.log(
  JSON.stringify(
    {
      verdict: verdict.verdict,
      test,
      naiveTest,
      known,
      unseen,
      resultDirectory,
    },
    null,
    2,
  ),
);
