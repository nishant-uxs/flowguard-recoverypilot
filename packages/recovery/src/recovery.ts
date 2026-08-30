import { createHash } from 'node:crypto';

import { z } from 'zod';

const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/, 'must be a safe identifier');
const timestampSchema = z.string().datetime({ offset: true });
const boundedProbability = z.number().finite().min(0).max(1);
const moneySchema = z.number().finite().int().nonnegative();

export const recoveryActionTypeSchema = z.literal('payment_link');
export type RecoveryActionType = z.infer<typeof recoveryActionTypeSchema>;

export const recoveryCandidateSchema = z
  .object({
    candidateId: identifierSchema,
    sourceEventId: identifierSchema,
    paymentId: identifierSchema,
    merchantId: identifierSchema,
    modelVersion: identifierSchema,
    segment: z.literal('UPI_INTENT'),
    riskScore: boundedProbability,
    estimatedSuccessProbability: boundedProbability,
    recoverableAmountPaise: moneySchema,
    interventionCostPaise: moneySchema,
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
  .strict();
export type RecoveryCandidate = z.infer<typeof recoveryCandidateSchema>;

export const recoveryRecommendationSchema = z
  .object({
    recommendationId: identifierSchema,
    candidateId: identifierSchema,
    actionType: recoveryActionTypeSchema,
    confidence: boundedProbability,
    expectedRecoveryValuePaise: z.number().finite(),
    rationale: z.string().min(1),
    requiresApproval: z.literal(true),
  })
  .strict();
export type RecoveryRecommendation = z.infer<typeof recoveryRecommendationSchema>;

export const recoveryActionStatusSchema = z.enum([
  'PENDING_APPROVAL',
  'APPROVED',
  'EXECUTING',
  'VERIFICATION_PENDING',
  'RECOVERED',
  'FAILED',
  'EXPIRED',
  'REJECTED',
  'ABSTAINED',
  'ALREADY_RECOVERED',
]);
export type RecoveryActionStatus = z.infer<typeof recoveryActionStatusSchema>;

export const recoveryActionSchema = z
  .object({
    actionId: identifierSchema,
    candidateId: identifierSchema,
    merchantId: identifierSchema,
    paymentId: identifierSchema,
    actionType: recoveryActionTypeSchema,
    idempotencyKey: identifierSchema,
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    status: recoveryActionStatusSchema,
    attempts: z.number().int().nonnegative(),
    providerReference: identifierSchema.optional(),
  })
  .strict();
export type RecoveryAction = z.infer<typeof recoveryActionSchema>;

export const recoveryOutcomeStatusSchema = z.enum([
  'RECOVERED',
  'FAILED',
  'PENDING',
  'EXPIRED',
  'REJECTED',
  'ABSTAINED',
  'ALREADY_RECOVERED',
]);
export type RecoveryOutcomeStatus = z.infer<typeof recoveryOutcomeStatusSchema>;

export const recoveryOutcomeSchema = z
  .object({
    actionId: identifierSchema,
    status: recoveryOutcomeStatusSchema,
    recoveredAmountPaise: moneySchema,
    verifiedAt: timestampSchema.optional(),
    verificationMethod: z
      .enum(['simulation', 'razorpay_payment_link_fetch', 'policy', 'idempotency'])
      .optional(),
    reason: z.string().min(1),
  })
  .strict();
export type RecoveryOutcome = z.infer<typeof recoveryOutcomeSchema>;

export type MerchantApproval = 'approved' | 'rejected' | 'unavailable';

export type PolicyConfig = {
  minimumRiskScore: number;
  minimumExpectedRecoveryValuePaise: number;
  maximumRecoverableAmountPaise: number;
  actionTtlMinutes: number;
  maximumAttempts: number;
  cooldownMinutes: number;
};

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  minimumRiskScore: 0.55,
  minimumExpectedRecoveryValuePaise: 50,
  maximumRecoverableAmountPaise: 500_000,
  actionTtlMinutes: 30,
  maximumAttempts: 1,
  cooldownMinutes: 30,
};

export type PolicyDecision = {
  decision: 'approved' | 'rejected' | 'abstained';
  reason:
    | 'approved'
    | 'low_confidence'
    | 'low_expected_value'
    | 'amount_limit'
    | 'approval_rejected'
    | 'approval_unavailable'
    | 'already_recovered'
    | 'maximum_attempts'
    | 'cooldown_active';
};

export type ExecutorCreateResult = {
  status: 'created' | 'expired' | 'already_recovered';
  providerReference?: string;
  actionUrl?: string;
};

export type ExecutorVerificationResult = {
  status: 'recovered' | 'failed' | 'pending' | 'expired' | 'already_recovered';
  recoveredAmountPaise: number;
  reason: string;
  verificationMethod?: RecoveryOutcome['verificationMethod'];
};

export interface RecoveryExecutor {
  createPaymentLink(
    action: RecoveryAction,
    candidate: RecoveryCandidate,
  ): Promise<ExecutorCreateResult>;
  verifyRecovery(
    action: RecoveryAction,
    candidate: RecoveryCandidate,
    creation: ExecutorCreateResult,
  ): Promise<ExecutorVerificationResult>;
}

export type SimulationScenario =
  'success' | 'failed' | 'expired' | 'already_recovered' | 'verification_timeout';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export function recoveryIdempotencyKey(candidate: RecoveryCandidate): string {
  return `recovery_${digest(`${candidate.merchantId}:${candidate.paymentId}:payment_link`)}`;
}

function actionIdFor(idempotencyKey: string): string {
  return `action_${digest(idempotencyKey)}`;
}

function addMinutes(timestamp: string, minutes: number): string {
  return new Date(new Date(timestamp).getTime() + minutes * 60_000).toISOString();
}

export function buildRecoveryRecommendation(candidate: RecoveryCandidate): RecoveryRecommendation {
  recoveryCandidateSchema.parse(candidate);
  return recoveryRecommendationSchema.parse({
    recommendationId: `recommendation_${digest(candidate.candidateId)}`,
    candidateId: candidate.candidateId,
    actionType: 'payment_link',
    confidence: candidate.riskScore,
    expectedRecoveryValuePaise:
      candidate.estimatedSuccessProbability * candidate.recoverableAmountPaise -
      candidate.interventionCostPaise,
    rationale: candidate.reason.join('; '),
    requiresApproval: true,
  });
}

export function evaluateRecoveryPolicy(
  candidate: RecoveryCandidate,
  recommendation: RecoveryRecommendation,
  approval: MerchantApproval,
  config: PolicyConfig = DEFAULT_POLICY_CONFIG,
  context: {
    alreadyRecovered?: boolean;
    attempts?: number;
    cooldownActive?: boolean;
  } = {},
): PolicyDecision {
  if (context.alreadyRecovered) return { decision: 'rejected', reason: 'already_recovered' };
  if ((context.attempts ?? 0) >= config.maximumAttempts) {
    return { decision: 'rejected', reason: 'maximum_attempts' };
  }
  if (approval === 'unavailable') return { decision: 'abstained', reason: 'approval_unavailable' };
  if (approval === 'rejected') return { decision: 'rejected', reason: 'approval_rejected' };
  if (context.cooldownActive && config.cooldownMinutes > 0) {
    return { decision: 'abstained', reason: 'cooldown_active' };
  }
  if (recommendation.confidence < config.minimumRiskScore) {
    return { decision: 'abstained', reason: 'low_confidence' };
  }
  if (recommendation.expectedRecoveryValuePaise < config.minimumExpectedRecoveryValuePaise) {
    return { decision: 'abstained', reason: 'low_expected_value' };
  }
  if (candidate.recoverableAmountPaise > config.maximumRecoverableAmountPaise) {
    return { decision: 'rejected', reason: 'amount_limit' };
  }
  return { decision: 'approved', reason: 'approved' };
}

type AuditValue = string | number | boolean | null;

export type RecoveryAuditEvent = {
  sequence: number;
  eventType:
    | 'candidate_received'
    | 'recommendation_created'
    | 'policy_decision'
    | 'approval_recorded'
    | 'action_started'
    | 'intervention_created'
    | 'verification_recorded'
    | 'outcome_recorded'
    | 'duplicate_prevented'
    | 'executor_error';
  occurredAt: string;
  actionId: string;
  candidateId: string;
  merchantId: string;
  paymentId: string;
  idempotencyKey: string;
  data: Record<string, AuditValue>;
};

export const recoveryAuditEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    eventType: z.string().min(1),
    occurredAt: timestampSchema,
    actionId: identifierSchema,
    candidateId: identifierSchema,
    eventId: identifierSchema,
    merchantId: identifierSchema,
    paymentId: identifierSchema,
    idempotencyKey: identifierSchema,
    data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  })
  .strict();

