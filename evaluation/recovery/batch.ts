import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DEFAULT_POLICY_CONFIG,
  RecoveryService,
  SimulationRecoveryExecutor,
  type MerchantApproval,
  type RecoveryCandidate,
  type RecoveryJourney,
  type SimulationScenario,
} from '../../packages/recovery/src/index.js';

export type RecoveryBatchCase = {
  caseId: string;
  candidate: RecoveryCandidate;
  merchantApproval: MerchantApproval;
  simulationScenario: SimulationScenario;
  recoveryOpportunity: boolean;
};

export type BatchMetrics = {
  label: 'SIMULATED';
  totalCandidates: number;
  interventionsAttempted: number;
  successfulRecoveries: number;
  failedRecoveries: number;
  pendingVerifications: number;
  recoveredSimulatedValuePaise: number;
  interventionRate: number;
  recoverySuccessRate: number;
  falseInterventions: number;
  policyRejections: number;
  humanApprovals: number;
  abstentions: number;
  expiredActions: number;
  duplicateActionsPrevented: number;
  alreadyRecovered: number;
};

export type RecoveryBatchResult = {
  batchVersion: 'm5-recovery-batch-v1';
  cases: number;
  scenarios: Record<SimulationScenario, number>;
  baseline: BatchMetrics;
  flowguard: BatchMetrics;
  incrementalRecoveredSimulatedValuePaise: number;
  auditEvents: number;
  flowguardAuditEventTypes: Record<string, number>;
};

const fixedNow = '2026-08-30T12:00:00.000Z';

function candidateFor(
  index: number,
  overrides: Partial<RecoveryCandidate> = {},
): RecoveryCandidate {
  return {
    candidateId: `batch_candidate_${String(index).padStart(3, '0')}`,
    sourceEventId: `batch_event_${String(index).padStart(3, '0')}`,
    paymentId: `batch_payment_${String(index).padStart(3, '0')}`,
    merchantId: `batch_merchant_${String((index % 30) + 1).padStart(3, '0')}`,
    modelVersion: 'logistic_v2',
    segment: 'UPI_INTENT',
    riskScore: 0.9,
    estimatedSuccessProbability: 0.8,
    recoverableAmountPaise: 1_000 + (index % 5) * 100,
    interventionCostPaise: 20,
    detectedAt: fixedNow,
    reason: ['sustained UPI Intent degradation exceeded the merchant baseline'],
    ...overrides,
  };
}

