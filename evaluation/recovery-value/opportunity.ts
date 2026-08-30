import {
  RecoveryService,
  type RecoveryCandidate,
  type RecoveryExecutor,
  type RecoveryAction,
  type ExecutorCreateResult,
  type ExecutorVerificationResult,
  type MerchantApproval,
  type RecoveryJourney,
} from '../../packages/recovery/src/index.js';

export type RecoveryOpportunityObservation = {
  caseId: string;
  paymentId: string;
  merchantId: string;
  sourceEventId: string;
  amountPaise: number;
  degradationSeverity: number;
  minutesSinceDetection: number;
  merchantHistoricalRecoveryRate: number;
  customerResponsivenessSignal: number;
  retryCount: number;
  latencyMs: number;
  interventionCostPaise: number;
  merchantApproval: MerchantApproval;
};

export type HiddenRecoveryOutcome = {
  latentSuccessProbability: number;
  wouldRecoverIfIntervened: boolean;
  recoveredAmountPaise: number;
};

export type RecoveryOpportunityCase = {
  observation: RecoveryOpportunityObservation;
  hiddenOutcome: HiddenRecoveryOutcome;
};

export const MODEL_FEATURE_FIELDS = [
  'amountPaise',
  'degradationSeverity',
  'minutesSinceDetection',
  'merchantHistoricalRecoveryRate',
  'customerResponsivenessSignal',
  'retryCount',
  'latencyMs',
  'interventionCostPaise',
] as const;

export type OpportunityScore = {
  observation: RecoveryOpportunityObservation;
  predictedSuccessProbability: number;
  expectedRecoveryValuePaise: number;
  rank: number;
};

export type OpportunityEnvironmentOptions = {
  observationNoise?: number;
  timingDecayMultiplier?: number;
  interventionCostPaise?: number;
};

type Random = () => number;

