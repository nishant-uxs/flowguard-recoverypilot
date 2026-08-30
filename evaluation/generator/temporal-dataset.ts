import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type PaymentEvent,
  type PaymentMethodSegment,
  paymentEventSchema,
} from '../../packages/domain/src/index.js';

export const TARGET_SEGMENT: PaymentMethodSegment = {
  paymentMethod: 'upi',
  segment: 'intent',
};

export const SEGMENTS: PaymentMethodSegment[] = [
  TARGET_SEGMENT,
  { paymentMethod: 'upi', segment: 'collect' },
  { paymentMethod: 'card', segment: 'domestic' },
  { paymentMethod: 'card', segment: 'international' },
  { paymentMethod: 'netbanking', segment: 'retail' },
  { paymentMethod: 'wallet', segment: 'standard' },
];

export const SCENARIO_PHASES = [
  'normal',
  'early_signal',
  'degraded',
  'severe',
  'recovery',
] as const;

export type ScenarioPhase = (typeof SCENARIO_PHASES)[number];
export type BehaviorClass = 'stable' | 'degraded' | 'noisy' | 'low_traffic' | 'high_traffic';
export type SegmentKey = `${PaymentMethodSegment['paymentMethod']}.${string}`;

export type GeneratorOptions = {
  seed?: number;
  merchants?: number;
  windows?: number;
  windowMinutes?: number;
  startAt?: string;
};

export type DegradationInterval = {
  merchantId: string;
  paymentMethodSegment: PaymentMethodSegment;
  phase: Exclude<ScenarioPhase, 'normal'>;
  startWindow: number;
  endWindowExclusive: number;
  startTimestamp: string;
  endTimestamp: string;
};

export type ScenarioMetadata = {
  merchantId: string;
  behaviorClass: BehaviorClass;
  targetDegraded: boolean;
  naturalRecovery: boolean;
};

export type TargetSpec = {
  targetSegment: PaymentMethodSegment;
  windowMinutes: number;
  observationWindowMinutes: number;
  predictionHorizonMinutes: number;
  sustainedDegradationMinutes: number;
  leadTimeTargetMinutes: number;
  degradationDefinition: string;
};

export type DatasetTruth = {
  targetSpec: TargetSpec;
  degradationIntervals: DegradationInterval[];
  scenarios: ScenarioMetadata[];
};

export type DatasetSplits = {
  temporalWindows: {
    train: { startWindow: number; endWindowExclusive: number };
    validation: { startWindow: number; endWindowExclusive: number };
    test: { startWindow: number; endWindowExclusive: number };
  };
  merchantHoldout: string[];
};

export type GeneratedDataset = {
  metadata: {
    schemaVersion: 'm2' | 'm4.5';
    seed: number;
    startAt: string;
    windowMinutes: number;
    windows: number;
    merchantIds: string[];
    segmentKeys: string[];
  };
  events: PaymentEvent[];
  truth: DatasetTruth;
  splits: DatasetSplits;
};

type MerchantProfile = {
  merchantId: string;
  behaviorClass: BehaviorClass;
  trafficMultiplier: number;
  failureNoise: number;
  baseFailureRate: number;
  baseLatencyMs: number;
  amountMean: number;
  amountSpread: number;
  degradationStartWindow?: number;
  earlyDuration?: number;
  degradedDuration?: number;
  severeDuration?: number;
  naturalRecovery: boolean;
};

type SegmentProfile = {
  volumeRate: number;
  failureRate: number;
  latencyMs: number;
  amountMean: number;
  amountSpread: number;
};

type Random = () => number;

export function segmentKey(segment: PaymentMethodSegment): SegmentKey {
  return `${segment.paymentMethod}.${segment.segment}` as SegmentKey;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function createRandom(seed: number): Random {
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
  if (lambda >= 30) {
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal(random)));
  }

  const threshold = Math.exp(-lambda);
  let product = 1;
  let count = 0;
  while (product > threshold) {
    count += 1;
    product *= Math.max(random(), Number.EPSILON);
  }
  return count - 1;
}

