import { describe, expect, it } from 'vitest';

import { buildFeatureDataset } from '../ml/features.js';
import { generateGeneralizationDataset } from './generator-v2.js';
import { inputWindowIndexes, splitDisjointSequences } from './splits.js';

describe('M4.5 purged temporal splits', () => {
  it('does not reuse input windows across temporal boundaries', () => {
    const dataset = generateGeneralizationDataset({ seed: 2026, merchants: 40, windows: 120 });
    const featureDataset = buildFeatureDataset(dataset);
    const splits = splitDisjointSequences(dataset, featureDataset, {
      excludeMerchantHoldoutFromTrain: true,
    });
    const inputs = (examples: typeof splits.train) =>
      new Set(
        examples.flatMap((example) =>
          inputWindowIndexes(example).map((windowIndex) => `${example.merchantId}:${windowIndex}`),
        ),
      );
    const trainInputs = inputs(splits.train);
    const validationInputs = inputs(splits.validation);
    const testInputs = inputs(splits.test);

    expect(
      splits.train.every((example) => !dataset.splits.merchantHoldout.includes(example.merchantId)),
    ).toBe(true);
    expect([...trainInputs].some((key) => validationInputs.has(key))).toBe(false);
    expect([...validationInputs].some((key) => testInputs.has(key))).toBe(false);
    expect(splits.train.at(-1)!.endWindow).toBeLessThan(
      dataset.splits.temporalWindows.validation.startWindow - featureDataset.sequenceLength + 1,
    );
    expect(splits.validation.at(-1)!.endWindow).toBeLessThan(
      dataset.splits.temporalWindows.test.startWindow - featureDataset.sequenceLength + 1,
    );
  }, 20_000);

  it('does not let future event changes alter past feature records', () => {
    const dataset = generateGeneralizationDataset({ seed: 2026, merchants: 40, windows: 120 });
    const startTime = new Date(dataset.metadata.startAt).getTime();
    const changedFuture = {
      ...dataset,
      events: dataset.events.map((event) => {
        const windowIndex = Math.floor(
          (new Date(event.timestamp).getTime() - startTime) /
            (dataset.metadata.windowMinutes * 60_000),
        );
        return windowIndex >= 80 ? { ...event, amount: event.amount + 999_999 } : event;
      }),
    };
    const originalFeatures = buildFeatureDataset(dataset);
    const changedFeatures = buildFeatureDataset(changedFuture);

    expect(changedFeatures.windowsByMerchant.get('v2_mrc_001')?.slice(0, 80)).toEqual(
      originalFeatures.windowsByMerchant.get('v2_mrc_001')?.slice(0, 80),
    );
  }, 20_000);
});
