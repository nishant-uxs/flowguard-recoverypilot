import { resolve } from 'node:path';

import {
  generateGeneralizationDataset,
  writeGeneralizationDataset,
} from '../generalization/generator-v2.js';

function numberArgument(argumentsMap: Map<string, string>, name: string, fallback: number): number {
  const value = argumentsMap.get(name);
  return value === undefined ? fallback : Number(value);
}

const argumentsMap = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index]!;
  if (!argument.startsWith('--')) continue;
  const [name, value] = argument.slice(2).split('=');
  if (name !== undefined && value !== undefined) argumentsMap.set(name, value);
}

const dataset = generateGeneralizationDataset({
  seed: numberArgument(argumentsMap, 'seed', 2026),
  merchants: numberArgument(argumentsMap, 'merchants', 240),
  windows: numberArgument(argumentsMap, 'windows', 144),
});
const outputDirectory = resolve(process.cwd(), 'evaluation/datasets/generalization-v2');
writeGeneralizationDataset(dataset, outputDirectory);
console.log(`Generated ${dataset.events.length} independent v2 events.`);
console.log(`Merchants: ${dataset.metadata.merchantIds.length}`);
console.log(`Output: ${outputDirectory}`);
