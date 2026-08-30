import {
  RecoveryOrchestrator,
  RecoveryService,
  SimulationRecoveryExecutor,
  type RecoveryJourney,
  type RecoveryOrchestrationInput,
  type RecoveryOrchestrationResult,
  type SimulationScenario,
} from '@flowguard/recovery';
import { z } from 'zod';

export const demoScenarioSchema = z.enum([
  'successful_recovery',
  'policy_rejection',
  'duplicate_prevention',
  'abstention',
  'expired_action',
  'verification_failure',
]);
export type DemoScenario = z.infer<typeof demoScenarioSchema>;

const fixedNow = '2026-08-30T20:41:02.000+05:30';
const scenarioLabels: Record<DemoScenario, string> = {
  successful_recovery: 'Successful Recovery',
  policy_rejection: 'Policy Rejection',
  duplicate_prevention: 'Duplicate Prevention',
  abstention: 'Abstention',
  expired_action: 'Expired Action',
  verification_failure: 'Verification Failure',
};

type DemoRuntime = {
  scenario: DemoScenario;
  executor: SimulationRecoveryExecutor;
  service: RecoveryService;
  orchestrator: RecoveryOrchestrator;
  result: RecoveryOrchestrationResult;
  duplicateJourney: RecoveryJourney | null;
};

const m6BudgetCurve = [
  { budget: 10, flowGuardPaise: 42_047.35, baselinePaise: 15_776.85 },
  { budget: 25, flowGuardPaise: 87_176.15, baselinePaise: 43_997.6 },
  { budget: 50, flowGuardPaise: 150_936.9, baselinePaise: 85_373.5 },
  { budget: 75, flowGuardPaise: 213_813.05, baselinePaise: 130_404.9 },
  { budget: 100, flowGuardPaise: 260_208.75, baselinePaise: 171_138.75 },
];

function scenarioInput(scenario: DemoScenario): RecoveryOrchestrationInput {
  const base = {
    correlationId: `demo_${scenario}`,
    detection: {
      candidateId: `demo_candidate_${scenario}`,
      sourceEventId: `demo_event_${scenario}`,
      paymentId: `demo_payment_${scenario}`,
      merchantId: 'demo_merchant_acme',
      modelVersion: 'logistic_v2',
      riskScore: 0.9,
      recoverableAmountPaise: 18_500,
      interventionCostPaise: 250,
      detectedAt: fixedNow,
      reason: ['sustained UPI Intent failure rate above baseline'],
    },
    opportunity: {
      estimatedSuccessProbability: 0.8,
      expectedRecoveryValuePaise: 14_550,
      signals: ['failure_rate_above_baseline', 'latency_above_baseline'],
    },
    now: fixedNow,
  } satisfies RecoveryOrchestrationInput;

  switch (scenario) {
    case 'policy_rejection':
      return {
        ...base,
        detection: { ...base.detection, recoverableAmountPaise: 600_000 },
      };
    case 'abstention':
      return {
        ...base,
        detection: { ...base.detection, riskScore: 0.2 },
      };
    default:
      return base;
  }
}

function executorScenario(scenario: DemoScenario): SimulationScenario {
  switch (scenario) {
    case 'expired_action':
      return 'expired';
    case 'verification_failure':
      return 'failed';
    default:
      return 'success';
  }
}

function pipelineFor(state: RecoveryOrchestrationResult['state']) {
  const stages = [
    ['DETECTED', 'Detected'],
    ['SCORED', 'Scored'],
    ['POLICY_APPROVED', 'Policy'],
    ['AWAITING_MERCHANT_APPROVAL', 'Approval'],
    ['APPROVED', 'Approved'],
    ['EXECUTING', 'Action'],
    ['PENDING_VERIFICATION', 'Verification'],
    ['RECOVERED', 'Recovered'],
  ] as const;
  const currentIndex = stages.findIndex(([key]) => key === state);
  const terminalIndex =
    currentIndex >= 0
      ? currentIndex
      : state === 'REJECTED' || state === 'ABSTAINED' || state === 'ALREADY_RECOVERED'
        ? 2
        : state === 'FAILED' || state === 'EXPIRED'
          ? 6
          : 0;
  return stages.map(([key, label], index) => ({
    key,
    label,
    status:
      state === key
        ? 'active'
        : index < terminalIndex
          ? 'complete'
          : index === terminalIndex
            ? 'blocked'
            : 'pending',
  }));
}

function auditFor(runtime: DemoRuntime) {
  const orchestrationEvents = runtime.result.events.map((event) => ({
    sequence: event.sequence,
    timestamp: event.timestamp,
    eventType: event.eventType,
    state: event.state,
    actionId: event.actionId,
    data: event.data,
  }));
  const recoveryEvents = runtime.service.listAuditEvents().map((event) => ({
    sequence: event.sequence + 1_000,
    timestamp: event.occurredAt,
    eventType:
      event.eventType === 'duplicate_prevented'
        ? 'IDEMPOTENCY_REPLAY'
        : event.eventType.toUpperCase(),
    state: typeof event.data.status === 'string' ? event.data.status : 'RECOVERY',
    actionId: event.actionId,
    data: event.data,
  }));
  return [...orchestrationEvents, ...recoveryEvents];
}