function shuffle<T>(random: Random, values: T[]): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

function randomToken(random: Random, length = 12): string {
  let token = '';
  while (token.length < length) {
    token += Math.floor(random() * 36).toString(36);
  }
  return token.slice(0, length);
}

function uniqueId(prefix: string, random: Random, used: Set<string>): string {
  let id = `${prefix}_${randomToken(random)}`;
  while (used.has(id)) {
    id = `${prefix}_${randomToken(random)}`;
  }
  used.add(id);
  return id;
}

function isoAt(start: Date, windowIndex: number, windowMinutes: number, offsetMs = 0): string {
  return new Date(start.getTime() + windowIndex * windowMinutes * 60_000 + offsetMs).toISOString();
}

function profileForClass(
  merchantId: string,
  behaviorClass: BehaviorClass,
  random: Random,
  windows: number,
): MerchantProfile {
  const trafficMultiplier =
    behaviorClass === 'low_traffic'
      ? 0.35 + random() * 0.2
      : behaviorClass === 'high_traffic'
        ? 2.2 + random() * 0.8
        : 0.8 + random() * 0.65;
  const baseFailureRate = clamp(0.018 + random() * 0.035, 0.012, 0.065);
  const profile: MerchantProfile = {
    merchantId,
    behaviorClass,
    trafficMultiplier,
    failureNoise: behaviorClass === 'noisy' ? 0.035 : 0.012 + random() * 0.008,
    baseFailureRate,
    baseLatencyMs: 850 + random() * 650,
    amountMean: 350 + random() * 1_400,
    amountSpread: 0.45 + random() * 0.25,
    naturalRecovery: random() < 0.72,
  };

  if (behaviorClass === 'degraded') {
    const startWindow = 14 + Math.floor(random() * 10);
    profile.degradationStartWindow = startWindow;
    profile.earlyDuration = 8 + Math.floor(random() * 5);
    profile.degradedDuration = 13 + Math.floor(random() * 7);
    profile.severeDuration = 7 + Math.floor(random() * 5);
    if (
      startWindow + profile.earlyDuration + profile.degradedDuration + profile.severeDuration >
      windows
    ) {
      profile.severeDuration = Math.max(
        4,
        windows - startWindow - profile.earlyDuration - profile.degradedDuration,
      );
    }
  }

  return profile;
}

function profilesForMerchant(
  merchant: MerchantProfile,
  random: Random,
): Map<SegmentKey, SegmentProfile> {
  const profiles = new Map<SegmentKey, SegmentProfile>();
  const segmentVolume = [3.2, 2.2, 2.8, 0.9, 1.8, 1.2];

  SEGMENTS.forEach((segment, index) => {
    profiles.set(segmentKey(segment), {
      volumeRate: segmentVolume[index]! * merchant.trafficMultiplier * (0.85 + random() * 0.3),
      failureRate: clamp(merchant.baseFailureRate + (random() - 0.5) * 0.018, 0.008, 0.11),
      latencyMs: merchant.baseLatencyMs * (0.85 + random() * 0.35),
      amountMean: merchant.amountMean * (0.65 + random() * 0.85),
      amountSpread: merchant.amountSpread + (random() - 0.5) * 0.08,
    });
  });

  return profiles;
}

function phaseAt(profile: MerchantProfile, windowIndex: number): ScenarioPhase {
  if (
    profile.behaviorClass !== 'degraded' ||
    profile.degradationStartWindow === undefined ||
    profile.earlyDuration === undefined ||
    profile.degradedDuration === undefined ||
    profile.severeDuration === undefined
  ) {
    return 'normal';
  }

  const relativeWindow = windowIndex - profile.degradationStartWindow;
  if (relativeWindow < 0) return 'normal';
  if (relativeWindow < profile.earlyDuration) return 'early_signal';
  if (relativeWindow < profile.earlyDuration + profile.degradedDuration) return 'degraded';
  if (relativeWindow < profile.earlyDuration + profile.degradedDuration + profile.severeDuration) {
    return 'severe';
  }
  return profile.naturalRecovery ? 'recovery' : 'severe';
}

