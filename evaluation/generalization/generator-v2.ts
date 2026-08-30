import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type FailureCategory,
  type PaymentEvent,
  paymentEventSchema,
  type PaymentMethodSegment,
} from '../../packages/domain/src/index.js';
import {
  type BehaviorClass,
  type DegradationInterval,
  type GeneratedDataset,
  type ScenarioPhase,
  SEGMENTS,
  segmentKey,
  TARGET_SEGMENT,
} from '../generator/temporal-dataset.js';

export type GeneralizationMechanism = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J';

export type GeneralizationScenario = {
  merchantId: string;
  mechanism: GeneralizationMechanism;
  behaviorClass: BehaviorClass;
  targetDegraded: boolean;
  naturalRecovery: boolean;
};

export type ScenarioFamily = 'TRAIN' | 'VALIDATION' | 'SHIFTED_TEST' | 'STRESS_TEST';

export type GeneralizationDataset = Omit<GeneratedDataset, 'metadata' | 'truth'> & {
  metadata: GeneratedDataset['metadata'] & { schemaVersion: 'm4.5' };
  truth: Omit<GeneratedDataset['truth'], 'scenarios'> & {
    scenarios: GeneralizationScenario[];
    protocolVersion: 'm4.5-v2';
    mechanismFamilies: Record<GeneralizationMechanism, string>;
    scenarioFamilies: Record<ScenarioFamily, GeneralizationMechanism[]>;
  };
};

type Random = () => number;
type EpisodeWindow = { start: number; early: number; degraded: number; severe: number };

const MECHANISM_FAMILIES: Record<GeneralizationMechanism, string> = {
  A: 'gradual failure-rate increase',
  B: 'latency-first degradation followed by failures',
  C: 'volume plus failure-rate degradation',
  D: 'short early signal followed by sustained degradation',
  E: 'slow low-amplitude degradation',
  F: 'faster degradation',
  G: 'noisy degradation',
  H: 'temporary spike with natural recovery',
  I: 'cross-segment confounder while UPI Intent remains healthy',
  J: 'merchant-specific target baseline shift without true degradation',
};

