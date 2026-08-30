import type { GeneratedDataset } from '../generator/temporal-dataset.js';
import type { FeatureDataset, SequenceExample } from '../ml/features.js';

export type GeneralizationSplits = {
  train: SequenceExample[];
  validation: SequenceExample[];
  test: SequenceExample[];
  merchantHoldout: SequenceExample[];
};

/**
 * Purge sequence boundaries so no raw input window is reused across periods.
 * The original M4 splitter remains unchanged for v1 reproducibility.
 */
export function splitDisjointSequences(
  dataset: GeneratedDataset,
  featureDataset: FeatureDataset,
  options: { excludeMerchantHoldoutFromTrain?: boolean } = {},
): GeneralizationSplits {
  const { validation, test } = dataset.splits.temporalWindows;
  const holdout = new Set(dataset.splits.merchantHoldout);
  const sequenceLength = featureDataset.sequenceLength;
  const trainEndExclusive = validation.startWindow - sequenceLength + 1;
  const validationEndExclusive = test.startWindow - sequenceLength + 1;
  const result: GeneralizationSplits = {
    train: [],
    validation: [],
    test: [],
    merchantHoldout: [],
  };
  for (const example of featureDataset.sequences) {
    if (
      example.endWindow >= sequenceLength - 1 &&
      example.endWindow < trainEndExclusive &&
      (!options.excludeMerchantHoldoutFromTrain || !holdout.has(example.merchantId))
    ) {
      result.train.push(example);
    } else if (
      example.endWindow >= validation.startWindow &&
      example.endWindow < validationEndExclusive
    ) {
      result.validation.push(example);
    } else if (
      example.endWindow >= test.startWindow &&
      example.endWindow < test.endWindowExclusive
    ) {
      result.test.push(example);
    }
    if (holdout.has(example.merchantId)) result.merchantHoldout.push(example);
  }
  return result;
}

export function inputWindowIndexes(example: SequenceExample): number[] {
  return Array.from(
    { length: example.values.length },
    (_, index) => example.endWindow - example.values.length + index + 1,
  );
}