function phaseAdjustment(phase: ScenarioPhase): {
  failure: number;
  latency: number;
  volume: number;
} {
  switch (phase) {
    case 'early_signal':
      return { failure: 0.022, latency: 0.12, volume: -0.02 };
    case 'degraded':
      return { failure: 0.065, latency: 0.32, volume: -0.05 };
    case 'severe':
      return { failure: 0.14, latency: 0.62, volume: -0.12 };
    case 'recovery':
      return { failure: 0.035, latency: 0.16, volume: -0.01 };
    default:
      return { failure: 0, latency: 0, volume: 0 };
  }
}

function failureCategory(random: Random, phase: ScenarioPhase): PaymentEvent['failureCategory'] {
  const timeoutWeight = phase === 'severe' ? 0.42 : phase === 'degraded' ? 0.3 : 0.18;
  const technicalWeight = phase === 'severe' ? 0.28 : phase === 'degraded' ? 0.2 : 0.14;
  const draw = random();

  if (draw < timeoutWeight) return 'timeout';
  if (draw < timeoutWeight + technicalWeight) return 'technical_error';
  if (draw < timeoutWeight + technicalWeight + 0.28) return 'issuer_declined';
  if (draw < timeoutWeight + technicalWeight + 0.43) return 'insufficient_funds';
  if (draw < timeoutWeight + technicalWeight + 0.51) return 'invalid_request';
  return 'unknown';
}

function eventFor(
  merchant: MerchantProfile,
  segment: PaymentMethodSegment,
  segmentProfile: SegmentProfile,
  phase: ScenarioPhase,
  windowIndex: number,
  windowMinutes: number,
  start: Date,
  random: Random,
  usedEventIds: Set<string>,
  usedPaymentIds: Set<string>,
  usedAttemptIds: Set<string>,
): PaymentEvent {
  const adjustment = phaseAdjustment(phase);
  const commonShock = normal(random) * merchant.failureNoise;
  const failureRate = clamp(
    segmentProfile.failureRate + adjustment.failure + commonShock,
    0.004,
    0.46,
  );
  const latency = Math.max(
    80,
    segmentProfile.latencyMs * (1 + adjustment.latency + commonShock * 2.5 + normal(random) * 0.08),
  );
  const amount = Math.max(
    0,
    Math.round(
      Math.exp(
        Math.log(segmentProfile.amountMean) -
          segmentProfile.amountSpread ** 2 / 2 +
          normal(random) * segmentProfile.amountSpread,
      ),
    ),
  );
  const outcome = random();
  const isFailure = outcome < failureRate;
  const isPending = !isFailure && outcome < failureRate + 0.018;
  const isCancelled = !isFailure && !isPending && outcome < failureRate + 0.027;
  const status: PaymentEvent['status'] = isFailure
    ? 'failed'
    : isPending
      ? 'pending'
      : isCancelled
        ? 'cancelled'
        : 'succeeded';
  const retryRoll = random();
  const retryCount = retryRoll < 0.1 ? 0 : retryRoll < 0.83 ? 1 : retryRoll < 0.97 ? 2 : 3;
  const offsetMs = Math.floor(random() * windowMinutes * 60_000);

  return paymentEventSchema.parse({
    eventId: uniqueId('evt', random, usedEventIds),
    merchantId: merchant.merchantId,
    paymentId: uniqueId('pay', random, usedPaymentIds),
    attemptId: uniqueId('att', random, usedAttemptIds),
    timestamp: isoAt(start, windowIndex, windowMinutes, offsetMs),
    paymentMethodSegment: segment,
    amount,
    currency: 'INR',
    status,
    ...(isFailure ? { failureCategory: failureCategory(random, phase) } : {}),
    latencyMs: Math.round(latency),
    retryCount,
  });
}

