import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';

describe('M8 deterministic demo API', () => {
  it('serves the default approval-ready simulation state', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/demo/state' });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.mode).toBe('SIMULATION');
    expect(body.state).toBeUndefined();
    expect(body.current.state).toBe('AWAITING_MERCHANT_APPROVAL');
    expect(body.approvalPayload.actionType).toBe('PAYMENT_LINK');
    expect(body.systemStatus.llm).toContain('FALLBACK');
    expect(body.batch.syntheticEvaluation.label).toContain('SYNTHETIC');
    expect(body.current.modelSignal).toMatchObject({
      modelType: 'Interpretable logistic opportunity scorer',
      estimatedProbability: 0.8,
      provenance: 'DEMO / SIMULATION · seeded model output',
    });

    await app.close();
  });

  it('completes approval, execution and verified recovery through the API', async () => {
    const app = buildApp();
    const initial = await app.inject({ method: 'GET', url: '/demo/state' });
    const correlationId = initial.json().correlationId as string;

    const response = await app.inject({
      method: 'POST',
      url: `/recovery/${correlationId}/approve`,
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.current.state).toBe('RECOVERED');
    expect(body.outcome.status).toBe('RECOVERED');
    expect(body.outcome.verification).toBe('simulation');
    expect(body.audit.map((event: { eventType: string }) => event.eventType)).toContain(
      'RECOVERY_VERIFIED',
    );

    await app.close();
  });

  it('returns a client error for an invalid scenario payload', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/demo/scenario',
      payload: { scenario: 'execute_payment' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid demo scenario');

    await app.close();
  });

  it('resets deterministic failure scenarios and records safe stops', async () => {
    const app = buildApp();
    const scenarios = [
      ['policy_rejection', 'REJECTED'],
      ['abstention', 'ABSTAINED'],
      ['expired_action', 'EXPIRED'],
      ['verification_failure', 'FAILED'],
    ] as const;

    for (const [scenario, expectedState] of scenarios) {
      const response = await app.inject({
        method: 'POST',
        url: '/demo/scenario',
        payload: { scenario },
      });
      expect(response.statusCode).toBe(200);
      if (expectedState === 'EXPIRED' || expectedState === 'FAILED') {
        const correlationId = response.json().correlationId as string;
        const approval = await app.inject({
          method: 'POST',
          url: `/recovery/${correlationId}/approve`,
        });
        expect(approval.json().current.state).toBe(expectedState);
      } else {
        expect(response.json().current.state).toBe(expectedState);
      }
    }

    await app.close();
  });

  it('shows duplicate prevention without a second executor action', async () => {
    const app = buildApp();
    const reset = await app.inject({
      method: 'POST',
      url: '/demo/scenario',
      payload: { scenario: 'duplicate_prevention' },
    });
    const correlationId = reset.json().correlationId as string;
    const response = await app.inject({
      method: 'POST',
      url: `/recovery/${correlationId}/approve`,
    });

    expect(response.json().batch.runtime.duplicateActionsPrevented).toBe(1);
    expect(response.json().audit.map((event: { eventType: string }) => event.eventType)).toContain(
      'IDEMPOTENCY_REPLAY',
    );

    await app.close();
  });
});
