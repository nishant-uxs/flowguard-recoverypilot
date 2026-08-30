// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import type { DemoState } from './api';

function state(overrides: Partial<DemoState> = {}): DemoState {
  return {
    mode: 'SIMULATION',
    scenario: 'successful_recovery',
    scenarioLabel: 'Successful Recovery',
    correlationId: 'demo_successful_recovery',
    systemStatus: {
      detector: 'ONLINE',
      policy: 'ENFORCED',
      executor: 'SIMULATION',
      verification: 'READY',
      llm: 'FALLBACK · NO PROVIDER',
    },
    current: {
      merchantReference: 'demo_merchant_acme',
      paymentReference: 'demo_payment_successful_recovery',
      segment: 'UPI_INTENT',
      severity: 'HIGH',
      riskScore: 0.9,
      expectedRecoveryValuePaise: 14_550,
      amountPaise: 18_500,
      action: 'Payment Link attempt',
      state: 'AWAITING_MERCHANT_APPROVAL',
      reasonCodes: ['failure_rate_above_baseline'],
      reason: 'sustained UPI Intent failure rate above baseline',
    },
    pipeline: [
      { key: 'DETECTED', label: 'Detected', status: 'complete' },
      { key: 'SCORED', label: 'Scored', status: 'complete' },
      { key: 'POLICY_APPROVED', label: 'Policy', status: 'complete' },
      { key: 'AWAITING_MERCHANT_APPROVAL', label: 'Approval', status: 'active' },
      { key: 'APPROVED', label: 'Approved', status: 'pending' },
      { key: 'EXECUTING', label: 'Action', status: 'pending' },
      { key: 'PENDING_VERIFICATION', label: 'Verification', status: 'pending' },
      { key: 'RECOVERED', label: 'Recovered', status: 'pending' },
    ],
    approvalPayload: {
      merchantReference: 'demo_merchant_acme',
      paymentReference: 'demo_payment_successful_recovery',
      candidateId: 'demo_candidate_successful_recovery',
      reasonCodes: ['failure_rate_above_baseline'],
      riskScore: 0.9,
      expectedRecoveryValuePaise: 14_550,
      amountPaise: 18_500,
      actionType: 'PAYMENT_LINK',
      expiresAt: '2026-08-30T21:11:02.000Z',
      policyChecks: [
        { check: 'minimum_risk_score', passed: true },
        { check: 'minimum_expected_recovery_value', passed: true },
        { check: 'maximum_amount', passed: true },
        { check: 'maximum_attempts', passed: true },
        { check: 'action_expiry', passed: true },
        { check: 'duplicate_prevention', passed: true },
        { check: 'already_paid_check', passed: true },
        { check: 'verification_required', passed: true },
      ],
      explanation: {
        summary: 'A bounded opportunity is available.',
        reasonCodes: ['failure_rate_above_baseline'],
        merchantExplanation: 'Failure signals are above the merchant baseline.',
      },
    },
    explanation: {
      output: {
        summary: 'A bounded opportunity is available.',
        reasonCodes: ['failure_rate_above_baseline'],
        merchantExplanation: 'Failure signals are above the merchant baseline.',
      },
      source: 'deterministic_fallback',
    },
    outcome: null,
    batch: {
      label: 'DEMO / SIMULATION',
      runtime: {
        candidates: 1,
        interventions: 0,
        recoveries: 0,
        abstentions: 0,
        policyRejections: 0,
        recoveredValuePaise: 0,
        duplicateActionsPrevented: 0,
        interventionRate: 0,
        recoverySuccessRate: 0,
        falseInterventionsAvoided: 1,
      },
      syntheticEvaluation: {
        label: 'SYNTHETIC EVALUATION · M6',
        budgetCurve: [{ budget: 10, flowGuardPaise: 42_047.35, baselinePaise: 15_776.85 }],
        note: 'Synthetic values only.',
      },
    },
    audit: [
      {
        sequence: 1,
        timestamp: '2026-08-30T20:41:02.000Z',
        eventType: 'DETECTION_CREATED',
        state: 'DETECTED',
        actionId: null,
        data: {},
      },
    ],
    technical: { policyVersion: 'm7-policy-v1' },
    ...overrides,
  };
}

function response(body: DemoState) {
  return { ok: true, json: async () => body } as Response;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('M8 control tower', () => {
  it('renders the opportunity and approval controls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(state())));

    render(<App />);

    expect(await screen.findByText('Expected recovery opportunity')).toBeInTheDocument();
    expect(screen.getByText('SIMULATION / DEMO MODE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve recovery/i })).toBeEnabled();
    expect(
      screen.getByText(/Approval is required before the financial\/test action/),
    ).toBeInTheDocument();
  });

  it('posts approval and displays verified recovery outcome', async () => {
    const recovered = state({
      current: { ...state().current, state: 'RECOVERED' },
      outcome: {
        status: 'RECOVERED',
        recoveredAmountPaise: 18_500,
        verification: 'simulation',
        reason: 'simulated payment was verified as captured',
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(state()))
      .mockResolvedValueOnce(response(recovered));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /approve recovery/i }));

    await waitFor(() => expect(screen.getByText(/verified by simulation/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining('/recovery/demo_successful_recovery/approve'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.getByText(/verified by simulation/i)).toBeInTheDocument();
  });

  it('resets a scenario and handles API failure without a blank screen', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(state()))
      .mockResolvedValueOnce(
        response(state({ scenario: 'abstention', scenarioLabel: 'Abstention' })),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Abstention' }));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Abstention' })).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining('/demo/scenario'),
      expect.objectContaining({ method: 'POST' }),
    );

    cleanup();
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Demo API unavailable');
    expect(screen.getByRole('button', { name: /retry connection/i })).toBeInTheDocument();
  });
});
