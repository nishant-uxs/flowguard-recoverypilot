import { describe, expect, it } from 'vitest';

import { merchantContextSchema, paymentEventSchema } from '../src/index.js';

const validEvent = {
  eventId: 'evt_01J8P5N3A7',
  merchantId: 'mrc_01J8P5N3A7',
  paymentId: 'pay_01J8P5N3A7',
  attemptId: 'att_01J8P5N3A7',
  timestamp: '2026-08-30T12:00:00.000Z',
  paymentMethodSegment: {
    paymentMethod: 'upi' as const,
    segment: 'intent' as const,
  },
  amount: 1250,
  currency: 'INR',
  status: 'failed' as const,
  failureCategory: 'timeout' as const,
  latencyMs: 5000,
  retryCount: 1,
};

describe('paymentEventSchema', () => {
  it('accepts a representative failed payment event', () => {
    expect(paymentEventSchema.parse(validEvent)).toEqual(validEvent);
  });

  it('accepts boundary values for zero amount and zero retries', () => {
    const event = {
      ...validEvent,
      amount: 0,
      status: 'initiated' as const,
      failureCategory: undefined,
      latencyMs: 0,
      retryCount: 0,
    };

    expect(paymentEventSchema.parse(event)).toEqual(event);
  });

  it('rejects an invalid timestamp', () => {
    expect(() =>
      paymentEventSchema.parse({ ...validEvent, timestamp: '30/08/2026 12:00' }),
    ).toThrow();
  });

  it('rejects a negative amount', () => {
    expect(() => paymentEventSchema.parse({ ...validEvent, amount: -1 })).toThrow();
  });

  it('rejects an invalid payment status', () => {
    expect(() => paymentEventSchema.parse({ ...validEvent, status: 'reversed' })).toThrow();
  });

  it('rejects an invalid payment-method segment', () => {
    expect(() =>
      paymentEventSchema.parse({
        ...validEvent,
        paymentMethodSegment: { paymentMethod: 'upi', segment: 'card' },
      }),
    ).toThrow();
  });

  it('rejects a negative retry count', () => {
    expect(() => paymentEventSchema.parse({ ...validEvent, retryCount: -1 })).toThrow();
  });

  it('rejects a missing required identifier', () => {
    const withoutPaymentId = Object.fromEntries(
      Object.entries(validEvent).filter(([key]) => key !== 'paymentId'),
    );

    expect(() => paymentEventSchema.parse(withoutPaymentId)).toThrow();
  });

  it('rejects an empty or malformed identifier', () => {
    expect(() => paymentEventSchema.parse({ ...validEvent, eventId: ' ' })).toThrow();
  });

  it('requires an observable failure category only for failed events', () => {
    expect(() =>
      paymentEventSchema.parse({ ...validEvent, status: 'failed', failureCategory: undefined }),
    ).toThrow();
    expect(() =>
      paymentEventSchema.parse({ ...validEvent, status: 'succeeded', failureCategory: 'timeout' }),
    ).toThrow();
  });

  it('rejects unknown fields that could hide future labels', () => {
    expect(() => paymentEventSchema.parse({ ...validEvent, recoverySuccess: true })).toThrow();
  });
});

describe('merchantContextSchema', () => {
  it('accepts the minimal detection-time merchant context', () => {
    expect(merchantContextSchema.parse({ merchantId: validEvent.merchantId })).toEqual({
      merchantId: validEvent.merchantId,
    });
  });

  it('rejects a missing merchant identifier', () => {
    expect(() => merchantContextSchema.parse({})).toThrow();
  });
});