export type RecoveryJourney = {
  candidate: RecoveryCandidate;
  recommendation: RecoveryRecommendation;
  action: RecoveryAction;
  outcome: RecoveryOutcome;
  duplicatePrevented: boolean;
  auditEvents: RecoveryAuditEvent[];
};

export class SimulationRecoveryExecutor implements RecoveryExecutor {
  private readonly outcomes: Record<string, SimulationScenario>;
  private readonly recoveredPayments = new Set<string>();
  private readonly seed: number;
  public createCalls = 0;
  public verificationCalls = 0;

  constructor(options: { seed?: number; outcomes?: Record<string, SimulationScenario> } = {}) {
    this.seed = options.seed ?? 7;
    this.outcomes = { ...(options.outcomes ?? {}) };
  }

  private scenarioFor(candidate: RecoveryCandidate): SimulationScenario {
    const configured = this.outcomes[candidate.paymentId];
    if (configured !== undefined) return configured;
    const bucket =
      Number.parseInt(digest(`${this.seed}:${candidate.paymentId}`).slice(0, 6), 16) % 100;
    if (bucket < 60) return 'success';
    if (bucket < 78) return 'failed';
    if (bucket < 88) return 'expired';
    if (bucket < 95) return 'already_recovered';
    return 'verification_timeout';
  }

