import { describe, expect, it } from 'vitest';

import { buildRecoveryBatchCases, evaluateRecoveryBatch } from './batch.js';

describe('M5 deterministic recovery batch', () => {
  it('contains the required mixed scenarios and more than 100 cases', () => {
    const cases = buildRecoveryBatchCases();
    const scenarios = new Set(cases.map((item) => item.simulationScenario));

    expect(cases).toHaveLength(120);
    expect(scenarios).toEqual(
      new Set(['success', 'failed', 'expired', 'already_recovered', 'verification_timeout']),
    );
    expect(cases.filter((item) => item.merchantApproval === 'rejected')).not.toHaveLength(0);
    expect(cases.filter((item) => item.merchantApproval === 'unavailable')).not.toHaveLength(0);
    expect(cases.filter((item) => !item.recoveryOpportunity)).not.toHaveLength(0);
  });

  it('compares the same batch fairly and prevents duplicates', async () => {
    const result = await evaluateRecoveryBatch();

    expect(result.baseline.label).toBe('SIMULATED');
    expect(result.flowguard.label).toBe('SIMULATED');
    expect(result.baseline.totalCandidates).toBe(result.flowguard.totalCandidates);
    expect(result.flowguard.interventionsAttempted).toBeLessThan(
      result.baseline.interventionsAttempted,
    );
    expect(result.flowguard.successfulRecoveries).toBe(result.baseline.successfulRecoveries);
    expect(result.flowguard.recoveredSimulatedValuePaise).toBe(
      result.baseline.recoveredSimulatedValuePaise,
    );
    expect(result.incrementalRecoveredSimulatedValuePaise).toBe(0);
    expect(result.flowguard.falseInterventions).toBe(0);
    expect(result.baseline.falseInterventions).toBe(15);
    expect(result.flowguard.duplicateActionsPrevented).toBe(15);
    expect(result.baseline.duplicateActionsPrevented).toBe(0);
    expect(result.flowguard.abstentions).toBe(20);
    expect(result.flowguard.expiredActions).toBe(10);
    expect(result.flowguard.pendingVerifications).toBe(10);
    expect(result.auditEvents).toBe(750);
    expect(result.flowguardAuditEventTypes).toMatchObject({
      candidate_received: 105,
      action_started: 80,
      intervention_created: 70,
      verification_recorded: 60,
      duplicate_prevented: 15,
    });
  });

  it('is reproducible byte-for-byte at the batch result level', async () => {
    const first = await evaluateRecoveryBatch();
    const second = await evaluateRecoveryBatch();

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
