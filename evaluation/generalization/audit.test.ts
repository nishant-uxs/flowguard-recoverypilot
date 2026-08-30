import { describe, expect, it } from 'vitest';

import { auditGeneralizationDataset } from './audit.js';
import { generateGeneralizationDataset } from './generator-v2.js';

describe('M4.5 adversarial dataset audit', () => {
  it('does not find identifier, split, duplicate, or suspicious single-feature leakage', () => {
    const audit = auditGeneralizationDataset(
      generateGeneralizationDataset({ seed: 99, merchants: 40, windows: 120 }),
    );

    expect(audit.duplicateEventIds).toBe(0);
    expect(audit.duplicatePaymentIds).toBe(0);
    expect(audit.merchantIdContainsMechanism).toBe(false);
    expect(audit.eventIdContainsMechanism).toBe(false);
    expect(audit.merchantOverlapBetweenTrainAndHoldout).toEqual([]);
    expect(audit.suspiciousSingleFeatureProbe).toBe(false);
    expect(audit.criticalLeakageDetected).toBe(false);
  }, 20_000);
});