function randomSource(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function normal(random: Random): number {
  const first = Math.max(random(), Number.EPSILON);
  const second = Math.max(random(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function sigmoid(value: number): number {
  return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
}

function observedValue(value: number, noise: number, random: Random): number {
  return clamp(value + normal(random) * noise);
}

export function generateRecoveryOpportunityBatch(
  seed: number,
  caseCount = 200,
  options: OpportunityEnvironmentOptions = {},
): RecoveryOpportunityCase[] {
  if (!Number.isInteger(seed) || seed < 0) throw new Error('seed must be a non-negative integer');
  if (!Number.isInteger(caseCount) || caseCount < 100) {
    throw new Error('caseCount must be an integer of at least 100');
  }
  const random = randomSource(seed);
  const observationNoise = options.observationNoise ?? 0.1;
  const timingDecayMultiplier = options.timingDecayMultiplier ?? 1;
  const interventionCostPaise = options.interventionCostPaise ?? 30;
  const merchantRates = Array.from({ length: 20 }, () => 0.25 + random() * 0.6);
  const cases: RecoveryOpportunityCase[] = [];

  for (let index = 0; index < caseCount; index += 1) {
    const merchantIndex = index % merchantRates.length;
    const merchantId = `value_merchant_${String(merchantIndex + 1).padStart(3, '0')}`;
    const merchantHistoricalRate = merchantRates[merchantIndex]!;
    const customerResponsiveness = 0.15 + random() * 0.8;
    const amountPaise = 200 + Math.floor(random() * 7_800);
    const degradationSeverity = 0.25 + random() * 0.75;
    const minutesSinceDetection = Math.floor(random() * 41);
    const retryCount = Math.floor(random() * 4);
    const latencyMs = 500 + Math.floor(random() * 3_500);
    const latentLogit =
      -0.45 +
      1.15 * merchantHistoricalRate +
      0.85 * customerResponsiveness +
      0.8 * degradationSeverity -
      0.022 * timingDecayMultiplier * minutesSinceDetection -
      0.17 * retryCount -
      0.00012 * latencyMs -
      0.2 * Math.log1p(amountPaise / 1_000) +
      normal(random) * 0.28;
    const latentSuccessProbability = sigmoid(latentLogit);
    const wouldRecoverIfIntervened = random() < latentSuccessProbability;
    const merchantApproval: MerchantApproval =
      index % 29 === 0 ? 'unavailable' : index % 31 === 0 ? 'rejected' : 'approved';
    const observation: RecoveryOpportunityObservation = {
      caseId: `value_case_${String(index + 1).padStart(3, '0')}`,
      paymentId: `value_payment_${String(index + 1).padStart(3, '0')}`,
      merchantId,
      sourceEventId: `value_event_${String(index + 1).padStart(3, '0')}`,
      amountPaise,
      degradationSeverity: observedValue(degradationSeverity, observationNoise, random),
      minutesSinceDetection,
      merchantHistoricalRecoveryRate: observedValue(
        merchantHistoricalRate,
        observationNoise,
        random,
      ),
      customerResponsivenessSignal: observedValue(customerResponsiveness, observationNoise, random),
      retryCount,
      latencyMs,
      interventionCostPaise,
      merchantApproval,
    };
    cases.push({
      observation,
      hiddenOutcome: {
        latentSuccessProbability,
        wouldRecoverIfIntervened,
        recoveredAmountPaise: wouldRecoverIfIntervened ? amountPaise : 0,
      },
    });
  }
  return cases;
}

/**
 * This is intentionally a small, interpretable opportunity model. It receives
 * only fields available before intervention; hiddenOutcome is not a parameter.
 */
export function predictRecoveryProbability(observation: RecoveryOpportunityObservation): number {
  return sigmoid(
    -0.45 +
      1.15 * observation.merchantHistoricalRecoveryRate +
      0.85 * observation.customerResponsivenessSignal +
      0.8 * observation.degradationSeverity -
      0.022 * observation.minutesSinceDetection -
      0.17 * observation.retryCount -
      0.00012 * observation.latencyMs -
      0.2 * Math.log1p(observation.amountPaise / 1_000),
  );
}

export function scoreRecoveryOpportunity(
  observation: RecoveryOpportunityObservation,
): OpportunityScore {
  const predictedSuccessProbability = predictRecoveryProbability(observation);
  return {
    observation,
    predictedSuccessProbability,
    expectedRecoveryValuePaise:
      predictedSuccessProbability * observation.amountPaise - observation.interventionCostPaise,
    rank: 0,
  };
}

export function rankRecoveryOpportunities(
  observations: RecoveryOpportunityObservation[],
): OpportunityScore[] {
  return observations
    .map(scoreRecoveryOpportunity)
    .sort(
      (first, second) =>
        second.expectedRecoveryValuePaise - first.expectedRecoveryValuePaise ||
        first.observation.caseId.localeCompare(second.observation.caseId),
    )
    .map((score, index) => ({ ...score, rank: index + 1 }));
}

export class CounterfactualRecoveryExecutor implements RecoveryExecutor {
  private readonly outcomes: Map<string, HiddenRecoveryOutcome>;
  private readonly recoveredPayments = new Set<string>();
  public createCalls = 0;
  public verificationCalls = 0;

  constructor(cases: RecoveryOpportunityCase[]) {
    this.outcomes = new Map(cases.map((item) => [item.observation.paymentId, item.hiddenOutcome]));
  }

  async createPaymentLink(
    _action: RecoveryAction,
    candidate: RecoveryCandidate,
  ): Promise<ExecutorCreateResult> {
    this.createCalls += 1;
    if (this.recoveredPayments.has(candidate.paymentId)) {
      return { status: 'already_recovered', providerReference: `value_${candidate.paymentId}` };
    }
    return {
      status: 'created',
      providerReference: `value_${candidate.paymentId}`,
      actionUrl: `https://simulation.invalid/value/${candidate.paymentId}`,
    };
  }

  async verifyRecovery(
    action: RecoveryAction,
    candidate: RecoveryCandidate,
    creation: ExecutorCreateResult,
  ): Promise<ExecutorVerificationResult> {
    this.verificationCalls += 1;
    if (creation.providerReference === undefined) {
      return {
        status: 'pending',
        recoveredAmountPaise: 0,
        reason: `counterfactual provider reference unavailable for ${action.actionId}`,
        verificationMethod: 'simulation',
      };
    }
    const outcome = this.outcomes.get(candidate.paymentId);
    if (outcome?.wouldRecoverIfIntervened) {
      this.recoveredPayments.add(candidate.paymentId);
      return {
        status: 'recovered',
        recoveredAmountPaise: outcome.recoveredAmountPaise,
        reason: 'counterfactual synthetic payment outcome was verified',
        verificationMethod: 'simulation',
      };
    }
    return {
      status: 'failed',
      recoveredAmountPaise: 0,
      reason: 'counterfactual synthetic payment outcome did not recover',
      verificationMethod: 'simulation',
    };
  }
}

export function recoveryCandidateFor(
  observation: RecoveryOpportunityObservation,
  predictedSuccessProbability: number,
  modelVersion: string,
): RecoveryCandidate {
  return {
    candidateId: observation.caseId,
    sourceEventId: observation.sourceEventId,
    paymentId: observation.paymentId,
    merchantId: observation.merchantId,
    modelVersion,
    segment: 'UPI_INTENT',
    riskScore: 0.9,
    estimatedSuccessProbability: predictedSuccessProbability,
    recoverableAmountPaise: observation.amountPaise,
    interventionCostPaise: observation.interventionCostPaise,
    detectedAt: '2026-08-30T12:00:00.000Z',
    reason: ['recovery opportunity scored from decision-time observable context'],
  };
}

export type OpportunityRun = {
  budget: number;
  strategy: 'baseline' | 'flowguard';
  selectedCandidates: number;
  interventionsAttempted: number;
  successfulRecoveries: number;
  recoveredSimulatedValuePaise: number;
  recoverySuccessRate: number;
  recoveredValuePerInterventionPaise: number;
  abstentions: number;
  policyRejections: number;
  falseInterventions: number;
};

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export async function runOpportunityStrategy(
  cases: RecoveryOpportunityCase[],
  budget: number,
  strategy: 'baseline' | 'flowguard',
): Promise<OpportunityRun> {
  const scored = rankRecoveryOpportunities(cases.map((item) => item.observation));
  const selected =
    strategy === 'flowguard'
      ? scored.slice(0, budget)
      : cases.slice(0, budget).map((item) => scoreRecoveryOpportunity(item.observation));
  const selectedById = new Map(selected.map((item) => [item.observation.caseId, item]));
  const executor = new CounterfactualRecoveryExecutor(cases);
  const service = new RecoveryService({ executor, clock: () => '2026-08-30T12:00:00.000Z' });
  const journeys: RecoveryJourney[] = [];
  for (const score of selected) {
    const candidate = recoveryCandidateFor(
      score.observation,
      strategy === 'flowguard' ? score.predictedSuccessProbability : 0.6,
      strategy === 'flowguard' ? 'm6-opportunity-v1' : 'fixed-baseline-v1',
    );
    journeys.push(
      await service.submit(candidate, {
        merchantApproval: score.observation.merchantApproval,
      }),
    );
  }
  const successfulRecoveries = journeys.filter(
    (journey) => journey.outcome.status === 'RECOVERED',
  ).length;
  const recoveredSimulatedValuePaise = journeys.reduce(
    (sum, journey) => sum + journey.outcome.recoveredAmountPaise,
    0,
  );
  const selectedCases = cases.filter((item) => selectedById.has(item.observation.caseId));
  return {
    budget,
    strategy,
    selectedCandidates: selected.length,
    interventionsAttempted: executor.createCalls,
    successfulRecoveries,
    recoveredSimulatedValuePaise,
    recoverySuccessRate: ratio(successfulRecoveries, executor.createCalls),
    recoveredValuePerInterventionPaise: ratio(recoveredSimulatedValuePaise, executor.createCalls),
    abstentions: journeys.filter((journey) => journey.outcome.status === 'ABSTAINED').length,
    policyRejections: journeys.filter((journey) => journey.outcome.status === 'REJECTED').length,
    falseInterventions: selectedCases.filter((item) => {
      const journey = journeys.find(
        (candidate) => candidate.candidate.candidateId === item.observation.caseId,
      );
      return (
        journey !== undefined &&
        journey.action.attempts > 0 &&
        !item.hiddenOutcome.wouldRecoverIfIntervened
      );
    }).length,
  };
}

export function topKMetrics(
  cases: RecoveryOpportunityCase[],
  k: number,
  strategy: 'baseline' | 'flowguard',
) {
  const ranked =
    strategy === 'flowguard'
      ? rankRecoveryOpportunities(cases.map((item) => item.observation)).slice(0, k)
      : cases.slice(0, k).map((item) => scoreRecoveryOpportunity(item.observation));
  const byCaseId = new Map(cases.map((item) => [item.observation.caseId, item]));
  const recoverable = cases.filter((item) => item.hiddenOutcome.wouldRecoverIfIntervened).length;
  const recovered = ranked.filter(
    (item) => byCaseId.get(item.observation.caseId)!.hiddenOutcome.wouldRecoverIfIntervened,
  );
  const value = recovered.reduce(
    (sum, item) => sum + byCaseId.get(item.observation.caseId)!.hiddenOutcome.recoveredAmountPaise,
    0,
  );
  return {
    k,
    strategy,
    precisionAtK: ratio(recovered.length, ranked.length),
    recallAtK: ratio(recovered.length, recoverable),
    recoveryValueAtKPaise: value,
    averageValuePerRankedInterventionPaise: ratio(value, ranked.length),
  };
}

export const CURRENT_M5_SIMULATOR_AUDIT = {
  version: 'm5-recovery-v1',
  recoveryProbabilityVariesWithModelScenario: false,
  recoveryProbabilityVariesWithAmount: false,
  recoveryProbabilityVariesWithTiming: false,
  recoveryProbabilityVariesWithSeverity: false,
  finding:
    'M5 outcomes are explicit scenario labels or a seed hash; they are not a calibrated opportunity-response model and cannot test opportunity ranking.',
  architecturalChange:
    'M6 keeps M5 immutable and uses hidden counterfactual propensity generated from latent factors with noisy observable proxies.',
};
