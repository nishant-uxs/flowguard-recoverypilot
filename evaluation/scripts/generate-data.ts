import { resolve } from 'node:path';

import { generateDataset, writeDataset } from '../generator/temporal-dataset.js';

function numericArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} requires a number`);
  return value;
}

const dataset = generateDataset({
  seed: numericArgument('--seed', 42),
  merchants: numericArgument('--merchants', 120),
  windows: numericArgument('--windows', 72),
});
const outputDirectory = resolve(process.cwd(), 'evaluation/datasets/generated');

writeDataset(dataset, outputDirectory);

console.log(
  `Generated ${dataset.events.length} events for ${dataset.metadata.merchantIds.length} merchants.`,
);
console.log(`Seed: ${dataset.metadata.seed}`);
console.log(`Output: ${outputDirectory}`);