function randomSource(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function normal(random: Random): number {
  const first = Math.max(random(), Number.EPSILON);
  const second = Math.max(random(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function poisson(random: Random, lambda: number): number {
  const threshold = Math.exp(-lambda);
  let product = 1;
  let count = 0;
  while (product > threshold) {
    count += 1;
    product *= Math.max(random(), Number.EPSILON);
  }
  return count - 1;
}

function token(random: Random, length = 14): string {
  let value = '';
  while (value.length < length) value += Math.floor(random() * 36).toString(36);
  return value.slice(0, length);
}

function unique(prefix: string, random: Random, used: Set<string>): string {
  let value = `${prefix}_${token(random)}`;
  while (used.has(value)) value = `${prefix}_${token(random)}`;
  used.add(value);
  return value;
}

function isoAt(startAt: string, windowIndex: number, windowMinutes: number, offset = 0): string {
  return new Date(
    new Date(startAt).getTime() + windowIndex * windowMinutes * 60_000 + offset,
  ).toISOString();
}

function phaseIntervals(
  merchantId: string,
  startAt: string,
  windowMinutes: number,
  episode: EpisodeWindow,
): DegradationInterval[] {
  const phases: Array<[Exclude<ScenarioPhase, 'normal'>, number]> = [
    ['early_signal', episode.early],
    ['degraded', episode.degraded],
    ['severe', episode.severe],
    ['recovery', 8],
  ];
  let cursor = episode.start;
  return phases.map(([phase, duration]) => {
    const interval: DegradationInterval = {
      merchantId,
      paymentMethodSegment: TARGET_SEGMENT,
      phase,
      startWindow: cursor,
      endWindowExclusive: cursor + duration,
      startTimestamp: isoAt(startAt, cursor, windowMinutes),
      endTimestamp: isoAt(startAt, cursor + duration, windowMinutes),
    };
    cursor += duration;
    return interval;
  });
}

function episodeFor(
  mechanism: GeneralizationMechanism,
  random: Random,
  start: number,
): EpisodeWindow {
  switch (mechanism) {
    case 'D':
      return { start, early: 2, degraded: 3, severe: 8 };
    case 'E':
      return { start, early: 10, degraded: 8, severe: 8 };
    case 'F':
      return { start, early: 2, degraded: 2, severe: 8 };
    case 'G':
      return { start, early: 6, degraded: 7, severe: 8 };
    case 'H':
      return { start, early: 3, degraded: 4, severe: 4 };
    case 'A':
    case 'B':
    case 'C':
    default:
      return {
        start,
        early: 5 + Math.floor(random() * 3),
        degraded: 5 + Math.floor(random() * 3),
        severe: 7 + Math.floor(random() * 3),
      };
  }
}

function adjustment(
  mechanism: GeneralizationMechanism,
  phase: ScenarioPhase,
  windowIndex: number,
  baselineShiftWindow: number,
): { failure: number; latency: number; volume: number; noise: number } {
  const phaseLevel = {
    normal: 0,
    early_signal: 1,
    degraded: 2,
    severe: 3,
    recovery: 1,
  }[phase];
  if (mechanism === 'I') {
    return { failure: 0, latency: 0, volume: 0, noise: 0.012 };
  }
  if (mechanism === 'J' && windowIndex >= baselineShiftWindow) {
    return { failure: 0.035, latency: 0.2, volume: 0, noise: 0.012 };
  }
  if (mechanism === 'B') {
    return {
      failure: [0, 0.005, 0.045, 0.12][phaseLevel]!,
      latency: [0, 0.38, 0.65, 0.75][phaseLevel]!,
      volume: [0, 0, -0.03, -0.08][phaseLevel]!,
      noise: 0.014,
    };
  }
  if (mechanism === 'C') {
    return {
      failure: [0, 0.035, 0.09, 0.18][phaseLevel]!,
      latency: [0, 0.08, 0.25, 0.55][phaseLevel]!,
      volume: [0, -0.25, -0.4, -0.5][phaseLevel]!,
      noise: 0.014,
    };
  }
  if (mechanism === 'E') {
    return {
      failure: [0, 0.012, 0.03, 0.055][phaseLevel]!,
      latency: [0, 0.08, 0.16, 0.27][phaseLevel]!,
      volume: [0, -0.01, -0.03, -0.05][phaseLevel]!,
      noise: 0.01,
    };
  }
  const noise = mechanism === 'G' ? 0.055 : 0.014;
  return {
    failure: [0, 0.025, 0.075, 0.16][phaseLevel]! * (mechanism === 'F' ? 1.15 : 1),
    latency: [0, 0.12, 0.32, 0.62][phaseLevel]!,
    volume: [0, -0.02, -0.08, -0.14][phaseLevel]!,
    noise,
  };
}

function failureCategory(random: Random): FailureCategory {
  const value = random();
  if (value < 0.35) return 'timeout';
  if (value < 0.6) return 'technical_error';
  if (value < 0.82) return 'issuer_declined';
  if (value < 0.94) return 'insufficient_funds';
  return 'unknown';
}

function segmentVolume(segment: PaymentMethodSegment): number {
  const volumes: Record<string, number> = {
    'upi.intent': 4.8,
    'upi.collect': 3.5,
    'card.domestic': 4.2,
    'card.international': 1.7,
    'netbanking.retail': 2.8,
    'wallet.standard': 2.1,
  };
  return volumes[segmentKey(segment)] ?? 1;
}

function trafficMultiplier(behaviorClass: BehaviorClass, random: Random): number {
  return behaviorClass === 'low_traffic'
    ? 0.35
    : behaviorClass === 'high_traffic'
      ? 2.1
      : 0.85 + random() * 0.65;
}

function eventFor(
  merchantId: string,
  segment: PaymentMethodSegment,
  mechanism: GeneralizationMechanism,
  phase: ScenarioPhase,
  windowIndex: number,
  baselineShiftWindow: number,
  startAt: string,
  windowMinutes: number,
  random: Random,
  usedIds: { event: Set<string>; payment: Set<string>; attempt: Set<string> },
): PaymentEvent {
  const baseFailure = 0.018 + random() * 0.025;
  const baseLatency = 850 + random() * 650;
  const phaseAdjustment = adjustment(mechanism, phase, windowIndex, baselineShiftWindow);
  const confounder =
    mechanism === 'I' && segmentKey(segment) === 'card.domestic'
      ? { failure: 0.1, latency: 0.35, volume: -0.1 }
      : { failure: 0, latency: 0, volume: 0 };
  const commonNoise = normal(random) * phaseAdjustment.noise;
  const failureRate = Math.min(
    0.55,
    Math.max(0.004, baseFailure + phaseAdjustment.failure + confounder.failure + commonNoise),
  );
  const latencyMs = Math.max(
    80,
    baseLatency *
      (1 + phaseAdjustment.latency + confounder.latency + commonNoise * 2 + normal(random) * 0.06),
  );
  const outcome = random();
  const failed = outcome < failureRate;
  const pending = !failed && outcome < failureRate + 0.018;
  const cancelled = !failed && !pending && outcome < failureRate + 0.027;
  const status: PaymentEvent['status'] = failed
    ? 'failed'
    : pending
      ? 'pending'
      : cancelled
        ? 'cancelled'
        : 'succeeded';
  const retryCount = random() < 0.14 ? 0 : random() < 0.82 ? 1 : random() < 0.96 ? 2 : 3;
  const amount = Math.max(
    20,
    Math.round(Math.exp(Math.log(500 + random() * 1500) + normal(random) * 0.7)),
  );
  const offset = Math.floor(random() * windowMinutes * 60_000);

  return paymentEventSchema.parse({
    eventId: unique('evt', random, usedIds.event),
    merchantId,
    paymentId: unique('pay', random, usedIds.payment),
    attemptId: unique('att', random, usedIds.attempt),
    timestamp: isoAt(startAt, windowIndex, windowMinutes, offset),
    paymentMethodSegment: segment,
    amount,
    currency: 'INR',
    status,
    ...(failed ? { failureCategory: failureCategory(random) } : {}),
    latencyMs: Math.round(latencyMs),
    retryCount,
  });
}

export function generateGeneralizationDataset(
  options: {
    seed?: number;
    merchants?: number;
    windows?: number;
    startAt?: string;
    windowMinutes?: number;
  } = {},
): GeneralizationDataset {
  const seed = options.seed ?? 2026;
  const merchantCount = options.merchants ?? 240;
  const windows = options.windows ?? 144;
  const windowMinutes = options.windowMinutes ?? 5;
  const startAt = options.startAt ?? '2026-08-02T00:00:00.000Z';
  if (!Number.isInteger(seed) || seed < 0) throw new Error('seed must be a non-negative integer');
  if (!Number.isInteger(merchantCount) || merchantCount < 40) {
    throw new Error('merchants must be an integer of at least 40');
  }
  if (!Number.isInteger(windows) || windows < 120) {
    throw new Error('windows must be an integer of at least 120');
  }
  const random = randomSource(seed);
  const merchantIds = Array.from(
    { length: merchantCount },
    (_, index) => `v2_mrc_${String(index + 1).padStart(3, '0')}`,
  );
  const holdoutStart = Math.floor(merchantCount * 0.8);
  const trainMechanisms: GeneralizationMechanism[] = ['A', 'B', 'C'];
  const shiftedMechanisms: GeneralizationMechanism[] = ['D', 'E', 'F', 'G', 'H', 'I', 'J'];
  const classes: BehaviorClass[] = ['stable', 'degraded', 'noisy', 'low_traffic', 'high_traffic'];
  const scenarios: GeneralizationScenario[] = [];
  const intervals: DegradationInterval[] = [];
  const intervalsByMerchant = new Map<string, DegradationInterval[]>();

  merchantIds.forEach((merchantId, index) => {
    const mechanism =
      index < holdoutStart
        ? trainMechanisms[index % trainMechanisms.length]!
        : shiftedMechanisms[(index - holdoutStart) % shiftedMechanisms.length]!;
    const targetDegraded = !['I', 'J'].includes(mechanism);
    const behaviorClass = classes[index % classes.length]!;
    scenarios.push({
      merchantId,
      mechanism,
      behaviorClass,
      targetDegraded,
      naturalRecovery: true,
    });
    if (!targetDegraded) return;
    const starts =
      index < holdoutStart
        ? [
            32 + Math.floor(random() * 8),
            72 + Math.floor(random() * 6),
            104 + Math.floor(random() * 8),
          ]
        : [104 + Math.floor(random() * 8)];
    const merchantIntervals = starts.flatMap((start) =>
      phaseIntervals(merchantId, startAt, windowMinutes, episodeFor(mechanism, random, start)),
    );
    intervals.push(...merchantIntervals);
    intervalsByMerchant.set(merchantId, merchantIntervals);
  });

  const usedIds = {
    event: new Set<string>(),
    payment: new Set<string>(),
    attempt: new Set<string>(),
  };
  const events: PaymentEvent[] = [];
  for (const scenario of scenarios) {
    const merchantIntervals = intervalsByMerchant.get(scenario.merchantId) ?? [];
    for (let windowIndex = 0; windowIndex < windows; windowIndex += 1) {
      const interval = merchantIntervals.find(
        (candidate) =>
          candidate.startWindow <= windowIndex && candidate.endWindowExclusive > windowIndex,
      );
      const phase = interval?.phase ?? 'normal';
      const baselineShiftWindow = 48;
      for (const segment of SEGMENTS) {
        const phaseAdjustment = adjustment(
          scenario.mechanism,
          phase,
          windowIndex,
          baselineShiftWindow,
        );
        const confounder =
          scenario.mechanism === 'I' && segmentKey(segment) === 'card.domestic'
            ? { volume: -0.1 }
            : { volume: 0 };
        const count = poisson(
          random,
          Math.max(
            0.2,
            segmentVolume(segment) *
              trafficMultiplier(scenario.behaviorClass, random) *
              Math.max(0.2, 1 + phaseAdjustment.volume + confounder.volume),
          ),
        );
        for (let eventIndex = 0; eventIndex < count; eventIndex += 1) {
          events.push(
            eventFor(
              scenario.merchantId,
              segment,
              scenario.mechanism,
              segmentKey(segment) === segmentKey(TARGET_SEGMENT) ? phase : 'normal',
              windowIndex,
              baselineShiftWindow,
              startAt,
              windowMinutes,
              random,
              usedIds,
            ),
          );
        }
      }
    }
  }
  events.sort(
    (first, second) =>
      first.timestamp.localeCompare(second.timestamp) ||
      first.eventId.localeCompare(second.eventId),
  );

  const dataset: GeneralizationDataset = {
    metadata: {
      schemaVersion: 'm4.5',
      seed,
      startAt,
      windowMinutes,
      windows,
      merchantIds,
      segmentKeys: SEGMENTS.map(segmentKey),
    },
    events,
    truth: {
      protocolVersion: 'm4.5-v2',
      targetSpec: {
        targetSegment: TARGET_SEGMENT,
        windowMinutes,
        observationWindowMinutes: 20,
        predictionHorizonMinutes: 30,
        sustainedDegradationMinutes: 15,
        leadTimeTargetMinutes: 10,
        degradationDefinition:
          'A true episode begins at the first degraded window and is useful only through 30 minutes after onset.',
      },
      degradationIntervals: intervals,
      scenarios,
      mechanismFamilies: MECHANISM_FAMILIES,
      scenarioFamilies: {
        TRAIN: ['A', 'B', 'C'],
        VALIDATION: ['A', 'B', 'C'],
        SHIFTED_TEST: ['D', 'E', 'F'],
        STRESS_TEST: ['G', 'H', 'I', 'J'],
      },
    },
    splits: {
      temporalWindows: {
        train: { startWindow: 0, endWindowExclusive: Math.floor(windows * 0.6) },
        validation: {
          startWindow: Math.floor(windows * 0.6),
          endWindowExclusive: Math.floor(windows * 0.8),
        },
        test: { startWindow: Math.floor(windows * 0.8), endWindowExclusive: windows },
      },
      merchantHoldout: merchantIds.slice(holdoutStart),
    },
  };
  return dataset;
}

export function writeGeneralizationDataset(
  dataset: GeneralizationDataset,
  outputDirectory: string,
): void {
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    join(outputDirectory, 'events.jsonl'),
    `${dataset.events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
  writeFileSync(
    join(outputDirectory, 'truth.json'),
    `${JSON.stringify(dataset.truth, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(outputDirectory, 'splits.json'),
    `${JSON.stringify({ metadata: dataset.metadata, ...dataset.splits }, null, 2)}\n`,
    'utf8',
  );
}

export function readGeneralizationDataset(inputDirectory: string): GeneralizationDataset {
  const events = readFileSync(join(inputDirectory, 'events.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => paymentEventSchema.parse(JSON.parse(line)));
  const truth = JSON.parse(
    readFileSync(join(inputDirectory, 'truth.json'), 'utf8'),
  ) as GeneralizationDataset['truth'];
  const splitFile = JSON.parse(readFileSync(join(inputDirectory, 'splits.json'), 'utf8')) as {
    metadata: GeneralizationDataset['metadata'];
    temporalWindows: GeneralizationDataset['splits']['temporalWindows'];
    merchantHoldout: string[];
  };
  return {
    metadata: splitFile.metadata,
    events,
    truth,
    splits: {
      temporalWindows: splitFile.temporalWindows,
      merchantHoldout: splitFile.merchantHoldout,
    },
  };
}