function buildRuntimeBatch(runtime: DemoRuntime) {
  const { action, outcome } = runtime.result;
  const interventions = action?.attempts ?? 0;
  const recoveries = outcome?.status === 'RECOVERED' ? 1 : 0;
  return {
    candidates: 1,
    interventions,
    recoveries,
    abstentions: outcome?.status === 'ABSTAINED' ? 1 : 0,
    policyRejections: outcome?.status === 'REJECTED' ? 1 : 0,
    recoveredValuePaise: outcome?.recoveredAmountPaise ?? 0,
    duplicateActionsPrevented: runtime.duplicateJourney?.duplicatePrevented ? 1 : 0,
    interventionRate: interventions,
    recoverySuccessRate: interventions === 0 ? 0 : recoveries / interventions,
    falseInterventionsAvoided: interventions === 0 ? 1 : 0,
  };
}

export class DemoController {
  private runtime!: DemoRuntime;
  private readyPromise: Promise<void>;

  constructor() {
    this.readyPromise = this.resetInternal('successful_recovery');
  }

  private async resetInternal(scenario: DemoScenario): Promise<void> {
    const executor = new SimulationRecoveryExecutor({
      outcomes: {
        [`demo_payment_${scenario}`]: executorScenario(scenario),
      },
    });
    const service = new RecoveryService({ executor, clock: () => fixedNow });
    const orchestrator = new RecoveryOrchestrator({
      recoveryService: service,
      clock: () => fixedNow,
    });
    const result = await orchestrator.begin(scenarioInput(scenario));
    this.runtime = {
      scenario,
      executor,
      service,
      orchestrator,
      result,
      duplicateJourney: null,
    };
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  async reset(scenario: DemoScenario): Promise<void> {
    await this.ready();
    this.readyPromise = this.resetInternal(scenario);
    await this.ready();
  }

  async approve(correlationId: string, approved: boolean): Promise<void> {
    await this.ready();
    if (this.runtime.result.correlationId !== correlationId) {
      throw new Error('recovery correlation does not match the active demo');
    }
    this.runtime.result = await this.runtime.orchestrator.approve(
      correlationId,
      approved ? 'approved' : 'rejected',
    );
    if (
      this.runtime.scenario === 'duplicate_prevention' &&
      this.runtime.result.outcome?.status === 'RECOVERED'
    ) {
      this.runtime.duplicateJourney = await this.runtime.service.submit(
        this.runtime.result.candidate,
        { merchantApproval: 'approved', now: fixedNow },
      );
    }
  }

  state() {
    const result = this.runtime.result;
    return {
      mode: 'SIMULATION',
      scenario: this.runtime.scenario,
      scenarioLabel: scenarioLabels[this.runtime.scenario],
      correlationId: result.correlationId,
      systemStatus: {
        detector: 'ONLINE',
        policy: 'ENFORCED',
        executor: 'SIMULATION',
        verification: 'READY',
        llm: 'FALLBACK · NO PROVIDER',
      },
      current: {
        merchantReference: result.candidate.merchantId,
        paymentReference: result.candidate.paymentId,
        segment: result.candidate.segment,
        severity: result.candidate.riskScore >= 0.8 ? 'HIGH' : 'MODERATE',
        riskScore: result.candidate.riskScore,
        expectedRecoveryValuePaise: result.recommendation.expectedRecoveryValuePaise,
        amountPaise: result.candidate.recoverableAmountPaise,
        action: 'Payment Link attempt',
        state: result.state,
        reasonCodes: this.runtime.result.approvalPayload?.reasonCodes ?? [],
        reason: result.recommendation.rationale,
        modelSignal: {
          modelType: 'Interpretable logistic opportunity scorer',
          estimatedProbability: result.candidate.estimatedSuccessProbability,
          importantSignals: scenarioInput(this.runtime.scenario).opportunity.signals,
          modelVersion: 'm6-opportunity-v1',
          provenance: 'DEMO / SIMULATION · seeded model output',
          calibrationNote:
            'The seeded demo probability is illustrative; calibration evidence is reported in the synthetic M6 evaluation.',
        },
      },
      pipeline: pipelineFor(result.state),
      approvalPayload: result.approvalPayload,
      explanation: result.explanation,
      outcome: result.outcome
        ? {
            status: result.outcome.status,
            recoveredAmountPaise: result.outcome.recoveredAmountPaise,
            verification: result.outcome.verificationMethod ?? 'policy',
            reason: result.outcome.reason,
          }
        : null,
      batch: {
        label: 'DEMO / SIMULATION',
        runtime: buildRuntimeBatch(this.runtime),
        syntheticEvaluation: {
          label: 'SYNTHETIC EVALUATION · M6',
          budgetCurve: m6BudgetCurve,
          note: '20 independent seeds; simulated values, not production Razorpay revenue.',
        },
      },
      audit: auditFor(this.runtime),
      technical: {
        detector: 'Temporal degradation detector + logistic scoring',
        opportunityScorer: 'Expected recovery value ranking',
        policyVersion: 'm7-policy-v1',
        executor: 'SimulationRecoveryExecutor',
        verification: 'Simulation payment capture verification',
        idempotency: 'Deterministic SHA-256 recovery key',
        audit: 'Structured orchestration events',
      },
    };
  }
}