  async createPaymentLink(
    action: RecoveryAction,
    candidate: RecoveryCandidate,
  ): Promise<ExecutorCreateResult> {
    this.createCalls += 1;
    const scenario = this.scenarioFor(candidate);
    if (scenario === 'expired') return { status: 'expired' };
    if (scenario === 'already_recovered' || this.recoveredPayments.has(candidate.paymentId)) {
      return { status: 'already_recovered', providerReference: `sim_${digest(action.actionId)}` };
    }
    return {
      status: 'created',
      providerReference: `sim_${digest(action.actionId)}`,
      actionUrl: `https://simulation.invalid/pay/${digest(action.actionId)}`,
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
        reason: `simulation provider reference unavailable for ${action.actionId}`,
        verificationMethod: 'simulation',
      };
    }
    const scenario = this.scenarioFor(candidate);
    if (scenario === 'success') {
      this.recoveredPayments.add(candidate.paymentId);
      return {
        status: 'recovered',
        recoveredAmountPaise: candidate.recoverableAmountPaise,
        reason: 'simulated payment was verified as captured',
        verificationMethod: 'simulation',
      };
    }
    if (scenario === 'verification_timeout') {
      return {
        status: 'pending',
        recoveredAmountPaise: 0,
        reason: 'verification window elapsed without a terminal payment state',
        verificationMethod: 'simulation',
      };
    }
    if (scenario === 'already_recovered') {
      return {
        status: 'already_recovered',
        recoveredAmountPaise: 0,
        reason: 'payment was already recovered before this action',
        verificationMethod: 'simulation',
      };
    }
    return {
      status: 'failed',
      recoveredAmountPaise: 0,
      reason:
        scenario === 'failed' ? 'simulated customer did not complete payment' : 'action expired',
      verificationMethod: 'simulation',
    };
  }
}

export class RazorpayTestRecoveryExecutor implements RecoveryExecutor {
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: (
    input: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

  constructor(options: {
    keyId: string;
    keySecret: string;
    baseUrl?: string;
    fetchImpl?: RazorpayTestRecoveryExecutor['fetchImpl'];
  }) {
    if (!options.keyId.startsWith('rzp_test_')) {
      throw new Error('RazorpayTestRecoveryExecutor requires an rzp_test_ key');
    }
    this.keyId = options.keyId;
    this.keySecret = options.keySecret;
    this.baseUrl = (options.baseUrl ?? 'https://api.razorpay.com/v1').replace(/\/$/, '');
    this.fetchImpl =
      options.fetchImpl ??
      (async (input, init) => {
        const response = await fetch(input, init);
        return response;
      });
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
    };
  }