function intervalsFor(
  merchant: MerchantProfile,
  start: Date,
  windowMinutes: number,
  windows: number,
): DegradationInterval[] {
  if (
    merchant.behaviorClass !== 'degraded' ||
    merchant.degradationStartWindow === undefined ||
    merchant.earlyDuration === undefined ||
    merchant.degradedDuration === undefined ||
    merchant.severeDuration === undefined
  ) {
    return [];
  }

  const phases: Array<[Exclude<ScenarioPhase, 'normal'>, number]> = [
    ['early_signal', merchant.earlyDuration],
    ['degraded', merchant.degradedDuration],
    ['severe', merchant.naturalRecovery ? merchant.severeDuration : Number.POSITIVE_INFINITY],
  ];
  if (merchant.naturalRecovery) phases.push(['recovery', Number.POSITIVE_INFINITY]);

  let cursor = merchant.degradationStartWindow;
  return phases.map(([phase, duration]) => {
    const endWindowExclusive = Number.isFinite(duration) ? cursor + duration : windows;
    const interval = {
      merchantId: merchant.merchantId,
      paymentMethodSegment: TARGET_SEGMENT,
      phase,
      startWindow: cursor,
      endWindowExclusive,
      startTimestamp: isoAt(start, cursor, windowMinutes),
      endTimestamp: isoAt(start, endWindowExclusive, windowMinutes),
    };
    cursor = endWindowExclusive;
    return interval;
  });
}

function generateSplits(merchantIds: string[], windows: number): DatasetSplits {
  const trainEnd = Math.floor(windows * 0.6);
  const validationEnd = Math.floor(windows * 0.8);
  const holdoutStart = Math.floor(merchantIds.length * 0.85);

  return {
    temporalWindows: {
      train: { startWindow: 0, endWindowExclusive: trainEnd },
      validation: { startWindow: trainEnd, endWindowExclusive: validationEnd },
      test: { startWindow: validationEnd, endWindowExclusive: windows },
    },
    merchantHoldout: merchantIds.slice(holdoutStart),
  };
}

