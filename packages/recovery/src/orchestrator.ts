import {
  buildRecoveryRecommendation,
  evaluateRecoveryPolicy,
  RecoveryService,
  type MerchantApproval,
  type PolicyConfig,
  type RecoveryAction,
  type RecoveryCandidate,
  type RecoveryJourney,
  type RecoveryOutcome,
} from './recovery.js';
import {
  EXPLANATION_SYSTEM_PROMPT_V1,
  explainRecovery,
  explanationInputForOutcome,
  type ExplanationProvider,
  type ExplanationResult,
  type LlmExplanationInput,
} from './explanation.js';
import { z } from 'zod';

const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/, 'must be a safe identifier');
const timestampSchema = z.string().datetime({ offset: true });
const probabilitySchema = z.number().finite().min(0).max(1);

export const recoveryOrchestrationInputSchema = z
  .object({
    correlationId: identifierSchema,
    detection: z
      .object({
        candidateId: identifierSchema,
        sourceEventId: identifierSchema,
        paymentId: identifierSchema,
        merchantId: identifierSchema,
        modelVersion: identifierSchema,
        riskScore: probabilitySchema,
        recoverableAmountPaise: z.number().int().nonnegative(),
        interventionCostPaise: z.number().int().nonnegative(),
        detectedAt: timestampSchema,
        reason: z.array(z.string().min(1)).min(1).max(10),
        customer: z
          .object({
            email: z.string().email().optional(),
            contact: z.string().min(7).max(20).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    opportunity: z
      .object({
        estimatedSuccessProbability: probabilitySchema,
        expectedRecoveryValuePaise: z.number().finite(),
        signals: z.array(z.string().max(200)).max(20),
      })
      .strict(),
    merchantApproval: z.enum(['approved', 'rejected', 'unavailable']).optional(),
    alreadyRecovered: z.boolean().optional(),
    now: timestampSchema.optional(),
  })
  .strict();

export type RecoveryState =
  | 'DETECTED'
  | 'SCORED'
  | 'POLICY_APPROVED'
  | 'AWAITING_MERCHANT_APPROVAL'
  | 'APPROVED'
  | 'EXECUTING'
  | 'PENDING_VERIFICATION'
  | 'RECOVERED'
  | 'REJECTED'
  | 'ABSTAINED'
  | 'FAILED'
  | 'EXPIRED'
  | 'ALREADY_RECOVERED';

const transitions: Record<RecoveryState, readonly RecoveryState[]> = {
  DETECTED: ['SCORED'],
  SCORED: ['POLICY_APPROVED', 'REJECTED', 'ABSTAINED'],
  POLICY_APPROVED: ['AWAITING_MERCHANT_APPROVAL', 'APPROVED'],
  AWAITING_MERCHANT_APPROVAL: ['APPROVED', 'REJECTED', 'ABSTAINED', 'EXPIRED'],
  APPROVED: ['EXECUTING'],
  EXECUTING: ['PENDING_VERIFICATION', 'RECOVERED', 'FAILED', 'EXPIRED', 'ALREADY_RECOVERED'],
  PENDING_VERIFICATION: ['RECOVERED', 'FAILED', 'EXPIRED', 'ALREADY_RECOVERED'],
  RECOVERED: [],
  REJECTED: [],
  ABSTAINED: [],
  FAILED: [],
  EXPIRED: [],
  ALREADY_RECOVERED: [],
};

export function canTransition(from: RecoveryState, to: RecoveryState): boolean {
  return transitions[from].includes(to);
}

export function assertValidTransition(from: RecoveryState, to: RecoveryState): void {
  if (!canTransition(from, to)) {
    throw new Error(`invalid recovery transition: ${from} -> ${to}`);
  }
}

export type RecoveryDetection = {
  candidateId: string;
  sourceEventId: string;
  paymentId: string;
  merchantId: string;
  modelVersion: string;
  riskScore: number;
  recoverableAmountPaise: number;
  interventionCostPaise: number;
  detectedAt: string;
  reason: string[];
  customer?: RecoveryCandidate['customer'];
};

export type RecoveryOpportunityScore = {
  estimatedSuccessProbability: number;
  expectedRecoveryValuePaise: number;
  signals: string[];
};

export type RecoveryOrchestrationInput = {
  correlationId: string;
  detection: RecoveryDetection;
  opportunity: RecoveryOpportunityScore;
  merchantApproval?: MerchantApproval;
  alreadyRecovered?: boolean;
  now?: string;
};

export const recoveryApprovalPayloadSchema = z
  .object({
    merchantReference: identifierSchema,
    paymentReference: identifierSchema,
    candidateId: identifierSchema,
    reasonCodes: z.array(z.string().min(1)).max(10),
    riskScore: probabilitySchema,
    expectedRecoveryValuePaise: z.number().finite(),
    amountPaise: z.number().int().nonnegative(),
    actionType: z.literal('PAYMENT_LINK'),
    expiresAt: timestampSchema,
    policyChecks: z
      .array(
        z
          .object({
            check: z.string().min(1),
            passed: z.boolean(),
          })
          .strict(),
      )
      .min(1),
    explanation: z
      .object({
        summary: z.string().min(1).max(500),
        reasonCodes: z.array(z.string().regex(/^[a-z0-9_]+$/)).max(20),
        merchantExplanation: z.string().min(1).max(2_000),
        customerMessageDraft: z.string().max(1_000).optional(),
      })
      .strict(),
  })
  .strict();
export type RecoveryApprovalPayload = z.infer<typeof recoveryApprovalPayloadSchema>;

export type OrchestrationEvent = {
  sequence: number;
  eventType:
    | 'DETECTION_CREATED'
    | 'OPPORTUNITY_SCORED'
    | 'POLICY_EVALUATED'
    | 'APPROVAL_REQUESTED'
    | 'APPROVAL_GRANTED'
    | 'ACTION_EXECUTED'
    | 'VERIFICATION_STARTED'
    | 'RECOVERY_VERIFIED'
    | 'RECOVERY_FAILED'
    | 'ACTION_EXPIRED'
    | 'ACTION_REJECTED'
    | 'ACTION_ABSTAINED'
    | 'ALREADY_RECOVERED'
    | 'IDEMPOTENCY_REPLAY';
  correlationId: string;
  merchantReference: string;
  paymentReference: string;
  timestamp: string;
  state: RecoveryState;
  modelVersion: string;
  policyVersion: string;
  actionId: string | null;
  data: Record<string, string | number | boolean | null>;
};

export type RecoveryOrchestrationResult = {
  correlationId: string;
  state: RecoveryState;
  candidate: RecoveryCandidate;
  recommendation: ReturnType<typeof buildRecoveryRecommendation>;
  approvalPayload: RecoveryApprovalPayload | null;
  action: RecoveryAction | null;
  outcome: RecoveryOutcome | null;
  explanation: ExplanationResult;
  events: readonly OrchestrationEvent[];
};

type Session = {
  input: RecoveryOrchestrationInput;
  candidate: RecoveryCandidate;
  recommendation: ReturnType<typeof buildRecoveryRecommendation>;
  approvalPayload: RecoveryApprovalPayload | null;
  state: RecoveryState;
  action: RecoveryAction | null;
  outcome: RecoveryOutcome | null;
  explanation: ExplanationResult;
  events: OrchestrationEvent[];
};

function terminalState(status: RecoveryOutcome['status']): RecoveryState {
  switch (status) {
    case 'RECOVERED':
      return 'RECOVERED';
    case 'FAILED':
      return 'FAILED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'ALREADY_RECOVERED':
      return 'ALREADY_RECOVERED';
    case 'REJECTED':
      return 'REJECTED';
    case 'ABSTAINED':
      return 'ABSTAINED';
    case 'PENDING':
      return 'PENDING_VERIFICATION';
  }
}

export class RecoveryOrchestrator {
  private readonly sessions = new Map<string, Session>();
  private readonly recoveryService: RecoveryService;
  private readonly explanationProvider?: ExplanationProvider;
  private readonly policy: PolicyConfig;
  private readonly policyVersion: string;
  private readonly clock: () => string;
  private readonly afterRecoveryService?: (journey: RecoveryJourney) => void;
  private nextEventSequence = 1;

  constructor(options: {
    recoveryService: RecoveryService;
    policy?: PolicyConfig;
    explanationProvider?: ExplanationProvider;
    policyVersion?: string;
    clock?: () => string;
    afterRecoveryService?: (journey: RecoveryJourney) => void;
  }) {
    this.recoveryService = options.recoveryService;
    this.policy = options.policy ?? options.recoveryService.getPolicy();
    this.explanationProvider = options.explanationProvider;
    this.policyVersion = options.policyVersion ?? 'm7-policy-v1';
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.afterRecoveryService = options.afterRecoveryService;
  }

  private event(
    session: Session,
    eventType: OrchestrationEvent['eventType'],
    state: RecoveryState,
    data: OrchestrationEvent['data'] = {},
  ): void {
    session.events.push({
      sequence: this.nextEventSequence++,
      eventType,
      correlationId: session.input.correlationId,
      merchantReference: session.candidate.merchantId,
      paymentReference: session.candidate.paymentId,
      timestamp: session.input.now ?? this.clock(),
      state,
      modelVersion: session.candidate.modelVersion,
      policyVersion: this.policyVersion,
      actionId: session.action?.actionId ?? null,
      data,
    });
  }

  private transition(
    session: Session,
    next: RecoveryState,
    eventType: OrchestrationEvent['eventType'],
    data: OrchestrationEvent['data'] = {},
  ): void {
    assertValidTransition(session.state, next);
    session.state = next;
    this.event(session, eventType, next, data);
  }

  private candidateFor(input: RecoveryOrchestrationInput): RecoveryCandidate {
    return {
      candidateId: input.detection.candidateId,
      sourceEventId: input.detection.sourceEventId,
      paymentId: input.detection.paymentId,
      merchantId: input.detection.merchantId,
      modelVersion: input.detection.modelVersion,
      segment: 'UPI_INTENT',
      riskScore: input.detection.riskScore,
      estimatedSuccessProbability: input.opportunity.estimatedSuccessProbability,
      recoverableAmountPaise: input.detection.recoverableAmountPaise,
      interventionCostPaise: input.detection.interventionCostPaise,
      detectedAt: input.detection.detectedAt,
      reason: input.detection.reason,
      customer: input.detection.customer,
    };
  }

  private explanationInput(
    session: Session,
    policyDecision: LlmExplanationInput['policyDecision'],
    outcomeStatus: RecoveryOutcome['status'] = 'PENDING',
  ): LlmExplanationInput {
    return explanationInputForOutcome(
      {
        merchantReference: session.candidate.merchantId,
        paymentReference: session.candidate.paymentId,
        riskScore: session.candidate.riskScore,
        expectedRecoveryValuePaise: session.recommendation.expectedRecoveryValuePaise,
        amountPaise: session.candidate.recoverableAmountPaise,
        degradationSignals: session.input.opportunity.signals.filter((signal) =>
          /^[a-z0-9_]+$/.test(signal),
        ),
        policyDecision,
        actionType: 'PAYMENT_LINK',
      },
      outcomeStatus,
    );
  }

  private async explain(
    session: Session,
    policyDecision: LlmExplanationInput['policyDecision'],
    outcomeStatus: RecoveryOutcome['status'] = 'PENDING',
  ): Promise<void> {
    session.explanation = await explainRecovery(
      this.explanationInput(session, policyDecision, outcomeStatus),
      this.explanationProvider,
      EXPLANATION_SYSTEM_PROMPT_V1,
    );
  }

  private approvalPayload(session: Session): RecoveryApprovalPayload {
    const now = session.input.now ?? this.clock();
    return recoveryApprovalPayloadSchema.parse({
      merchantReference: session.candidate.merchantId,
      paymentReference: session.candidate.paymentId,
      candidateId: session.candidate.candidateId,
      reasonCodes: session.input.opportunity.signals.filter((signal) =>
        /^[a-z0-9_]+$/.test(signal),
      ),
      riskScore: session.candidate.riskScore,
      expectedRecoveryValuePaise: session.recommendation.expectedRecoveryValuePaise,
      amountPaise: session.candidate.recoverableAmountPaise,
      actionType: 'PAYMENT_LINK',
      expiresAt: new Date(
        new Date(now).getTime() + this.policy.actionTtlMinutes * 60_000,
      ).toISOString(),
      policyChecks: [
        {
          check: 'minimum_risk_score',
          passed: session.candidate.riskScore >= this.policy.minimumRiskScore,
        },
        {
          check: 'minimum_expected_recovery_value',
          passed:
            session.recommendation.expectedRecoveryValuePaise >=
            this.policy.minimumExpectedRecoveryValuePaise,
        },
        {
          check: 'maximum_amount',
          passed:
            session.candidate.recoverableAmountPaise <= this.policy.maximumRecoverableAmountPaise,
        },
        { check: 'maximum_attempts', passed: this.policy.maximumAttempts === 1 },
        { check: 'action_expiry', passed: this.policy.actionTtlMinutes === 30 },
        { check: 'duplicate_prevention', passed: true },
        { check: 'already_paid_check', passed: session.input.alreadyRecovered !== true },
        { check: 'verification_required', passed: true },
      ],
      explanation: session.explanation.output,
    });
  }

  private result(session: Session): RecoveryOrchestrationResult {
    return {
      correlationId: session.input.correlationId,
      state: session.state,
      candidate: session.candidate,
      recommendation: session.recommendation,
      approvalPayload: session.approvalPayload,
      action: session.action,
      outcome: session.outcome,
      explanation: session.explanation,
      events: session.events.map((event) => ({ ...event, data: { ...event.data } })),
    };
  }

  private async completeJourney(
    session: Session,
    action: RecoveryAction,
    outcome: RecoveryOutcome,
    duplicatePrevented: boolean,
  ): Promise<RecoveryOrchestrationResult> {
    session.action = action;
    session.outcome = outcome;
    if (duplicatePrevented) {
      this.event(session, 'IDEMPOTENCY_REPLAY', session.state, {
        existingActionId: action.actionId,
      });
    }
    if (action.attempts > 0) {
      if (session.state === 'APPROVED') {
        this.transition(session, 'EXECUTING', 'ACTION_EXECUTED', {
          actionType: action.actionType,
          attempts: action.attempts,
        });
      }
    } else {
      const rejectedState = terminalState(outcome.status);
      this.transition(
        session,
        rejectedState,
        rejectedState === 'ABSTAINED' ? 'ACTION_ABSTAINED' : 'ACTION_REJECTED',
        { reason: outcome.reason },
      );
      await this.explain(
        session,
        rejectedState === 'ABSTAINED' ? 'ABSTAINED' : 'REJECTED',
        outcome.status,
      );
      return this.result(session);
    }
    this.event(session, 'VERIFICATION_STARTED', 'EXECUTING', {
      verificationRequired: true,
    });
    const nextState = terminalState(outcome.status);
    if (nextState === 'PENDING_VERIFICATION') {
      if (session.state === 'EXECUTING') {
        this.transition(session, nextState, 'VERIFICATION_STARTED', {
          status: outcome.status,
        });
      }
    } else if (session.state === 'EXECUTING') {
      const eventType =
        nextState === 'RECOVERED'
          ? 'RECOVERY_VERIFIED'
          : nextState === 'FAILED'
            ? 'RECOVERY_FAILED'
            : nextState === 'EXPIRED'
              ? 'ACTION_EXPIRED'
              : 'ALREADY_RECOVERED';
      this.transition(session, nextState, eventType, {
        status: outcome.status,
        recoveredAmountPaise: outcome.recoveredAmountPaise,
      });
    }
    await this.explain(session, 'APPROVED', outcome.status);
    return this.result(session);
  }

  private async executeApproved(
    session: Session,
    merchantApproval: MerchantApproval,
  ): Promise<RecoveryOrchestrationResult> {
    if (merchantApproval !== 'approved') {
      const journey = await this.recoveryService.submit(session.candidate, {
        merchantApproval,
        alreadyRecovered: session.input.alreadyRecovered,
        now: session.input.now,
      });
      session.action = journey.action;
      session.outcome = journey.outcome;
      const rejectedState = terminalState(journey.outcome.status);
      this.transition(
        session,
        rejectedState,
        rejectedState === 'ABSTAINED' ? 'ACTION_ABSTAINED' : 'ACTION_REJECTED',
        { reason: journey.outcome.reason, merchantApproval },
      );
      await this.explain(
        session,
        rejectedState === 'ABSTAINED' ? 'ABSTAINED' : 'REJECTED',
        journey.outcome.status,
      );
      return this.result(session);
    }
    this.transition(session, 'APPROVED', 'APPROVAL_GRANTED', {
      merchantApproval,
    });
    const journey = await this.recoveryService.submit(session.candidate, {
      merchantApproval,
      alreadyRecovered: session.input.alreadyRecovered,
      now: session.input.now,
    });
    session.action = journey.action;
    session.outcome = journey.outcome;
    this.afterRecoveryService?.(journey);
    return this.completeJourney(
      session,
      journey.action,
      journey.outcome,
      journey.duplicatePrevented,
    );
  }

  async begin(input: RecoveryOrchestrationInput): Promise<RecoveryOrchestrationResult> {
    const validatedInput = recoveryOrchestrationInputSchema.parse(input);
    const existing = this.sessions.get(validatedInput.correlationId);
    if (existing) return this.result(existing);
    const candidate = this.candidateFor(validatedInput);
    const recommendation = buildRecoveryRecommendation(candidate);
    const session: Session = {
      input: validatedInput,
      candidate,
      recommendation,
      approvalPayload: null,
      state: 'DETECTED',
      action: null,
      outcome: null,
      explanation: {
        output: {
          summary: 'Explanation pending.',
          reasonCodes: [],
          merchantExplanation: 'Explanation pending.',
        },
        source: 'deterministic_fallback',
      },
      events: [],
    };
    this.sessions.set(validatedInput.correlationId, session);
    this.event(session, 'DETECTION_CREATED', 'DETECTED', {
      score: candidate.riskScore,
    });
    await this.explain(session, 'PENDING_APPROVAL');
    this.transition(session, 'SCORED', 'OPPORTUNITY_SCORED', {
      expectedRecoveryValuePaise: recommendation.expectedRecoveryValuePaise,
      estimatedSuccessProbability: candidate.estimatedSuccessProbability,
    });
    const preDecision = evaluateRecoveryPolicy(candidate, recommendation, 'approved', this.policy, {
      alreadyRecovered: validatedInput.alreadyRecovered,
    });
    session.approvalPayload = this.approvalPayload(session);
    this.event(session, 'POLICY_EVALUATED', 'SCORED', {
      decision: preDecision.decision,
      reason: preDecision.reason,
    });
    if (preDecision.decision !== 'approved') {
      const outcomeState = preDecision.decision === 'abstained' ? 'ABSTAINED' : 'REJECTED';
      const journey = await this.recoveryService.submit(candidate, {
        merchantApproval: 'approved',
        alreadyRecovered: validatedInput.alreadyRecovered,
        now: validatedInput.now,
      });
      session.action = journey.action;
      session.outcome = journey.outcome;
      this.transition(
        session,
        outcomeState,
        outcomeState === 'ABSTAINED' ? 'ACTION_ABSTAINED' : 'ACTION_REJECTED',
        {
          reason: preDecision.reason,
        },
      );
      await this.explain(session, outcomeState, journey.outcome.status);
      return this.result(session);
    }
    this.transition(session, 'POLICY_APPROVED', 'POLICY_EVALUATED', {
      decision: 'approved',
    });
    if (validatedInput.merchantApproval === undefined) {
      this.transition(session, 'AWAITING_MERCHANT_APPROVAL', 'APPROVAL_REQUESTED', {
        expiresInMinutes: this.policy.actionTtlMinutes,
      });
      await this.explain(session, 'PENDING_APPROVAL');
      return this.result(session);
    }
    if (validatedInput.merchantApproval !== 'approved') {
      this.transition(session, 'AWAITING_MERCHANT_APPROVAL', 'APPROVAL_REQUESTED', {
        expiresInMinutes: this.policy.actionTtlMinutes,
      });
    }
    return this.executeApproved(session, validatedInput.merchantApproval);
  }

  async approve(
    correlationId: string,
    merchantApproval: MerchantApproval,
  ): Promise<RecoveryOrchestrationResult> {
    const validatedCorrelationId = identifierSchema.parse(correlationId);
    const validatedApproval = z
      .enum(['approved', 'rejected', 'unavailable'])
      .parse(merchantApproval);
    const session = this.sessions.get(validatedCorrelationId);
    if (!session) throw new Error(`unknown recovery correlation: ${correlationId}`);
    if (session.state === 'APPROVED' && session.action !== null && session.outcome !== null) {
      return this.completeJourney(session, session.action, session.outcome, true);
    }
    if (session.state !== 'AWAITING_MERCHANT_APPROVAL') {
      throw new Error(`recovery is not awaiting approval: ${session.state}`);
    }
    return this.executeApproved(session, validatedApproval);
  }
}
