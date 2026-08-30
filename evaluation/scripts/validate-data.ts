import { resolve } from 'node:path';

import { buildSanityReport, formatTimeline, validateDataset } from '../generator/sanity.js';
import { readDataset } from '../generator/temporal-dataset.js';

const inputDirectory = resolve(process.cwd(), 'evaluation/datasets/generated');
const dataset = readDataset(inputDirectory);
const report = buildSanityReport(dataset);
const issues = validateDataset(dataset);

console.log(JSON.stringify(report, null, 2));

const firstDegradedMerchant = dataset.truth.scenarios.find((scenario) => scenario.targetDegraded);
const requestedMerchantIndex = process.argv.indexOf('--merchant');
const requestedMerchant =
  requestedMerchantIndex === -1
    ? firstDegradedMerchant?.merchantId
    : process.argv[requestedMerchantIndex + 1];

if (requestedMerchant) {
  console.log(formatTimeline(dataset, requestedMerchant));
}

if (issues.length > 0) {
  console.error(`Dataset validation failed with ${issues.length} issue(s):`);
  issues.forEach((issue) => console.error(`- ${issue}`));
  process.exitCode = 1;
} else {
  console.log('Dataset validation passed.');
}