export function generateDataset(options: GeneratorOptions = {}): GeneratedDataset {
  const seed = options.seed ?? 42;
  const merchantCount = options.merchants ?? 120;
  const windows = options.windows ?? 72;
  const windowMinutes = options.windowMinutes ?? 5;
  const startAt = options.startAt ?? '2026-08-01T00:00:00.000Z';
  const start = new Date(startAt);

  if (!Number.isInteger(seed) || seed < 0) throw new Error('seed must be a non-negative integer');
  if (!Number.isInteger(merchantCount) || merchantCount < 5) {
    throw new Error('merchants must be an integer of at least 5');
  }
  if (!Number.isInteger(windows) || windows < 24) {
    throw new Error('windows must be an integer of at least 24');
  }
  if (!Number.isInteger(windowMinutes) || windowMinutes < 1) {
    throw new Error('windowMinutes must be a positive integer');
  }
  if (Number.isNaN(start.getTime())) throw new Error('startAt must be a valid timestamp');

  const random = createRandom(seed);
  const merchantIds = Array.from(
    { length: merchantCount },
    (_, index) => `mrc_${String(index + 1).padStart(3, '0')}`,
  );
  const classRatios: Array<[BehaviorClass, number]> = [
    ['degraded', 0.35],
    ['noisy', 0.15],
    ['low_traffic', 0.1],
    ['high_traffic', 0.1],
    ['stable', 0.3],
  ];
  const assignedClasses = classRatios.flatMap(([behaviorClass, ratio]) =>
    Array.from({ length: Math.floor(merchantCount * ratio) }, () => behaviorClass),
  );
  while (assignedClasses.length < merchantCount) assignedClasses.push('stable');
  const classOrder = shuffle(random, assignedClasses);
  const merchants = merchantIds.map((merchantId, index) =>
    profileForClass(merchantId, classOrder[index]!, random, windows),
  );
  const intervals = merchants.flatMap((merchant) =>
    intervalsFor(merchant, start, windowMinutes, windows),
  );
  const events: PaymentEvent[] = [];
  const usedEventIds = new Set<string>();
  const usedPaymentIds = new Set<string>();
  const usedAttemptIds = new Set<string>();

  for (const merchant of merchants) {
    const segmentProfiles = profilesForMerchant(merchant, random);
    for (let windowIndex = 0; windowIndex < windows; windowIndex += 1) {
      const phase = phaseAt(merchant, windowIndex);
      for (const segment of SEGMENTS) {
        const profile = segmentProfiles.get(segmentKey(segment))!;
        const segmentPhase = segmentKey(segment) === segmentKey(TARGET_SEGMENT) ? phase : 'normal';
        const volumeAdjustment = phaseAdjustment(segmentPhase).volume;
        const commonVolumeNoise = Math.max(0.35, 1 + normal(random) * 0.16);
        const eventCount = poisson(
          random,
          Math.max(0.15, profile.volumeRate * (1 + volumeAdjustment) * commonVolumeNoise),
        );

        for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
          events.push(
            eventFor(
              merchant,
              segment,
              profile,
              segmentPhase,
              windowIndex,
              windowMinutes,
              start,
              random,
              usedEventIds,
              usedPaymentIds,
              usedAttemptIds,
            ),
          );
        }
      }
    }
  }

  events.sort((first, second) => {
    const timestampOrder = first.timestamp.localeCompare(second.timestamp);
    if (timestampOrder !== 0) return timestampOrder;
    const merchantOrder = first.merchantId.localeCompare(second.merchantId);
    if (merchantOrder !== 0) return merchantOrder;
    return first.eventId.localeCompare(second.eventId);
  });

  return {
    metadata: {
      schemaVersion: 'm2',
      seed,
      startAt,
      windowMinutes,
      windows,
      merchantIds,
      segmentKeys: SEGMENTS.map(segmentKey),
    },
    events,
    truth: {
      targetSpec: {
        targetSegment: TARGET_SEGMENT,
        windowMinutes,
        observationWindowMinutes: 20,
        predictionHorizonMinutes: 30,
        sustainedDegradationMinutes: 15,
        leadTimeTargetMinutes: 10,
        degradationDefinition:
          'The target segment is degraded when the hidden state is degraded or severe for at least three consecutive five-minute windows.',
      },
      degradationIntervals: intervals,
      scenarios: merchants.map((merchant) => ({
        merchantId: merchant.merchantId,
        behaviorClass: merchant.behaviorClass,
        targetDegraded: merchant.behaviorClass === 'degraded',
        naturalRecovery: merchant.naturalRecovery,
      })),
    },
    splits: generateSplits(merchantIds, windows),
  };
}

export function writeDataset(dataset: GeneratedDataset, outputDirectory: string): void {
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

export function readDataset(inputDirectory: string): GeneratedDataset {
  const events = readFileSync(join(inputDirectory, 'events.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => paymentEventSchema.parse(JSON.parse(line)));
  const truth = JSON.parse(
    readFileSync(join(inputDirectory, 'truth.json'), 'utf8'),
  ) as DatasetTruth;
  const splitFile = JSON.parse(readFileSync(join(inputDirectory, 'splits.json'), 'utf8')) as {
    metadata: GeneratedDataset['metadata'];
    temporalWindows: DatasetSplits['temporalWindows'];
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

export function phaseForEvent(
  event: PaymentEvent,
  truth: DatasetTruth,
  startAt: string,
  windowMinutes: number,
): ScenarioPhase {
  if (segmentKey(event.paymentMethodSegment) !== segmentKey(truth.targetSpec.targetSegment)) {
    return 'normal';
  }

  const eventTime = new Date(event.timestamp).getTime();
  const startTime = new Date(startAt).getTime();
  const windowIndex = Math.floor((eventTime - startTime) / (windowMinutes * 60_000));
  const interval = truth.degradationIntervals.find(
    (candidate) =>
      candidate.merchantId === event.merchantId &&
      candidate.startWindow <= windowIndex &&
      candidate.endWindowExclusive > windowIndex,
  );
  return interval?.phase ?? 'normal';
}
