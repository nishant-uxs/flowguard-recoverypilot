import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POLICY_CONFIG,
  RazorpayTestRecoveryExecutor,
  RecoveryService,
  SimulationRecoveryExecutor,
  buildRecoveryRecommendation,
  evaluateRecoveryPolicy,
  recoveryCandidateSchema,
} from '../src/index.js';
import type { RecoveryCandidate, RecoveryExecutor } from '../src/index.js';

const fixedNow = '2026-08-30T10:00:00.000Z';

function candidate(overrides: Partial<RecoveryCandidate> = {}): RecoveryCandidate {
  return recoveryCandidateSchema.parse({
    candidateId: 'candidate_001',
    sourceEventId: 'event_001',
    paymentId: 'payment_001',
    merchantId: 'merchant_001',
    modelVersion: 'logistic_v2',
    segment: 'UPI_INTENT',
    riskScore: 0.9,
    estimatedSuccessProbability: 0.8,
    recoverableAmountPaise: 1_000,
    interventionCostPaise: 20,
    detectedAt: fixedNow,
    reason: ['failure rate is above the merchant baseline'],
    ...overrides,
  });
}

describe('recovery contracts and policy', () => {
  it('calculates transparent expected recovery value', () => {
    const recommendation = buildRecoveryRecommendation(candidate());

    expect(recommendation.actionType).toBe('payment_link');
    expect(recommendation.requiresApproval).toBe(true);
    expect(recommendation.expectedRecoveryValuePaise).toBe(780);
  });

  it.each([
    ['low confidence', candidate({ riskScore: 0.4 }), 'approved', 'abstained', 'low_confidence'],
    [
      'low value',
      candidate({ recoverableAmountPaise: 50, interventionCostPaise: 20 }),
      'approved',
      'abstained',
      'low_expected_value',
    ],
    ['approval unavailable', candidate(), 'unavailable', 'abstained', 'approval_unavailable'],
    ['approval rejected', candidate(), 'rejected', 'rejected', 'approval_rejected'],
    [
      'amount limit',
      candidate({ recoverableAmountPaise: 600_000 }),
      'approved',
      'rejected',
      'amount_limit',
    ],
  ])('%s creates a deterministic policy decision', (_name, item, approval, decision, reason) => {
    const result = evaluateRecoveryPolicy(
      item,
      buildRecoveryRecommendation(item),
      approval as 'approved' | 'rejected' | 'unavailable',
    );

    expect(result).toEqual({ decision, reason });
  });
});

describe('recovery service end-to-end semantics', () => {
  it('requires approval, executes once, verifies value, and records the complete journey', async () => {
    const executor = new SimulationRecoveryExecutor({
      outcomes: { payment_001: 'success' },
    });
    const service = new RecoveryService({ executor, clock: () => fixedNow });
    const result = await service.submit(candidate(), { merchantApproval: 'approved' });

    expect(result.outcome).toMatchObject({
      status: 'RECOVERED',
      recoveredAmountPaise: 1_000,
      verificationMethod: 'simulation',
    });
    expect(result.action).toMatchObject({ status: 'RECOVERED', attempts: 1 });
    expect(executor.createCalls).toBe(1);
    expect(executor.verificationCalls).toBe(1);
    expect(result.auditEvents.map((event) => event.eventType)).toEqual([
      'candidate_received',
      'recommendation_created',
      'policy_decision',
      'approval_recorded',
      'action_started',
      'intervention_created',
      'verification_recorded',
      'outcome_recorded',
    ]);
  });

  it('prevents duplicate actions for the same payment recovery context', async () => {
    const executor = new SimulationRecoveryExecutor({ outcomes: { payment_001: 'success' } });
    const service = new RecoveryService({ executor, clock: () => fixedNow });
    const first = await service.submit(candidate(), { merchantApproval: 'approved' });
    const second = await service.submit(candidate({ candidateId: 'candidate_002' }), {
      merchantApproval: 'approved',
    });

    expect(second.duplicatePrevented).toBe(true);
    expect(second.action.actionId).toBe(first.action.actionId);
    expect(second.outcome.recoveredAmountPaise).toBe(1_000);
    expect(executor.createCalls).toBe(1);
    expect(service.listAuditEvents().at(-1)?.eventType).toBe('duplicate_prevented');
  });

  it('coalesces concurrent identical submissions into one logical action', async () => {
    let releaseCreation!: () => void;
    const creationReleased = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    let createCalls = 0;
    const executor: RecoveryExecutor = {
      async createPaymentLink() {
        createCalls += 1;
        await creationReleased;
        return { status: 'created', providerReference: 'plink_concurrent' };
      },
      async verifyRecovery() {
        return {
          status: 'recovered',
          recoveredAmountPaise: 1_000,
          reason: 'concurrent simulation verified',
          verificationMethod: 'simulation',
        };
      },
    };
    const service = new RecoveryService({ executor, clock: () => fixedNow });
    const first = service.submit(candidate(), { merchantApproval: 'approved' });
    const second = service.submit(candidate({ candidateId: 'candidate_002' }), {
      merchantApproval: 'approved',
    });

    releaseCreation();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(createCalls).toBe(1);
    expect(firstResult.action.actionId).toBe(secondResult.action.actionId);
    expect(firstResult.outcome.status).toBe('RECOVERED');
    expect(secondResult.outcome.status).toBe('RECOVERED');
  });

  it.each([
    ['failed', 'FAILED'],
    ['expired', 'EXPIRED'],
    ['verification_timeout', 'PENDING'],
    ['already_recovered', 'ALREADY_RECOVERED'],
  ] as const)('stops safely for %s simulation outcomes', async (scenario, expectedStatus) => {
    const paymentId = `payment_${scenario}`;
    const executor = new SimulationRecoveryExecutor({ outcomes: { [paymentId]: scenario } });
    const service = new RecoveryService({ executor, clock: () => fixedNow });
    const result = await service.submit(candidate({ paymentId }), { merchantApproval: 'approved' });

    expect(result.outcome.status).toBe(expectedStatus);
    expect(result.outcome.recoveredAmountPaise).toBe(0);
  });

  it('makes abstention and rejection visible without calling the executor', async () => {
    const executor = new SimulationRecoveryExecutor();
    const service = new RecoveryService({ executor, clock: () => fixedNow });
    const abstained = await service.submit(candidate({ riskScore: 0.1 }), {
      merchantApproval: 'approved',
    });
    const rejected = await service.submit(candidate({ paymentId: 'payment_002' }), {
      merchantApproval: 'rejected',
    });

    expect(abstained.outcome.status).toBe('ABSTAINED');
    expect(rejected.outcome.status).toBe('REJECTED');
    expect(executor.createCalls).toBe(0);
    expect(
      service.listAuditEvents().filter((event) => event.eventType === 'policy_decision'),
    ).toHaveLength(2);
  });

  it('returns copies of the append-only audit view', async () => {
    const service = new RecoveryService({
      executor: new SimulationRecoveryExecutor({ outcomes: { payment_001: 'success' } }),
      clock: () => fixedNow,
    });
    await service.submit(candidate(), { merchantApproval: 'approved' });
    const events = service.listAuditEvents();
    events[0]!.data.riskScore = 0;

    expect(service.listAuditEvents()[0]!.data.riskScore).toBe(0.9);
  });

  it('does not expose mutable audit objects through a journey result', async () => {
    const service = new RecoveryService({
      executor: new SimulationRecoveryExecutor({ outcomes: { payment_001: 'success' } }),
      clock: () => fixedNow,
    });
    const journey = await service.submit(candidate(), { merchantApproval: 'approved' });
    journey.auditEvents[0]!.data.riskScore = 0;

    expect(service.listAuditEvents()[0]!.data.riskScore).toBe(0.9);
  });
});