  async createPaymentLink(
    action: RecoveryAction,
    candidate: RecoveryCandidate,
  ): Promise<ExecutorCreateResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/payment_links`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        amount: candidate.recoverableAmountPaise,
        currency: 'INR',
        accept_partial: false,
        description: `FlowGuard recovery for ${candidate.paymentId}`,
        reference_id: action.idempotencyKey,
        expire_by: Math.floor(new Date(action.expiresAt).getTime() / 1000),
        customer: candidate.customer,
        notify: { sms: false, email: Boolean(candidate.customer?.email) },
        reminder_enable: false,
        notes: {
          flowguard_action_id: action.actionId,
          flowguard_payment_id: candidate.paymentId,
        },
      }),
    });
    const body = JSON.parse(await response.text()) as { id?: string; short_url?: string };
    if (!response.ok || body.id === undefined) {
      throw new Error(`Razorpay payment link creation failed with HTTP ${response.status}`);
    }
    return { status: 'created', providerReference: body.id, actionUrl: body.short_url };
  }

  async verifyRecovery(
    action: RecoveryAction,
    candidate: RecoveryCandidate,
    creation: ExecutorCreateResult,
  ): Promise<ExecutorVerificationResult> {
    if (creation.providerReference === undefined) {
      return {
        status: 'pending',
        recoveredAmountPaise: 0,
        reason: 'provider reference unavailable',
      };
    }
    const response = await this.fetchImpl(
      `${this.baseUrl}/payment_links/${creation.providerReference}`,
      { method: 'GET', headers: this.headers() },
    );
    const body = JSON.parse(await response.text()) as {
      status?: string;
      amount_paid?: number;
      amount?: number;
    };
    if (!response.ok)
      throw new Error(`Razorpay payment link verification failed with HTTP ${response.status}`);
    if (body.status === 'paid' && typeof body.amount_paid === 'number') {
      return {
        status: 'recovered',
        recoveredAmountPaise: Math.min(candidate.recoverableAmountPaise, body.amount_paid),
        reason: `Razorpay TEST MODE payment link ${creation.providerReference} is paid`,
        verificationMethod: 'razorpay_payment_link_fetch',
      };
    }
    if (body.status === 'expired' || body.status === 'cancelled') {
      return {
        status: 'expired',
        recoveredAmountPaise: 0,
        reason: `payment link status is ${body.status}`,
        verificationMethod: 'razorpay_payment_link_fetch',
      };
    }
    return {
      status: 'pending',
      recoveredAmountPaise: 0,
      reason: `payment link status is ${body.status ?? 'unknown'} for action ${action.actionId}`,
      verificationMethod: 'razorpay_payment_link_fetch',
    };
  }
}

function actionFor(
  candidate: RecoveryCandidate,
  now: string,
  config: PolicyConfig,
  status: RecoveryActionStatus,
): RecoveryAction {
  const idempotencyKey = recoveryIdempotencyKey(candidate);
  return recoveryActionSchema.parse({
    actionId: actionIdFor(idempotencyKey),
    candidateId: candidate.candidateId,
    merchantId: candidate.merchantId,
    paymentId: candidate.paymentId,
    actionType: 'payment_link',
    idempotencyKey,
    createdAt: now,
    expiresAt: addMinutes(now, config.actionTtlMinutes),
    status,
    attempts: 0,
  });
}

function outcomeFor(
  actionId: string,
  status: RecoveryOutcomeStatus,
  reason: string,
  now: string,
  recoveredAmountPaise = 0,
  verificationMethod: RecoveryOutcome['verificationMethod'] = 'policy',
): RecoveryOutcome {
  return recoveryOutcomeSchema.parse({
    actionId,
    status,
    recoveredAmountPaise,
    ...(status === 'RECOVERED' ? { verifiedAt: now } : {}),
    verificationMethod,
    reason,
  });
}

export class RecoveryService {
  private readonly actions = new Map<string, RecoveryAction>();
  private readonly outcomes = new Map<string, RecoveryOutcome>();
  private readonly lastActionAtByMerchant = new Map<string, string>();
  private readonly audit: RecoveryAuditEvent[] = [];
  private readonly executor: RecoveryExecutor;
  private readonly policy: PolicyConfig;
  private readonly clock: () => string;

  constructor(options: {
    executor: RecoveryExecutor;
    policy?: PolicyConfig;
    clock?: () => string;
  }) {
    this.executor = options.executor;
    this.policy = options.policy ?? DEFAULT_POLICY_CONFIG;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  getPolicy(): PolicyConfig {
    return { ...this.policy };
  }

  private append(
    eventType: RecoveryAuditEvent['eventType'],
    action: RecoveryAction,
    candidate: RecoveryCandidate,
    data: Record<string, AuditValue>,
    occurredAt: string,
  ): void {
    const event = {
      sequence: this.audit.length + 1,
      eventType,
      occurredAt,
      actionId: action.actionId,
      candidateId: candidate.candidateId,
      eventId: candidate.sourceEventId,
      merchantId: candidate.merchantId,
      paymentId: candidate.paymentId,
      idempotencyKey: action.idempotencyKey,
      data,
    };
    recoveryAuditEventSchema.parse(event);
    this.audit.push(Object.freeze(event));
  }

  private journey(
    candidate: RecoveryCandidate,
    recommendation: RecoveryRecommendation,
    action: RecoveryAction,
    outcome: RecoveryOutcome,
    duplicatePrevented: boolean,
  ): RecoveryJourney {
    return {
      candidate,
      recommendation,
      action,
      outcome,
      duplicatePrevented,
      auditEvents: this.audit
        .filter((event) => event.actionId === action.actionId)
        .map((event) => ({ ...event, data: { ...event.data } })),
    };
  }

  private async reconcileInFlight(
    candidate: RecoveryCandidate,
    recommendation: RecoveryRecommendation,
    existing: RecoveryAction,
    now: string,
  ): Promise<RecoveryJourney> {
    let action = existing;
    if (existing.status === 'VERIFICATION_PENDING' && existing.providerReference !== undefined) {
      try {
        const verification = await this.executor.verifyRecovery(action, candidate, {
          status: 'created',
          providerReference: existing.providerReference,
        });
        const mappedStatus: RecoveryOutcomeStatus =
          verification.status === 'recovered'
            ? 'RECOVERED'
            : verification.status === 'already_recovered'
              ? 'ALREADY_RECOVERED'
              : verification.status === 'expired'
                ? 'EXPIRED'
                : verification.status === 'pending'
                  ? 'PENDING'
                  : 'FAILED';
        const boundedRecoveredAmount = Math.min(
          candidate.recoverableAmountPaise,
          Math.max(0, verification.recoveredAmountPaise),
        );
        action = recoveryActionSchema.parse({
          ...action,
          status:
            mappedStatus === 'RECOVERED'
              ? 'RECOVERED'
              : mappedStatus === 'PENDING'
                ? 'VERIFICATION_PENDING'
                : mappedStatus,
        });
        this.actions.set(action.idempotencyKey, action);
        this.append(
          'verification_recorded',
          action,
          candidate,
          {
            status: mappedStatus,
            recoveredAmountPaise: boundedRecoveredAmount,
            reason: verification.reason,
          },
          now,
        );
        const outcome = outcomeFor(
          action.actionId,
          mappedStatus,
          verification.reason,
          now,
          boundedRecoveredAmount,
          verification.verificationMethod ?? 'idempotency',
        );
        this.outcomes.set(action.idempotencyKey, outcome);
        this.append(
          'outcome_recorded',
          action,
          candidate,
          { status: outcome.status, recoveredAmountPaise: boundedRecoveredAmount },
          now,
        );
        return this.journey(candidate, recommendation, action, outcome, true);
      } catch (error) {
        action = recoveryActionSchema.parse({ ...action, status: 'FAILED' });
        this.actions.set(action.idempotencyKey, action);
        const outcome = outcomeFor(
          action.actionId,
          'FAILED',
          error instanceof Error ? error.message : 'in-flight verification error',
          now,
          0,
          'idempotency',
        );
        this.outcomes.set(action.idempotencyKey, outcome);
        this.append('executor_error', action, candidate, { reason: outcome.reason }, now);
        this.append('outcome_recorded', action, candidate, { status: outcome.status }, now);
        return this.journey(candidate, recommendation, action, outcome, true);
      }
    }

    action = recoveryActionSchema.parse({
      ...action,
      status: 'VERIFICATION_PENDING',
    });
    this.actions.set(action.idempotencyKey, action);
    const outcome = outcomeFor(
      action.actionId,
      'PENDING',
      'existing execution has no provider reference; no duplicate action was created',
      now,
      0,
      'idempotency',
    );
    this.outcomes.set(action.idempotencyKey, outcome);
    this.append(
      'outcome_recorded',
      action,
      candidate,
      { status: outcome.status, reason: outcome.reason },
      now,
    );
    return this.journey(candidate, recommendation, action, outcome, true);
  }

  async submit(
    candidateInput: RecoveryCandidate,
    options: {
      merchantApproval: MerchantApproval;
      alreadyRecovered?: boolean;
      now?: string;
    },
  ): Promise<RecoveryJourney> {
    const candidate = recoveryCandidateSchema.parse(candidateInput);
    const now = options.now ?? this.clock();
    const recommendation = buildRecoveryRecommendation(candidate);
    const idempotencyKey = recoveryIdempotencyKey(candidate);
    const existing = this.actions.get(idempotencyKey);
    if (existing) {
      const recordedOutcome = this.outcomes.get(idempotencyKey);
      if (recordedOutcome === undefined) {
        const reconciled = await this.reconcileInFlight(candidate, recommendation, existing, now);
        this.append(
          'duplicate_prevented',
          reconciled.action,
          candidate,
          { existingActionId: reconciled.action.actionId, status: reconciled.action.status },
          now,
        );
        return this.journey(candidate, recommendation, reconciled.action, reconciled.outcome, true);
      }
      this.append(
        'duplicate_prevented',
        existing,
        candidate,
        { existingActionId: existing.actionId, status: existing.status },
        now,
      );
      return this.journey(candidate, recommendation, existing, recordedOutcome, true);
    }

    let action = actionFor(candidate, now, this.policy, 'PENDING_APPROVAL');
    this.actions.set(idempotencyKey, action);
    this.append(
      'candidate_received',
      action,
      candidate,
      { riskScore: candidate.riskScore, modelVersion: candidate.modelVersion },
      now,
    );
    this.append(
      'recommendation_created',
      action,
      candidate,
      {
        confidence: recommendation.confidence,
        expectedRecoveryValuePaise: recommendation.expectedRecoveryValuePaise,
        actionType: recommendation.actionType,
      },
      now,
    );
    const decision = evaluateRecoveryPolicy(
      candidate,
      recommendation,
      options.merchantApproval,
      this.policy,
      {
        alreadyRecovered: options.alreadyRecovered,
        cooldownActive:
          this.policy.cooldownMinutes > 0 &&
          (() => {
            const lastActionAt = this.lastActionAtByMerchant.get(candidate.merchantId);
            return (
              lastActionAt !== undefined &&
              new Date(now).getTime() <
                new Date(lastActionAt).getTime() + this.policy.cooldownMinutes * 60_000
            );
          })(),
      },
    );
    this.append('policy_decision', action, candidate, decision, now);
    this.append(
      'approval_recorded',
      action,
      candidate,
      { merchantApproval: options.merchantApproval },
      now,
    );
    if (decision.decision !== 'approved') {
      const status = decision.decision === 'abstained' ? 'ABSTAINED' : 'REJECTED';
      action = recoveryActionSchema.parse({ ...action, status });
      this.actions.set(idempotencyKey, action);
      const outcome = outcomeFor(action.actionId, status, decision.reason, now);
      this.outcomes.set(idempotencyKey, outcome);
      this.append('outcome_recorded', action, candidate, { status, reason: decision.reason }, now);
      return this.journey(candidate, recommendation, action, outcome, false);
    }

    this.lastActionAtByMerchant.set(candidate.merchantId, now);
    action = recoveryActionSchema.parse({ ...action, status: 'APPROVED' });
    this.actions.set(idempotencyKey, action);
    this.append(
      'action_started',
      action,
      candidate,
      { maximumAttempts: this.policy.maximumAttempts },
      now,
    );
    let creation: ExecutorCreateResult;
    try {
      action = recoveryActionSchema.parse({
        ...action,
        status: 'EXECUTING',
        attempts: action.attempts + 1,
      });
      this.actions.set(idempotencyKey, action);
      creation = await this.executor.createPaymentLink(action, candidate);
    } catch (error) {
      action = recoveryActionSchema.parse({ ...action, status: 'FAILED' });
      this.actions.set(idempotencyKey, action);
      const outcome = outcomeFor(
        action.actionId,
        'FAILED',
        error instanceof Error ? error.message : 'executor error',
        now,
      );
      this.outcomes.set(idempotencyKey, outcome);
      this.append('executor_error', action, candidate, { reason: outcome.reason }, now);
      this.append('outcome_recorded', action, candidate, { status: outcome.status }, now);
      return this.journey(candidate, recommendation, action, outcome, false);
    }
    if (creation.status === 'expired') {
      action = recoveryActionSchema.parse({ ...action, status: 'EXPIRED' });
      this.actions.set(idempotencyKey, action);
      const outcome = outcomeFor(
        action.actionId,
        'EXPIRED',
        'executor reported an expired action',
        now,
      );
      this.outcomes.set(idempotencyKey, outcome);
      this.append('outcome_recorded', action, candidate, { status: outcome.status }, now);
      return this.journey(candidate, recommendation, action, outcome, false);
    }
    if (creation.status === 'already_recovered') {
      action = recoveryActionSchema.parse({
        ...action,
        status: 'ALREADY_RECOVERED',
        providerReference: creation.providerReference,
      });
      this.actions.set(idempotencyKey, action);
      const outcome = outcomeFor(
        action.actionId,
        'ALREADY_RECOVERED',
        'executor found the payment already recovered',
        now,
      );
      this.outcomes.set(idempotencyKey, outcome);
      this.append(
        'intervention_created',
        action,
        candidate,
        { providerReference: creation.providerReference ?? null },
        now,
      );
      this.append('outcome_recorded', action, candidate, { status: outcome.status }, now);
      return this.journey(candidate, recommendation, action, outcome, false);
    }

    action = recoveryActionSchema.parse({
      ...action,
      status: 'VERIFICATION_PENDING',
      providerReference: creation.providerReference,
    });
    this.actions.set(idempotencyKey, action);
    this.append(
      'intervention_created',
      action,
      candidate,
      {
        providerReference: creation.providerReference ?? null,
        actionUrl: creation.actionUrl ?? null,
      },
      now,
    );
    let verification: ExecutorVerificationResult;
    try {
      verification = await this.executor.verifyRecovery(action, candidate, creation);
    } catch (error) {
      action = recoveryActionSchema.parse({ ...action, status: 'FAILED' });
      this.actions.set(idempotencyKey, action);
      const outcome = outcomeFor(
        action.actionId,
        'FAILED',
        error instanceof Error ? error.message : 'verification error',
        now,
      );
      this.outcomes.set(idempotencyKey, outcome);
      this.append('executor_error', action, candidate, { reason: outcome.reason }, now);
      this.append('outcome_recorded', action, candidate, { status: outcome.status }, now);
      return this.journey(candidate, recommendation, action, outcome, false);
    }
    const mappedStatus: RecoveryOutcomeStatus =
      verification.status === 'recovered'
        ? 'RECOVERED'
        : verification.status === 'already_recovered'
          ? 'ALREADY_RECOVERED'
          : verification.status === 'expired'
            ? 'EXPIRED'
            : verification.status === 'pending'
              ? 'PENDING'
              : 'FAILED';
    const boundedRecoveredAmount = Math.min(
      candidate.recoverableAmountPaise,
      Math.max(0, verification.recoveredAmountPaise),
    );
    const finalActionStatus: RecoveryActionStatus =
      mappedStatus === 'RECOVERED'
        ? 'RECOVERED'
        : mappedStatus === 'PENDING'
          ? 'VERIFICATION_PENDING'
          : mappedStatus;
    action = recoveryActionSchema.parse({ ...action, status: finalActionStatus });
    this.actions.set(idempotencyKey, action);
    this.append(
      'verification_recorded',
      action,
      candidate,
      {
        status: mappedStatus,
        recoveredAmountPaise: boundedRecoveredAmount,
        reason: verification.reason,
      },
      now,
    );
    const outcome = outcomeFor(
      action.actionId,
      mappedStatus,
      verification.reason,
      now,
      boundedRecoveredAmount,
      verification.verificationMethod ?? 'simulation',
    );
    this.outcomes.set(idempotencyKey, outcome);
    this.append(
      'outcome_recorded',
      action,
      candidate,
      { status: outcome.status, recoveredAmountPaise: boundedRecoveredAmount },
      now,
    );
    return this.journey(candidate, recommendation, action, outcome, false);
  }

  listAuditEvents(): readonly RecoveryAuditEvent[] {
    return this.audit.map((event) => ({ ...event, data: { ...event.data } }));
  }

  listActions(): readonly RecoveryAction[] {
    return [...this.actions.values()].map((action) => ({ ...action }));
  }
}
