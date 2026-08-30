import { describe, expect, it } from 'vitest';

import {
  CURRENT_M5_SIMULATOR_AUDIT,
  generateRecoveryOpportunityBatch,
  MODEL_FEATURE_FIELDS,
  predictRecoveryProbability,
  rankRecoveryOpportunities,
  runOpportunityStrategy,
  scoreRecoveryOpportunity,
} from './opportunity.js';

describe('M6 recovery opportunity environment', () => {
  it('records why the M5 simulator could not evaluate opportunity ranking', () => {
    expect(CURRENT_M5_SIMULATOR_AUDIT.recoveryProbabilityVariesWithModelScenario).toBe(false);
    expect(CURRENT_M5_SIMULATOR_AUDIT.recoveryProbabilityVariesWithAmount).toBe(false);
    expect(CURRENT_M5_SIMULATOR_AUDIT.recoveryProbabilityVariesWithTiming).toBe(false);
    expect(CURRENT_M5_SIMULATOR_AUDIT.architecturalChange).toContain('hidden counterfactual');
  });

  it('generates deterministic hidden counterfactual outcomes with observable proxies', () => {
    const first = generateRecoveryOpportunityBatch(7, 100);
    const second = generateRecoveryOpportunityBatch(7, 100);

    expect(first).toEqual(second);
    expect(first).toHaveLength(100);
    expect(first.some((item) => item.hiddenOutcome.wouldRecoverIfIntervened)).toBe(true);
    expect(first.some((item) => !item.hiddenOutcome.wouldRecoverIfIntervened)).toBe(true);
    expect(Object.keys(first[0]!.observation).some((key) => key.includes('hidden'))).toBe(false);
    expect(Object.keys(first[0]!.observation).some((key) => key.includes('latent'))).toBe(false);
    expect(MODEL_FEATURE_FIELDS).not.toContain('merchantId');
    expect(MODEL_FEATURE_FIELDS).not.toContain('paymentId');
    expect(MODEL_FEATURE_FIELDS).not.toContain('merchantApproval');
  });

  it('changes propensity with timing and observable context without reading the outcome', () => {
    const base = generateRecoveryOpportunityBatch(8, 100)[0]!.observation;
    const early = { ...base, minutesSinceDetection: 0 };
    const late = { ...base, minutesSinceDetection: 40 };
    const lowerLatency = { ...base, latencyMs: 500 };
    const higherLatency = { ...base, latencyMs: 4_000 };

    expect(predictRecoveryProbability(early)).toBeGreaterThan(predictRecoveryProbability(late));
    expect(predictRecoveryProbability(lowerLatency)).toBeGreaterThan(
      predictRecoveryProbability(higherLatency),
    );
    expect(scoreRecoveryOpportunity(early).expectedRecoveryValuePaise).not.toBe(
      scoreRecoveryOpportunity(late).expectedRecoveryValuePaise,
    );
  });

  it('ranks by expected recovery value rather than probability alone', () => {
    const cases = generateRecoveryOpportunityBatch(11, 100);
    const ranked = rankRecoveryOpportunities(cases.map((item) => item.observation));

    expect(ranked.map((item) => item.rank)).toEqual(
      Array.from({ length: ranked.length }, (_, index) => index + 1),
    );
    expect(ranked[0]!.expectedRecoveryValuePaise).toBeGreaterThanOrEqual(
      ranked[ranked.length - 1]!.expectedRecoveryValuePaise,
    );
    expect(ranked.every((item) => item.observation.merchantApproval !== undefined)).toBe(true);
  });

  it('enforces an intervention budget while retaining policy abstention', async () => {
    const cases = generateRecoveryOpportunityBatch(12, 100);
    const flowguard = await runOpportunityStrategy(cases, 10, 'flowguard');
    const baseline = await runOpportunityStrategy(cases, 10, 'baseline');

    expect(flowguard.selectedCandidates).toBe(10);
    expect(baseline.selectedCandidates).toBe(10);
    expect(flowguard.interventionsAttempted).toBeLessThanOrEqual(10);
    expect(baseline.interventionsAttempted).toBeLessThanOrEqual(10);
    expect(flowguard.recoveredSimulatedValuePaise).toBeGreaterThanOrEqual(0);
    expect(flowguard.abstentions).toBeGreaterThanOrEqual(0);
  });
});
