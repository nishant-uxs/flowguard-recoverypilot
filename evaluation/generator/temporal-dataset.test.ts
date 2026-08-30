import { describe, expect, it } from 'vitest';

import { paymentEventSchema } from '../../packages/domain/src/index.js';
import { generateDataset, phaseForEvent, segmentKey, TARGET_SEGMENT } from './temporal-dataset.js';
import { buildSanityReport, validateDataset } from './sanity.js';

function smallDataset(seed = 42) {
  return generateDataset({ seed, merchants: 20, windows: 48 });
}

describe('temporal payment dataset generator', () => {
  it('produces identical output for the same seed', () => {
    expect(smallDataset()).toEqual(smallDataset());
  });

  it('produces different output for different seeds', () => {
    expect(smallDataset(42)).not.toEqual(smallDataset(43));
  });

  it('keeps each merchant and segment stream chronological', () => {
    const dataset = smallDataset();
    const streams = new Map<string, string[]>();

    dataset.events.forEach((event) => {
      const key = `${event.merchantId}:${segmentKey(event.paymentMethodSegment)}`;
      streams.set(key, [...(streams.get(key) ?? []), event.timestamp]);
    });

    streams.forEach((timestamps) => {
      expect(timestamps.slice(1).every((timestamp, index) => timestamp >= timestamps[index]!)).toBe(
        true,
      );
    });
  });

  it('keeps event IDs unique', () => {
    const events = smallDataset().events;
    expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
  });

  it('emits only events accepted by the M1 PaymentEvent schema', () => {
    const events = smallDataset().events;
    expect(events.every((event) => paymentEventSchema.safeParse(event).success)).toBe(true);
  });

  it('uses valid currencies, statuses and payment-method segments', () => {
    const dataset = smallDataset();
    const statuses = new Set(dataset.events.map((event) => event.status));
    const segments = new Set<string>(
      dataset.events.map((event) => segmentKey(event.paymentMethodSegment)),
    );

    expect(new Set(dataset.events.map((event) => event.currency))).toEqual(new Set(['INR']));
    expect(statuses.has('succeeded')).toBe(true);
    expect(statuses.has('failed')).toBe(true);
    dataset.metadata.segmentKeys.forEach((segment) => expect(segments.has(segment)).toBe(true));
  });

  it('contains multiple merchants and behavior classes', () => {
    const dataset = smallDataset();
    expect(dataset.metadata.merchantIds.length).toBe(20);
    expect(
      new Set(dataset.truth.scenarios.map((scenario) => scenario.behaviorClass)).size,
    ).toBeGreaterThan(2);
  });

  it('contains target degradation and normal control periods', () => {
    const dataset = smallDataset();
    expect(dataset.truth.scenarios.some((scenario) => scenario.targetDegraded)).toBe(true);
    expect(
      dataset.truth.degradationIntervals.some((interval) => interval.phase === 'degraded'),
    ).toBe(true);

    const targetEvents = dataset.events.filter(
      (event) => segmentKey(event.paymentMethodSegment) === segmentKey(TARGET_SEGMENT),
    );
    expect(
      targetEvents.some(
        (event) =>
          phaseForEvent(
            event,
            dataset.truth,
            dataset.metadata.startAt,
            dataset.metadata.windowMinutes,
          ) === 'normal',
      ),
    ).toBe(true);
  });

  it('represents degradation across multiple windows rather than one event', () => {
    const dataset = smallDataset();
    const sustainedIntervals = dataset.truth.degradationIntervals.filter(
      (interval) => interval.phase === 'degraded' || interval.phase === 'severe',
    );

    expect(
      sustainedIntervals.every(
        (interval) => interval.endWindowExclusive - interval.startWindow >= 3,
      ),
    ).toBe(true);
  });

  it('creates heterogeneous merchant traffic', () => {
    const dataset = smallDataset();
    const counts = dataset.metadata.merchantIds.map(
      (merchantId) => dataset.events.filter((event) => event.merchantId === merchantId).length,
    );

    expect(Math.max(...counts)).toBeGreaterThan(Math.min(...counts));
    expect(new Set(counts).size).toBeGreaterThan(3);
  });

  it('does not expose future labels or hidden scenario state in raw events', () => {
    const forbiddenKeys = new Set([
      'isDegraded',
      'degradationState',
      'recoverySuccess',
      'recoveredValue',
      'futureFailureCount',
      'scenarioType',
      'groundTruth',
    ]);

    expect(
      smallDataset().events.every((event) =>
        Object.keys(event).every((key) => !forbiddenKeys.has(key)),
      ),
    ).toBe(true);
  });

  it('creates non-overlapping temporal splits within dataset bounds', () => {
    const dataset = smallDataset();
    const { train, validation, test } = dataset.splits.temporalWindows;

    expect(train.endWindowExclusive).toBe(validation.startWindow);
    expect(validation.endWindowExclusive).toBe(test.startWindow);
    expect(test.endWindowExclusive).toBe(dataset.metadata.windows);
    expect(train.startWindow).toBe(0);
  });

  it('passes dataset sanity validation', () => {
    const dataset = smallDataset();
    expect(validateDataset(dataset)).toEqual([]);
    expect(buildSanityReport(dataset).trivialProbeFlag).toBe(false);
  });

  it('contains no duplicate events and has no negative values', () => {
    const dataset = smallDataset();
    expect(new Set(dataset.events.map((event) => event.eventId)).size).toBe(dataset.events.length);
    expect(dataset.events.every((event) => event.amount >= 0 && event.retryCount >= 0)).toBe(true);
  });
});