export function buildRecoveryBatchCases(): RecoveryBatchCase[] {
  const cases: RecoveryBatchCase[] = [];
  let index = 1;
  const add = (
    count: number,
    simulationScenario: SimulationScenario,
    overrides: Partial<RecoveryCandidate>,
    merchantApproval: MerchantApproval = 'approved',
    recoveryOpportunity = true,
  ) => {
    for (let offset = 0; offset < count; offset += 1) {
      cases.push({
        caseId: `batch_case_${String(index).padStart(3, '0')}`,
        candidate: candidateFor(index, overrides),
        merchantApproval,
        simulationScenario,
        recoveryOpportunity,
      });
      index += 1;
    }
  };

  add(30, 'success', {});
  add(20, 'failed', {});
  add(10, 'expired', {});
  add(10, 'already_recovered', {});
  add(10, 'verification_timeout', {});
  add(10, 'failed', { riskScore: 0.25 }, 'approved', false);
  add(5, 'failed', { recoverableAmountPaise: 50, interventionCostPaise: 100 }, 'approved', false);
  add(5, 'success', {}, 'rejected', false);
  add(5, 'success', {}, 'unavailable', false);
  for (let duplicate = 1; duplicate <= 15; duplicate += 1) {
    cases.push({
      caseId: `batch_duplicate_${String(duplicate).padStart(3, '0')}`,
      candidate: candidateFor(duplicate, {
        candidateId: `batch_duplicate_candidate_${String(duplicate).padStart(3, '0')}`,
        paymentId: `batch_payment_${String(duplicate).padStart(3, '0')}`,
      }),
      merchantApproval: 'approved',
      simulationScenario: 'success',
      recoveryOpportunity: true,
    });
  }
  return cases;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function metricsFor(
  cases: RecoveryBatchCase[],
  journeys: RecoveryJourney[],
  attempted: number,
  duplicateActionsPrevented: number,
  deduplicateActions: boolean,
): BatchMetrics {
  const measuredJourneys = deduplicateActions
    ? [...new Map(journeys.map((journey) => [journey.action.actionId, journey])).values()]
    : journeys;
  const successfulRecoveries = measuredJourneys.filter(
    (journey) => journey.outcome.status === 'RECOVERED',
  ).length;
  const failedRecoveries = measuredJourneys.filter(
    (journey) => journey.outcome.status === 'FAILED',
  ).length;
  const pendingVerifications = measuredJourneys.filter(
    (journey) => journey.outcome.status === 'PENDING',
  ).length;
  const recoveredSimulatedValuePaise = measuredJourneys.reduce(
    (sum, journey) => sum + journey.outcome.recoveredAmountPaise,
    0,
  );
  const falseInterventions = measuredJourneys.filter((journey) => {
    const matchingCase = cases.find(
      (item) => item.candidate.candidateId === journey.candidate.candidateId,
    );
    return (
      matchingCase !== undefined &&
      !matchingCase.recoveryOpportunity &&
      journey.action.attempts > 0 &&
      [
        'APPROVED',
        'EXECUTING',
        'VERIFICATION_PENDING',
        'RECOVERED',
        'FAILED',
        'EXPIRED',
        'ALREADY_RECOVERED',
      ].includes(journey.action.status)
    );
  }).length;
  return {
    label: 'SIMULATED',
    totalCandidates: cases.length,
    interventionsAttempted: attempted,
    successfulRecoveries,
    failedRecoveries,
    pendingVerifications,
    recoveredSimulatedValuePaise,
    interventionRate: ratio(attempted, cases.length),
    recoverySuccessRate: ratio(successfulRecoveries, attempted),
    falseInterventions,
    policyRejections: measuredJourneys.filter((journey) => journey.outcome.status === 'REJECTED')
      .length,
    humanApprovals: journeys.filter((journey) =>
      journey.auditEvents.some(
        (event) =>
          event.eventType === 'approval_recorded' && event.data.merchantApproval === 'approved',
      ),
    ).length,
    abstentions: measuredJourneys.filter((journey) => journey.outcome.status === 'ABSTAINED')
      .length,
    expiredActions: measuredJourneys.filter((journey) => journey.outcome.status === 'EXPIRED')
      .length,
    duplicateActionsPrevented,
    alreadyRecovered: measuredJourneys.filter(
      (journey) => journey.outcome.status === 'ALREADY_RECOVERED',
    ).length,
  };
}

function auditTypeCounts(journeys: RecoveryJourney[]): Record<string, number> {
  const counts: Record<string, number> = {};
  const events = [
    ...new Map(
      journeys.flatMap((journey) => journey.auditEvents).map((event) => [event.sequence, event]),
    ).values(),
  ];
  events.forEach((event) => {
    counts[event.eventType] = (counts[event.eventType] ?? 0) + 1;
  });
  return counts;
}

async function runStrategy(
  cases: RecoveryBatchCase[],
  flowguard: boolean,
): Promise<{ metrics: BatchMetrics; journeys: RecoveryJourney[] }> {
  const outcomes = Object.fromEntries(
    cases.map((item) => [item.candidate.paymentId, item.simulationScenario]),
  ) as Record<string, SimulationScenario>;
  const executor = new SimulationRecoveryExecutor({ seed: 55, outcomes });
  const policy = flowguard
    ? DEFAULT_POLICY_CONFIG
    : {
        ...DEFAULT_POLICY_CONFIG,
        minimumRiskScore: 0,
        minimumExpectedRecoveryValuePaise: -Number.MAX_SAFE_INTEGER,
        maximumRecoverableAmountPaise: Number.MAX_SAFE_INTEGER,
      };
  const journeys: RecoveryJourney[] = [];
  if (flowguard) {
    const service = new RecoveryService({ executor, policy, clock: () => fixedNow });
    for (const item of cases) {
      journeys.push(
        await service.submit(item.candidate, {
          merchantApproval: item.merchantApproval,
          now: fixedNow,
        }),
      );
    }
  } else {
    for (const item of cases) {
      const service = new RecoveryService({ executor, policy, clock: () => fixedNow });
      journeys.push(
        await service.submit(item.candidate, {
          merchantApproval: item.merchantApproval,
          now: fixedNow,
        }),
      );
    }
  }
  return {
    metrics: metricsFor(
      cases,
      journeys,
      executor.createCalls,
      journeys.filter((journey) => journey.duplicatePrevented).length,
      flowguard,
    ),
    journeys,
  };
}

export async function evaluateRecoveryBatch(
  cases = buildRecoveryBatchCases(),
): Promise<RecoveryBatchResult> {
  const flowguardResult = await runStrategy(cases, true);
  const baselineResult = await runStrategy(cases, false);
  const scenarios = Object.fromEntries(
    [...new Set(cases.map((item) => item.simulationScenario))].map((scenario) => [
      scenario,
      cases.filter((item) => item.simulationScenario === scenario).length,
    ]),
  ) as Record<SimulationScenario, number>;
  return {
    batchVersion: 'm5-recovery-batch-v1',
    cases: cases.length,
    scenarios,
    baseline: baselineResult.metrics,
    flowguard: flowguardResult.metrics,
    incrementalRecoveredSimulatedValuePaise:
      flowguardResult.metrics.recoveredSimulatedValuePaise -
      baselineResult.metrics.recoveredSimulatedValuePaise,
    auditEvents: new Set(
      flowguardResult.journeys.flatMap((journey) =>
        journey.auditEvents.map((event) => event.sequence),
      ),
    ).size,
    flowguardAuditEventTypes: auditTypeCounts(flowguardResult.journeys),
  };
}

export async function writeRecoveryBatchReport(
  result: RecoveryBatchResult,
  outputDirectory = resolve(process.cwd(), 'evaluation/results'),
): Promise<void> {
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    resolve(outputDirectory, 'recovery-batch.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    resolve(outputDirectory, 'recovery-batch-report.md'),
    `# M5 Recovery Batch Report

## Scope

This is a deterministic **SIMULATED** recovery evaluation. Amounts are simulated paise-like units and are not Razorpay revenue. It runs 120 cases through the same bounded payment-link semantics. The baseline is a fixed payment-link policy that does not apply FlowGuard's risk/value abstention or cross-request idempotency ledger.

## Results

| Strategy | Interventions | Successful | Failed | Pending | Simulated recovered value | Success rate | False interventions | Rejections | Abstentions | Expired | Duplicate actions prevented |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline | ${result.baseline.interventionsAttempted} | ${result.baseline.successfulRecoveries} | ${result.baseline.failedRecoveries} | ${result.baseline.pendingVerifications} | ${result.baseline.recoveredSimulatedValuePaise} | ${(result.baseline.recoverySuccessRate * 100).toFixed(1)}% | ${result.baseline.falseInterventions} | ${result.baseline.policyRejections} | ${result.baseline.abstentions} | ${result.baseline.expiredActions} | ${result.baseline.duplicateActionsPrevented} |
| FlowGuard | ${result.flowguard.interventionsAttempted} | ${result.flowguard.successfulRecoveries} | ${result.flowguard.failedRecoveries} | ${result.flowguard.pendingVerifications} | ${result.flowguard.recoveredSimulatedValuePaise} | ${(result.flowguard.recoverySuccessRate * 100).toFixed(1)}% | ${result.flowguard.falseInterventions} | ${result.flowguard.policyRejections} | ${result.flowguard.abstentions} | ${result.flowguard.expiredActions} | ${result.flowguard.duplicateActionsPrevented} |

Incremental simulated recovered value versus baseline: **${result.incrementalRecoveredSimulatedValuePaise}**.

## Coverage

- Total candidates: ${result.cases}
- Scenarios: ${Object.entries(result.scenarios)
      .map(([scenario, count]) => `${scenario}=${count}`)
      .join(', ')}
- FlowGuard already-recovered outcomes: ${result.flowguard.alreadyRecovered}
- FlowGuard human approvals recorded: ${result.flowguard.humanApprovals}
- FlowGuard audit events: ${result.auditEvents}
- Audit event types: ${Object.entries(result.flowguardAuditEventTypes)
      .map(([type, count]) => `${type}=${count}`)
      .join(', ')}

The batch intentionally includes successful, failed, expired, already-recovered, verification-timeout, low-confidence, low-value, rejected-approval, unavailable-approval and duplicate cases. A payment-link creation is counted as an intervention, never as recovered value; only verified simulated recovery contributes to recovered value.

## Safety conclusion

The recovery action is a single merchant-approved payment-link attempt with a 30-minute expiry, one-attempt limit, deterministic idempotency key, explicit abstention, verification and append-only application audit events. Razorpay TEST MODE is implemented as an isolated adapter but was not called in this batch. The default demo path remains SIMULATED.
`,
    'utf8',
  );
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('batch.ts')) {
  void evaluateRecoveryBatch()
    .then(async (result) => {
      await writeRecoveryBatchReport(result);
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