describe('Razorpay TEST MODE adapter', () => {
  it('requires test keys and verifies paid links rather than counting creation', async () => {
    const requests: Array<{ url: string; init: { method: string; body?: string } }> = [];
    const executor = new RazorpayTestRecoveryExecutor({
      keyId: 'rzp_test_demo',
      keySecret: 'test_secret',
      baseUrl: 'https://example.test/v1',
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return {
          ok: true,
          status: 200,
          text: async () =>
            requests.length === 1
              ? JSON.stringify({ id: 'plink_001', short_url: 'https://rzp.test/plink_001' })
              : JSON.stringify({ status: 'paid', amount_paid: 1_000 }),
        };
      },
    });
    const service = new RecoveryService({ executor, clock: () => fixedNow });
    const result = await service.submit(candidate(), { merchantApproval: 'approved' });

    expect(result.outcome.status).toBe('RECOVERED');
    expect(result.outcome.verificationMethod).toBe('razorpay_payment_link_fetch');
    expect(requests.map((request) => `${request.init.method} ${request.url}`)).toEqual([
      'POST https://example.test/v1/payment_links',
      'GET https://example.test/v1/payment_links/plink_001',
    ]);
    expect(JSON.parse(requests[0]!.init.body!)).toMatchObject({
      amount: 1_000,
      currency: 'INR',
      accept_partial: false,
      reference_id: result.action.idempotencyKey,
      expire_by: Math.floor(new Date('2026-08-30T10:30:00.000Z').getTime() / 1000),
    });
  });

  it('rejects non-test credentials before any API call', () => {
    expect(
      () =>
        new RazorpayTestRecoveryExecutor({
          keyId: ['rzp', 'live_not_allowed'].join('_'),
          keySecret: 'secret',
        }),
    ).toThrow('requires an rzp_test_ key');
  });

  it('uses the configured safety limits rather than silently changing them', () => {
    expect(DEFAULT_POLICY_CONFIG).toMatchObject({
      minimumRiskScore: 0.55,
      maximumAttempts: 1,
      actionTtlMinutes: 30,
      cooldownMinutes: 30,
    });
  });

  it('enforces the merchant cooldown across different payment references', async () => {
    const executor = new SimulationRecoveryExecutor({
      outcomes: { payment_001: 'failed', payment_002: 'success' },
    });
    const service = new RecoveryService({ executor, clock: () => fixedNow });

    await service.submit(candidate(), { merchantApproval: 'approved' });
    const second = await service.submit(
      candidate({ candidateId: 'candidate_002', paymentId: 'payment_002' }),
      { merchantApproval: 'approved' },
    );

    expect(second.outcome.status).toBe('ABSTAINED');
    expect(second.outcome.reason).toBe('cooldown_active');
    expect(executor.createCalls).toBe(1);
  });
});
